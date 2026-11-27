/// <reference types="@cloudflare/workers-types" />
// Unattended Facebook winner-photo publication. Deliberately a separate Worker (folh-facebook-winner-photos) so it
// can never replace folh-facebook-live-discovery, its DiscoveryScheduler Durable Object, migration or cron.
import { graphReader, GRAPH_PAGE_ID, isoTime } from '../facebook-live/graph';
import { pageAccessToken, usesFohlSync, type FacebookCredentials } from '../facebook-live/credentials';
import { inSeason, qualifies, pollDue, alertsDue, sameSecret, validSignature, webhookPostIds, webhookLiveHint, webhookLiveEvents, liveEventSummary } from './webhook';
import { downloadPhoto, extractPhotoCandidates } from '../facebook-live/photos';
import { PHOTO_MODEL, hashBytes } from '../../src/lib/raffle-photo-import';
import { chicagoDate, claimPost, decidePhoto, duePosts, enqueuePost, failPost, finishPost, loadContext, photoFinalStatus, recordAttempts, recordPhotoFailure,
    removedAutoWinners, rowDiagnostics, sanitizeCode, validPostId, writeDecision, townCorrectionTargets, confirmTownCorrections, monthCorrections, writeMonthScan, queueMonthScan, nextMonthScan, startMonthScan, finishMonthScan, decidedReads, type MonthScanMode,
    type PublicationSummary } from '../../src/lib/server/raffle-photo-autopublish';
import { extractPasses, extractMonthPasses, keepReads, readableImage, readDates, rereadTownCells, PHOTO_LEASE_SECONDS, QuotaExhausted, type ReadEnv, type StoredRead } from './reads';
import { evaluatePhotoAlerts, recordWebhookReceipts } from './alerts';
import type { AlertEnv } from '../../src/lib/server/alerts';
import { configureSeason } from '../../src/lib/server/raffle-season';
import { monthCalendar } from '../../src/lib/server/raffle-prizes';

export type Env = FacebookCredentials & AlertEnv & ReadEnv & {
    DB: D1Database;
    FACEBOOK_LIVE?:{notify(id:string,events?:unknown[]):Promise<unknown>;recordDiagnostic?(value:unknown):Promise<unknown>};
    FACEBOOK_READS?: { read(path:string,params:Record<string,string>):Promise<Record<string,unknown>> };
    FB_APP_SECRET?: string;            // secret: verifies X-Hub-Signature-256
    FB_WEBHOOK_VERIFY_TOKEN?: string;  // secret: echoed by Meta during subscription
    FOHL_SYNC_APP_SECRET?: string;
    FOHL_SYNC_WEBHOOK_VERIFY_TOKEN?: string;
    FB_PHOTO_AUTOMATION_ENABLED?: string; // master switch for webhook processing and polling
    FB_PHOTO_AUTOPUBLISH?: string;        // "false" records decisions as held without inserting winners
    FB_PHOTO_POLL_ENABLED?: string;       // polling fallback when webhooks are unavailable
    FB_PHOTO_EXTRACTION_PASSES?: string;  // differently instructed AI reads that must agree (2-3)
    FB_PHOTO_MONTH_SCAN?: string;         // month-wide hometown scan: unset/"true" corrects, "report" only shows, "false" is off
    FB_RAFFLE_MARKER?: string;
    FB_SEASON_START?: string;
    FB_SEASON_END?: string;
    ALERT_WEBHOOK_DELIVERY_ENABLED?: string; // receipt-based webhook-delivery alert; default off
};
const trackReceipts = (env: Env) => env.ALERTS_ENABLED === 'true' && env.ALERT_WEBHOOK_DELIVERY_ENABLED === 'true';
type Fetcher = typeof fetch;

const POST_FIELDS = 'id,message,created_time,attachments{type,target,url,subattachments{type,target,url,subattachments{type,target,url}}}';
const MAX_POST_AGE_MS = 3 * 86400000;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const log = (event: string, detail: Record<string, string | number | boolean> = {}) => console.log(JSON.stringify({ event, ...detail }));
const enabled = (env: Env) => env.FB_PHOTO_AUTOMATION_ENABLED === 'true';

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext, syncRoute: boolean) {
    const receivedAt = Date.now();
    const verifyToken = syncRoute ? env.FOHL_SYNC_WEBHOOK_VERIFY_TOKEN : env.FB_WEBHOOK_VERIFY_TOKEN;
    const appSecret = syncRoute ? env.FOHL_SYNC_APP_SECRET : env.FB_APP_SECRET;
    if (request.method === 'GET') {
        const url = new URL(request.url), challenge = url.searchParams.get('hub.challenge') ?? '';
        const token = url.searchParams.get('hub.verify_token') ?? '';
        if (url.searchParams.get('hub.mode') !== 'subscribe' || !verifyToken || !/^[\w-]{1,200}$/.test(challenge)
            || !(await sameSecret(token, verifyToken))) return new Response('Forbidden', { status: 403 });
        log('webhook-verified');
        return new Response(challenge, { headers: { 'content-type': 'text/plain' } });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!appSecret) return new Response('Unavailable', { status: 503 });
    if (Number(request.headers.get('content-length')) > MAX_WEBHOOK_BYTES) return new Response('Too large', { status: 413 });
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_WEBHOOK_BYTES) return new Response('Too large', { status: 413 });
    if (!(await validSignature(appSecret, request.headers.get('x-hub-signature-256'), body))) {
        log('webhook-bad-signature');
        return new Response('Forbidden', { status: 403 });
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response('Bad request', { status: 400 }); }
    const ids = webhookPostIds(payload);
    const liveHint = webhookLiveHint(payload);
    const activeRoute = syncRoute === usesFohlSync(env);
    log('webhook-signature-accepted', { syncRoute, activeRoute, posts: ids.length, liveHint });
    if (!activeRoute) return new Response('EVENT_RECEIVED');
    // Independent, best-effort capture also survives photo D1 failures. Never records the payload.
    const liveEventId=env.FACEBOOK_LIVE&&liveHint?await hashBytes(new Uint8Array(body)):null;
    const diagnostic=(value:Record<string,unknown>)=>{
        if(!env.FACEBOOK_LIVE?.recordDiagnostic)return;
        ctx.waitUntil(Promise.resolve().then(()=>env.FACEBOOK_LIVE!.recordDiagnostic!({eventRef:liveEventId?.slice(0,12),...value})).catch(()=>{}));
    };
    if(liveEventId) diagnostic({stage:'webhook-received',at:receivedAt,receivedAt});
    // Receipt evidence for the webhook-delivery alert, separate from queue ownership. Best effort; never blocks the queue.
    if (trackReceipts(env)) await recordWebhookReceipts(env.DB, ids, new Date(receivedAt));
    // Durably queue before acknowledging; a D1 failure returns 500 so Meta redelivers. Redeliveries dedupe on post_id.
    const fresh: string[] = [];
    try { for (const id of ids) if (await enqueuePost(env.DB, id, 'webhook')) fresh.push(id); }
    catch(error){if(liveEventId)diagnostic({stage:'webhook-forward',at:Date.now(),receivedAt,accepted:false,status:'queue-failed'});throw error;}
    if(env.FACEBOOK_LIVE && liveHint) {
        const id=liveEventId!;
        // Timing correlation: eventRef is the first 12 hex of the body hash the Live coordinator logs too.
        const forwardAt = Date.now();
        try {
            // Signed Live/video facts (IDs, codes, key names) ride along as evidence; a Live Worker without support ignores them.
            let events: ReturnType<typeof webhookLiveEvents> = [];
            try { events = webhookLiveEvents(payload); } catch { /* Evidence is optional; forwarding the hint never depends on it. */ }
            log('webhook-live-events', { eventRef: id.slice(0, 12), count: events.length, facts: liveEventSummary(events) });
            const result = await env.FACEBOOK_LIVE.notify(id, events) as { accepted?: boolean } | undefined;
            log('webhook-live-forwarded', { eventRef: id.slice(0, 12), receivedAt: new Date(receivedAt).toISOString(), queueMs: forwardAt - receivedAt,
                notifyMs: Date.now() - forwardAt, accepted: result?.accepted === true });
            diagnostic({stage:'webhook-forward',at:Date.now(),receivedAt,forwardAt,queueMs:forwardAt-receivedAt,notifyMs:Date.now()-forwardAt,accepted:result?.accepted===true});
        }
        catch {
            log('webhook-live-forward-failed', { eventRef: id.slice(0, 12), receivedAt: new Date(receivedAt).toISOString(), notifyMs: Date.now() - forwardAt });
            diagnostic({stage:'webhook-forward',at:Date.now(),receivedAt,forwardAt,queueMs:forwardAt-receivedAt,notifyMs:Date.now()-forwardAt,accepted:false,status:'forward-failed'});
            return new Response('Retry event delivery',{status:503});
        }
    }
    log('webhook-received', { posts: ids.length, queued: fresh.length });
    // Queued posts are processed by the two-minute cron; AI extraction outlasts the webhook's post-response waitUntil budget.
    return new Response('EVENT_RECEIVED', { headers: { 'content-type': 'text/plain' } });
}

// ---- Processing ----
function photoReader(env:Env, now:Date, fetcher:Fetcher) {
    const token = pageAccessToken(env);
    if (token) return graphReader(token, now, fetcher, AbortSignal.timeout(25000));
    const fallback = env.FACEBOOK_READS;
    if (usesFohlSync(env) || !fallback) throw Error('missing-token');
    return (path:string,params:Record<string,string>) => fallback.read(path,params);
}
class Permanent extends Error {}

// Photos already final on an earlier run report their stored status; this run's rows supply the counts.
function summaryFor(statuses: string[], counts: Omit<PublicationSummary, 'status' | 'photos'>): PublicationSummary {
    const has = (status: string) => statuses.includes(status);
    const published = counts.inserted > 0 || has('published') || has('partial');
    const rejected = counts.rejected > 0 || has('rejected'), held = counts.held > 0 || has('held');
    return { ...counts, photos: statuses.length, status: published && (rejected || held || has('partial')) ? 'partial' : published ? 'published'
        : rejected ? 'rejected' : held ? 'held' : counts.duplicate > 0 || has('duplicate') ? 'duplicate' : 'none' };
}

/** `adminQueued` posts were chosen explicitly by an administrator, so caption and age filters are skipped;
 * every row still has to pass the same date-window, agreement and conflict checks. */
export async function processPost(env: Env, postId: string, fetcher: Fetcher, now = new Date(), adminQueued = false, attempt: number | null = null): Promise<{ queue: 'done' | 'ignored'; publication?: PublicationSummary }> {
    if (!env.AI) throw Error('worker-not-configured');
    const get = photoReader(env, now, fetcher);
    const post = await get(postId, { fields: POST_FIELDS });
    if (post.id !== postId || !postId.startsWith(GRAPH_PAGE_ID + '_') || !isoTime(post.created_time)) throw new Permanent('identity-mismatch');
    const published = new Date(post.created_time);
    if (!inSeason(env, published) || (!adminQueued && (!qualifies(post.message, env.FB_RAFFLE_MARKER)
        || now.getTime() - published.getTime() > MAX_POST_AGE_MS))) return { queue: 'ignored' };
    const photos = extractPhotoCandidates([post], false, now).slice(0, 4);
    if (!photos.length) return { queue: 'ignored' };
    const announcementDate = chicagoDate(published);
    // No photo download or AI read until an administrator has approved this month's prize calendar: nothing could publish.
    // Requeue the post from admin after approval.
    if ((await monthCalendar(env.DB, announcementDate.slice(0, 7))).status !== 'approved') {
        log('calendar-not-approved', { postId, month: announcementDate.slice(0, 7) });
        return { queue: 'ignored' };
    }
    let queue: 'done' | 'ignored' = 'ignored';
    const statuses: string[] = [], counts = { inserted: 0, duplicate: 0, held: 0, rejected: 0, outsideWindow: 0 };
    for (const photo of photos) {
        const context = { postId, photoId: photo.photoId, attempt };
        const finalStatus = await photoFinalStatus(env.DB, photo.photoId);
        if (finalStatus) { queue = 'done'; statuses.push(finalStatus); continue; }
        try {
            const { image, dimensions } = await downloadPhoto(get, fetcher, photo.photoId);
            const sha256 = await hashBytes(image.bytes);
            const readable = await readableImage(env, image.bytes, image.mime, dimensions.width, context);
            const { passes, reads, aiCalls, reused, fallback } = await extractPasses(env, readable.bytes, readable.mime, announcementDate, context,
                { sha256, width: dimensions.width, height: dimensions.height }, readable.enlarged);
            const months = new Set([announcementDate.slice(0, 7), ...passes.flatMap(p => p.rows.map(r => r.drawDate.slice(0, 7))).filter(m => /^\d{4}-\d{2}$/.test(m))]);
            const { existing, schedule } = await loadContext(env.DB, [...months]);
            let decision = decidePhoto(passes, existing, schedule, announcementDate, { removedWinnerIds: await removedAutoWinners(env.DB, photo.photoId) });
            // Only a proposed hometown correction costs an extra AI call: one targeted re-read of that cell must confirm it.
            const targets = townCorrectionTargets(decision);
            if (targets.length) {
                const cells = await rereadTownCells(env, readable.bytes, readable.mime, context, { sha256, width: dimensions.width, height: dimensions.height }, readable.enlarged, targets, reads);
                decision = confirmTownCorrections(decision, cells.results);
                log('town-corrections', { ...context, attempt: attempt ?? 0, proposed: targets.length, confirmed: decision.rows.filter(r => r.outcome === 'correct').length,
                    aiCalls: cells.aiCalls, reused: cells.reused });
            }
            // The stored extraction keeps every read with its kind, dates, prompt version and token usage.
            const status = await writeDecision(env.DB, { photoId: photo.photoId, postId, sha256,
                width: dimensions.width, height: dimensions.height, model: PHOTO_MODEL, passes: reads }, decision, env.FB_PHOTO_AUTOPUBLISH === 'true');
            const estNeurons = Math.round(reads.reduce((n, r) => n + (r.read.usage?.estNeurons ?? 0), 0));
            log('photo-ai-usage', { ...context, attempt: attempt ?? 0, aiCalls, reused, fallback: fallback ?? 'none', estNeurons });
            // Stored outcomes, not the plan: a row can lose a race with manual entry during the write.
            const stored = (await env.DB.prepare(`SELECT outcome, count(*) AS n FROM raffle_photo_auto_rows WHERE photo_id=? GROUP BY outcome`).bind(photo.photoId).all<{ outcome: string; n: number }>()).results;
            const stat = (o: string) => stored.find(r => r.outcome === o)?.n ?? 0;
            counts.inserted += stat('inserted'); counts.duplicate += stat('duplicate'); counts.held += stat('held'); counts.rejected += stat('rejected'); counts.outsideWindow += stat('outside-window');
            statuses.push(status);
            const rows = decision.rows.map(rowDiagnostics);
            log('photo-processed', { ...context, attempt: attempt ?? 0, status, plannedInserts: decision.rows.filter(r => r.outcome === 'insert').length,
                decisionRejections: decision.rows.filter(r => r.outcome === 'rejected').length, decisionHolds: decision.rows.filter(r => r.outcome === 'held').length,
                imageReasons: decision.reasons.length });
            for (const row of rows) console.log(JSON.stringify({ event: 'row-decision', ...context, ...row }));
            await recordAttempts(env.DB, [{ ...context, stage: 'photo', outcome: status, detail: { imageReasons: decision.reasons.map(r => sanitizeCode(r.split(':')[0])),
                aiCalls, reused, fallback, estNeurons } },
                ...rows.map(r => ({ ...context, stage: 'row' as const, rowNumber: r.rowNumber, outcome: r.outcome, detail: r }))]);
            // Tonight's winners are stored. The rest of the month is checked for hometowns in a later cron invocation (runMonthScan), so
            // the scan's reads and CPU are never added to this one, and it can never fail, retry or delay a post or the queue alerts.
            if (status !== 'ignored' && !fallback && passes.some(p => p.containsWinners) && env.FB_PHOTO_MONTH_SCAN !== 'false'
                && readDates(announcementDate)[0] > announcementDate.slice(0, 8) + '01') {
                try { await queueMonthScan(env.DB, { photoId: photo.photoId, postId, announcementDate, windowProposed: targets.length }); }
                catch (e) { log('month-scan-queue-failed', { ...context, attempt: attempt ?? 0, code: sanitizeCode(e) }); }
            }
            if (status !== 'ignored') queue = 'done';
        } catch (e) {
            const code = sanitizeCode(e);
            await recordPhotoFailure(env.DB, photo.photoId, postId, code);
            await recordAttempts(env.DB, [{ ...context, stage: 'photo', outcome: 'failed', code }]);
            throw e; // Retry the post; photos already finalized above are skipped next time.
        }
    }
    return { queue, publication: summaryFor(statuses, counts) };
}

/**
 * Month-wide hometown verification of one decided photo, in a cron invocation that processed no post: the oldest queued scan is taken
 * atomically (startMonthScan; an overlapping invocation gets false and reads nothing), the photo is downloaded again and must be the
 * same image that was decided, then two whole-table reads, monthCorrections, a targeted re-read per proposal and writeMonthScan
 * (corrections; conflicts shown once in Photo imports without review or alert). The window decision's proposals for this photo count
 * against the shared correction limit. No AI read starts after `deadline`. Every failure is logged and swallowed, and the scan is never
 * retried: publication is long complete and the next announcement's table is scanned again.
 */
const MONTH_SCAN_MAX_AGE_MS = 12 * 3600_000; // a scan still queued after this (no idle tick before the season ended) is dropped
async function runMonthScan(env: Env, fetcher: Fetcher, now: Date, deadline: number) {
    const next = await nextMonthScan(env.DB);
    if (!next) return false;
    const context = { postId: next.postId, photoId: next.photoId, attempt: null }, mode: MonthScanMode = env.FB_PHOTO_MONTH_SCAN === 'report' ? 'report' : 'correct';
    if (!(await startMonthScan(env.DB, next.photoId))) { log('month-scan-skipped', { ...context, attempt: 0, reason: 'taken-by-another-invocation' }); return false; }
    try {
        const stored = await decidedReads(env.DB, next.photoId);
        const age = now.getTime() - Date.parse(next.announcementDate + 'T23:59:59-06:00');
        if (!stored?.sha256 || age > MONTH_SCAN_MAX_AGE_MS) { await finishMonthScan(env.DB, next.photoId, 'not run: the photo or its queue entry is no longer current'); return true; }
        const get = photoReader(env, now, fetcher);
        const { image, dimensions } = await downloadPhoto(get, fetcher, next.photoId);
        const sha256 = await hashBytes(image.bytes);
        if (sha256 !== stored.sha256) { await finishMonthScan(env.DB, next.photoId, 'not run: Facebook now serves a different image than the one decided'); return true; }
        const readable = await readableImage(env, image.bytes, image.mime, dimensions.width, context);
        const info = { sha256, width: dimensions.width, height: dimensions.height }, reads = stored.reads as StoredRead[];
        const month = await extractMonthPasses(env, readable.bytes, readable.mime, next.announcementDate, context, info, readable.enlarged, reads, deadline);
        if (!month.passes) { await finishMonthScan(env.DB, next.photoId, 'the whole-table reads did not complete; the next announcement is checked again'); return true; }
        const { existing, schedule } = await loadContext(env.DB, [next.announcementDate.slice(0, 7)]);
        let found = monthCorrections(month.passes, existing, schedule, next.announcementDate, readDates(next.announcementDate), next.windowProposed);
        const targets = townCorrectionTargets(found);
        let cellCalls = 0;
        if (targets.length) {
            const cells = await rereadTownCells(env, readable.bytes, readable.mime, context, info, readable.enlarged, targets, reads, deadline);
            cellCalls = cells.aiCalls;
            found = confirmTownCorrections(found, cells.results);
            await keepReads(env.DB, next.photoId, info, reads);
        }
        const written = await writeMonthScan(env.DB, next.photoId, found, mode, env.FB_PHOTO_AUTOPUBLISH === 'true');
        await finishMonthScan(env.DB, next.photoId, `${month.passes[0].rows.length} cells read; ${written.corrected} hometown(s) corrected; ${written.shown} new conflict(s) shown`
            + (mode === 'report' ? ' (report-only mode)' : ''));
        log('month-scan', { ...context, attempt: 0, mode, aiCalls: month.aiCalls + cellCalls, reused: month.reused, proposed: targets.length, windowProposed: next.windowProposed,
            corrected: written.corrected, shown: written.shown, estNeurons: Math.round(reads.filter(r => r.read.kind !== 'window').reduce((n, r) => n + (r.read.usage?.estNeurons ?? 0), 0)) });
        await recordAttempts(env.DB, found.rows.map(d => ({ ...context, stage: 'row' as const, rowNumber: null, outcome: d.outcome === 'correct' ? 'month-correct' : 'month-conflict',
            detail: rowDiagnostics(d) })));
    } catch (e) {
        log('month-scan-failed', { ...context, attempt: 0, code: sanitizeCode(e) });
        try { await finishMonthScan(env.DB, next.photoId, `stopped (${sanitizeCode(e)}); the next announcement is checked again`); } catch { /* diagnostics only */ }
    }
    return true;
}

// Cloudflare ends a scheduled invocation after 15 minutes of wall time. A month-end whole-table read takes about 2 minutes, so no
// month-scan AI read starts later than 8 minutes into the invocation.
const MONTH_SCAN_DEADLINE_MS = 8 * 60_000; // not exported: a Worker entry module may export only handlers and entrypoints
export async function drain(env: Env, fetcher: Fetcher, now = new Date(), only?: string[]) {
    const started = Date.now();
    const ids = only ?? await duePosts(env.DB, now);
    const processed = await drainPosts(env, fetcher, now, ids);
    // A tick that processed a post does nothing else, so a scan never shares an invocation (CPU, wall time) with a publication.
    if (!processed && !only && env.FB_PHOTO_MONTH_SCAN !== 'false') await runMonthScan(env, fetcher, now, started + MONTH_SCAN_DEADLINE_MS);
}
async function drainPosts(env: Env, fetcher: Fetcher, now: Date, ids: string[]) {
    let processed = 0;
    for (const [index, id] of ids.entries()) {
        if (!(await claimPost(env.DB, id, now, PHOTO_LEASE_SECONDS))) continue;
        processed++;
        const claimed = await env.DB.prepare(`SELECT source, attempts FROM raffle_photo_auto_posts WHERE post_id=?`).bind(id).first<{ source: string; attempts: number }>();
        const attempt = claimed?.attempts ?? 1;
        try {
            const result = await processPost(env, id, fetcher, now, claimed?.source === 'admin', attempt);
            await finishPost(env.DB, id, result.queue, result.publication, attempt);
            // Queue completion and winner publication are separate facts.
            log('post-finished', { postId: id, attempt: attempt ?? 0, queue: result.queue, publication: result.publication?.status ?? 'none', inserted: result.publication?.inserted ?? 0,
                duplicate: result.publication?.duplicate ?? 0, held: result.publication?.held ?? 0, rejected: result.publication?.rejected ?? 0 });
            await recordAttempts(env.DB, [{ postId: id, attempt, stage: 'post', outcome: result.queue, code: result.publication?.status ?? 'none', detail: result.publication ?? {} }]);
        } catch (e) {
            const code = sanitizeCode(e);
            const retryAfter = Number((e as any)?.retryAfterSeconds) || 0, quota = e instanceof QuotaExhausted;
            await failPost(env.DB, id, code, attempt, now, retryAfter, e instanceof Permanent, quota);
            log('post-failed', { postId: id, attempt: attempt ?? 0, code, retryAfterSeconds: retryAfter, quota });
            await recordAttempts(env.DB, [{ postId: id, attempt, stage: 'post', outcome: 'failed', code, detail: { retryAfterSeconds: retryAfter, permanent: e instanceof Permanent, quota } }]);
            // Every other post would hit the same exhausted allocation; they keep their place in the queue for the next attempt.
            if (quota) { if (index < ids.length - 1) log('drain-stopped-quota', { skipped: ids.length - index - 1 }); break; }
        }
    }
    return processed;
}

/** Fallback discovery with the Page token's already-working published_posts read; no webhook permissions needed. */
export async function poll(env: Env, fetcher: Fetcher, now = new Date()) {
    if (!usesFohlSync(env) && !pageAccessToken(env) && !env.FACEBOOK_READS) return 0;
    const get = photoReader(env, now, fetcher);
    const body = await get(`${GRAPH_PAGE_ID}/published_posts`, { fields: POST_FIELDS, limit: '10' });
    if (!Array.isArray(body.data)) throw Error('invalid-response');
    let queued = 0;
    for (const post of body.data.slice(0, 10) as any[]) {
        if (!validPostId(post?.id) || !isoTime(post.created_time) || now.getTime() - Date.parse(post.created_time) > MAX_POST_AGE_MS
            || !qualifies(post.message, env.FB_RAFFLE_MARKER) || !extractPhotoCandidates([post], false, now).length) continue;
        if (await enqueuePost(env.DB, post.id, 'poll')) queued++;
    }
    return queued;
}

export function createWorker(fetcher: Fetcher = (...a) => fetch(...a)) {
    return {
        async fetch(request: Request, env: Env, ctx: ExecutionContext) {
            configureSeason(env);
            const { pathname } = new URL(request.url);
            if (pathname === '/facebook/webhook' || pathname === '/facebook/webhook/fohl-sync') {
                return handleWebhook(request, env, ctx, pathname.endsWith('/fohl-sync'));
            }
            return new Response('Not found', { status: 404 });
        },
        async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
            configureSeason(env);
            const now = new Date(controller.scheduledTime);
            if (!enabled(env) || !inSeason(env, now)) return;
            ctx.waitUntil((async () => {
                let pollError: string | null = null;
                const pollRan = env.FB_PHOTO_POLL_ENABLED === 'true' && pollDue(now);
                if (pollRan) {
                    try { log('poll', { queued: await poll(env, fetcher, now) }); }
                    catch (e) { pollError = sanitizeCode(e); log('poll-failed', { code: pollError }); }
                }
                // Posts queued by this tick's poll are stamped after scheduledTime; drain against the real clock.
                try { await drain(env, fetcher, new Date(Math.max(now.getTime(), Date.now()))); }
                finally {
                    // Alerts run after publication and never throw; evaluated on their own schedule to keep D1 reads low.
                    if (alertsDue(now)) {
                        const sync = usesFohlSync(env);
                        const result = await evaluatePhotoAlerts(env, new Date(Math.max(now.getTime(), Date.now())), {
                            webhookConfigured: sync ? !!env.FOHL_SYNC_APP_SECRET && !!env.FOHL_SYNC_WEBHOOK_VERIFY_TOKEN : !!env.FB_APP_SECRET && !!env.FB_WEBHOOK_VERIFY_TOKEN,
                            automationEnabled: enabled(env), pollError, pollRan, webhookDeliveryAlert: trackReceipts(env), seasonStart: new Date(Date.parse(env.FB_SEASON_START!)).toISOString() }, fetcher);
                        if (result.status !== 'disabled') log('alerts', { status: result.status, ...('changed' in result ? { changed: result.changed, open: result.open } : {}) });
                    }
                }
            })());
        },
    };
}
export default createWorker();

import { WorkerEntrypoint } from 'cloudflare:workers';
import { inspectGraph } from '../facebook-live/inspect';
export class PhotoDiagnostics extends WorkerEntrypoint<Env> { async inspect() { return inspectGraph(this.env); } async inspectPhoto(){
    const get=graphReader(pageAccessToken(this.env)??'',new Date(),fetch,AbortSignal.timeout(25000));
    const post=await get('144051422124740_122333284658073310',{fields:POST_FIELDS});
    const {image,dimensions}=await downloadPhoto(get,fetch,'122333284628073310');
    const queue=await this.env.DB.prepare('SELECT post_id,status,attempts,error_code FROM raffle_photo_auto_posts WHERE post_id=?').bind('144051422124740_122333284658073310').first();
    return {at:new Date().toISOString(),postMatches:post.id==='144051422124740_122333284658073310',photoId:'122333284628073310',bytes:image.bytes.length,mime:image.mime,width:dimensions.width,height:dimensions.height,sha256:await hashBytes(image.bytes),queue,ownTokenUsed:true};
} async webhookStatus(){
    const sync = usesFohlSync(this.env);
    return { configured: sync ? !!this.env.FOHL_SYNC_APP_SECRET && !!this.env.FOHL_SYNC_WEBHOOK_VERIFY_TOKEN
        : !!this.env.FB_APP_SECRET && !!this.env.FB_WEBHOOK_VERIFY_TOKEN, liveForwarding: !!this.env.FACEBOOK_LIVE };
} }
