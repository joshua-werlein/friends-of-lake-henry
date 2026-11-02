import { normalizeFacebookVideoUrl, FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_PAGE_ID, FACEBOOK_API_VERSION, FACEBOOK_LIVE_CONTRACT } from '../../src/lib/facebook';

export const GRAPH_PAGE_ID = FACEBOOK_GRAPH_PAGE_ID;
export const PUBLIC_PAGE_ID = FACEBOOK_PAGE_ID;
export const GRAPH_VERSION = FACEBOOK_API_VERSION;
export const LIVE_CONTRACT = FACEBOOK_LIVE_CONTRACT;
export const POST_FIELDS = 'id,message,created_time,permalink_url,attachments{type,target,url,subattachments{type,target,url}}';
// Hashtag policy selects eligible Page videos, not proof of broadcast origin or current streaming state.
export const PROBE_FIELDS = 'id,from,live_status,published,embeddable';
export type Failure = 'permission-denied' | 'token-expired' | 'rate-limited' | 'unsupported-contract'
    | 'api-failure' | 'invalid-response' | 'identity-mismatch';
export type Candidate = { postId: string; videoId: string; publishedAt: string };
export type Discovery = Candidate & { url: string; status: 'video'; liveStatus: 'LIVE' | 'VOD' | 'UNKNOWN' };
export type GraphResult = { ok: true; candidates: number; postsExamined: number; discoveries: Discovery[] }
    | { ok: false; reason: Failure; retryAfterSeconds?: number };
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
export const numericId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,40}$/.test(v);
export function isoTime(v: unknown): v is string {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(v)) return false;
    const time = Date.parse(v);
    return Number.isFinite(time) && new Date(v.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === v.slice(0, 10);
}
class GraphFailure extends Error {
    constructor(readonly reason: Failure, readonly retryAfterSeconds?: number) { super(reason); }
}

export function errorReason(code: unknown, httpStatus: number): Failure {
    if (code === 190 || code === 102) return 'token-expired';
    if (httpStatus === 429 || [4, 17, 32, 613, 80001, 80002, 80004].includes(Number(code))) return 'rate-limited';
    if ([10, 200, 283].includes(Number(code)) || httpStatus === 403) return 'permission-denied';
    if (code === 100) return 'unsupported-contract';
    return 'api-failure';
}

async function boundedJson(response: Response): Promise<unknown> {
    const limit = 512 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new GraphFailure('invalid-response');
    }
    if (!response.body) throw new GraphFailure('invalid-response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > limit) { await reader.cancel(); throw new GraphFailure('invalid-response'); }
            text += decoder.decode(part.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
    } catch (e) {
        if (e instanceof GraphFailure) throw e;
        throw new GraphFailure('invalid-response');
    } finally { reader.releaseLock(); }
}

function retryAfter(value: string | null, now: number): number | undefined {
    if (!value) return;
    const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, seconds) : undefined;
}

/** Only extracts candidates. Video attachments, captions and status_type never prove Live. */
export function extractCandidates(posts: unknown[], marker: string, now: Date): Candidate[] {
    const unique = new Map<string, Candidate>();
    for (const post of posts) {
        if (!record(post) || typeof post.id !== 'string' || !new RegExp(`^${GRAPH_PAGE_ID}_\\d+$`).test(post.id)
            || !isoTime(post.created_time) || Date.parse(post.created_time) > now.getTime() || now.getTime() - Date.parse(post.created_time) > 36 * 60 * 60 * 1000
            || typeof post.message !== 'string' || !post.message.split(/\s+/).includes(marker)) continue;
        const postId = post.id;
        const publishedAt = post.created_time;
        function visit(attachments: unknown, depth = 0) {
            if (depth > 2 || !record(attachments) || !Array.isArray(attachments.data)) return;
            for (const attachment of attachments.data.slice(0, 50)) {
                if (!record(attachment)) continue;
                const target = record(attachment.target) ? attachment.target : null;
                if (['video_inline', 'video_autoplay', 'video'].includes(String(attachment.type)) && target && numericId(target.id)) {
                    const rawUrl = typeof target.url === 'string' ? target.url : attachment.url;
                    const normalized = typeof rawUrl === 'string' ? normalizeFacebookVideoUrl(rawUrl) : null;
                    // Reels/share links/foreign links are not silently treated as live video.
                    if (normalized === `https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/${target.id}/`) {
                        const candidate = { postId, videoId: target.id, publishedAt };
                        const previous = unique.get(candidate.videoId);
                        if (!previous || Date.parse(candidate.publishedAt) < Date.parse(previous.publishedAt)) unique.set(candidate.videoId, candidate);
                    }
                }
                visit(attachment.subattachments, depth + 1);
            }
        }
        visit(post.attachments);
    }
    return [...unique.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

export function verifyVideo(candidate: Candidate, metadata: unknown): Discovery | null {
    if (!record(metadata) || metadata.id !== candidate.videoId || !record(metadata.from)
        || metadata.from.id !== GRAPH_PAGE_ID || metadata.published !== true || metadata.embeddable !== true
        ) return null;
    return { ...candidate, url: `https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/${candidate.videoId}/`,
        status: 'video', liveStatus: metadata.live_status === 'LIVE' ? 'LIVE' : metadata.live_status === 'VOD' ? 'VOD' : 'UNKNOWN' };
}

/** Shared read-only Graph transport for video and photo paths. Errors never expose API bodies. */
export function graphReader(token: string, now = new Date(), fetcher: typeof fetch = fetch, signal?: AbortSignal) {
    return async function get(path: string, params: Record<string, string>): Promise<RecordValue> {
        const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const response = await fetcher(url, { method: 'GET', redirect: 'error', cache: 'no-store',
            signal: signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        let body: unknown;
        try { body = await boundedJson(response); }
        catch (e) {
            if (!response.ok) throw new GraphFailure(errorReason(undefined, response.status), retryAfter(response.headers.get('retry-after'), now.getTime()));
            throw e;
        }
        if (!record(body)) throw new GraphFailure('invalid-response');
        if (!response.ok || body.error) {
            const error = record(body.error) ? body.error : {};
            throw new GraphFailure(errorReason(error.code, response.status), retryAfter(response.headers.get('retry-after'), now.getTime()));
        }
        return body;
    }
}

/** Shared bounded Page-post feed. Never follows a token-bearing paging URL. */
export async function readPagePosts(get: ReturnType<typeof graphReader>, fields = POST_FIELDS): Promise<unknown[]> {
        const posts: unknown[] = [];
        let after: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < 3; page++) {
            const body = await get(`${GRAPH_PAGE_ID}/published_posts`, { fields, limit: '25', ...(after ? { after } : {}) });
            if (!Array.isArray(body.data) || body.data.length > 100) throw new GraphFailure('invalid-response');
            posts.push(...body.data);
            const paging = record(body.paging) ? body.paging : null;
            if (!paging?.next) break;
            const cursor = record(paging.cursors) ? paging.cursors.after : null;
            if (typeof cursor !== 'string' || !cursor || cursor.length > 1024 || /[\x00-\x20]/.test(cursor) || cursors.has(cursor)) throw new GraphFailure('invalid-response');
            cursors.add(cursor);
            after = cursor; // Rebuild on fixed Graph host; paging.next may contain a token.
        }
        return posts;
}

/** Read-only Graph client. Never follows paging URLs or redirects; never logs raw API data. */
export async function discoverPosts(options: {
    token: string; marker: string; probeVideoMetadata?: boolean; now?: Date; fetcher?: typeof fetch;
}): Promise<GraphResult> {
    const now = options.now ?? new Date();
    const fetcher = options.fetcher ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const get = graphReader(options.token, now, fetcher, controller.signal);
    try {
        if (!options.token || !/^#[A-Za-z][A-Za-z0-9_]{2,80}$/.test(options.marker)) throw new GraphFailure('invalid-response');
        const identity = await get(GRAPH_PAGE_ID, { fields: 'id' });
        if (identity.id !== GRAPH_PAGE_ID) throw new GraphFailure('identity-mismatch');
        const posts = await readPagePosts(get);
        const candidates = extractCandidates(posts, options.marker, now).slice(0, 8);
        const discoveries: Discovery[] = [];
        if (options.probeVideoMetadata) {
            for (const candidate of candidates) {
                const video = verifyVideo(candidate, await get(candidate.videoId, { fields: PROBE_FIELDS }));
                if (video) discoveries.push(video);
            }
        }
        return { ok: true, candidates: candidates.length, postsExamined: posts.length, discoveries };
    } catch (e) {
        return e instanceof GraphFailure ? { ok: false, reason: e.reason, ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}) }
            : { ok: false, reason: 'api-failure' };
    } finally { clearTimeout(timer); }
}
