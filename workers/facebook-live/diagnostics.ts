import { discoverPosts, GRAPH_PAGE_ID, PUBLIC_PAGE_ID, GRAPH_VERSION, LIVE_CONTRACT, numericId } from './graph';
import { type Env, type Staged } from './poller';
import { parseLiveConfig, RAFFLE_LIVE_KEY } from '../../src/lib/facebook';
import { AUTOMATIC_KEY } from '../../src/lib/server/facebook-automation';
import { selectionMode, selectRaffleVideo, STATE_KEY } from '../../src/lib/server/raffle-selection';
import { raffleSeason } from '../../src/lib/server/raffle-season';

/** Explicit private verification only. Never writes manual settings or a receipt. */
export async function verifyAndStage(env: Env, expectedId: string, deps: { now?: Date; fetcher?: typeof fetch } = {}) {
    const now = deps.now ?? new Date(), season = raffleSeason(env);
    if (env.FB_AUTOMATION_ENABLED !== 'false' || env.FB_VIDEO_PROBE_ENABLED !== 'false'
        || !env.CONFIG || !env.FB_PAGE_ACCESS_TOKEN || env.FB_GRAPH_PAGE_ID !== GRAPH_PAGE_ID
        || env.FB_PUBLIC_PAGE_ID !== PUBLIC_PAGE_ID || env.FB_RAFFLE_MARKER !== '#LakeHenryRaffle'
        || !numericId(expectedId) || !season || now.getTime() < season.start || now.getTime() >= season.end) return { ok: false, status: 'verification-precondition-failed' };
    const store = env.CONFIG;
    const before = await store.get(RAFFLE_LIVE_KEY);
    const manual = parseLiveConfig(before);
    if (selectionMode(before) !== 'manual' || manual.latestVideoUrl !== `https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/${expectedId}/`) return { ok: false, status: 'manual-selection-mismatch' };
    const result = await discoverPosts({ token: env.FB_PAGE_ACCESS_TOKEN, marker: '#LakeHenryRaffle', probeVideoMetadata: true, now, fetcher: deps.fetcher });
    if (!result.ok) return { ok: false, status: result.reason };
    const candidate = result.discoveries.filter(v => Date.parse(v.publishedAt) >= season.start)
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.videoId.localeCompare(b.videoId))[0];
    if (!candidate || candidate.videoId !== expectedId) return { ok: false, status: 'expected-video-not-newest-eligible', candidates: result.candidates, eligible: result.discoveries.length };
    if (await store.get(RAFFLE_LIVE_KEY) !== before) return { ok: false, status: 'manual-selection-changed' };
    const previous = await store.get(AUTOMATIC_KEY);
    if (previous) {
        let old;
        try { old = JSON.parse(previous); } catch { return { ok: false, status: 'invalid-previous-stage' }; }
        if (!old || !Number.isFinite(Date.parse(old.publishedAt)) || Date.parse(old.publishedAt) > Date.parse(candidate.publishedAt)) return { ok: false, status: 'previous-stage-protected' };
    }
    const stage: Staged = { ...candidate, schemaVersion: 2, id: candidate.videoId, graphPageId: GRAPH_PAGE_ID,
        publicPageId: PUBLIC_PAGE_ID, apiVersion: GRAPH_VERSION, contract: LIVE_CONTRACT, observedAt: now.toISOString() };
    const state = { version: 1, accessRevision: env.FB_ACCESS_REVISION ?? '1', lastAttemptAt: now.getTime(), nextAttemptAt: now.getTime() + 300000,
        failures: 0, status: 'staged', paused: false, lastVerifiedVideoId: candidate.videoId, lastVerifiedAt: now.toISOString() };
    await store.put(AUTOMATIC_KEY, JSON.stringify(stage));
    await store.put(STATE_KEY, JSON.stringify(state));
    const stagedRaw = await store.get(AUTOMATIC_KEY), stateRaw = await store.get(STATE_KEY);
    if (stagedRaw !== JSON.stringify(stage) || stateRaw !== JSON.stringify(state)) return { ok: false, status: 'staging-readback-pending' };
    // Hypothetical receipt/mode only in memory. These fault injections never mutate KV.
    const receipt = JSON.stringify({ schemaVersion: 3, graphPageId: GRAPH_PAGE_ID, publicPageId: PUBLIC_PAGE_ID, apiVersion: GRAPH_VERSION,
        contract: LIVE_CONTRACT, evidence: 'tagged-page-video-policy-reviewed', marker: '#LakeHenryRaffle', verifiedVideoId: candidate.videoId,
        publicPlaybackVerified: true, rollbackTested: true, verifiedAt: now.toISOString(), expiresAt: new Date(season.end).toISOString() });
    const automaticRaw = JSON.stringify({ ...JSON.parse(before!), selectionMode: 'automatic' });
    const base = { manualRaw: automaticRaw, automaticRaw: stagedRaw, stateRaw, verificationRaw: receipt, enabled: true, now, season };
    const outcomes = {
        eligible: selectRaffleVideo(base).source === 'automatic',
        disabledFallback: selectRaffleVideo({ ...base, enabled: false }).source === 'manual',
        manualOverride: selectRaffleVideo({ ...base, manualRaw: before }).source === 'manual',
        staleFallback: selectRaffleVideo({ ...base, stateRaw: JSON.stringify({ ...state, lastVerifiedAt: new Date(now.getTime() - 600001).toISOString() }) }).source === 'manual',
        revokedReceiptFallback: selectRaffleVideo({ ...base, verificationRaw: null }).source === 'manual',
        permissionFallback: selectRaffleVideo({ ...base, stateRaw: JSON.stringify({ ...state, paused: true, status: 'permission-denied' }) }).source === 'manual',
        manualUnchanged: await store.get(RAFFLE_LIVE_KEY) === before,
    };
    return { ok: Object.values(outcomes).every(Boolean), status: 'verification-complete', observedAt: now.toISOString(),
        candidates: result.candidates, eligible: result.discoveries.length, stage, checks: outcomes,
        scope: 'Real Graph and KV stage; hypothetical Automatic mode/receipt and injected failures are read-only resolver checks.' };
}
