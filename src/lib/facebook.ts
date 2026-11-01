/** Shared, network-free URL handling. Never resolves Facebook short links. */
export const FACEBOOK_PAGE_ID = "61552199315213";
export const FACEBOOK_GRAPH_PAGE_ID = '144051422124740';
export const FACEBOOK_API_VERSION = 'v26.0';
export const FACEBOOK_LIVE_CONTRACT = 'video-live-status-v1';
export const FACEBOOK_PAGE_VIDEOS_URL = `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/`;
export type LiveConfig = { latestVideoUrl: string | null; updatedAt: string | null };
export const RAFFLE_LIVE_KEY = "raffle_live";

export function normalizeFacebookVideoUrl(input: string, depth = 0): string | null {
    if (depth > 3 || input.length > 4096) return null;
    try {
        const url = new URL(input.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
        if (url.hostname === 'l.facebook.com' && url.pathname === '/l.php') {
            const wrapped = url.searchParams.get('u'); // already decoded once
            return wrapped ? normalizeFacebookVideoUrl(wrapped, depth + 1) : null;
        }
        if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname)) return null;
        const video = url.pathname.match(/^\/(?:[^/]+\/)?videos\/(\d+)\/?$/);
        const watch = /^\/(?:watch(?:\/live)?\/?|live\/?|video\.php)$/.test(url.pathname) ? url.searchParams.get('v') : null;
        const id = video?.[1] ?? (watch && /^\d+$/.test(watch) ? watch : null);
        if (id) return `${FACEBOOK_PAGE_VIDEOS_URL}${id}/`;
        const reel = url.pathname.match(/^\/reel\/(\d+)\/?$/);
        return reel ? `https://www.facebook.com/reel/${reel[1]}` : null;
    } catch { return null; }
}

export function parseLiveConfig(raw: string | null | undefined): LiveConfig {
    const empty = { latestVideoUrl: null, updatedAt: null };
    try {
        const value: unknown = JSON.parse(raw ?? 'null');
        if (!value || typeof value !== 'object') return empty;
        const record = value as Record<string, unknown>;
        return {
            latestVideoUrl: typeof record.latestVideoUrl === 'string'
                ? normalizeFacebookVideoUrl(record.latestVideoUrl) : null,
            updatedAt: typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
                ? record.updatedAt : null,
        };
    } catch { return empty; }
}

export function facebookEmbedSrc(videoUrl: string | null): string | null {
    const canonical = videoUrl ? normalizeFacebookVideoUrl(videoUrl) : null;
    if (!canonical) return null;
    return canonical.includes('/reel/')
        ? `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(canonical)}&show_text=0&width=500`
        : `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonical)}&show_text=0&adapt_container_width=true`;
}
