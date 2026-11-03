/// <reference types="@cloudflare/workers-types" />
// Unattended Facebook winner-photo publication. Deliberately a separate Worker (folh-facebook-winner-photos) so it
// can never replace folh-facebook-live-discovery, its DiscoveryScheduler Durable Object, migration or cron.
import { graphReader, GRAPH_PAGE_ID, isoTime } from '../facebook-live/graph';
import { inSeason, qualifies, pollDue, sameSecret, validSignature, webhookPostIds } from './webhook';
import { base64Image, downloadPhoto, extractPhotoCandidates, extractWinners } from '../facebook-live/photos';
import { PHOTO_MODEL, hashBytes, type Extraction } from '../../src/lib/raffle-photo-import';
import { chicagoDate, claimPost, decidePhoto, duePosts, enqueuePost, failPost, finishPost, loadContext,
    photoAlreadyFinal, recordPhotoFailure, validPostId, writeDecision } from '../../src/lib/server/raffle-photo-autopublish';

export type Env = {
    DB: D1Database;
    AI?: { run(model: string, input: unknown): Promise<unknown> };
    FB_PAGE_ACCESS_TOKEN?: string;     // secret
    FB_APP_SECRET?: string;            // secret: verifies X-Hub-Signature-256
    FB_WEBHOOK_VERIFY_TOKEN?: string;  // secret: echoed by Meta during subscription
    FB_PHOTO_AUTOMATION_ENABLED?: string; // master switch for webhook processing and polling
    FB_PHOTO_AUTOPUBLISH?: string;        // "false" records decisions as held without inserting winners
    FB_PHOTO_POLL_ENABLED?: string;       // polling fallback when webhooks are unavailable
    FB_PHOTO_EXTRACTION_PASSES?: string;  // independent AI reads that must agree (1-3)
    FB_RAFFLE_MARKER?: string;
    FB_SEASON_START?: string;
    FB_SEASON_END?: string;
};
type Fetcher = typeof fetch;

const POST_FIELDS = 'id,message,created_time,attachments{type,target,url,subattachments{type,target,url,subattachments{type,target,url}}}';
const MAX_POST_AGE_MS = 3 * 86400000;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const log = (event: string, detail: Record<string, string | number | boolean> = {}) => console.log(JSON.stringify({ event, ...detail }));
const enabled = (env: Env) => env.FB_PHOTO_AUTOMATION_ENABLED === 'true';

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext, fetcher: Fetcher) {
    if (request.method === 'GET') {
        const url = new URL(request.url), challenge = url.searchParams.get('hub.challenge') ?? '';
        const token = url.searchParams.get('hub.verify_token') ?? '';
        if (url.searchParams.get('hub.mode') !== 'subscribe' || !env.FB_WEBHOOK_VERIFY_TOKEN || !/^[\w-]{1,200}$/.test(challenge)
            || !(await sameSecret(token, env.FB_WEBHOOK_VERIFY_TOKEN))) return new Response('Forbidden', { status: 403 });
        log('webhook-verified');
        return new Response(challenge, { headers: { 'content-type': 'text/plain' } });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.FB_APP_SECRET) return new Response('Unavailable', { status: 503 });
    if (Number(request.headers.get('content-length')) > MAX_WEBHOOK_BYTES) return new Response('Too large', { status: 413 });
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_WEBHOOK_BYTES) return new Response('Too large', { status: 413 });
    if (!(await validSignature(env.FB_APP_SECRET, request.headers.get('x-hub-signature-256'), body))) {
        log('webhook-bad-signature');
        return new Response('Forbidden', { status: 403 });
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response('Bad request', { status: 400 }); }
    const ids = webhookPostIds(payload);
    // Durably queue before acknowledging; a D1 failure returns 500 so Meta redelivers. Redeliveries dedupe on post_id.
    const fresh: string[] = [];
    for (const id of ids) if (await enqueuePost(env.DB, id, 'webhook')) fresh.push(id);
    log('webhook-received', { posts: ids.length, queued: fresh.length });
    if (fresh.length && enabled(env)) ctx.waitUntil(drain(env, fetcher, new Date(), fresh));
    return new Response('EVENT_RECEIVED', { headers: { 'content-type': 'text/plain' } });
}

// ---- Processing ----
class Permanent extends Error {}

async function extractPasses(env: Env, bytes: Uint8Array, mime: string, announcementDate: string): Promise<Extraction[]> {
    const passes = Math.min(3, Math.max(1, Number(env.FB_PHOTO_EXTRACTION_PASSES) || 2));
    const out: Extraction[] = [], dataUrl = `data:${mime};base64,${base64Image(bytes)}`; // Encode once for all passes.
    for (let i = 0; i < passes; i++) {
        out.push(await extractWinners(env.AI!, dataUrl, mime, announcementDate.slice(0, 7), PHOTO_MODEL, announcementDate));
        if (i === 0 && !out[0].containsWinners) break; // A non-winner photo needs no confirmation pass.
    }
    return out;
}

/** `adminQueued` posts were chosen explicitly by an administrator, so caption and age filters are skipped;
 * every row still has to pass the same date-window, agreement and conflict checks. */
export async function processPost(env: Env, postId: string, fetcher: Fetcher, now = new Date(), adminQueued = false) {
    if (!env.FB_PAGE_ACCESS_TOKEN || !env.AI) throw Error('worker-not-configured');
    const get = graphReader(env.FB_PAGE_ACCESS_TOKEN, now, fetcher, AbortSignal.timeout(25000));
    const post = await get(postId, { fields: POST_FIELDS });
    if (post.id !== postId || !postId.startsWith(GRAPH_PAGE_ID + '_') || !isoTime(post.created_time)) throw new Permanent('identity-mismatch');
    const published = new Date(post.created_time);
    if (!inSeason(env, published) || (!adminQueued && (!qualifies(post.message, env.FB_RAFFLE_MARKER)
        || now.getTime() - published.getTime() > MAX_POST_AGE_MS))) return 'ignored';
    const photos = extractPhotoCandidates([post], false, now).slice(0, 4);
    if (!photos.length) return 'ignored';
    const announcementDate = chicagoDate(published);
    let outcome: 'done' | 'ignored' = 'ignored';
    for (const photo of photos) {
        if (await photoAlreadyFinal(env.DB, photo.photoId)) { outcome = 'done'; continue; }
        try {
            const { image, dimensions } = await downloadPhoto(get, fetcher, photo.photoId);
            const passes = await extractPasses(env, image.bytes, image.mime, announcementDate);
            const months = new Set([announcementDate.slice(0, 7), ...passes[0].rows.map(r => r.drawDate.slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m))]);
            const { existing, schedule } = await loadContext(env.DB, [...months]);
            const decision = decidePhoto(passes, existing, schedule, announcementDate);
            const status = await writeDecision(env.DB, { photoId: photo.photoId, postId, sha256: await hashBytes(image.bytes),
                width: dimensions.width, height: dimensions.height, model: PHOTO_MODEL, passes }, decision, env.FB_PHOTO_AUTOPUBLISH === 'true');
            log('photo-processed', { photoId: photo.photoId, status, inserted: decision.rows.filter(r => r.outcome === 'insert').length,
                rejected: decision.rows.filter(r => r.outcome === 'rejected').length });
            if (status !== 'ignored') outcome = 'done';
        } catch (e) {
            const code = e instanceof Error ? e.message.slice(0, 80) : 'unknown';
            await recordPhotoFailure(env.DB, photo.photoId, postId, code);
            throw e; // Retry the post; photos already finalized above are skipped next time.
        }
    }
    return outcome;
}

export async function drain(env: Env, fetcher: Fetcher, now = new Date(), only?: string[]) {
    const ids = only ?? await duePosts(env.DB, now);
    for (const id of ids) {
        if (!(await claimPost(env.DB, id, now))) continue;
        const source = await env.DB.prepare(`SELECT source FROM raffle_photo_auto_posts WHERE post_id=?`).bind(id).first<{ source: string }>();
        try { await finishPost(env.DB, id, await processPost(env, id, fetcher, now, source?.source === 'admin')); }
        catch (e) {
            const code = e instanceof Error ? e.message.slice(0, 80) : 'unknown';
            const retryAfter = Number((e as any)?.retryAfterSeconds) || 0;
            await failPost(env.DB, id, code, now, retryAfter, e instanceof Permanent);
            log('post-failed', { postId: id, code });
        }
    }
}

/** Fallback discovery with the Page token's already-working published_posts read; no webhook permissions needed. */
export async function poll(env: Env, fetcher: Fetcher, now = new Date()) {
    if (!env.FB_PAGE_ACCESS_TOKEN) return 0;
    const get = graphReader(env.FB_PAGE_ACCESS_TOKEN, now, fetcher, AbortSignal.timeout(25000));
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
            const { pathname } = new URL(request.url);
            if (pathname === '/facebook/webhook') return handleWebhook(request, env, ctx, fetcher);
            return new Response('Not found', { status: 404 });
        },
        async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
            const now = new Date(controller.scheduledTime);
            if (!enabled(env) || !inSeason(env, now)) return;
            ctx.waitUntil((async () => {
                if (env.FB_PHOTO_POLL_ENABLED === 'true' && pollDue(now)) {
                    try { log('poll', { queued: await poll(env, fetcher, now) }); }
                    catch (e) { log('poll-failed', { code: e instanceof Error ? e.message.slice(0, 80) : 'unknown' }); }
                }
                // Posts queued by this tick's poll are stamped after scheduledTime; drain against the real clock.
                await drain(env, fetcher, new Date(Math.max(now.getTime(), Date.now())));
            })());
        },
    };
}
export default createWorker();
