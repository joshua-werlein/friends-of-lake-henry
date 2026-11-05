/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { extractCandidates, graphReader, GRAPH_PAGE_ID, PUBLIC_PAGE_ID, POST_FIELDS, PROBE_FIELDS } from '../facebook-live/graph';
import { downloadPhoto, extractPhotoCandidates } from '../facebook-live/photos';
import { sameSecret, validSignature, webhookLiveHint, webhookPostIds } from '../facebook-photos/webhook';

const APP_ID = '2349506929155471';
const CALLBACK = 'https://folh-sync-webhook-test.jjwerlein.workers.dev/facebook/webhook';
const REQUIRED_SCOPES = ['pages_manage_metadata', 'pages_read_engagement', 'pages_show_list', 'public_profile'];
const MAX_BODY = 256 * 1024;

type Secrets = {
    FB_APP_SECRET?: string;
    FB_PAGE_ACCESS_TOKEN?: string;
    FB_WEBHOOK_VERIFY_TOKEN?: string;
};

export default {
    async fetch(request: Request, env: Secrets): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== '/facebook/webhook') return new Response('Not found', { status: 404 });
        if (request.method === 'GET') {
            const challenge = url.searchParams.get('hub.challenge') ?? '';
            const token = url.searchParams.get('hub.verify_token') ?? '';
            if (!env.FB_WEBHOOK_VERIFY_TOKEN || url.searchParams.get('hub.mode') !== 'subscribe'
                || !/^[\w-]{1,200}$/.test(challenge) || !await sameSecret(token, env.FB_WEBHOOK_VERIFY_TOKEN)) {
                return new Response('Forbidden', { status: 403 });
            }
            console.log(JSON.stringify({ event: 'fohl-sync-verified', appId: APP_ID }));
            return new Response(challenge);
        }
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        if (!env.FB_APP_SECRET) return new Response('Unavailable', { status: 503 });
        const signature = request.headers.get('x-hub-signature-256');
        if (!/^sha256=[a-f0-9]{64}$/i.test(signature ?? '')) return new Response('Forbidden', { status: 403 });
        if (Number(request.headers.get('content-length')) > MAX_BODY) return new Response('Too large', { status: 413 });

        // Bound chunked bodies too. Verify the original bytes before parsing.
        const reader = request.body?.getReader();
        if (!reader) return new Response('Bad request', { status: 400 });
        const bytes = new Uint8Array(MAX_BODY);
        let length = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (length + value.byteLength > MAX_BODY) {
                    await reader.cancel();
                    return new Response('Too large', { status: 413 });
                }
                bytes.set(value, length);
                length += value.byteLength;
            }
        } finally {
            reader.releaseLock();
        }
        const body = bytes.buffer.slice(0, length);
        if (!await validSignature(env.FB_APP_SECRET, signature, body)) {
            console.log(JSON.stringify({ event: 'fohl-sync-bad-signature', appId: APP_ID }));
            return new Response('Forbidden', { status: 403 });
        }
        let payload;
        try { payload = JSON.parse(new TextDecoder().decode(body)); }
        catch { return new Response('Bad request', { status: 400 }); }
        const officialPage = payload?.object === 'page' && Array.isArray(payload.entry)
            && payload.entry.slice(0, 50).some((entry: { id?: unknown } | null) =>
                [GRAPH_PAGE_ID, PUBLIC_PAGE_ID].includes(String(entry?.id)));
        console.log(JSON.stringify({ event: 'fohl-sync-signed-received', appId: APP_ID, officialPage,
            photoRouteCandidates: webhookPostIds(payload).length, liveRouteCandidate: webhookLiveHint(payload) }));
        if (officialPage) {
            let remaining = 10;
            for (const entry of payload.entry.slice(0, 50)) {
                if (![GRAPH_PAGE_ID, PUBLIC_PAGE_ID].includes(String(entry?.id)) || !Array.isArray(entry.changes)) continue;
                for (const change of entry.changes.slice(0, 50)) {
                    const value = change?.value;
                    const match = typeof value?.post_id === 'string' && value.post_id.match(/^(\d{1,40})_(\d{1,40})$/);
                    if (change?.field !== 'feed' || !match || ![GRAPH_PAGE_ID, PUBLIC_PAGE_ID].includes(match[1])) continue;
                    console.log(JSON.stringify({ event: 'fohl-sync-page-feed', postId: `${GRAPH_PAGE_ID}_${match[2]}`,
                        item: ['status', 'post', 'photo', 'video', 'comment'].includes(value.item) ? value.item : 'other',
                        verb: ['add', 'edited', 'remove', 'delete'].includes(value.verb) ? value.verb : 'other' }));
                    if (--remaining === 0) return new Response('EVENT_RECEIVED');
                }
            }
        }
        return new Response('EVENT_RECEIVED');
    },
};

// Named service-binding entrypoint. The public fetch handler cannot call this probe.
export class SyncDiagnostics extends WorkerEntrypoint<Secrets> {
    async inspectPost(postId: string) {
        if (typeof postId !== 'string' || !new RegExp(`^${GRAPH_PAGE_ID}_\\d{1,40}$`).test(postId)) return { ok: false };
        const token = this.env.FB_PAGE_ACCESS_TOKEN;
        if (!token) return { ok: false };
        try {
            const post = await graphReader(token, new Date(), fetch, AbortSignal.timeout(20000))(postId, { fields: POST_FIELDS });
            if (post.id !== postId) return { ok: false };
            return { ok: true, postId, photos: extractPhotoCandidates([post], false).length,
                videos: extractCandidates([post], '', new Date()).length };
        } catch { return { ok: false }; }
    }

    async inspect() {
        const { FB_APP_SECRET: secret, FB_PAGE_ACCESS_TOKEN: token } = this.env;
        if (!secret || !token) return { ok: false, stage: 'credentials' };
        const app = graphReader(`${APP_ID}|${secret}`, new Date(), fetch, AbortSignal.timeout(20000));
        const page = graphReader(token, new Date(), fetch, AbortSignal.timeout(20000));
        let stage = 'token';
        try {
            const { data } = await app('debug_token', { input_token: token });
            const debug = data as Record<string, unknown> | undefined;
            const scopes = debug?.scopes;
            if (String(debug?.app_id) !== APP_ID || debug?.is_valid !== true || debug?.type !== 'PAGE'
                || !Array.isArray(scopes) || !REQUIRED_SCOPES.every(scope => scopes.includes(scope))) {
                return { ok: false, stage };
            }
            stage = 'page-identity';
            if ((await page('me', { fields: 'id' })).id !== GRAPH_PAGE_ID) return { ok: false, stage };
            stage = 'app-subscription';
            const appSubscriptions = await app(`${APP_ID}/subscriptions`, {});
            const appFeed = Array.isArray(appSubscriptions.data) && appSubscriptions.data.some(subscription =>
                subscription?.object === 'page' && subscription.active === true && subscription.callback_url === CALLBACK
                && Array.isArray(subscription.fields) && subscription.fields.some((field: unknown) =>
                    field === 'feed' || (field as { name?: string } | null)?.name === 'feed'));
            stage = 'page-subscription';
            const pageSubscriptions = await page(`${GRAPH_PAGE_ID}/subscribed_apps`, { fields: 'id,subscribed_fields' });
            const pageFeed = Array.isArray(pageSubscriptions.data) && pageSubscriptions.data.some(subscription =>
                String(subscription?.id) === APP_ID && subscription.subscribed_fields?.includes('feed'));
            stage = 'page-posts';
            const posts = await page(`${GRAPH_PAGE_ID}/published_posts`, { fields: 'id,created_time', limit: '5' });
            if (!Array.isArray(posts.data)) return { ok: false, stage };
            stage = 'photo-download';
            const { image, dimensions } = await downloadPhoto(page, fetch, '122333482004073310');
            stage = 'video-metadata';
            const video = await page('2008286453186547', { fields: PROBE_FIELDS });
            const pageOwned = (video.from as { id?: string } | undefined)?.id === GRAPH_PAGE_ID;
            const liveStatus = ['LIVE', 'LIVE_STOPPED', 'VOD'].includes(String(video.live_status)) ? video.live_status : 'unknown';
            return { ok: appFeed && pageFeed && pageOwned && video.id === '2008286453186547',
                appId: APP_ID, pageId: GRAPH_PAGE_ID, appFeed, pageFeed, postsRead: posts.data.length,
                photo: { bytes: image.bytes.byteLength, width: dimensions.width, height: dimensions.height },
                video: { pageOwned, liveStatus, published: video.published === true, embeddable: video.embeddable === true } };
        } catch {
            return { ok: false, stage };
        }
    }
}
