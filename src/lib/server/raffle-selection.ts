import { parseLiveConfig, normalizeFacebookVideoUrl, RAFFLE_LIVE_KEY, FACEBOOK_PAGE_ID, FACEBOOK_GRAPH_PAGE_ID,
    FACEBOOK_API_VERSION, FACEBOOK_LIVE_CONTRACT, type LiveConfig } from '../facebook';
import { AUTOMATIC_KEY } from './facebook-automation';
import { raffleSeason, type SeasonEnv, type Season } from './raffle-season';
import { offHoursReplayHealthy } from './raffle-discovery-schedule';

export const VERIFICATION_KEY = 'raffle_live_verification';
export const STATE_KEY = 'raffle_live_automation_state';
export type SelectionMode = 'manual' | 'automatic';
export type Selection = { manualConfig: LiveConfig; config: LiveConfig; selectionMode: SelectionMode;
    source: 'manual' | 'automatic'; reason: string; automaticAllowed: boolean; videoMetadata?: unknown };
export function readRecord(raw: string | null | undefined): Record<string, unknown> | null {
    try { const v: unknown = JSON.parse(raw ?? 'null'); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; }
    catch { return null; }
}
function iso(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === value.slice(0, 10);
}
export function verificationValid(raw: string | null, now: Date, season: Season | null = raffleSeason()): boolean {
    const v = readRecord(raw);
    return !!season && !!v && v.schemaVersion === 3 && v.graphPageId === FACEBOOK_GRAPH_PAGE_ID && v.publicPageId === FACEBOOK_PAGE_ID
        && v.apiVersion === FACEBOOK_API_VERSION && v.contract === FACEBOOK_LIVE_CONTRACT
        && v.evidence === 'tagged-page-video-policy-reviewed' && v.marker === '#LakeHenryRaffle'
        && v.publicPlaybackVerified === true && v.rollbackTested === true
        && typeof v.verifiedVideoId === 'string' && /^\d{1,40}$/.test(v.verifiedVideoId)
        && iso(v.verifiedAt) && iso(v.expiresAt) && Date.parse(v.verifiedAt) <= now.getTime()
        && Date.parse(v.expiresAt) > now.getTime() && Date.parse(v.expiresAt) <= season.end && Date.parse(v.verifiedAt) >= season.start;
}
export function selectionMode(raw: string | null): SelectionMode {
    const v = readRecord(raw);
    if (!v || !('latestVideoUrl' in v) || (v.latestVideoUrl !== null
        && (typeof v.latestVideoUrl !== 'string' || !normalizeFacebookVideoUrl(v.latestVideoUrl)))) return 'manual';
    return v.selectionMode === 'automatic' ? 'automatic' : 'manual';
}

/** Pure resolver. No mutations, API calls, token access or implicit promotion. */
export function selectRaffleVideo(input: { manualRaw: string | null; automaticRaw?: string | null;
    stateRaw?: string | null; verificationRaw?: string | null; enabled?: boolean; now?: Date; season?: Season | null }): Selection {
    const now = input.now ?? new Date(), time = now.getTime();
    const season = input.season === undefined ? raffleSeason() : input.season;
    const manualConfig = parseLiveConfig(input.manualRaw);
    const mode = selectionMode(input.manualRaw);
    const allowed = input.enabled === true && verificationValid(input.verificationRaw ?? null, now, season);
    const base: Selection = { manualConfig, config: manualConfig, selectionMode: mode, source: 'manual',
        reason: 'manual', automaticAllowed: allowed };
    const fallback = (reason: string): Selection => ({ ...base, reason });
    if (mode === 'manual') return base;
    if (!input.enabled) return fallback('automatic-disabled');
    if (!allowed) return fallback('verification-required');
    if (!season || !Number.isFinite(time) || time < season.start || time >= season.end) return fallback('outside-window');
    const stage = readRecord(input.automaticRaw), state = readRecord(input.stateRaw);
    if (!stage || stage.schemaVersion !== 2 || stage.graphPageId !== FACEBOOK_GRAPH_PAGE_ID
        || stage.publicPageId !== FACEBOOK_PAGE_ID || stage.apiVersion !== FACEBOOK_API_VERSION
        || stage.contract !== FACEBOOK_LIVE_CONTRACT || typeof stage.id !== 'string' || !/^\d{1,40}$/.test(stage.id)
        || stage.videoId !== stage.id || typeof stage.postId !== 'string' || !new RegExp(`^${FACEBOOK_GRAPH_PAGE_ID}_\\d+$`).test(stage.postId)
        || stage.url !== `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${stage.id}/`
        || !iso(stage.publishedAt) || !iso(stage.observedAt) || Date.parse(stage.publishedAt) < season.start
        || Date.parse(stage.publishedAt) > time || Date.parse(stage.observedAt) < Date.parse(stage.publishedAt)
        || Date.parse(stage.observedAt) > time
        || stage.status !== 'video' || !['LIVE', 'VOD', 'UNKNOWN'].includes(String(stage.liveStatus))
        || time - Date.parse(stage.publishedAt) > 36 * 60 * 60 * 1000) return fallback('invalid-discovery');
    // During checks require fresh health. Off-hours retain only the last window's
    // healthy closing verification; the next window must reverify the same video.
    const retainedReplay = !!state && iso(state.lastVerifiedAt) && Number.isSafeInteger(state.lastAttemptAt)
        && offHoursReplayHealthy(now, new Date(state.lastVerifiedAt), new Date(Number(state.lastAttemptAt)));
    if (!state || state.version !== 1 || state.paused !== false || state.failures !== 0
        || !['staged', 'unchanged', 'checking'].includes(String(state.status))
        || state.lastVerifiedVideoId !== stage.id || !iso(state.lastVerifiedAt)
        || Date.parse(state.lastVerifiedAt) > time || (!retainedReplay && time - Date.parse(state.lastVerifiedAt) > 10 * 60 * 1000)
        || !Number.isSafeInteger(state.lastAttemptAt) || Number(state.lastAttemptAt) > time
        || (!retainedReplay && time - Number(state.lastAttemptAt) > 10 * 60 * 1000)) return fallback('detection-unavailable');
    return { ...base, config: { latestVideoUrl: stage.url, updatedAt: stage.observedAt }, source: 'automatic', reason: 'verified-discovery', videoMetadata: stage };
}

export async function loadRaffleSelection(store: { get(key: string): Promise<string | null> }, enabled: boolean, now = new Date(), seasonEnv: SeasonEnv = {}): Promise<Selection> {
    const manualRaw = await store.get(RAFFLE_LIVE_KEY);
    const season = raffleSeason(seasonEnv);
    if (!enabled) return selectRaffleVideo({ manualRaw, enabled, now, season });
    try {
        const [automaticRaw, stateRaw, verificationRaw] = await Promise.all([store.get(AUTOMATIC_KEY), store.get(STATE_KEY), store.get(VERIFICATION_KEY)]);
        return selectRaffleVideo({ manualRaw, automaticRaw, stateRaw, verificationRaw, enabled, now, season });
    } catch {
        return { ...selectRaffleVideo({ manualRaw, enabled: false, now, season }), reason: 'detection-unavailable' };
    }
}
