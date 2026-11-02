import { AUTOMATIC_KEY } from '../../src/lib/server/facebook-automation';
import { discoverPosts, GRAPH_PAGE_ID, PUBLIC_PAGE_ID, GRAPH_VERSION, LIVE_CONTRACT, isoTime, numericId, type Discovery } from './graph';

import { raffleSeason, type SeasonEnv } from '../../src/lib/server/raffle-season';
import { STATE_KEY, VERIFICATION_KEY, verificationValid } from '../../src/lib/server/raffle-selection';
const CRON_EARLY_SLACK_MS = 60_000; // well under the 300-second minimum interval
export { STATE_KEY, VERIFICATION_KEY, verificationValid };
type Store = { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
export type Env = SeasonEnv & {
    CONFIG?: Store;
    FB_PAGE_ACCESS_TOKEN?: string;
    FB_AUTOMATION_ENABLED?: string;
    FB_VIDEO_PROBE_ENABLED?: string;
    FB_GRAPH_PAGE_ID?: string;
    FB_PUBLIC_PAGE_ID?: string;
    FB_RAFFLE_MARKER?: string;
    FB_ACCESS_REVISION?: string;
    FB_POLL_INTERVAL_SECONDS?: string;
};
type State = { version: 1; accessRevision: string; lastAttemptAt: number; nextAttemptAt: number;
    failures: number; status: string; paused: boolean; lastVerifiedVideoId?: string; lastVerifiedAt?: string; candidates?: number; postsExamined?: number };
export type Outcome = { status: string; candidates?: number; postsExamined?: number };
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
            || value.apiVersion !== GRAPH_VERSION || value.contract !== LIVE_CONTRACT) throw Error('stage');
    } else if (value.pageId !== PUBLIC_PAGE_ID) throw Error('stage');
    return { id: value.id, publishedAt: date, status: String(value.status) };
}

/** Staging only. There is deliberately no code path that writes/deletes raffle_live. */
export async function runPoll(env: Env = {}, dependencies: { now?: Date; fetcher?: typeof fetch; random?: () => number } = {}): Promise<Outcome> {
    if (env.FB_AUTOMATION_ENABLED !== 'true') return { status: 'disabled' };
    const now = dependencies.now ?? new Date();
    const time = now.getTime();
    const season = raffleSeason(env);
    if (!season) return { status: 'configuration-error' };
    if (!Number.isFinite(time) || time < season.start || time >= season.end) return { status: 'outside-window' };
    if (env.FB_GRAPH_PAGE_ID !== GRAPH_PAGE_ID || env.FB_PUBLIC_PAGE_ID !== PUBLIC_PAGE_ID
        || !/^#[A-Za-z][A-Za-z0-9_]{2,80}$/.test(env.FB_RAFFLE_MARKER ?? '')) return { status: 'configuration-error' };
    if (!env.CONFIG) return { status: 'storage-unavailable' };
    if (!env.FB_PAGE_ACCESS_TOKEN) return { status: 'missing-token' };
    const interval = Number(env.FB_POLL_INTERVAL_SECONDS ?? '300');
    if (!Number.isInteger(interval) || interval < 300 || interval > 86400) return { status: 'configuration-error' };
    const accessRevision = env.FB_ACCESS_REVISION ?? '1';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(accessRevision)) return { status: 'configuration-error' };
    const store = env.CONFIG;
    try {
        let previousState = parseState(await store.get(STATE_KEY));
        if (previousState?.accessRevision !== accessRevision) previousState = null;
        if (previousState?.paused) return { status: 'access-paused' };
        // Cron ticks land a few seconds either side of the minute. Without slack, a tick that arrives
        // just before lastAttempt+interval is skipped and healthy polling silently halves (observed
        // 2026-11-02: 01:35:04 then 01:45:03), letting public health age past its 10-minute window.
        // Backoff/Retry-After schedules (failures > 0) are honored exactly.
        const slack = previousState && previousState.failures === 0 ? CRON_EARLY_SLACK_MS : 0;
        if (previousState && time + slack < previousState.nextAttemptAt) return { status: 'not-due' };
        const state: State = { version: 1, accessRevision, lastAttemptAt: time, nextAttemptAt: time + interval * 1000,
            failures: previousState?.failures ?? 0, status: 'checking', paused: false,
            lastVerifiedVideoId: previousState?.lastVerifiedVideoId, lastVerifiedAt: previousState?.lastVerifiedAt };
        // Persist before network activity. KV is not a distributed lock; see README.
        await store.put(STATE_KEY, JSON.stringify(state));
        const verified = verificationValid(await store.get(VERIFICATION_KEY), now, season);
        const probing = env.FB_VIDEO_PROBE_ENABLED === 'true';
        const result = await discoverPosts({ token: env.FB_PAGE_ACCESS_TOKEN, marker: env.FB_RAFFLE_MARKER!,
            probeVideoMetadata: probing, now, fetcher: dependencies.fetcher });
        if (!result.ok) {
            state.status = result.reason;
            state.failures = Math.min(16, state.failures + 1);
            state.paused = ['token-expired', 'permission-denied', 'identity-mismatch', 'unsupported-contract'].includes(result.reason);
            const random = Math.max(0, Math.min(1, (dependencies.random ?? Math.random)()));
            const backoff = Math.min(3600, interval * 2 ** Math.min(state.failures, 4));
            state.nextAttemptAt = time + Math.max(interval, result.retryAfterSeconds ?? 0, Math.ceil(backoff * (1 + random * 0.2))) * 1000;
        } else {
            state.failures = 0;
            state.candidates = result.candidates;
            state.postsExamined = result.postsExamined;
            state.status = !probing ? 'candidates-only' : !verified ? 'verification-required' : 'no-eligible-video';
            if (probing && verified) {
                const candidate = result.discoveries
                    .filter(v => Date.parse(v.publishedAt) >= season.start && Date.parse(v.publishedAt) <= time)
                    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.videoId.localeCompare(b.videoId))[0];
                if (candidate) {
                    const previous = previousIdentity(await store.get(AUTOMATIC_KEY));
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
        return { status: state.status, ...(state.candidates === undefined ? {} : { candidates: state.candidates, postsExamined: state.postsExamined }) };
    } catch {
        // No raw exception, token, request URL, post message or pagination data escapes.
        return { status: 'storage-or-state-failure' };
    }
}
