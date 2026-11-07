// Operational email alerts shared by the winner-photo and Facebook Live Workers.
// Level-triggered: each evaluation reports the problems that exist right now. A stable incident ID is emailed once
// when it crosses its threshold and once more (recovery) when it is confirmed resolved.
//
// Delivery is split into three steps so an email can never be duplicated or altered by a retry:
//   1. plan:    pure state transitions. A due email is frozen into an immutable envelope (key + exact payload).
//   2. persist: the caller stores incidents and envelopes BEFORE any send. If that write fails, nothing is sent.
//   3. deliver: a dispatch marker (first-attempt time, conservative "possibly delivered", claim lease) is stored
//               BEFORE the request; only then is the stored envelope sent verbatim. Every retry reuses the same
//               Idempotency-Key and bytes, including From and To. An unknown outcome is never treated as a failure.
// No Workers globals; storage is supplied by the caller (D1 for photos, Durable Object storage for Live).

export type AlertSystem = 'photo-automation' | 'facebook-live';
export type AlertDetail = Record<string, string | number | boolean>;
export type Signal = {
    id: string; system: AlertSystem; title: string; problem: string; action: string; detail?: AlertDetail;
    /** Consecutive evaluations that must report the problem before emailing (default 1). */
    threshold?: number;
    /** The problem must also have persisted this long before emailing (default 0). */
    minDurationMs?: number;
    /** false: informational notice with no recovery email (manual review is not observable). */
    recovery?: boolean;
};
export type IncidentStatus = 'open' | 'recovering' | 'resolved';
export type DeliveryMode = 'live' | 'test';
export type Envelope = {
    kind: 'alert' | 'recovery'; mode: DeliveryMode; key: string; version: number;
    /** The complete provider payload is frozen: a configuration change never alters a pending email. */
    from: string; to: string[]; subject: string; text: string; html: string; createdAt: string;
    attempts: number; firstAttemptAt: string | null; nextAttemptAt: string | null;
    /** An attempt may have been accepted: set conservatively before every request and kept after any timeout,
     * transport error, 5xx or 409. Only a confirmed rejection restores the value from before that attempt. */
    uncertain: boolean; lastError: string | null;
    /** Set (and stored) before a request; cleared when its result is recorded. A lost result leaves it in place. */
    dispatchedAt: string | null; uncertainBefore: boolean;
};
export type LedgerEntry = { key: string; kind: 'alert' | 'recovery'; at: string;
    outcome: 'delivered' | 'deferred' | 'uncertain-expired' | 'abandoned' | 'cancelled' | 'rekeyed'; code?: string };
export type IncidentRecord = {
    id: string; system: AlertSystem; status: IncidentStatus; occurrences: number; firstSeenAt: string; lastSeenAt: string;
    notifiedAt: string | null; notifiedMode: DeliveryMode | null;
    /** How the alert email ended: a recovery is only sent after a delivered (or possibly delivered) alert. */
    alertOutcome: 'delivered' | 'uncertain' | 'abandoned' | null;
    recoveryNotifiedAt: string | null; resolvedAt: string | null;
    title: string; problem: string; action: string; detail: AlertDetail; recovery: boolean;
    envelope: Envelope | null; ledger: LedgerEntry[];
};
export type AlertEnv = { ALERTS_ENABLED?: string; ALERTS_MODE?: string; ALERT_RESEND_API_KEY?: string; ALERT_EMAIL_TO?: string; ALERT_EMAIL_FROM?: string };
export type AlertConfig = { enabled: boolean; mode: DeliveryMode; configured: boolean; apiKey: string; from: string; to: string[] };
export type Delivery = { ok: true } | { ok: false; uncertain: boolean; code: string; retryAfterSeconds?: number };
export type Sender = (envelope: Envelope) => Promise<Delivery>;

export const DEFAULT_ALERT_FROM = 'Friends of Lake Henry Alerts <alerts@friendsoflakehenry.com>';
export const MAX_SENDS_PER_EVALUATION = 3;
export const MAX_DELIVERY_ATTEMPTS = 10;
/** Resend keeps idempotency keys for 24 hours. Stop reusing a key comfortably before that. */
export const IDEMPOTENCY_WINDOW_MS = 23 * 3600_000;
/** A claimed send is not re-claimed for this long, so concurrent runs cannot both send it. */
export const DISPATCH_LEASE_MS = 5 * 60_000;
const PERMANENT_RETRY_MS = 6 * 3600_000;
const LEDGER_LIMIT = 12;
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** Off unless ALERTS_ENABLED=true. Anything but ALERTS_MODE=live, or missing credentials, is a log-only dry run. */
export function alertConfig(env: AlertEnv): AlertConfig {
    const to = (env.ALERT_EMAIL_TO ?? '').split(',').map(s => s.trim()).filter(s => EMAIL.test(s)).slice(0, 10);
    const from = env.ALERT_EMAIL_FROM?.trim() || DEFAULT_ALERT_FROM;
    const apiKey = env.ALERT_RESEND_API_KEY?.trim() ?? '';
    const configured = !!apiKey && to.length > 0;
    return { enabled: env.ALERTS_ENABLED === 'true', mode: env.ALERTS_MODE === 'live' && configured ? 'live' : 'test', configured, apiKey, from, to };
}

// Diagnostics only: codes, counts, IDs and timestamps. Anything that could carry a token, URL or free text is dropped.
const SENSITIVE = /https?:|access_token|bearer|secret|signature|authorization|fbcdn|graph\.facebook|token=|re_[A-Za-z0-9]{8,}/i;
const OPAQUE = /(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/; // Long mixed strings look like credentials; numeric IDs pass.
export function safeValue(value: unknown): string | number | boolean {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '');
    if (SENSITIVE.test(text) || OPAQUE.test(text)) return 'redacted';
    return text.replace(/[^\w:.,+\- ]+/g, '-').slice(0, 120);
}
export function safeDetail(detail: AlertDetail = {}): AlertDetail {
    const out: AlertDetail = {};
    for (const [key, value] of Object.entries(detail).slice(0, 20)) {
        if (/^[A-Za-z][\w]{0,40}$/.test(key)) out[key] = safeValue(value);
    }
    return out;
}

const central = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const SYSTEM_NAMES: Record<AlertSystem, string> = { 'photo-automation': 'Winner-photo automation', 'facebook-live': 'Facebook Live selection' };
const FOOTER = 'Automated message from friendsoflakehenry.com. Each incident is emailed once, plus one recovery notice.';

/** Renders only from stored incident fields (recovery time is the stored resolvedAt), so a re-render is identical. */
export type Recipients = { from: string; to: string[] };
export function composeEnvelope(record: IncidentRecord, kind: 'alert' | 'recovery', mode: DeliveryMode, createdAt: string, version: number, recipients: Recipients): Envelope {
    const subject = `${mode === 'test' ? '[TEST] ' : ''}[FOLH ${kind === 'alert' ? 'alert' : 'resolved'}] ${record.title}`.slice(0, 200);
    const resolvedAt = record.resolvedAt ?? createdAt;
    const lines: [string, string][] = [
        ['System', SYSTEM_NAMES[record.system]],
        ['Incident', record.id],
        ['First detected', `${central(record.firstSeenAt)} Central (${record.firstSeenAt})`],
        ...(kind === 'recovery' ? [['Resolved', `${central(resolvedAt)} Central (${resolvedAt})`] as [string, string]] : []),
        ['Problem', kind === 'recovery' ? `Resolved: ${record.problem}` : record.problem],
        ['Suggested action', kind === 'recovery' ? 'None. Automation reported healthy on its latest check.' : record.action],
        ...Object.entries(record.detail).map(([k, v]) => [k, String(v)] as [string, string]),
    ];
    const text = lines.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' + FOOTER;
    const html = `<table cellpadding="4" style="font-family:sans-serif;font-size:14px">${lines.map(([k, v]) =>
        `<tr><th align="left" valign="top">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`
        + `<p style="font-family:sans-serif;font-size:12px;color:#555">${FOOTER}</p>`;
    return { kind, mode, version, key: `folh:${record.id}:${record.firstSeenAt}:${kind}:${mode}:v${version}`.slice(0, 256),
        from: recipients.from, to: [...recipients.to], subject, text, html, createdAt,
        attempts: 0, firstAttemptAt: null, nextAttemptAt: null, uncertain: false, lastError: null, dispatchedAt: null, uncertainBefore: false };
}

/** The exact JSON body for an envelope, built only from the envelope. Retries send these same bytes. */
export const resendBody = (e: Envelope) => JSON.stringify({ from: e.from, to: e.to, subject: e.subject, text: e.text, html: e.html });

/** Resend delivery. Never throws and never logs the request or response body. */
export function resendSender(config: AlertConfig, fetcher: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 5000): Sender {
    return async envelope => {
        try {
            const response = await fetcher('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
                headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': envelope.key },
                body: resendBody(envelope) });
            await response.body?.cancel();
            if (response.ok) return { ok: true };
            const status = response.status, retryAfter = Number(response.headers.get('retry-after'));
            // 409: the same key is still being processed (or was accepted earlier): it may already be delivered.
            return { ok: false, uncertain: status === 409 || status >= 500, code: `resend-${status}`,
                ...(status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: Math.min(3600, retryAfter) } : {}) };
        } catch (e) {
            return { ok: false, uncertain: true, code: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'resend-timeout' : 'resend-transport' };
        }
    };
}

/** Dry-run delivery: what would be sent is logged without recipients. */
export const testSender = (log: (line: string) => void = console.log): Sender => async envelope => {
    log(JSON.stringify({ event: 'alert-test-mode', kind: envelope.kind, key: envelope.key, subject: envelope.subject }));
    return { ok: true };
};

function fresh(signal: Signal, now: string): IncidentRecord {
    return { id: signal.id, system: signal.system, status: 'open', occurrences: 1, firstSeenAt: now, lastSeenAt: now, notifiedAt: null, notifiedMode: null,
        alertOutcome: null, recoveryNotifiedAt: null, resolvedAt: null, title: signal.title, problem: signal.problem, action: signal.action,
        detail: safeDetail(signal.detail), recovery: signal.recovery !== false, envelope: null, ledger: [] };
}
const notifiedIn = (r: IncidentRecord, mode: DeliveryMode) => mode === 'live' ? r.notifiedMode === 'live' : r.notifiedMode !== null;
const log2 = (r: IncidentRecord, entry: LedgerEntry): LedgerEntry[] => [...r.ledger, entry].slice(-LEDGER_LIMIT);
/** Closes an envelope: delivered, or ended without certainty, or abandoned. */
function finish(r: IncidentRecord, outcome: 'delivered' | 'uncertain-expired' | 'abandoned', iso: string, code?: string): IncidentRecord {
    const e = r.envelope!;
    const ledger = log2(r, { key: e.key, kind: e.kind, at: iso, outcome, ...(code ? { code } : {}) });
    if (e.kind === 'alert') return { ...r, envelope: null, ledger, notifiedAt: iso, notifiedMode: e.mode,
        alertOutcome: outcome === 'delivered' ? 'delivered' : outcome === 'uncertain-expired' || e.uncertain ? 'uncertain' : 'abandoned' };
    return { ...r, envelope: null, ledger, status: 'resolved', recoveryNotifiedAt: iso };
}
function cancel(r: IncidentRecord, iso: string): IncidentRecord {
    return { ...r, envelope: null, ledger: log2(r, { key: r.envelope!.key, kind: r.envelope!.kind, at: iso, outcome: 'cancelled' }) };
}

/**
 * Step 1, pure. `records` are stored incidents (any status) for the signal IDs plus active ones; `signals` are the problems
 * confirmed now. `quiet(id)` retires an absent incident without a recovery email (past drawing, unknown evidence).
 * Absent incidents are treated as resolved, so callers must re-check absent active incidents authoritatively first.
 * Returns only records whose stored state changed.
 */
export function planIncidents(input: { system: AlertSystem; signals: Signal[]; records: IncidentRecord[]; now: Date; mode: DeliveryMode;
    recipients: Recipients; quiet?: (id: string) => boolean }): IncidentRecord[] {
    const { now, mode, recipients } = input, time = now.getTime(), iso = now.toISOString();
    const stored = new Map(input.records.filter(r => r.system === input.system).map(r => [r.id, r]));
    const changed = new Map<string, IncidentRecord>();
    const seen = new Set<string>();
    for (const signal of input.signals) {
        if (signal.system !== input.system || seen.has(signal.id)) continue;
        seen.add(signal.id);
        let previous = stored.get(signal.id);
        // A pending envelope from another mode (test → live switch) is never sent.
        if (previous?.envelope && previous.envelope.mode !== mode && !previous.envelope.uncertain) previous = cancel(previous, iso);
        let record: IncidentRecord;
        if (!previous || previous.status === 'resolved') record = fresh(signal, iso);
        else if (previous.status === 'recovering') {
            if (previous.envelope?.uncertain) record = fresh(signal, iso); // Recovery may have gone out: this is a new incident.
            else record = { ...(previous.envelope ? cancel(previous, iso) : previous), status: 'open', resolvedAt: null, occurrences: previous.occurrences + 1, lastSeenAt: iso };
        } else if (notifiedIn(previous, mode) || previous.envelope) {
            if (previous !== stored.get(signal.id)) changed.set(previous.id, previous);
            continue; // Reported or frozen for delivery: no rewrite, no new email.
        } else record = { ...previous, occurrences: previous.occurrences + 1, lastSeenAt: iso, detail: safeDetail(signal.detail),
            problem: signal.problem, title: signal.title, action: signal.action };
        const ready = record.occurrences >= Math.max(1, signal.threshold ?? 1) && time - Date.parse(record.firstSeenAt) >= (signal.minDurationMs ?? 0);
        if (ready && !notifiedIn(record, mode) && !record.envelope) record = { ...record, envelope: composeEnvelope(record, 'alert', mode, iso, 1, recipients) };
        changed.set(record.id, record);
    }
    for (const original of stored.values()) {
        if (seen.has(original.id) || original.status === 'resolved') continue;
        let record = original;
        if (record.envelope && record.envelope.mode !== mode && !record.envelope.uncertain) record = cancel(record, iso);
        if (record.status === 'recovering') {
            if (!record.envelope) record = { ...record, status: 'resolved' }; // Its dry-run recovery was cancelled by a mode switch.
            if (record !== original) changed.set(record.id, record);
            continue;
        }
        if (record.envelope?.kind === 'alert') {
            // Never confirmed sent: drop it. Possibly sent: count it as reported so its recovery follows.
            record = record.envelope.uncertain ? finish(record, 'uncertain-expired', iso, 'resolved-before-confirmation') : cancel(record, iso);
        }
        const reported = record.recovery && !input.quiet?.(record.id) && notifiedIn(record, mode) && (mode === 'test' || record.notifiedMode === 'live')
            && (record.alertOutcome === 'delivered' || record.alertOutcome === 'uncertain');
        if (!reported) {
            changed.set(record.id, { ...record, status: 'resolved', resolvedAt: record.resolvedAt ?? iso });
            continue;
        }
        record = { ...record, status: 'recovering', resolvedAt: iso };
        changed.set(record.id, { ...record, envelope: composeEnvelope(record, 'recovery', mode, iso, 1, recipients) });
    }
    return [...changed.values()];
}

/**
 * Step 3a. Claims a due envelope for one send. The returned record MUST be stored (compare-and-set) before the request;
 * if that write fails or loses a race, nothing is sent. The stored claim records the first attempt, marks the email
 * possibly delivered, and leases it so no concurrent run sends it too. A lost result therefore keeps its 23-hour deadline
 * and its uncertainty: it is retried with the same key inside the window and never re-keyed or resent after it.
 */
export function prepareDelivery(record: IncidentRecord, now: Date): { record: IncidentRecord; changed: boolean; send: Envelope | null } {
    const e = record.envelope, time = now.getTime(), iso = now.toISOString();
    if (!e || (e.nextAttemptAt && Date.parse(e.nextAttemptAt) > time)) return { record, changed: false, send: null };
    let base = record, target = e;
    if (e.firstAttemptAt && time - Date.parse(e.firstAttemptAt) >= IDEMPOTENCY_WINDOW_MS) {
        // The provider may have forgotten the key. Possibly delivered (including a lost result): stop, never resend.
        if (e.uncertain || e.dispatchedAt) return { record: finish(record, 'uncertain-expired', iso, e.lastError ?? 'result-unknown'), changed: true, send: null };
        // Every attempt was a confirmed rejection: a new key for the same frozen payload is safe.
        target = composeEnvelope(record, e.kind, e.mode, e.createdAt, e.version + 1, { from: e.from, to: e.to });
        base = { ...record, envelope: target, ledger: log2(record, { key: e.key, kind: e.kind, at: iso, outcome: 'rekeyed', ...(e.lastError ? { code: e.lastError } : {}) }) };
    }
    const claimed: Envelope = { ...target, firstAttemptAt: target.firstAttemptAt ?? iso, dispatchedAt: iso,
        uncertainBefore: target.uncertain || !!target.dispatchedAt, uncertain: true, nextAttemptAt: new Date(time + DISPATCH_LEASE_MS).toISOString() };
    return { record: { ...base, envelope: claimed }, changed: true, send: claimed };
}

/** Step 3b. Applies a send result, but only to the stored claim that was sent. */
export function applyDelivery(record: IncidentRecord, key: string, result: Delivery, now: Date): IncidentRecord | null {
    const e = record.envelope, iso = now.toISOString(), time = now.getTime();
    if (!e || e.key !== key || !e.dispatchedAt) return null; // Superseded, already applied, or never claimed.
    if (result.ok) return finish(record, 'delivered', iso);
    const attempts = e.attempts + 1;
    // Only a confirmed rejection clears this attempt's uncertainty; earlier possibly-accepted attempts stay recorded.
    const uncertain = result.uncertain || e.uncertainBefore;
    const transient = result.uncertain || result.code === 'resend-429';
    const delay = Math.max(transient ? Math.min(60, 2 * 2 ** Math.min(attempts, 5)) * 60_000 : PERMANENT_RETRY_MS, (result.retryAfterSeconds ?? 0) * 1000);
    const updated: IncidentRecord = { ...record, envelope: { ...e, attempts, uncertain, uncertainBefore: uncertain, dispatchedAt: null, lastError: result.code,
        nextAttemptAt: new Date(time + delay).toISOString() }, ledger: log2(record, { key, kind: e.kind, at: iso, outcome: 'deferred', code: result.code }) };
    return attempts >= MAX_DELIVERY_ATTEMPTS ? finish(updated, uncertain ? 'uncertain-expired' : 'abandoned', iso, result.code) : updated;
}

/** Compare-and-set store: each write applies only if the stored record still equals `before` (null: must not exist). */
export type Write = { before: IncidentRecord | null; after: IncidentRecord };
export type Store = (writes: Write[]) => Promise<boolean[]>;

/** Steps 3a-3b for in-process senders (photo Worker). */
export async function deliverDue(input: { records: IncidentRecord[]; now: Date; send: Sender; save: Store;
    log?: (line: string) => void; max?: number; mode: DeliveryMode }) {
    const log = input.log ?? console.log;
    const deliveries: { id: string; kind: 'alert' | 'recovery'; ok: boolean; code?: string }[] = [];
    let budget = input.max ?? MAX_SENDS_PER_EVALUATION;
    for (const current of input.records) {
        if (budget <= 0) break;
        if (!current.envelope || current.envelope.mode !== input.mode) continue;
        const prepared = prepareDelivery(current, input.now);
        if (!prepared.changed) continue;
        let claimed = false;
        try { [claimed] = await input.save([{ before: current, after: prepared.record }]); }
        catch { log(JSON.stringify({ event: 'alert-dispatch-save-failed', incidentId: current.id })); }
        if (!claimed || !prepared.send) continue; // No durable claim: never send. (Expiry-only changes send nothing.)
        budget--;
        let result: Delivery;
        try { result = await input.send(prepared.send); } catch { result = { ok: false, uncertain: true, code: 'sender-failure' }; }
        deliveries.push({ id: current.id, kind: prepared.send.kind, ok: result.ok, ...(result.ok ? {} : { code: result.code }) });
        log(JSON.stringify({ event: result.ok ? 'alert-delivered' : 'alert-delivery-failed', kind: prepared.send.kind, mode: input.mode, incidentId: current.id,
            ...(result.ok ? {} : { code: result.code, uncertain: result.uncertain }) }));
        const applied = applyDelivery(prepared.record, prepared.send.key, result, input.now);
        if (!applied) continue;
        // If this write is lost, the stored claim stays "possibly delivered": retried verbatim within 23 hours, never after.
        try { const [ok] = await input.save([{ before: prepared.record, after: applied }]); if (!ok) throw Error('conflict'); }
        catch { log(JSON.stringify({ event: 'alert-ledger-save-failed', incidentId: current.id })); }
    }
    return deliveries;
}

export type Prepared = { signals: Signal[]; records: IncidentRecord[]; quiet?: (id: string) => boolean };
/** Plan + persist + deliver for the photo Worker. Never throws, so alerting can never interrupt winner publication. */
export async function runAlerts(input: { env: AlertEnv; system: AlertSystem; now: Date; fetcher?: typeof fetch;
    prepare: () => Promise<Prepared>; save: Store; log?: (line: string) => void; sender?: Sender }) {
    const config = alertConfig(input.env);
    if (!config.enabled) return { status: 'disabled' as const };
    const log = input.log ?? console.log;
    try {
        const { signals, records, quiet } = await input.prepare();
        const loaded = new Map(records.map(r => [r.id, r]));
        const changed = planIncidents({ system: input.system, signals, records, now: input.now, mode: config.mode, recipients: config, quiet });
        // Throws to the catch below: no envelope is sent unless it is stored.
        const saved = changed.length ? await input.save(changed.map(after => ({ before: loaded.get(after.id) ?? null, after }))) : [];
        const current = new Map(loaded);
        changed.forEach((r, i) => { if (saved[i]) current.set(r.id, r); else current.delete(r.id); }); // A lost race is re-planned next time.
        const send = input.sender ?? (config.mode === 'live' ? resendSender(config, input.fetcher) : testSender(log));
        const deliveries = await deliverDue({ records: [...current.values()], now: input.now, send, save: input.save, log, mode: config.mode });
        return { status: 'evaluated' as const, mode: config.mode, open: signals.length, changed: changed.length, deliveries };
    } catch (e) {
        log(JSON.stringify({ event: 'alerts-unavailable', system: input.system, code: safeValue(e instanceof Error ? e.message : 'unknown') }));
        return { status: 'error' as const };
    }
}
