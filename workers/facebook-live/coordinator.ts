import { discoverySlot, inDiscoveryWindow, nextDiscoverySlot } from '../../src/lib/server/raffle-discovery-schedule';
import { runPoll, STATE_KEY, type Env, type Outcome } from './poller';
import { AUTOMATIC_KEY } from '../../src/lib/server/facebook-automation';
import { drawingDate } from '../../src/lib/server/raffle-discovery-schedule';
import { claimLiveDeliveries, planLiveAlerts, recordLiveDelivery } from './alerts';
import type { Delivery } from '../../src/lib/server/alerts';

/** First-occurrence timestamps per drawing day (at most a few DO writes a day). Never contains tokens or post data. */
export type DrawingTimeline = { day: string; firstWebhookAt?: string; firstWebhookRef?: string; firstLiveEvidenceAt?: string;
    firstSelectedAt?: string; firstSelectedTrigger?: string; firstSelectedWakeLagMs?: number; firstSelectedGraphMs?: number };
const timelineKey = (day: string) => 'timeline:' + day;

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
        private now: () => number = Date.now, private poll: Poll = runPoll,
        private fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

    async event(id:string):Promise<boolean> {
        if(!/^[a-f0-9]{64}$/.test(id)||!inDiscoveryWindow(new Date(this.now()))) return false;
        const events=await this.storage.get<string[]>('events')??[];
        if(events.includes(id)) return false;
        const received=this.now();
        if(this.env.CONFIG) await this.env.CONFIG.put('raffle_live_webhook_state',JSON.stringify({lastEventReceivedAt:new Date(received).toISOString(),signedEventReceived:true}));
        await this.storage.put('pending-event',id);
        await this.storage.put('pending-event-at',received);
        await this.storage.setAlarm(received);
        await this.storage.put('events',[...events.slice(-99),id]);
        await this.mark({firstWebhookAt:new Date(received).toISOString(),firstWebhookRef:id.slice(0,12)},received);
        return true;
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
            // Correlated stage timing (logged, not stored): wake lag, Graph time and KV write time.
            const eventAt = webhook ? await this.storage.get<number>('pending-event-at') : undefined;
            const timing = { graphRequests: 0, graphMs: 0, selectionWriteMs: 0, stateWriteMs: 0 };
            const timedStore = { get: store.get, put: async (key: string, value: string) => {
                const started = this.now();
                try { await store.put(key, value); }
                finally { if (key === AUTOMATIC_KEY) timing.selectionWriteMs += this.now() - started; else if (key === STATE_KEY) timing.stateWriteMs += this.now() - started; }
            } };
            const pollStarted = this.now();
            const outcome = await this.poll({ ...this.env, CONFIG: timedStore }, {
                now: date, trigger:webhook?'webhook':'poll', nextScheduledAt: next ?? time + 60_000,
                fetcher: async (input, init) => {
                    assertWindow();
                    const started = this.now(); timing.graphRequests++;
                    try { return await this.fetcher(input, init); } finally { timing.graphMs += this.now() - started; }
                },
            });
            const finished = this.now();
            const wakeLagMs = webhook && eventAt !== undefined ? time - eventAt : time - slot;
            console.log(JSON.stringify({ component: 'facebook-live', event: 'live-timing', trigger: webhook ? 'webhook' : 'poll',
                ...(webhook ? { eventRef: pending!.slice(0, 12), eventReceivedAt: eventAt !== undefined ? new Date(eventAt).toISOString() : null } : { slotAt: new Date(slot).toISOString() }),
                alarmAt: date.toISOString(), wakeLagMs, ...timing, pollMs: finished - pollStarted, status: outcome.status,
                liveVideo: !!outcome.monitor?.liveVideoId, selected: !!outcome.monitor?.selected }));
            if (outcome.monitor?.liveVideoId) await this.mark({ firstLiveEvidenceAt: date.toISOString() }, time);
            if (outcome.status === 'staged') await this.mark({ firstSelectedAt: new Date(finished).toISOString(), firstSelectedTrigger: webhook ? 'webhook' : 'poll',
                firstSelectedWakeLagMs: wakeLagMs, firstSelectedGraphMs: timing.graphMs }, time);
            // After the selection and state writes, and storage-only: emails are sent by the cron, outside this alarm.
            await planLiveAlerts(this.storage, this.env, outcome, new Date(finished));
            return outcome;
        } finally { this.busy = false; }
    }

    /** Cron delivery hand-off (storage only). The network send happens in the stateless Worker, not here. */
    async claimAlerts() { return claimLiveDeliveries(this.storage, this.env, new Date(this.now())); }
    async recordAlert(id: string, key: string, result: Delivery) { return recordLiveDelivery(this.storage, id, key, result, new Date(this.now())); }

    /** Records only fields not yet set for that drawing day. */
    private async mark(fields: Omit<DrawingTimeline, 'day'>, at: number) {
        try {
            const day = drawingDate(new Date(at)); if (!day) return;
            const current = await this.storage.get<DrawingTimeline>(timelineKey(day)) ?? { day };
            const missing = Object.fromEntries(Object.entries(fields).filter(([k]) => current[k as keyof DrawingTimeline] === undefined));
            if (Object.keys(missing).length) await this.storage.put(timelineKey(day), { ...current, ...missing });
        } catch { /* Diagnostics never affect detection. */ }
    }
    async timeline(day: string): Promise<DrawingTimeline | null> {
        if (!/^2026-11-\d{2}$/.test(day)) return null;
        return await this.storage.get<DrawingTimeline>(timelineKey(day)) ?? null;
    }
}
