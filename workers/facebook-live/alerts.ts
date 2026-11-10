// Facebook Live alert signals. State lives in the coordinator's strongly consistent Durable Object storage,
// so alerting adds no KV reads or writes.
//
// The detection check only PLANS (pure + DO storage). During the 5:50-6:30 PM November cron window the Worker's
// cron claims due envelopes from the DO, sends them and reports each result back. Outside it the coordinator sends
// them itself right after the check that raised them, and on retry alarms, only when no detection check is due
// within DELIVERY_GUARD_MS. Both paths use the same claim/lease/idempotency-key records, so nothing is sent twice.
import { alertConfig, applyDelivery, planIncidents, prepareDelivery, resendSender, testSender, MAX_SENDS_PER_EVALUATION,
    type AlertEnv, type Delivery, type Envelope, type IncidentRecord, type Signal } from '../../src/lib/server/alerts';
import { drawingDate } from '../../src/lib/server/raffle-discovery-schedule';
import type { Outcome } from './poller';

export const GRAPH_FAILURE_STREAK = 3;     // ~45 s at the 15-second drawing cadence; single transient errors never alert.
export const SELECTION_GRACE_MS = 60_000;  // A confirmed Live video should be selected by the same or next poll.
const SYSTEM = 'facebook-live' as const;
const INCIDENTS_KEY = 'alerts:incidents', MONITOR_KEY = 'alerts:monitor';
// Outcomes where no poll ran (or automation was intentionally turned off): leave incidents untouched.
const SKIPPED = ['not-due', 'slot-already-claimed', 'already-running', 'outside-drawing-window', 'outside-window', 'disabled', 'disabled-by-admin'];
const FAILURES = ['storage-or-state-failure', 'storage-unavailable', 'configuration-error', 'missing-token'];

type Storage = { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<unknown> };
export type LiveMonitor = { day: string; failureStreak: number; evidenceAt?: string; evidenceVideoId?: string; lastReason?: string };

/** Pure: next monitor state and current signals for one completed poll. */
export function liveSignals(previous: LiveMonitor | undefined, outcome: Outcome, now: Date): { monitor: LiveMonitor; signals: Signal[] } {
    const day = drawingDate(now) ?? 'unknown', iso = now.toISOString();
    const base: LiveMonitor = previous?.day === day ? previous : { day, failureStreak: previous?.failureStreak ?? 0 };
    const m = outcome.monitor;
    const failed = FAILURES.includes(outcome.status) || (!!m && m.failures > 0) || !!m?.paused;
    const monitor: LiveMonitor = { ...base, failureStreak: failed ? base.failureStreak + 1 : 0, lastReason: m?.reason ?? outcome.status };
    if (m?.liveVideoId && !monitor.evidenceAt) Object.assign(monitor, { evidenceAt: iso, evidenceVideoId: m.liveVideoId });
    const signals: Signal[] = [];
    if (m?.paused || outcome.status === 'access-paused') {
        signals.push({ id: 'live:access-paused', system: SYSTEM,
            title: 'Facebook Live detection paused: Graph access rejected',
            problem: 'Facebook rejected the Live Worker\'s Page token or permissions, so automatic Live detection has paused itself until access is fixed.',
            action: 'Select the Live video manually in Admin > Raffle now. Then rotate the Page token / permissions and redeploy with a new FB_ACCESS_REVISION.',
            detail: { reason: m?.reason ?? outcome.status } });
    } else if (monitor.failureStreak >= GRAPH_FAILURE_STREAK) {
        signals.push({ id: 'live:graph-failures', system: SYSTEM,
            title: 'Facebook Live detection failing repeatedly',
            problem: `The last ${monitor.failureStreak} Live checks during the drawing window failed (latest: ${monitor.lastReason}).`,
            action: 'If the drawing is live, paste the Facebook video URL in Admin > Raffle. Check the Live Worker log and Facebook status.',
            detail: { consecutiveFailures: monitor.failureStreak, reason: monitor.lastReason ?? 'unknown' } });
    }
    // Only a Graph-confirmed Live origin counts as evidence; an unscheduled or absent stream never alerts.
    if (monitor.evidenceAt && !m?.selected && outcome.status !== 'candidates-only') {
        signals.push({ id: `live:selection:${day}`, system: SYSTEM, minDurationMs: SELECTION_GRACE_MS,
            title: 'Live broadcast confirmed but not shown on the website',
            problem: 'Facebook reports a Live raffle video for today, but automatic selection has not published it to the raffle page.',
            action: 'Paste the Facebook video URL in Admin > Raffle immediately. Afterwards check the verification receipt, ambiguity (two videos) and the Worker log.',
            detail: { drawingDate: day, videoId: monitor.evidenceVideoId ?? 'unknown', status: outcome.status, firstConfirmedAt: monitor.evidenceAt } });
    }
    return { monitor, signals };
}

async function loadMap(storage: Storage) { return await storage.get<Record<string, IncidentRecord>>(INCIDENTS_KEY) ?? {}; }
async function saveMap(storage: Storage, all: Record<string, IncidentRecord>, now: Date) {
    // Keep the map small: resolved incidents older than a week are dropped.
    for (const [id, r] of Object.entries(all)) if (r.status === 'resolved' && Date.parse(r.resolvedAt ?? r.lastSeenAt) < now.getTime() - 7 * 86400_000) delete all[id];
    await storage.put(INCIDENTS_KEY, all);
}

/** Called inside the alarm after the poll. DO storage only: no network. Never throws. */
export async function planLiveAlerts(storage: Storage, env: AlertEnv, outcome: Outcome, now: Date) {
    const config = alertConfig(env);
    if (!config.enabled || SKIPPED.includes(outcome.status)) return { status: 'skipped' as const };
    try {
        const previous = await storage.get<LiveMonitor>(MONITOR_KEY);
        const { monitor, signals } = liveSignals(previous, outcome, now);
        if (JSON.stringify(previous) !== JSON.stringify(monitor)) await storage.put(MONITOR_KEY, monitor);
        const today = `live:selection:${monitor.day}`;
        const all = await loadMap(storage);
        // Every Live incident is in this one map, so absence here is authoritative.
        const changed = planIncidents({ system: SYSTEM, signals, records: Object.values(all), now, mode: config.mode, recipients: config,
            quiet: id => id.startsWith('live:selection:') && id !== today }); // A past drawing's unselected broadcast is history, not a recovery.
        if (changed.length) { for (const r of changed) all[r.id] = r; await saveMap(storage, all, now); }
        return { status: 'planned' as const, changed: changed.length, pending: Object.values(all).filter(r => r.envelope).length };
    } catch { return { status: 'error' as const }; }
}

/** DO side of delivery (storage only). Each returned envelope's dispatch claim (first attempt, possibly-delivered, lease) is
 * stored BEFORE it is returned; if that write fails this throws, the route returns 500 and the cron sends nothing.
 * The DO serializes requests, so a concurrent claim sees the lease and receives nothing. */
export async function claimLiveDeliveries(storage: Storage, env: AlertEnv, now: Date): Promise<{ id: string; envelope: Envelope }[]> {
    const mode = alertConfig(env).mode, all = await loadMap(storage), due: { id: string; envelope: Envelope }[] = [];
    let changed = false;
    for (const record of Object.values(all)) {
        if (due.length >= MAX_SENDS_PER_EVALUATION) break;
        if (!record.envelope || record.envelope.mode !== mode) continue;
        const prepared = prepareDelivery(record, now);
        if (prepared.changed) { all[record.id] = prepared.record; changed = true; }
        if (prepared.send) due.push({ id: record.id, envelope: prepared.send });
    }
    if (changed) await saveMap(storage, all, now); // Claims, re-keys and expiries are stored before anything is returned.
    return due;
}
/** DO side of delivery: applies one result, only to the envelope that was sent. */
export async function recordLiveDelivery(storage: Storage, id: string, key: string, result: Delivery, now: Date) {
    const all = await loadMap(storage), record = all[id];
    const applied = record ? applyDelivery(record, key, result, now) : null;
    if (!applied) return false;
    all[id] = applied; await saveMap(storage, all, now); return true;
}

/** Earliest time a stored envelope in the current mode is due (claims and retries included), or null. Never throws. */
export async function nextLiveDeliveryAt(storage: Storage, env: AlertEnv, now: Date): Promise<number | null> {
    const config = alertConfig(env);
    if (!config.enabled) return null;
    try {
        let next: number | null = null;
        for (const record of Object.values(await loadMap(storage))) {
            const e = record.envelope;
            if (!e || e.mode !== config.mode) continue;
            const due = e.nextAttemptAt ? Date.parse(e.nextAttemptAt) : now.getTime();
            if (Number.isFinite(due) && (next === null || due < next)) next = due;
        }
        return next;
    } catch { return null; }
}

/** Coordinator side (outside the cron window): the same claim -> send -> record sequence as the cron, using the
 * stored claims directly instead of the /alerts routes. Never throws. */
export async function deliverFromCoordinator(storage: Storage, env: AlertEnv, now: () => Date, fetcher?: typeof fetch, log: (l: string) => void = console.log, timeoutMs = 5000) {
    const config = alertConfig(env);
    if (!config.enabled) return { status: 'skipped' as const, sent: 0 };
    try {
        const due = await claimLiveDeliveries(storage, env, now());
        const send = config.mode === 'live' ? resendSender(config, fetcher, timeoutMs) : testSender(log);
        let sent = 0;
        for (const { id, envelope } of due) {
            let result: Delivery;
            try { result = await send(envelope); } catch { result = { ok: false, uncertain: true, code: 'sender-failure' }; }
            sent++;
            log(JSON.stringify({ event: result.ok ? 'alert-delivered' : 'alert-delivery-failed', kind: envelope.kind, mode: config.mode, incidentId: id, path: 'coordinator',
                ...(result.ok ? {} : { code: result.code, uncertain: result.uncertain }) }));
            try { await recordLiveDelivery(storage, id, envelope.key, result, now()); }
            catch { log(JSON.stringify({ event: 'alert-result-report-failed', incidentId: id })); }
        }
        return { status: 'delivered' as const, sent };
    } catch { log(JSON.stringify({ event: 'alerts-unavailable', system: SYSTEM })); return { status: 'error' as const, sent: 0 }; }
}

type Scheduler = { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } };
/** Worker side (cron): network sends happen here, never inside the Durable Object. Never throws. */
export async function deliverLiveAlerts(env: AlertEnv & { DISCOVERY_SCHEDULER?: Scheduler }, fetcher?: typeof fetch, log: (l: string) => void = console.log, timeoutMs = 5000) {
    const config = alertConfig(env);
    if (!config.enabled || !env.DISCOVERY_SCHEDULER) return { status: 'skipped' as const, sent: 0 };
    try {
        const ns = env.DISCOVERY_SCHEDULER, stub = ns.get(ns.idFromName('november-2026'));
        const claim = await stub.fetch('https://discovery.internal/alerts/claim', { method: 'POST' });
        if (!claim.ok) return { status: 'error' as const, sent: 0 };
        const due = (await claim.json()) as { id: string; envelope: Envelope }[];
        const send = config.mode === 'live' ? resendSender(config, fetcher, timeoutMs) : testSender(log);
        let sent = 0;
        for (const { id, envelope } of due) {
            let result: Delivery;
            try { result = await send(envelope); } catch { result = { ok: false, uncertain: true, code: 'sender-failure' }; }
            sent++;
            log(JSON.stringify({ event: result.ok ? 'alert-delivered' : 'alert-delivery-failed', kind: envelope.kind, mode: config.mode, incidentId: id,
                ...(result.ok ? {} : { code: result.code, uncertain: result.uncertain }) }));
            // If this report is lost, the stored claim stays "possibly delivered": after its lease it is retried with the same
            // key and bytes inside the 23-hour window, and never sent after it.
            try { await stub.fetch('https://discovery.internal/alerts/result', { method: 'POST', body: JSON.stringify({ id, key: envelope.key, result }) }); }
            catch { log(JSON.stringify({ event: 'alert-result-report-failed', incidentId: id })); }
        }
        return { status: 'delivered' as const, sent };
    } catch { log(JSON.stringify({ event: 'alerts-unavailable', system: SYSTEM })); return { status: 'error' as const, sent: 0 }; }
}
