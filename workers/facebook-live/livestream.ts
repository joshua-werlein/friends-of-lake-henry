import {
    graphReader, verifyVideo, GRAPH_PAGE_ID, PROBE_FIELDS, numericId,
    isoTime, LIVE_CONTRACT, PUBLIC_PAGE_ID, GRAPH_VERSION, type GraphResult, type Discovery,
} from './graph';
import { normalizeFacebookVideoUrl } from '../../src/lib/facebook';
import { inDiscoveryWindow, drawingDate, liveDay, LIVE_RECENT_MS } from '../../src/lib/server/raffle-discovery-schedule';
import { dimensions } from '../../src/lib/video-presentation';
import { LIVE_EVENT_STATUSES, type LiveSignals, type StoredFact } from './live-events';
import type { LiveLookup } from './poller';

export type LiveDiscovery = Discovery & {
    origin: 'page-video-live-status';
    originStatus: 'LIVE' | 'LIVE_STOPPED';
    originObservedAt: string;
    drawingDate: string;
    formatProbe?: 'live' | 'replay';
    /** What proved Live origin. The `origin` field keeps its resolver-compatible value; this records the real source. */
    originEvidence?: 'graph-live-status' | 'signed-live-webhook';
    /** Signed-webhook origin only: how the event was tied to this exact video, and the webhook's body-hash reference. */
    originCorrelation?: 'event-video-id' | 'live-video-lookup';
    originEventRef?: string;
};
export type PendingVideo = { videoId: string; publishedAt: string; reason: 'live-origin-unproven'; liveStatus: string };
/** How the Page post linked the video. Diagnostic only: eligibility never depends on the link form alone. */
export type LinkForm = 'page-video' | 'reel' | 'other';
export type VideoCheck = {videoId:string;liveStatus:string;published:boolean;embeddable:boolean;metadataVerified:boolean;originVerified:boolean;form?:LinkForm;reason?:string};
/** Sanitized reason code -> count for every post or video that did not become a discovery. Never raw API data. */
export type Rejections = Record<string, number>;
export type LiveResult = GraphResult & { pending?: PendingVideo[]; checks?:VideoCheck[]; rejections?: Rejections; lookups?: LiveLookup[] };
/** Read-only LiveVideo lookups per check (only for signed live_videos events not yet tied to a video). */
export const LOOKUP_LIMIT = 2;
/** Lookup outcomes that will not change on retry (others, such as timeouts, are retried on a later check). */
const FINAL_LOOKUP = new Set(['mapped', 'no-video-field', 'id-mismatch', 'unsupported-contract', 'permission-denied']);
/** Video metadata reads per check (unchanged bound). At most EARLY_LIMIT of them are "early-post" candidates: in the
 * backup window, a Page video whose post time fails the time rule (a Live announced or scheduled in advance, or a post
 * Facebook dated before the broadcast). Those qualify only if the video itself (Graph Video created_time, the
 * broadcast's own start for a Live) satisfies the same time rule, never merely for being LIVE now. */
export const CANDIDATE_LIMIT = 8, EARLY_LIMIT = 3;
export type LiveCandidate = { postId: string; videoId: string; publishedAt: string; form: LinkForm };
const recordValue = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// Graph attachment types for Page videos: video, video_inline, video_autoplay, live_video, ... (never photo/album/share).
const VIDEO_TYPE = /(^|_)video(_|$)/;
/** Live discovery's metadata read: the shared PROBE_FIELDS plus the documented Video created_time. */
export const LIVE_PROBE_FIELDS = PROBE_FIELDS + ',created_time';
const count = (rejections: Rejections, reason: string) => { rejections[reason] = (rejections[reason] ?? 0) + 1; };

function linkForm(raw: unknown, videoId: string): LinkForm {
    const normalized = typeof raw === 'string' ? normalizeFacebookVideoUrl(raw) : null;
    if (normalized === `https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/${videoId}/`) return 'page-video';
    return normalized === `https://www.facebook.com/reel/${videoId}` ? 'reel' : 'other';
}

/** Live discovery's own extractor. The shared graph.extractCandidates keeps its exact-URL rule for the photo and sync
 * paths. Any Page-post video attachment with a numeric target ID qualifies, whatever its link form (/videos/, /reel/,
 * /watch, share links); ownership, availability and Live status are then proven from the video's own Graph metadata. */
export function extractLiveCandidates(posts: unknown[], now: Date, rejections: Rejections = {}): LiveCandidate[] {
    const unique = new Map<string, LiveCandidate>();
    for (const post of posts) {
        if (!recordValue(post) || typeof post.id !== 'string' || !new RegExp(`^${GRAPH_PAGE_ID}_\\d+$`).test(post.id) || !isoTime(post.created_time)) { count(rejections, 'invalid-post'); continue; }
        const time = Date.parse(post.created_time);
        if (time > now.getTime()) { count(rejections, 'future-post'); continue; }
        if (now.getTime() - time > 36 * 3600_000) { count(rejections, 'stale-post'); continue; }
        const postId = post.id, publishedAt = post.created_time;
        let found = false;
        const visit = (attachments: unknown, depth = 0) => {
            if (depth > 2 || !recordValue(attachments) || !Array.isArray(attachments.data)) return;
            for (const attachment of attachments.data.slice(0, 50)) {
                if (!recordValue(attachment)) continue;
                const target = recordValue(attachment.target) ? attachment.target : null;
                if (VIDEO_TYPE.test(String(attachment.type)) && target && numericId(target.id)) {
                    found = true;
                    const candidate = { postId, videoId: target.id, publishedAt, form: linkForm(target.url ?? attachment.url, target.id) };
                    const previous = unique.get(candidate.videoId);
                    if (!previous || Date.parse(candidate.publishedAt) < Date.parse(previous.publishedAt)) unique.set(candidate.videoId, candidate);
                }
                visit(attachment.subattachments, depth + 1);
            }
        };
        visit(post.attachments);
        if (!found) count(rejections, 'no-video-attachment');
    }
    return [...unique.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.videoId.localeCompare(b.videoId));
}

/** Why verified metadata disqualifies a video (ownership, identity, availability), or null when it passes. */
export function metadataRejection(videoId: string, metadata: unknown): string | null {
    if (!recordValue(metadata) || metadata.id !== videoId) return 'metadata-mismatch';
    if (!recordValue(metadata.from) || metadata.from.id !== GRAPH_PAGE_ID) return 'not-page-owned';
    if (metadata.published !== true) return 'unpublished';
    if (metadata.embeddable !== true) return 'not-embeddable';
    return null;
}

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
    token: string; now?: Date; fetcher?: typeof fetch; prior?: unknown; signals?: LiveSignals;
}): Promise<LiveResult> {
    const now = options.now ?? new Date();
    const get = graphReader(options.token, now, options.fetcher ?? fetch, AbortSignal.timeout(25000));
    let phase = 'identity';
    const checks:VideoCheck[]=[];
    const rejections: Rejections = {};
    const lookups: LiveLookup[] = [];
    try {
        const identity = await get(GRAPH_PAGE_ID, { fields: 'id' });
        if (identity.id !== GRAPH_PAGE_ID) return { ok: false, reason: 'identity-mismatch', detail: { phase } };
        phase = 'posts';
        const posts = await get(`${GRAPH_PAGE_ID}/published_posts`, {
            fields: 'id,created_time,attachments{type,target,url,subattachments{type,target,url}}', limit: '25',
        });
        if (!Array.isArray(posts.data)) return { ok: false, reason: 'invalid-response', detail: { phase } };
        // Time rule (unchanged): in the backup window, a time in the window; outside it (signed webhook check), a same-day
        // time within LIVE_RECENT_MS, so a stale Page video is never selected. It is applied to the post time and, for an
        // early post in the backup window, to the video's own creation (broadcast) time: either one qualifies.
        const scheduled = inDiscoveryWindow(now), today = drawingDate(now);
        const onTime = (at: string) => { const t = new Date(at);
            return (scheduled ? inDiscoveryWindow(t) : now.getTime() - t.getTime() <= LIVE_RECENT_MS) && t.getTime() <= now.getTime() && drawingDate(t) === today; };
        const timely: LiveCandidate[] = [], early: LiveCandidate[] = [];
        const previousVideo = recordValue(options.prior) && typeof options.prior.videoId === 'string' ? options.prior : null;
        for (const candidate of extractLiveCandidates(posts.data, now, rejections)) {
            if (onTime(candidate.publishedAt)) timely.push(candidate);
            else if (!scheduled) count(rejections, 'outside-time-window');
            // An earlier drawing's selected broadcast is never re-probed as a new one.
            else if (previousVideo?.videoId === candidate.videoId && previousVideo.drawingDate !== today) count(rejections, 'previous-drawing');
            else if (early.length < EARLY_LIMIT) early.push(candidate);
            else count(rejections, 'candidate-limit');
        }
        // Signed webhook facts from today (Release B). A feed video fact names the exact video before Page posts index it;
        // it joins as an early candidate (its video's own creation time must pass the time rule, in or out of the window).
        const facts = (options.signals?.facts ?? []).filter((f: StoredFact) => f.at <= now.getTime() && drawingDate(new Date(f.at)) === today);
        let webhookCandidates = 0;
        for (const f of facts) {
            if (f.field !== 'feed' || f.item !== 'video' || !f.videoId || webhookCandidates >= 2) continue;
            if ([...timely, ...early].some(c => c.videoId === f.videoId)) continue;
            if (previousVideo?.videoId === f.videoId && previousVideo.drawingDate !== today) continue;
            early.push({ postId: f.postId ?? `${GRAPH_PAGE_ID}_${f.videoId}`, videoId: f.videoId, publishedAt: new Date(f.at).toISOString(), form: 'other' });
            webhookCandidates++;
        }
        const candidates = [...timely, ...early].slice(0, CANDIDATE_LIMIT);
        for (let i = CANDIDATE_LIMIT; i < timely.length + early.length; i++) count(rejections, 'candidate-limit');
        // Signed live_videos events with a broadcast status. Origin needs an EXACT ID tie to a candidate video: the event's
        // own ID equals the video ID, or a read-only LiveVideo lookup returns that video ID. Timing never ties them.
        const liveEvents = facts.filter(f => f.field === 'live_videos' && f.id && LIVE_EVENT_STATUSES.has(f.status ?? ''));
        const mappings = { ...(options.signals?.mappings ?? {}) };
        const candidateIds = new Set(candidates.map(c => c.videoId));
        const unresolved = [...new Set(liveEvents.map(f => f.id!))].filter(id => !candidateIds.has(id)
            && !(mappings[id] && FINAL_LOOKUP.has(mappings[id].videoId ? 'mapped' : mappings[id].reason ?? ''))).slice(0, LOOKUP_LIMIT);
        if (unresolved.length) {
            const lookup = graphReader(options.token, now, options.fetcher ?? fetch, AbortSignal.timeout(3000));
            for (const liveId of unresolved) {
                let result: LiveLookup;
                try {
                    const body = await lookup(liveId, { fields: 'id,status,video' });
                    const video = recordValue(body.video) && numericId(body.video.id) ? body.video.id : null;
                    const st = typeof body.status === 'string' && /^[A-Za-z_]{1,40}$/.test(body.status) ? body.status.toLowerCase() : undefined;
                    result = body.id !== liveId ? { liveId, reason: 'id-mismatch' } : video ? { liveId, videoId: video, ...(st ? { status: st } : {}) } : { liveId, reason: 'no-video-field' };
                } catch (e) { result = { liveId, reason: String((e as { reason?: string }).reason ?? 'api-failure') }; }
                lookups.push(result);
                mappings[liveId] = { ...result, at: now.getTime() };
                count(rejections, result.videoId ? 'live-lookup-mapped' : 'live-lookup-' + result.reason);
            }
        }
        const correlatedEvent = (videoId: string) => liveEvents.find(f => f.id === videoId || mappings[f.id!]?.videoId === videoId);
        const discoveries: LiveDiscovery[] = [];
        const pending: PendingVideo[] = [];
        for (const candidate of candidates) {
            phase = 'video';
            const metadata = await get(candidate.videoId, { fields: LIVE_PROBE_FIELDS });
            const status = metadata.live_status;
            const check:VideoCheck={videoId:candidate.videoId,liveStatus:['LIVE','LIVE_STOPPED','VOD'].includes(String(status))?String(status):'UNKNOWN',
                published:metadata.published===true,embeddable:metadata.embeddable===true,metadataVerified:false,originVerified:false,form:candidate.form};
            checks.push(check);
            const refuse = (reason: string) => { check.reason = reason; count(rejections, reason); };
            const invalid = metadataRejection(candidate.videoId, metadata);
            if (invalid) { refuse(invalid); continue; }
            const isEarly = !timely.includes(candidate);
            const createdAt = isoTime(metadata.created_time) ? metadata.created_time : null;
            if (isEarly && !(createdAt && onTime(createdAt))) { refuse('outside-time-window'); continue; }
            // An early post's selection record carries the broadcast time: same day and no later than the first Live
            // observation, as the public resolver requires, and stable across polls for the replay continuity check.
            const publishedAt = isEarly ? createdAt! : candidate.publishedAt;
            const video = verifyVideo({ postId: candidate.postId, videoId: candidate.videoId, publishedAt }, metadata);
            if (!video) { refuse('metadata-mismatch'); continue; }
            check.metadataVerified = true;
            const prior = priorLiveOrigin(options.prior, candidate.videoId, publishedAt, now);
            if (status === 'LIVE' || status === 'LIVE_STOPPED') {
                check.originVerified=true;
                // Retain the first observed proof instead of manufacturing a new Live observation on replay polls.
                discoveries.push({ ...video, origin: 'page-video-live-status',
                    originStatus: prior?.originStatus ?? status,
                    originObservedAt: prior?.originObservedAt ?? now.toISOString(),
                    drawingDate: drawingDate(new Date(publishedAt))!, originEvidence: prior?.originEvidence ?? 'graph-live-status' });
            } else if (status === 'VOD' && prior) {
                check.originVerified=true;
                discoveries.push({ ...video, origin: prior.origin, originStatus: prior.originStatus,
                    originObservedAt: prior.originObservedAt, drawingDate: prior.drawingDate,
                    ...(prior.originEvidence ? { originEvidence: prior.originEvidence } : {}),
                    ...(prior.originCorrelation ? { originCorrelation: prior.originCorrelation, originEventRef: prior.originEventRef } : {}) });
            } else if (correlatedEvent(candidate.videoId)) {
                // Meta-signed live_videos event tied to this exact video ID: Live origin without Graph live_status.
                const event = correlatedEvent(candidate.videoId)!;
                check.originVerified = true; check.reason = 'signed-live-webhook';
                discoveries.push({ ...video, origin: 'page-video-live-status',
                    originStatus: prior?.originStatus ?? (event.status === 'live_stopped' ? 'LIVE_STOPPED' : 'LIVE'),
                    originObservedAt: prior?.originObservedAt ?? now.toISOString(),
                    drawingDate: drawingDate(new Date(publishedAt))!, originEvidence: 'signed-live-webhook',
                    originCorrelation: event.id === candidate.videoId ? 'event-video-id' : 'live-video-lookup', originEventRef: event.ref });
            } else if (candidate.form !== 'page-video') {
                // A Reel, share or other non-Page-video link with no Live evidence is an ordinary upload, not a drawing.
                // (Previously these were dropped by URL; they still never make the drawing ambiguous.)
                refuse('not-live-video');
            } else {
                check.reason = 'live-origin-unproven';
                count(rejections, 'live-origin-unproven');
                pending.push({ videoId: candidate.videoId, publishedAt,
                    reason: 'live-origin-unproven', liveStatus: video.liveStatus });
            }
        }
        if (liveEvents.length && !liveEvents.some(f => candidates.some(c => correlatedEvent(c.videoId) === f))) count(rejections, 'live-event-uncorrelated');
        // A second plausible broadcast/upload makes the drawing ambiguous: do not guess between them.
        if (discoveries.length > 1 || (discoveries.length && pending.length)) {
            return { ok: false, reason: 'ambiguous-livestream', pending, checks, rejections, lookups,
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
        return { ok: true, candidates: candidates.length, postsExamined: posts.data.length, discoveries, pending, checks, rejections, lookups };
    } catch (e) {
        const error = e as { reason?: any; retryAfterSeconds?: number; detail?: Record<string, string | number> };
        return { ok: false, reason: error.reason ?? 'api-failure', checks, rejections, lookups,
            ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
            detail: { phase, ...error.detail, at: now.toISOString(),
                category: e instanceof Error && e.name === 'AbortError' ? 'timeout' : error.reason ? 'graph-error' : 'transport-error' } };
    }
}
