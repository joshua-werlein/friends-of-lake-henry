import {
    graphReader, extractCandidates, verifyVideo, GRAPH_PAGE_ID, PROBE_FIELDS,
    isoTime, LIVE_CONTRACT, PUBLIC_PAGE_ID, GRAPH_VERSION, type GraphResult, type Discovery,
} from './graph';
import { inDiscoveryWindow, drawingDate, liveDay, LIVE_RECENT_MS } from '../../src/lib/server/raffle-discovery-schedule';
import { dimensions } from '../../src/lib/video-presentation';

export type LiveDiscovery = Discovery & {
    origin: 'page-video-live-status';
    originStatus: 'LIVE' | 'LIVE_STOPPED';
    originObservedAt: string;
    drawingDate: string;
    formatProbe?: 'live' | 'replay';
};
export type PendingVideo = { videoId: string; publishedAt: string; reason: 'live-origin-unproven'; liveStatus: string };
export type VideoCheck = {videoId:string;liveStatus:string;published:boolean;embeddable:boolean;metadataVerified:boolean;originVerified:boolean};
export type LiveResult = GraphResult & { pending?: PendingVideo[]; checks?:VideoCheck[] };

/** A VOD label alone is insufficient. A replay may reuse only a prior, same-video Live observation. */
export function priorLiveOrigin(value: unknown, videoId: string, publishedAt: string, now: Date): LiveDiscovery | null {
    if (!value || typeof value !== 'object') return null;
    const previous = value as LiveDiscovery & {schemaVersion?:number;contract?:string;graphPageId?:string;publicPageId?:string;apiVersion?:string};
    return previous.schemaVersion===2 && previous.contract===LIVE_CONTRACT && previous.graphPageId===GRAPH_PAGE_ID && previous.publicPageId===PUBLIC_PAGE_ID && previous.apiVersion===GRAPH_VERSION && previous.videoId === videoId && previous.origin === 'page-video-live-status'
        && ['LIVE', 'LIVE_STOPPED'].includes(previous.originStatus)
        && previous.publishedAt === publishedAt && isoTime(previous.originObservedAt)
        && Date.parse(previous.originObservedAt) >= Date.parse(publishedAt)
        && Date.parse(previous.originObservedAt) <= now.getTime()
        && liveDay(new Date(previous.originObservedAt))
        && drawingDate(new Date(previous.originObservedAt)) === drawingDate(new Date(publishedAt))
        ? previous : null;
}

/** Page posts discover candidates; individual Graph metadata supplies identity, availability and Live evidence. */
export async function discoverLivestreams(options: {
    token: string; now?: Date; fetcher?: typeof fetch; prior?: unknown;
}): Promise<LiveResult> {
    const now = options.now ?? new Date();
    const get = graphReader(options.token, now, options.fetcher ?? fetch, AbortSignal.timeout(25000));
    let phase = 'identity';
    const checks:VideoCheck[]=[];
    try {
        const identity = await get(GRAPH_PAGE_ID, { fields: 'id' });
        if (identity.id !== GRAPH_PAGE_ID) return { ok: false, reason: 'identity-mismatch', detail: { phase } };
        phase = 'posts';
        const posts = await get(`${GRAPH_PAGE_ID}/published_posts`, {
            fields: 'id,created_time,attachments{type,target,url,subattachments{type,target,url}}', limit: '25',
        });
        if (!Array.isArray(posts.data)) return { ok: false, reason: 'invalid-response', detail: { phase } };
        // In the backup window: videos published in the window (unchanged). Outside it (signed webhook check): a same-day
        // video published within LIVE_RECENT_MS, so a stale Page video is never selected.
        const scheduled = inDiscoveryWindow(now);
        const candidates = extractCandidates(posts.data, '', now).filter(candidate =>
            (scheduled ? inDiscoveryWindow(new Date(candidate.publishedAt)) : now.getTime() - Date.parse(candidate.publishedAt) <= LIVE_RECENT_MS)
            && drawingDate(new Date(candidate.publishedAt)) === drawingDate(now)).slice(0, 8);
        const discoveries: LiveDiscovery[] = [];
        const pending: PendingVideo[] = [];
        for (const candidate of candidates) {
            phase = 'video';
            const metadata = await get(candidate.videoId, { fields: PROBE_FIELDS });
            const video = verifyVideo(candidate, metadata);
            const check:VideoCheck={videoId:candidate.videoId,liveStatus:['LIVE','LIVE_STOPPED','VOD'].includes(String(metadata.live_status))?String(metadata.live_status):'UNKNOWN',
                published:metadata.published===true,embeddable:metadata.embeddable===true,metadataVerified:!!video,originVerified:false};
            checks.push(check);
            if (!video) continue;
            const status = metadata.live_status;
            const prior = priorLiveOrigin(options.prior, candidate.videoId, candidate.publishedAt, now);
            if (status === 'LIVE' || status === 'LIVE_STOPPED') {
                check.originVerified=true;
                // Retain the first observed proof instead of manufacturing a new Live observation on replay polls.
                discoveries.push({ ...video, origin: 'page-video-live-status',
                    originStatus: prior?.originStatus ?? status,
                    originObservedAt: prior?.originObservedAt ?? now.toISOString(),
                    drawingDate: drawingDate(new Date(candidate.publishedAt))! });
            } else if (status === 'VOD' && prior) {
                check.originVerified=true;
                discoveries.push({ ...video, origin: prior.origin, originStatus: prior.originStatus,
                    originObservedAt: prior.originObservedAt, drawingDate: prior.drawingDate });
            } else {
                pending.push({ videoId: candidate.videoId, publishedAt: candidate.publishedAt,
                    reason: 'live-origin-unproven', liveStatus: video.liveStatus });
            }
        }
        // A second plausible broadcast/upload makes the drawing ambiguous: do not guess between them.
        if (discoveries.length > 1 || (discoveries.length && pending.length)) {
            return { ok: false, reason: 'ambiguous-livestream', pending, checks,
                detail: { phase: 'classification', candidates: discoveries.length + pending.length } };
        }
        const video = discoveries[0];
        if (video) {
            const prior = priorLiveOrigin(options.prior, video.videoId, video.publishedAt, now);
            const phase = video.liveStatus === 'VOD' ? 'replay' : 'live';
            video.formatProbe = prior?.formatProbe;
            if (prior?.width && prior.height && prior.source) {
                Object.assign(video, { width: prior.width, height: prior.height, source: prior.source });
            } else if (!prior?.formatProbe || (phase === 'replay' && prior.formatProbe === 'live')) {
                // A format can appear only after replay processing. Retry once on that transition.
                video.formatProbe = phase;
                try {
                    const getFormat = graphReader(options.token, now, options.fetcher ?? fetch, AbortSignal.timeout(2500));
                    const format = await getFormat(video.videoId, { fields: 'id,format' });
                    if (format.id === video.videoId) Object.assign(video, dimensions(format) ?? {});
                } catch { /* Keep the existing layout fallback if Graph cannot provide dimensions. */ }
            }
        }
        return { ok: true, candidates: candidates.length, postsExamined: posts.data.length, discoveries, pending, checks };
    } catch (e) {
        const error = e as { reason?: any; retryAfterSeconds?: number; detail?: Record<string, string | number> };
        return { ok: false, reason: error.reason ?? 'api-failure', checks,
            ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
            detail: { phase, ...error.detail, at: now.toISOString(),
                category: e instanceof Error && e.name === 'AbortError' ? 'timeout' : error.reason ? 'graph-error' : 'transport-error' } };
    }
}
