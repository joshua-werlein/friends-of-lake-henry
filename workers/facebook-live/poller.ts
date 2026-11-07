import { discoverLivestreams } from './livestream';
import { AUTOMATIC_KEY } from '../../src/lib/server/facebook-automation';
import { discoverPosts, GRAPH_PAGE_ID, PUBLIC_PAGE_ID, GRAPH_VERSION, LIVE_CONTRACT, isoTime, numericId, type Discovery } from './graph';

import { raffleSeason, type SeasonEnv } from '../../src/lib/server/raffle-season';
import { STATE_KEY, VERIFICATION_KEY, verificationValid } from '../../src/lib/server/raffle-selection';
import { burstCadence, inDiscoveryWindow, lastDiscoverySlot } from '../../src/lib/server/raffle-discovery-schedule';
import { pageAccessToken, type FacebookCredentials } from './credentials';
import type { AlertEnv } from '../../src/lib/server/alerts';
const CRON_EARLY_SLACK_MS = 10_000; // jitter tolerance remains below the one-minute interval
// Consecutive transient failures retried on the next 15-second drawing slot before exponential backoff resumes.
export const BURST_RETRY_LIMIT = 3;
export { STATE_KEY, VERIFICATION_KEY, verificationValid };
type Store = { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
export type Env = SeasonEnv & FacebookCredentials & AlertEnv & {
    CONFIG?: Store;
    DISCOVERY_SCHEDULER?: {idFromName(name:string):any;get(id:any):{fetch(url:string,init?:RequestInit):Promise<Response>}};
    FB_AUTOMATION_ENABLED?: string;
    FB_VIDEO_PROBE_ENABLED?: string;
    FB_GRAPH_PAGE_ID?: string;
    FB_PUBLIC_PAGE_ID?: string;
    FB_RAFFLE_MARKER?: string;
    FB_ACCESS_REVISION?: string;
    FB_POLL_INTERVAL_SECONDS?: string;
};
type State = { version: 1; accessRevision: string; lastAttemptAt: number; nextAttemptAt: number;
    failures: number; status: string; paused: boolean; lastVerifiedVideoId?: string; lastVerifiedAt?: string; candidates?: number; postsExamined?: number; lastError?:Record<string,string|number>; lastSuccessAt?:string; pendingVideos?:unknown[]; lastLiveObservation?:unknown; retryAfterUntil?:number };
/** Sanitized facts for alerting and timing: IDs, counts and codes only. */
export type PollMonitor = { failures: number; paused: boolean; reason?: string; phase?: string; liveVideoId?: string; selected: boolean; pending?:number; candidates?:number; verified?:number; videos?:unknown[] };
export type Outcome = { status: string; candidates?: number; postsExamined?: number; monitor?: PollMonitor };
export type Staged = Discovery & { schemaVersion: 2; id: string; graphPageId: string; publicPageId: string;
    apiVersion: string; contract: string; observedAt: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseState(raw: string | null): State | null {
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (!object(v) || v.version !== 1 || typeof v.accessRevision !== 'string'
        || !Number.isSafeInteger(v.lastAttemptAt) || !Number.isSafeInteger(v.nextAttemptAt)
        || !Number.isInteger(v.failures) || Number(v.failures) < 0 || Number(v.failures) > 16
        || typeof v.status !== 'string' || typeof v.paused !== 'boolean') throw Error('state');
    return v as State;
}

function previousIdentity(raw: string | null): { id: string; publishedAt: string; status: string } | null {
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!object(value)) throw Error('stage');
    const date = value.schemaVersion === 2 ? value.publishedAt : value.startedAt;
    if (!numericId(value.id) || !isoTime(date) || !['live', 'replay', 'video'].includes(String(value.status))
        || value.url !== `https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/${value.id}/`) throw Error('stage');
    if (value.schemaVersion === 2) {
        if (value.graphPageId !== GRAPH_PAGE_ID || value.publicPageId !== PUBLIC_PAGE_ID
            || value.apiVersion !== GRAPH_VERSION || value.contract !== LIVE_CONTRACT) return null;
    } else if (value.pageId !== PUBLIC_PAGE_ID) throw Error('stage');
    return { id: value.id, publishedAt: date, status: String(value.status) };
}

/** Staging only. There is deliberately no code path that writes/deletes raffle_live. */
export async function runPoll(env: Env = {}, dependencies: { now?: Date; fetcher?: typeof fetch; random?: () => number; nextScheduledAt?: number; trigger?:'webhook'|'poll' } = {}): Promise<Outcome> {
    if (env.FB_AUTOMATION_ENABLED !== 'true') return { status: 'disabled' };
    const now = dependencies.now ?? new Date();
    // This gate precedes every KV operation and every Facebook request. The cron
    // runs every minute; off-hours and unconfirmed months are zero-I/O invocations.
    if (!inDiscoveryWindow(now)) return { status: 'outside-drawing-window' };
    const time = now.getTime();
    const season = raffleSeason(env);
    if (!season) return { status: 'configuration-error' };
    if (!Number.isFinite(time) || time < season.start || time >= season.end) return { status: 'outside-window' };
    if (env.FB_GRAPH_PAGE_ID !== GRAPH_PAGE_ID || env.FB_PUBLIC_PAGE_ID !== PUBLIC_PAGE_ID) return { status: 'configuration-error' };
    if (!env.CONFIG) return { status: 'storage-unavailable' };
    const token = pageAccessToken(env);
    if (!token) return { status: 'missing-token' };
    const interval = Number(env.FB_POLL_INTERVAL_SECONDS ?? '60');
    if (!Number.isInteger(interval) || interval < 60 || interval > 86400) return { status: 'configuration-error' };
    const accessRevision = env.FB_ACCESS_REVISION ?? '1';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(accessRevision)) return { status: 'configuration-error' };
    const store = env.CONFIG;
    try {
        const manual = JSON.parse(await store.get('raffle_live') ?? 'null');
        if (manual?.automaticEnabled === false) return {status:'disabled-by-admin'};
        let previousState = parseState(await store.get(STATE_KEY));
        if (previousState?.accessRevision !== accessRevision) previousState = null;
        if (previousState?.paused) return { status: 'access-paused', monitor: { failures: previousState.failures, paused: true, reason: previousState.status, selected: false } };
        // Cron ticks land a few seconds either side of the minute. Without slack, a tick that arrives
        // just before lastAttempt+interval is skipped and healthy polling silently halves.
        // Backoff/Retry-After schedules (failures > 0) are honored exactly.
        const slack = previousState && previousState.failures === 0 && dependencies.nextScheduledAt === undefined ? CRON_EARLY_SLACK_MS : 0;
        if (previousState && time + slack < previousState.nextAttemptAt && (dependencies.trigger!=='webhook' || previousState.status==='rate-limited' || (previousState.retryAfterUntil??0)>time)) return { status: 'not-due' };
        const state: State = { version: 1, accessRevision, lastAttemptAt: time, nextAttemptAt: dependencies.nextScheduledAt ?? time + interval * 1000,
            failures: previousState?.failures ?? 0, status: 'checking', paused: false,
            lastVerifiedVideoId: previousState?.lastVerifiedVideoId, lastVerifiedAt: previousState?.lastVerifiedAt, lastSuccessAt:previousState?.lastSuccessAt, lastLiveObservation:previousState?.lastLiveObservation };
        // Keep in-progress state in memory. Persist one completed outcome below,
        // including every unchanged-video heartbeat and provider failure/backoff.
        // Interrupted polls leave the previous health timestamp to expire normally.
        const verified = verificationValid(await store.get(VERIFICATION_KEY), now, season);
        const probing = env.FB_VIDEO_PROBE_ENABLED === 'true';
        const previousRaw=await store.get(AUTOMATIC_KEY);
        const prior=previousState?.lastLiveObservation??(previousRaw?JSON.parse(previousRaw):null);
        const result = await discoverLivestreams({ token, now, prior, fetcher: dependencies.fetcher });
        state.pendingVideos=result.pending??[];
        if (!result.ok) {
            state.retryAfterUntil=result.retryAfterSeconds?time+result.retryAfterSeconds*1000:undefined;
            state.status = result.reason;
            state.lastError = {cause:result.reason,at:now.toISOString(),...result.detail};
            state.failures = Math.min(16, state.failures + 1);
            state.paused = ['token-expired', 'permission-denied', 'identity-mismatch', 'unsupported-contract'].includes(result.reason);
            const random = Math.max(0, Math.min(1, (dependencies.random ?? Math.random)()));
            const backoff = Math.min(120, interval * 2 ** Math.min(state.failures, 4));
            state.nextAttemptAt = time + Math.max(interval, result.retryAfterSeconds ?? 0, Math.min(120, Math.ceil(backoff * (1 + random * 0.2)))) * 1000;
            const closing=lastDiscoverySlot(now);
            if(closing!==null&&closing>time&&!result.retryAfterSeconds) state.nextAttemptAt=Math.min(state.nextAttemptAt,closing);
            // A lone transient error (timeout, 5xx, malformed body) must not suppress the drawing's 15-second burst for
            // two minutes. Retrying on the next scheduled slot never exceeds the healthy request rate; rate limits,
            // Retry-After, paused access and persistent failures keep the exponential backoff above.
            const next = dependencies.nextScheduledAt;
            if (next !== undefined && next > time && burstCadence(new Date(next)) && !state.paused && !result.retryAfterSeconds
                && result.reason !== 'rate-limited' && state.failures <= BURST_RETRY_LIMIT) state.nextAttemptAt = Math.min(state.nextAttemptAt, next);
        } else {
            state.failures = 0;
            state.lastSuccessAt = now.toISOString();
            if(probing && result.discoveries.length===1) state.lastLiveObservation={...result.discoveries[0],
                schemaVersion:2,contract:LIVE_CONTRACT,graphPageId:GRAPH_PAGE_ID,publicPageId:PUBLIC_PAGE_ID,apiVersion:GRAPH_VERSION};
            state.candidates = result.candidates;
            state.postsExamined = result.postsExamined;
            state.status = result.pending?.length ? 'pending-live-confirmation' : !probing ? 'candidates-only' : !verified ? 'verification-required' : 'no-eligible-video';
            if (probing && verified) {
                const candidate = result.discoveries
                    .filter(v => Date.parse(v.publishedAt) >= season.start && Date.parse(v.publishedAt) <= time)
                    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.videoId.localeCompare(b.videoId))[0];
                if (candidate) {
                    const previous = previousIdentity(previousRaw);
                    const older = previous && Date.parse(previous.publishedAt) > Date.parse(candidate.publishedAt);
                    // Selection identity is stable across Facebook status changes; do not rewrite playback.
                    const same = previous?.id === candidate.videoId && previous.status === candidate.status;
                    if (!older) {
                        state.lastVerifiedVideoId = candidate.videoId;
                        state.lastVerifiedAt = now.toISOString();
                    } else {
                        delete state.lastVerifiedVideoId;
                        delete state.lastVerifiedAt;
                    }
                    if (older || same) state.status = 'unchanged';
                    else {
                        const stage: Staged = { ...candidate, schemaVersion: 2, id: candidate.videoId,
                            graphPageId: GRAPH_PAGE_ID, publicPageId: PUBLIC_PAGE_ID, apiVersion: GRAPH_VERSION,
                            contract: LIVE_CONTRACT, observedAt: now.toISOString() };
                        await store.put(AUTOMATIC_KEY, JSON.stringify(stage));
                        state.status = 'staged';
                    }
                }
            }
        }
        await store.put(STATE_KEY, JSON.stringify(state));
        const liveVideoId = result.ok ? result.discoveries[0]?.videoId : result.reason === 'ambiguous-livestream' ? 'ambiguous' : undefined;
        const monitor: PollMonitor = { failures: state.failures, paused: state.paused, pending:result.pending?.length??0,videos:result.checks,
            ...(result.ok ? {candidates:result.candidates,verified:result.discoveries.length} : { reason: result.reason,phase:typeof result.detail?.phase==='string'?result.detail.phase:undefined }),
            ...(liveVideoId ? { liveVideoId } : {}), selected: !!liveVideoId && ['staged', 'unchanged'].includes(state.status) && state.lastVerifiedVideoId === liveVideoId };
        return { status: state.status, ...(state.candidates === undefined ? {} : { candidates: state.candidates, postsExamined: state.postsExamined }), monitor };
    } catch {
        // No raw exception, token, request URL, post message or pagination data escapes.
        return { status: 'storage-or-state-failure' };
    }
}
