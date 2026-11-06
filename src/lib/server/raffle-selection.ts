import { parseLiveConfig, normalizeFacebookVideoUrl, RAFFLE_LIVE_KEY, FACEBOOK_PAGE_ID, FACEBOOK_GRAPH_PAGE_ID,
    FACEBOOK_API_VERSION, FACEBOOK_LIVE_CONTRACT, type LiveConfig } from '../facebook';
import { AUTOMATIC_KEY } from './facebook-automation';
import { raffleSeason, type SeasonEnv, type Season } from './raffle-season';
import { inDiscoveryWindow, drawingDate } from './raffle-discovery-schedule';

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
    return !!season && !!v && v.schemaVersion === 5 && v.graphPageId === FACEBOOK_GRAPH_PAGE_ID && v.publicPageId === FACEBOOK_PAGE_ID
        && v.apiVersion === FACEBOOK_API_VERSION && v.contract === FACEBOOK_LIVE_CONTRACT
        && v.evidence === 'page-video-live-origin-policy-reviewed'
        && v.publicPlaybackVerified === true && v.rollbackTested === true
        && typeof v.verifiedVideoId === 'string' && /^\d{1,40}$/.test(v.verifiedVideoId)
        && iso(v.verifiedAt) && iso(v.expiresAt) && Date.parse(v.verifiedAt) <= now.getTime()
        && Date.parse(v.expiresAt) > now.getTime() && Date.parse(v.expiresAt) <= season.end && Date.parse(v.verifiedAt) >= season.start;
}
export function selectionMode(raw: string | null): SelectionMode {
    const v = readRecord(raw);
    if (!v || !('latestVideoUrl' in v) || (v.latestVideoUrl !== null
        && (typeof v.latestVideoUrl !== 'string' || !normalizeFacebookVideoUrl(v.latestVideoUrl)))) return 'manual';
    return v.automaticEnabled === true || (v.automaticEnabled === undefined && v.selectionMode === 'automatic') ? 'automatic' : 'manual';
}

/** Pure resolver. No mutations, API calls, token access or implicit promotion. */
export function selectRaffleVideo(input: { manualRaw: string | null; automaticRaw?: string | null;
    stateRaw?: string | null; verificationRaw?: string | null; enabled?: boolean; now?: Date; season?: Season | null }): Selection {
    const now = input.now ?? new Date(), time = now.getTime();
    const season = input.season === undefined ? raffleSeason() : input.season;
    const manualConfig = parseLiveConfig(input.manualRaw);
    const mode = selectionMode(input.manualRaw);
    const manualRecord=readRecord(input.manualRaw);
    const overrideUrl=manualRecord?.manualOverrideUrl;
    const overrideAt=manualRecord?.manualOverrideAt;
    const hasOverride=iso(overrideAt)&&Date.parse(overrideAt)<=time&&('manualOverrideUrl' in manualRecord!)
        && (overrideUrl===null||(typeof overrideUrl==='string'&&!!normalizeFacebookVideoUrl(overrideUrl)));
    const manualDisplay=hasOverride?{latestVideoUrl:overrideUrl===null?null:normalizeFacebookVideoUrl(overrideUrl as string),updatedAt:overrideAt as string}:manualConfig;
    const allowed = input.enabled === true && verificationValid(input.verificationRaw ?? null, season && time >= season.end ? new Date(season.end-1) : now, season);
    const state = readRecord(input.stateRaw);
    const observation = state?.lastLiveObservation as Record<string, unknown> | undefined;
    const observedFormat = observation?.schemaVersion === 2 && observation.contract === FACEBOOK_LIVE_CONTRACT
        && observation.graphPageId === FACEBOOK_GRAPH_PAGE_ID && observation.publicPageId === FACEBOOK_PAGE_ID
        && observation.apiVersion === FACEBOOK_API_VERSION && observation.source === 'format' ? observation : undefined;
    const base: Selection = { manualConfig, config: manualDisplay, selectionMode: mode, source: 'manual',
        reason: 'manual', automaticAllowed: allowed,
        ...(observedFormat && observedFormat.url === manualDisplay.latestVideoUrl ? { videoMetadata: observedFormat } : {}) };
    const fallback = (reason: string): Selection => ({ ...base, reason });
    if (mode === 'manual') return base;
    if (!input.enabled) return fallback('automatic-disabled');
    if (!allowed) return fallback('verification-required');
    if (!season || !Number.isFinite(time) || time < season.start) return fallback('outside-window');
    const stage = readRecord(input.automaticRaw);
    if (!stage || stage.schemaVersion !== 2 || stage.graphPageId !== FACEBOOK_GRAPH_PAGE_ID
        || stage.publicPageId !== FACEBOOK_PAGE_ID || stage.apiVersion !== FACEBOOK_API_VERSION
        || stage.contract !== FACEBOOK_LIVE_CONTRACT || typeof stage.id !== 'string' || !/^\d{1,40}$/.test(stage.id)
        || stage.origin !== 'page-video-live-status' || !['LIVE','LIVE_STOPPED'].includes(String(stage.originStatus))
        || !iso(stage.originObservedAt) || !inDiscoveryWindow(new Date(stage.originObservedAt))
        || Date.parse(stage.originObservedAt)>Date.parse(stage.observedAt as string) || Date.parse(stage.originObservedAt)<Date.parse(stage.publishedAt as string)
        || stage.drawingDate !== drawingDate(new Date(stage.originObservedAt)) || drawingDate(new Date(stage.publishedAt as string)) !== stage.drawingDate
        || Date.parse(stage.originObservedAt) < season!.start || Date.parse(stage.originObservedAt) >= season!.end
        || stage.videoId !== stage.id || typeof stage.postId !== 'string' || !new RegExp(`^${FACEBOOK_GRAPH_PAGE_ID}_\\d+$`).test(stage.postId)
        || stage.url !== `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${stage.id}/`
        || !iso(stage.publishedAt) || !iso(stage.observedAt) || Date.parse(stage.publishedAt) < season.start
        || Date.parse(stage.publishedAt) > time || Date.parse(stage.observedAt) < Date.parse(stage.publishedAt)
        || Date.parse(stage.observedAt) > time
        || stage.status !== 'video' || !['LIVE', 'VOD', 'UNKNOWN'].includes(String(stage.liveStatus))
        || Date.parse(stage.publishedAt) >= season.end) return fallback('invalid-discovery');
    if (iso(manualRecord?.manualOverrideAt) && drawingDate(new Date(manualRecord.manualOverrideAt))! >= String(stage.drawingDate)) return fallback('manual-override');
    // Provider failures never erase a previously verified replay. New stages still require an actual successful verification.
    if (!state || state.version!==1 || state.lastVerifiedVideoId!==stage.id || !iso(state.lastVerifiedAt)
        || Date.parse(state.lastVerifiedAt)<Date.parse(stage.observedAt) || Date.parse(state.lastVerifiedAt)>time) return fallback('detection-unavailable');
    return { ...base, config: { latestVideoUrl: stage.url, updatedAt: stage.observedAt }, source: 'automatic',
        reason: 'verified-discovery', videoMetadata: observedFormat?.url === stage.url ? observedFormat : stage };
}

export async function loadRaffleSelection(store: { get(key: string): Promise<string | null> }, enabled: boolean, now = new Date(), seasonEnv: SeasonEnv = {}): Promise<Selection> {
    const manualRaw = await store.get(RAFFLE_LIVE_KEY);
    const season = raffleSeason(seasonEnv);
    if (!enabled || selectionMode(manualRaw)==='manual') return selectRaffleVideo({ manualRaw, enabled, now, season });
    try {
        const [automaticRaw, stateRaw, verificationRaw] = await Promise.all([store.get(AUTOMATIC_KEY), store.get(STATE_KEY), store.get(VERIFICATION_KEY)]);
        return selectRaffleVideo({ manualRaw, automaticRaw, stateRaw, verificationRaw, enabled, now, season });
    } catch {
        return { ...selectRaffleVideo({ manualRaw, enabled: false, now, season }), reason: 'detection-unavailable' };
    }
}
