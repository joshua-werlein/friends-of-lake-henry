// Winner-photo alert signals, derived from the existing D1 queue/import tables plus this tick's poll result.
// Discovery reads are bounded. An active incident absent from a bounded read is unknown, not healthy, so it is
// re-checked by its primary key before any recovery. Writes happen only in migration 008's tables.
import type { D1Database } from '@cloudflare/workers-types';
import { runAlerts, type AlertEnv, type IncidentRecord, type Prepared, type Signal, type Write } from '../../src/lib/server/alerts';

export const STUCK_AFTER_MS = 20 * 60_000;     // A queued announcement should finish within a few minutes.
export const REPEATED_ATTEMPTS = 3;            // Attempts 1-3 span ~3 minutes of backoff (1, 2 minutes).
export const REVIEW_WINDOW_MS = 72 * 3600_000; // Matches the 3-day announcement age limit.
export const WEBHOOK_GRACE_MS = 10 * 60_000;   // A signed webhook normally arrives within seconds of the post.
export const ACTIVE_LOAD_LIMIT = 200;
export const AUTH_CODES = ['token-expired', 'permission-denied', 'missing-token'];
const AI_CODE = /extraction|vision|model|inference|neuron|capacity|^ai[-_:.]|workers-ai/i;
const SYSTEM = 'photo-automation' as const;
const TRACKING_START = 'tracking-start';

type PostRow = { post_id: string; source: string; status: string; attempts: number; error_code: string | null; last_error_code: string | null; created_at: string };
type ReviewRow = { photo_id: string; post_id: string; status: string; updated_at: string; held: number; rejected: number };
export type PhotoAlertInput = { webhookConfigured: boolean; automationEnabled: boolean; pollError?: string | null; seasonStart: string;
    /** False when this tick skipped the Graph poll: its auth evidence is unknown, not healthy. */
    pollRan?: boolean;
    /** ALERT_WEBHOOK_DELIVERY_ENABLED: receipt-based webhook-delivery alert, off by default. */
    webhookDeliveryAlert?: boolean };

const POST_COLUMNS = 'post_id, source, status, attempts, error_code, last_error_code, created_at';
const REVIEW_SELECT = `SELECT i.photo_id, i.post_id, i.status, i.updated_at,
        (SELECT count(*) FROM raffle_photo_auto_rows r WHERE r.photo_id=i.photo_id AND r.outcome='held') AS held,
        (SELECT count(*) FROM raffle_photo_auto_rows r WHERE r.photo_id=i.photo_id AND r.outcome='rejected') AS rejected
    FROM raffle_photo_auto_imports i`;

/** The signal a post's authoritative row implies right now; null means healthy (finished or still within its normal time). */
export function postSignal(post: PostRow, now: Date): Signal | null {
    if (post.status !== 'failed' && AUTH_CODES.includes(post.error_code ?? '')) return null; // Reported once, as photo:graph-auth.
    const code = post.error_code ?? post.last_error_code ?? 'none';
    const age = now.getTime() - Date.parse(post.created_at);
    const ai = AI_CODE.test(code);
    if (post.status === 'failed') return { id: `photo:post:${post.post_id}`, system: SYSTEM,
        title: ai ? 'Winner photo AI extraction failed repeatedly' : 'Winner photo processing stopped',
        problem: `Automatic processing of a Facebook post stopped after ${post.attempts} attempts; any winners in it were not published automatically.`,
        action: 'Open Admin > Raffle > Photo imports, review the failure, then requeue the post or enter the winners manually.',
        detail: { postId: post.post_id, attempts: post.attempts, code, source: post.source } };
    if (['queued', 'retry', 'processing'].includes(post.status) && (age >= STUCK_AFTER_MS || post.attempts >= REPEATED_ATTEMPTS)) return { id: `photo:post:${post.post_id}`, system: SYSTEM,
        title: ai ? 'Repeated winner photo AI extraction failures' : 'Winner photo processing not completing',
        problem: `A Facebook post queued ${Math.round(age / 60_000)} minutes ago has not finished processing (${post.attempts} attempts, status ${post.status}). It is still retrying.`,
        action: 'No action is needed if a recovery email follows. Otherwise check Admin > Raffle > Photo imports and the Worker log.',
        detail: { postId: post.post_id, attempts: post.attempts, status: post.status, code, source: post.source } };
    return null;
}
function reviewSignal(review: ReviewRow, now: Date): Signal | null {
    if (!['held', 'rejected', 'partial'].includes(review.status) || Date.parse(review.updated_at) < now.getTime() - REVIEW_WINDOW_MS) return null;
    return { id: `photo:review:${review.photo_id}`, system: SYSTEM, recovery: false,
        title: 'Winner rows need manual review',
        problem: `A winner photo was processed but ${review.held} row(s) were held and ${review.rejected} rejected instead of being published automatically.`,
        action: 'Open Admin > Raffle > Photo imports, compare the held/rejected rows with the Facebook post, and enter or correct those winners.',
        detail: { postId: review.post_id, photoId: review.photo_id, importStatus: review.status, held: review.held, rejected: review.rejected } };
}

/** Records signed-webhook receipts per post, independent of which path queued the post. Never throws. */
export async function recordWebhookReceipts(db: D1Database, postIds: string[], now: Date) {
    if (!postIds.length) return;
    try {
        await db.batch(postIds.map(id => db.prepare(`INSERT INTO ops_webhook_receipts (post_id, first_received_at) VALUES (?,?) ON CONFLICT(post_id) DO NOTHING`)
            .bind(id, now.toISOString())));
    } catch { /* Migration 008 not applied, or a transient D1 failure: receipts are evidence for alerts only. */ }
}

type WebhookState = 'failing' | 'healthy' | 'unknown';
/** Two distinct eligible announcements, both older than the grace period, with no signed receipt. Admin requeues and
 * posts queued before receipt tracking began (backfills) are excluded. Too few samples is unknown, never healthy. */
async function webhookDelivery(db: D1Database, now: Date): Promise<WebhookState> {
    const start = await db.prepare(`SELECT first_received_at AS at FROM ops_webhook_receipts WHERE post_id=?`).bind(TRACKING_START).first<{ at: string }>();
    if (!start) {
        await db.prepare(`INSERT INTO ops_webhook_receipts (post_id, first_received_at) VALUES (?,?) ON CONFLICT(post_id) DO NOTHING`).bind(TRACKING_START, now.toISOString()).run();
        return 'unknown';
    }
    const time = now.getTime();
    const rows = (await db.prepare(`SELECT p.post_id, r.first_received_at AS receipt FROM raffle_photo_auto_posts p
            LEFT JOIN ops_webhook_receipts r ON r.post_id=p.post_id
        WHERE p.status='done' AND p.source IN ('webhook','poll') AND p.created_at >= ? AND p.created_at >= ? AND p.created_at <= ?
        ORDER BY p.created_at DESC LIMIT 2`).bind(start.at, new Date(time - 7 * 86400_000).toISOString(), new Date(time - WEBHOOK_GRACE_MS).toISOString())
        .all<{ post_id: string; receipt: string | null }>()).results;
    if (rows[0]?.receipt) return 'healthy';
    return rows.length === 2 && rows.every(r => !r.receipt) ? 'failing' : 'unknown';
}

/** Bounded discovery. Returns signals plus IDs whose evidence is unknown this round (closed silently if absent). */
export async function photoSignals(db: D1Database, now: Date, input: PhotoAlertInput): Promise<{ signals: Signal[]; unknown: Set<string> }> {
    const time = now.getTime();
    const [posts, reviews, auth] = await db.batch([
        db.prepare(`SELECT ${POST_COLUMNS} FROM raffle_photo_auto_posts
            WHERE status IN ('queued','retry','processing','failed') AND created_at >= ? ORDER BY created_at DESC LIMIT 20`).bind(input.seasonStart),
        db.prepare(`${REVIEW_SELECT} WHERE i.status IN ('held','rejected','partial') AND i.updated_at >= ? ORDER BY i.updated_at DESC LIMIT 10`)
            .bind(new Date(time - REVIEW_WINDOW_MS).toISOString()),
        // Authoritative aggregate, not a sample: any unfinished post currently blocked by Graph access.
        db.prepare(`SELECT count(*) AS n, min(error_code) AS code FROM raffle_photo_auto_posts
            WHERE status IN ('queued','retry','processing') AND error_code IN (${AUTH_CODES.map(() => '?').join(',')})`).bind(...AUTH_CODES),
    ]);
    const signals: Signal[] = [], unknown = new Set<string>();
    const blocked = (auth.results[0] as { n: number; code: string | null } | undefined) ?? { n: 0, code: null };
    const pollAuth = input.pollError && AUTH_CODES.includes(input.pollError) ? input.pollError : null;
    if (pollAuth || blocked.n > 0) {
        signals.push({ id: 'photo:graph-auth', system: SYSTEM, threshold: 2,
            title: 'Facebook Graph access failing for winner photos',
            problem: 'The winner-photo Worker cannot read Facebook posts: its Page access token was rejected or lacks permission.',
            action: 'Check the Page access token and app permissions in Meta, rotate the Worker secret if expired, then confirm the next poll succeeds.',
            detail: { code: pollAuth ?? blocked.code ?? 'unknown', affectedPosts: blocked.n } });
    } else if (input.pollRan === false) unknown.add('photo:graph-auth');
    if (!input.webhookConfigured && input.automationEnabled) {
        signals.push({ id: 'photo:webhook-config', system: SYSTEM,
            title: 'Facebook webhook secret missing',
            problem: 'Signed Facebook webhooks are being refused because the active route has no app secret or verify token configured.',
            action: 'Restore the app secret and verify token Worker secrets for the active credential set. Polling continues as a fallback.',
            detail: {} });
    }
    const delivery: WebhookState = input.webhookConfigured && input.webhookDeliveryAlert ? await webhookDelivery(db, now) : 'unknown';
    if (delivery === 'failing') {
        signals.push({ id: 'photo:webhook-delivery', system: SYSTEM,
            title: 'Polling found the last two winner posts first',
            problem: `No signed Facebook webhook receipt was recorded for either of the last two winner announcements within ${WEBHOOK_GRACE_MS / 60_000} minutes; the polling fallback processed them. Webhook delivery or signature checks may be failing.`,
            action: 'In the Meta app dashboard, confirm the Page feed subscription is active and recent deliveries succeed; check the Worker log for webhook-bad-signature.',
            detail: {} });
    } else if (delivery === 'unknown') unknown.add('photo:webhook-delivery');
    for (const post of posts.results as PostRow[]) { const s = postSignal(post, now); if (s) signals.push(s); }
    for (const review of reviews.results as ReviewRow[]) { const s = reviewSignal(review, now); if (s) signals.push(s); }
    return { signals, unknown };
}

/** Active post/review incidents absent from the bounded discovery are re-read by primary key. */
export async function recheckActive(db: D1Database, records: IncidentRecord[], signals: Signal[], now: Date): Promise<{ signals: Signal[]; missing: Set<string> }> {
    const seen = new Set(signals.map(s => s.id)), out: Signal[] = [], missing = new Set<string>();
    const absent = records.filter(r => r.status !== 'resolved' && !seen.has(r.id));
    const posts = absent.filter(r => r.id.startsWith('photo:post:')).map(r => r.id.slice('photo:post:'.length));
    const photos = absent.filter(r => r.id.startsWith('photo:review:')).map(r => r.id.slice('photo:review:'.length));
    for (let i = 0; i < posts.length; i += 50) {
        const ids = posts.slice(i, i + 50);
        const rows = (await db.prepare(`SELECT ${POST_COLUMNS} FROM raffle_photo_auto_posts WHERE post_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<PostRow>()).results;
        for (const id of ids) {
            const row = rows.find(r => r.post_id === id);
            if (!row) { missing.add('photo:post:' + id); continue; } // Row removed: no basis for a recovery claim.
            const s = postSignal(row, now); if (s) out.push(s);
        }
    }
    for (let i = 0; i < photos.length; i += 50) {
        const ids = photos.slice(i, i + 50);
        const rows = (await db.prepare(`${REVIEW_SELECT} WHERE i.photo_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<ReviewRow>()).results;
        for (const row of rows) { const s = reviewSignal(row, now); if (s) out.push(s); }
    }
    return { signals: out, missing };
}

type IncidentRow = { incident_id: string; record_json: string };
// The exact stored JSON of each loaded record, used as the compare-and-set token on write.
const storedJson = new WeakMap<IncidentRecord, string>();
/** Every incident named by a current signal (any status) plus active ones. Over the active limit, unloaded incidents are
 * left untouched this round; they can never be recreated because signalled IDs are always loaded explicitly. */
export async function loadIncidents(db: D1Database, ids: string[]): Promise<IncidentRecord[]> {
    const byId = new Map<string, IncidentRecord>();
    const parse = (rows: IncidentRow[]) => { for (const r of rows) { try { const record = JSON.parse(r.record_json); storedJson.set(record, r.record_json); byId.set(r.incident_id, record); } catch { /* skip corrupt row */ } } };
    const active = (await db.prepare(`SELECT incident_id, record_json FROM ops_alert_incidents WHERE system=? AND status<>'resolved' ORDER BY first_seen_at LIMIT ?`)
        .bind(SYSTEM, ACTIVE_LOAD_LIMIT).all<IncidentRow>()).results;
    if (active.length >= ACTIVE_LOAD_LIMIT) console.log(JSON.stringify({ event: 'alerts-active-limit', system: SYSTEM, limit: ACTIVE_LOAD_LIMIT }));
    parse(active);
    const named = ids.filter(id => !byId.has(id));
    for (let i = 0; i < named.length; i += 50) {
        const chunk = named.slice(i, i + 50);
        parse((await db.prepare(`SELECT incident_id, record_json FROM ops_alert_incidents WHERE incident_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<IncidentRow>()).results);
    }
    return [...byId.values()];
}

/** Compare-and-set: a write applies only if the row still holds exactly what this run read (or, for a new incident,
 * does not exist). Concurrent cron runs therefore cannot both claim the same send. One D1 batch, one statement per write. */
export async function saveIncidents(db: D1Database, writes: Write[]): Promise<boolean[]> {
    if (!writes.length) return [];
    const results = await db.batch(writes.map(({ before, after: r }) => {
        const json = JSON.stringify(r), next = r.envelope?.nextAttemptAt ?? null;
        if (!before) return db.prepare(`INSERT INTO ops_alert_incidents (incident_id, system, status, first_seen_at, notified_at, next_delivery_at, record_json)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(incident_id) DO NOTHING`).bind(r.id, r.system, r.status, r.firstSeenAt, r.notifiedAt, next, json);
        return db.prepare(`UPDATE ops_alert_incidents SET system=?, status=?, first_seen_at=?, notified_at=?, next_delivery_at=?, record_json=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE incident_id=? AND record_json=?`)
            .bind(r.system, r.status, r.firstSeenAt, r.notifiedAt, next, json, r.id, storedJson.get(before) ?? JSON.stringify(before));
    }));
    return results.map(result => result.meta.changes === 1);
}

export async function preparePhotoAlerts(db: D1Database, now: Date, input: PhotoAlertInput): Promise<Prepared> {
    const discovered = await photoSignals(db, now, input);
    const records = await loadIncidents(db, discovered.signals.map(s => s.id));
    const rechecked = await recheckActive(db, records, discovered.signals, now);
    const signals = [...discovered.signals, ...rechecked.signals];
    const quiet = (id: string) => discovered.unknown.has(id) || rechecked.missing.has(id);
    // Rechecked signals may name incidents beyond the active limit; they are already loaded (they came from loaded records).
    return { signals, records, quiet };
}

export function evaluatePhotoAlerts(env: AlertEnv & { DB: D1Database }, now: Date, input: PhotoAlertInput, fetcher?: typeof fetch) {
    return runAlerts({ env, system: SYSTEM, now, fetcher, prepare: () => preparePhotoAlerts(env.DB, now, input), save: records => saveIncidents(env.DB, records) });
}
