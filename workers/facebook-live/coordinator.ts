import { alertWindowEnd, discoverySlot, drawingStartFastUntil, inAlertDeliveryWindow, inDiscoveryWindow, liveDay, nextDiscoverySlot } from '../../src/lib/server/raffle-discovery-schedule';
import { runPoll, STATE_KEY, type Env, type Outcome } from './poller';
import { AUTOMATIC_KEY } from '../../src/lib/server/facebook-automation';
import { drawingDate } from '../../src/lib/server/raffle-discovery-schedule';
import { claimLiveDeliveries, deliverFromCoordinator, nextLiveDeliveryAt, planLiveAlerts, recordLiveDelivery } from './alerts';
import type { Delivery } from '../../src/lib/server/alerts';
import { TimingJournal } from './timing';

/** First-occurrence timestamps per drawing day (at most a few DO writes a day). Never contains tokens or post data. */
export type DrawingTimeline = { day: string; firstWebhookAt?: string; firstWebhookRef?: string; firstLiveEvidenceAt?: string;
    firstSelectedAt?: string; firstSelectedTrigger?: string; firstSelectedWakeLagMs?: number; firstSelectedGraphMs?: number };
const timelineKey = (day: string) => 'timeline:' + day;
/** An off-schedule webhook check may not touch KV after this long (Graph deadline 25 s + format probe 2.5 s + storage). */
export const CHECK_DEADLINE_MS = 60_000;
/** Public pages read the coordinator snapshot fresh and poll every 5 s for this long after a signed hint or a new selection. */
export const ACTIVE_DISPLAY_MS = 2 * 60_000;
/** Coordinator alert sends wait until no detection check is due within this long; retry alarms are at least this far apart. */
export const DELIVERY_GUARD_MS = 15_000;

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
    private journal: TimingJournal;
    constructor(private storage: Storage, private env: Env,
        private now: () => number = Date.now, private poll: Poll = runPoll,
        private fetcher: typeof fetch = (input, init) => fetch(input, init)) { this.journal = new TimingJournal(storage); }

    async recordTiming(value: unknown) { await this.journal.append(value); }

    async event(id:string):Promise<boolean> {
        if(!/^[a-f0-9]{64}$/.test(id)||!liveDay(new Date(this.now()))) return false;
        const events=await this.storage.get<string[]>('events')??[];
        if(events.includes(id)) return false;
        const received=this.now();
        if(this.env.CONFIG) await this.env.CONFIG.put('raffle_live_webhook_state',JSON.stringify({lastEventReceivedAt:new Date(received).toISOString(),signedEventReceived:true}));
        await this.storage.put('pending-event',id);
        await this.storage.put('pending-event-at',received);
        await this.storage.setAlarm(received);
        await this.storage.put('events',[...events.slice(-99),id]);
        await this.mark({firstWebhookAt:new Date(received).toISOString(),firstWebhookRef:id.slice(0,12)},received);
        await this.journal.append({stage:'do-event',at:received,eventRef:id.slice(0,12),accepted:true});
        return true;
    }
    async kick(): Promise<void> {
        if (this.env.FB_AUTOMATION_ENABLED !== 'true' || !inDiscoveryWindow(new Date(this.now())) || this.busy) return;
        // A later alert-retry alarm must not postpone the backup check.
        const alarm = await this.storage.getAlarm();
        if (alarm === null || alarm > this.now() + 60_000) await this.storage.setAlarm(this.now());
    }

    async alarm(): Promise<Outcome> {
        const outcome = await this.check();
        if (outcome.status !== 'already-running') await this.afterCheck();
        return outcome;
    }

    /** Event-driven alert email outside the cron window: sends due envelopes right after the check that planned them
     * (and on retry alarms) when no detection check is due within DELIVERY_GUARD_MS, then keeps one alarm for the next
     * due envelope. Inside the window the cron sends and the coordinator takes over at its 6:31 PM end. Never throws. */
    private async afterCheck() {
        try {
            const time = this.now();
            if (!inAlertDeliveryWindow(new Date(time))) {
                const alarm = await this.storage.getAlarm(), due = await nextLiveDeliveryAt(this.storage, this.env, new Date(time));
                if (due !== null && due <= time && (alarm === null || alarm - time >= DELIVERY_GUARD_MS))
                    await deliverFromCoordinator(this.storage, this.env, () => new Date(this.now()), this.fetcher);
            }
            const after = this.now(), due = await nextLiveDeliveryAt(this.storage, this.env, new Date(after));
            if (due === null) return;
            let at = Math.max(due, after + DELIVERY_GUARD_MS);
            at = alertWindowEnd(new Date(at)) ?? at;
            const alarm = await this.storage.getAlarm();
            if (alarm === null || alarm > at) await this.storage.setAlarm(at);
        } catch { /* Alert delivery never affects detection. */ }
    }

    private async check(): Promise<Outcome> {
        if (this.busy) return { status: 'already-running' };
        const time = this.now(), date = new Date(time);
        if (this.env.FB_AUTOMATION_ENABLED !== 'true' || !liveDay(date)) return { status: 'outside-drawing-window' };
        const pending=await this.storage.get<string>('pending-event');
        const claimedEvent=await this.storage.get<string>('claimed-event');
        const webhook=!!pending && pending!==claimedEvent;
        // Backup slots only 5:50-6:15 PM. Outside it only an unclaimed signed webhook runs a check, with no follow-on polling.
        const slot = discoverySlot(date) ?? (webhook ? Math.floor(time / 15_000) * 15_000 : null);
        if (slot === null) return { status: 'outside-drawing-window' };
        this.busy = true;
        try {
            const previous = await this.storage.get<number>('claimed-slot');
            const next = nextDiscoverySlot(date);
            // Arm before external work: a runtime interruption leaves a recovery
            // alarm. Platform serialization prevents the next alarm overlapping.
            if (next !== null) await this.storage.setAlarm(next);
            if (!webhook && previous !== undefined && previous >= slot) return { status: 'slot-already-claimed' };
            // Durable claim precedes every KV/Facebook operation. At-least-once
            // alarm retries never repeat an already-started slot after a reset.
            await this.storage.put('claimed-slot', slot);
            if(webhook) await this.storage.put('claimed-event',pending);
            if (!this.env.CONFIG) return { status: 'storage-unavailable' };
            const upstream = this.env.CONFIG;
            const assertWindow = () => {
                if (webhook ? this.now() - time > CHECK_DEADLINE_MS : !inDiscoveryWindow(new Date(this.now()))) throw Error('Discovery window closed');
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
            const graph: {phase:string;startedAt:number;completedAt:number;httpStatus:number}[] = [];
            let selectionCompletedAt: number | undefined, stateCompletedAt: number | undefined;
            const timedStore = { get: store.get, put: async (key: string, value: string) => {
                const started = this.now();
                try { await store.put(key, value); if(key===AUTOMATIC_KEY) selectionCompletedAt=this.now(); else if(key===STATE_KEY) stateCompletedAt=this.now(); }
                finally { if (key === AUTOMATIC_KEY) timing.selectionWriteMs += this.now() - started; else if (key === STATE_KEY) timing.stateWriteMs += this.now() - started; }
            } };
            const pollStarted = this.now();
            const correlation = {trigger:webhook?'webhook':'poll',eventRef:webhook?pending!.slice(0,12):undefined,alarmAt:time,slotAt:slot};
            await this.journal.append({stage:'check-start',at:time,...correlation});
            const outcome = await this.poll({ ...this.env, CONFIG: timedStore }, {
                now: date, trigger:webhook?'webhook':'poll', nextScheduledAt: next ?? time + 60_000,
                fetcher: async (input, init) => {
                    assertWindow();
                    const started = this.now(); timing.graphRequests++;
                    const url = new URL(String(input instanceof Request ? input.url : input));
                    const phase = url.searchParams.get('fields')==='id,format'?'format':url.pathname.endsWith('/published_posts')?'posts':url.searchParams.get('fields')==='id'?'identity':'video';
                    let httpStatus=0;
                    try { const response=await this.fetcher(input, init); httpStatus=response.status; return response; }
                    finally { timing.graphMs += this.now() - started; if(graph.length<11) graph.push({phase,startedAt:started,completedAt:this.now(),httpStatus}); }
                },
            }).catch(async error=>{
                await this.journal.append({stage:'check-result',at:this.now(),...correlation,status:'runtime-failure',graph,...timing,completedAt:this.now()});
                throw error;
            });
            const finished = this.now();
            const wakeLagMs = webhook && eventAt !== undefined ? time - eventAt : time - slot;
            await this.journal.append({stage:'check-result',at:finished,...correlation,completedAt:finished,wakeLagMs,
                ...timing,graph,pollMs:finished-pollStarted,status:outcome.status,selectionCompletedAt,stateCompletedAt,
                ...outcome.monitor,videoId:outcome.monitor?.liveVideoId});
            console.log(JSON.stringify({ component: 'facebook-live', event: 'live-timing', trigger: webhook ? 'webhook' : 'poll',
                ...(webhook ? { eventRef: pending!.slice(0, 12), eventReceivedAt: eventAt !== undefined ? new Date(eventAt).toISOString() : null } : { slotAt: new Date(slot).toISOString() }),
                alarmAt: date.toISOString(), wakeLagMs, ...timing, pollMs: finished - pollStarted, status: outcome.status,
                liveVideo: !!outcome.monitor?.liveVideoId, selected: !!outcome.monitor?.selected }));
            if (outcome.monitor?.liveVideoId && /^\d+$/.test(outcome.monitor.liveVideoId)) await this.mark({ firstLiveEvidenceAt: date.toISOString() }, time);
            if (outcome.status === 'staged') await this.storage.put('staged-at', finished);
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

    /** Read-only public snapshot of the strongly consistent selection and state copies, read together so they always
     * match. `undefined` means no copy exists yet (the caller then uses KV). No KV, Graph, alarm or journal I/O. */
    /** `activeUntil`: a new Live may need to appear until then (recent signed hint, recent selection or the scheduled
     * drawing start). Pages read fresh and browsers poll every 5 s only until then. */
    async selectionSnapshot(): Promise<{ automaticRaw?: string | null; stateRaw?: string | null; activeUntil: number }> {
        const [automatic, state, hintAt, stagedAt] = await Promise.all([this.storage.get<{ value: string | null }>('cache:' + AUTOMATIC_KEY),
            this.storage.get<{ value: string | null }>('cache:' + STATE_KEY), this.storage.get<number>('pending-event-at'), this.storage.get<number>('staged-at')]);
        const activeUntil = Math.max((hintAt ?? -Infinity) + ACTIVE_DISPLAY_MS, (stagedAt ?? -Infinity) + ACTIVE_DISPLAY_MS, drawingStartFastUntil(new Date(this.now())), 0);
        return { ...(automatic ? { automaticRaw: automatic.value } : {}), ...(state ? { stateRaw: state.value } : {}), activeUntil };
    }

    /** Records only fields not yet set for that drawing day. */
    private async mark(fields: Omit<DrawingTimeline, 'day'>, at: number) {
        try {
            const day = drawingDate(new Date(at)); if (!day) return;
            const current = await this.storage.get<DrawingTimeline>(timelineKey(day)) ?? { day };
            const missing = Object.fromEntries(Object.entries(fields).filter(([k]) => current[k as keyof DrawingTimeline] === undefined));
            if (Object.keys(missing).length) await this.storage.put(timelineKey(day), { ...current, ...missing });
        } catch { /* Diagnostics never affect detection. */ }
    }
    async timeline(day: string) {
        if (!/^2026-11-\d{2}$/.test(day)) return null;
        return {...await this.storage.get<DrawingTimeline>(timelineKey(day)),day,diagnostics:await this.journal.read(day)};
    }
}
