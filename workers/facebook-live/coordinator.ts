import { discoverySlot, inDiscoveryWindow, nextDiscoverySlot } from '../../src/lib/server/raffle-discovery-schedule';
import { runPoll, STATE_KEY, type Env, type Outcome } from './poller';
import { AUTOMATIC_KEY } from '../../src/lib/server/facebook-automation';

type Storage = {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<unknown>;
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<unknown>;
};
type Poll = typeof runPoll;
/** One instance per singleton Durable Object. Only alarm() may call Facebook.
 * Cloudflare serializes alarms globally for that object. The synchronous busy
 * flag also rejects re-entry in tests; no network work occurs in kick(). */
export class DiscoveryCoordinator {
    private busy = false;
    constructor(private storage: Storage, private env: Env,
        private now: () => number = Date.now, private poll: Poll = runPoll, private fetcher: typeof fetch = fetch) {}

    async event(id:string):Promise<boolean> {
        if(!/^[a-f0-9]{64}$/.test(id)||!inDiscoveryWindow(new Date(this.now()))) return false;
        const events=await this.storage.get<string[]>('events')??[];
        if(events.includes(id)) return false;
        if(this.env.CONFIG) await this.env.CONFIG.put('raffle_live_webhook_state',JSON.stringify({lastEventReceivedAt:new Date(this.now()).toISOString(),signedEventReceived:true}));
        await this.storage.put('pending-event',id);
        await this.storage.setAlarm(this.now());
        await this.storage.put('events',[...events.slice(-99),id]);return true;
    }
    async kick(): Promise<void> {
        if (this.env.FB_AUTOMATION_ENABLED !== 'true' || !inDiscoveryWindow(new Date(this.now())) || this.busy) return;
        if (await this.storage.getAlarm() === null) await this.storage.setAlarm(this.now());
    }

    async alarm(): Promise<Outcome> {
        if (this.busy) return { status: 'already-running' };
        const time = this.now(), date = new Date(time), slot = discoverySlot(date);
        if (this.env.FB_AUTOMATION_ENABLED !== 'true' || slot === null) return { status: 'outside-drawing-window' };
        this.busy = true;
        try {
            const previous = await this.storage.get<number>('claimed-slot');
            const next = nextDiscoverySlot(date);
            // Arm before external work: a runtime interruption leaves a recovery
            // alarm. Platform serialization prevents the next alarm overlapping.
            if (next !== null) await this.storage.setAlarm(next);
            const pending=await this.storage.get<string>('pending-event');
            const claimedEvent=await this.storage.get<string>('claimed-event');
            const webhook=!!pending && pending!==claimedEvent;
            if (!webhook && previous !== undefined && previous >= slot) return { status: 'slot-already-claimed' };
            // Durable claim precedes every KV/Facebook operation. At-least-once
            // alarm retries never repeat an already-started slot after a reset.
            await this.storage.put('claimed-slot', slot);
            if(webhook) await this.storage.put('claimed-event',pending);
            if (!this.env.CONFIG) return { status: 'storage-unavailable' };
            const upstream = this.env.CONFIG;
            const assertWindow = () => {
                if (!inDiscoveryWindow(new Date(this.now()))) throw Error('Discovery window closed');
            };
            // Strongly consistent coordinator copies prevent cached KV reads from
            // forgetting a just-written backoff or selection during the 15s burst.
            const cached = (key: string) => key === STATE_KEY || key === AUTOMATIC_KEY;
            const store = {
                get: async (key: string): Promise<string | null> => {
                    assertWindow();
                    if (cached(key)) {
                        const saved = await this.storage.get<{ value: string | null }>('cache:' + key);
                        if (saved) return saved.value;
                        assertWindow();
                        const value = await upstream.get(key);
                        await this.storage.put('cache:' + key, { value });
                        return value;
                    }
                    assertWindow();
                    return upstream.get(key);
                },
                put: async (key: string, value: string): Promise<void> => {
                    assertWindow();
                    // Retain retry/pause truth even if the public heartbeat write
                    // fails. Public selection then expires safely to manual.
                    if (key === STATE_KEY) await this.storage.put('cache:' + key, { value });
                    assertWindow();
                    await upstream.put(key, value);
                    if (key === AUTOMATIC_KEY) await this.storage.put('cache:' + key, { value });
                },
            };
            return await this.poll({ ...this.env, CONFIG: store }, {
                now: date, trigger:webhook?'webhook':'poll', nextScheduledAt: next ?? time + 60_000,
                fetcher: (input, init) => { assertWindow(); return this.fetcher(input, init); },
            });
        } finally { this.busy = false; }
    }
}
