import { normalizeFacebookVideoUrl } from './facebook';

export type Orientation = 'portrait' | 'landscape';
export type Dimensions = { width: number; height: number; source: 'format' | 'thumbnail' };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// Administrator-verified Graph v26.0 format responses, November 1, 2026.
// Public dimensions only; no Facebook HTML, signed image URL or credentials.
const verifiedFormats: Record<string, Dimensions> = {
    '39756815320632328': { width: 720, height: 1280, source: 'format' },
    '1706736221227932': { width: 720, height: 1280, source: 'format' },
};
export function videoId(url: string | null): string | null {
    return url ? normalizeFacebookVideoUrl(url)?.match(/(?:videos\/|reel\/)(\d+)/)?.[1] ?? null : null;
}
function size(v: unknown, source: Dimensions['source']): Dimensions | null {
    if (!record(v) || !Number.isInteger(v.width) || !Number.isInteger(v.height)) return null;
    const width = Number(v.width), height = Number(v.height), ratio = width / height;
    return width >= 120 && height >= 120 && width <= 16384 && height <= 16384 && ratio >= .3 && ratio <= 3.5
        && Math.abs(ratio - 1) > .05 ? { width, height, source } : null;
}
/** Copy dimensions only. Never copy embed_html, thumbnail URLs or credentials. */
export function dimensions(metadata: unknown): Dimensions | null {
    if (!record(metadata)) return null;
    const formats = Array.isArray(metadata.format) ? metadata.format : [];
    const usable = formats.slice(0, 30).map(v => size(v, 'format')).filter((v): v is Dimensions => !!v)
        .sort((a, b) => b.width * b.height - a.width * a.height);
    // Conflicting format orientations are ambiguous, not a basis for automatic layout.
    if (usable.length && usable.every(v => (v.width > v.height) === (usable[0].width > usable[0].height))) return usable[0];
    if (usable.length) return null;
    const media = record(metadata.media) ? metadata.media : null;
    return size(media?.image, 'thumbnail');
}
export function presentation(url: string | null, value: unknown) {
    const id = videoId(url);
    const matches = id && record(value) && value.videoId === id;
    const override = matches && ['portrait', 'landscape'].includes(String(value.override)) ? value.override as Orientation : null;
    const d = matches ? size(value, value.source === 'thumbnail' ? 'thumbnail' : 'format') : null;
    return { orientation: override ?? (d ? d.width > d.height ? 'landscape' : 'portrait' : 'portrait'),
        source: override ? 'admin' : d?.source ?? 'fallback' };
}
export async function loadPresentation(store: { get(key: string): Promise<string | null> }, url: string | null, automatic?: unknown) {
    const id = videoId(url);
    if (!id) return presentation(url, null);
    try {
        const raw = await store.get(`raffle_video_presentation:${id}`);
        const saved: unknown = raw ? JSON.parse(raw) : null;
        if (record(saved) && saved.videoId === id && (saved.override === 'portrait' || saved.override === 'landscape' || size(saved, saved.source === 'thumbnail' ? 'thumbnail' : 'format'))) return presentation(url, saved);
    } catch { /* Layout failure must never interrupt playback. */ }
    return presentation(url, automatic ?? (verifiedFormats[id] ? { videoId: id, ...verifiedFormats[id] } : null));
}
