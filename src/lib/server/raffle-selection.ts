import { parseLiveConfig, normalizeFacebookVideoUrl, RAFFLE_LIVE_KEY, FACEBOOK_PAGE_ID, FACEBOOK_GRAPH_PAGE_ID,
    FACEBOOK_API_VERSION, FACEBOOK_LIVE_CONTRACT, type LiveConfig } from '../facebook';
import { AUTOMATIC_KEY } from './facebook-automation';
import { raffleSeason, type SeasonEnv, type Season } from './raffle-season';
import { drawingDate, drawingStartFastUntil, liveDay } from './raffle-discovery-schedule';

export const VERIFICATION_KEY = 'raffle_live_verification';
export const STATE_KEY = 'raffle_live_automation_state';
/** A reviewed receipt authorizes at most this long after its verification; it must then be re-reviewed. */
export const MAX_RECEIPT_MS = 366 * 86400000;
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
        && Date.parse(v.expiresAt) > now.getTime() && Date.parse(v.expiresAt) - Date.parse(v.verifiedAt) <= MAX_RECEIPT_MS && Date.parse(v.verifiedAt) >= season.start;
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
    // After the season, the final season replay stays displayable under the season's receipt (no new selections: the
    // poller needs an unexpired receipt to stage). A later reviewed receipt authorizes year-round selection directly.
    const allowedNow = verificationValid(input.verificationRaw ?? null, now, season);
    const finalReplay = !allowedNow && !!season && time >= season.end && verificationValid(input.verificationRaw ?? null, new Date(season.end - 1), season);
    const allowed = input.enabled === true && (allowedNow || finalReplay);
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
        || !iso(stage.originObservedAt) || !liveDay(new Date(stage.originObservedAt))
        || Date.parse(stage.originObservedAt)>Date.parse(stage.observedAt as string) || Date.parse(stage.originObservedAt)<Date.parse(stage.publishedAt as string)
        || stage.drawingDate !== drawingDate(new Date(stage.originObservedAt)) || drawingDate(new Date(stage.publishedAt as string)) !== stage.drawingDate
        || Date.parse(stage.originObservedAt) < season!.start || (finalReplay && Date.parse(stage.originObservedAt) >= season!.end)
        || stage.videoId !== stage.id || typeof stage.postId !== 'string' || !new RegExp(`^${FACEBOOK_GRAPH_PAGE_ID}_\\d+$`).test(stage.postId)
        || stage.url !== `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${stage.id}/`
        || !iso(stage.publishedAt) || !iso(stage.observedAt) || Date.parse(stage.publishedAt) < season.start
        || Date.parse(stage.publishedAt) > time || Date.parse(stage.observedAt) < Date.parse(stage.publishedAt)
        || Date.parse(stage.observedAt) > time
        || stage.status !== 'video' || !['LIVE', 'VOD', 'UNKNOWN'].includes(String(stage.liveStatus))
        || (finalReplay && Date.parse(stage.publishedAt) >= season.end)) return fallback('invalid-discovery');
    if (iso(manualRecord?.manualOverrideAt) && drawingDate(new Date(manualRecord.manualOverrideAt))! >= String(stage.drawingDate)) return fallback('manual-override');
    // Provider failures never erase a previously verified replay. New stages still require an actual successful verification.
    if (!state || state.version!==1 || state.lastVerifiedVideoId!==stage.id || !iso(state.lastVerifiedAt)
        || Date.parse(state.lastVerifiedAt)<Date.parse(stage.observedAt) || Date.parse(state.lastVerifiedAt)>time) return fallback('detection-unavailable');
    return { ...base, config: { latestVideoUrl: stage.url, updatedAt: stage.observedAt }, source: 'automatic',
        reason: 'verified-discovery', videoMetadata: observedFormat?.url === stage.url ? observedFormat : stage };
}

/** The Live coordinator's strongly consistent copy of the automatic selection and its state, read as one snapshot. */
export type FreshSelection = () => Promise<unknown>;
export type ReadPath = 'durable-object' | 'kv';
export const FRESH_SELECTION_TIMEOUT_MS = 1500;
/** Per-isolate reuse of a coordinator snapshot: 2 s while a new Live may need to appear (coalesces 5-second polls),
 * 15 s otherwise, so an idle page costs at most one coordinator read per isolate per 15 s. */
export const ACTIVE_SNAPSHOT_MS = 2_000, IDLE_SNAPSHOT_MS = 15_000;
export const ACTIVE_REFRESH_MS = 5_000, IDLE_REFRESH_MS = 15_000;
const rawValue = (v: unknown): v is string | null => v === null || typeof v === 'string';
/** Pages service binding → FreshSelection, or undefined when the binding/method is absent. */
export function freshSelectionFrom(binding: unknown): FreshSelection | undefined {
    const live = binding as { selection?: () => Promise<unknown> } | undefined;
    return typeof live?.selection === 'function' ? () => live.selection!() : undefined;
}
type Fresh = { pair: { automaticRaw: string | null; stateRaw: string | null } | null; activeUntil: number };
async function readFresh(fresh: FreshSelection): Promise<Fresh | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const value = await Promise.race([fresh(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), FRESH_SELECTION_TIMEOUT_MS); })]);
        if (!value || typeof value !== 'object') return null;
        const v = value as { automaticRaw?: unknown; stateRaw?: unknown; activeUntil?: unknown };
        // Both values or neither: a coordinator selection paired with a KV state (or the reverse) can mismatch.
        return { pair: rawValue(v.automaticRaw) && rawValue(v.stateRaw) ? { automaticRaw: v.automaticRaw, stateRaw: v.stateRaw } : null,
            activeUntil: Number.isSafeInteger(v.activeUntil) ? Number(v.activeUntil) : 0 };
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); }
}
/** One per isolate in production (module state); tests pass their own. Failed reads are never cached. */
export class SnapshotCache {
    private value: (Fresh & { fetchedAt: number }) | null = null;
    async read(fresh: FreshSelection, now: number): Promise<Fresh | null> {
        const v = this.value;
        const ttl = v && Math.max(v.activeUntil, drawingStartFastUntil(new Date(now))) > now ? ACTIVE_SNAPSHOT_MS : IDLE_SNAPSHOT_MS;
        if (v && now >= v.fetchedAt && now - v.fetchedAt < ttl) return v;
        const result = await readFresh(fresh);
        if (result) this.value = { ...result, fetchedAt: now };
        return result;
    }
}
export const sharedSnapshotCache = new SnapshotCache();

/** Manual record and verification receipt always come from KV. On any November day the automatic selection and state
 * come from the coordinator snapshot when it answers in time; any failure, timeout or missing copy falls back to KV.
 * `refreshMs`: browsers poll every 5 s while a new Live may need to appear, otherwise every 15 s. */
export async function loadRaffleSelection(store: { get(key: string): Promise<string | null> }, enabled: boolean, now = new Date(), seasonEnv: SeasonEnv = {},
    fresh?: FreshSelection, cache: SnapshotCache = sharedSnapshotCache): Promise<Selection & { readPath: ReadPath; refreshMs: number }> {
    const manualRaw = await store.get(RAFFLE_LIVE_KEY);
    const season = raffleSeason(seasonEnv);
    if (!enabled || selectionMode(manualRaw)==='manual') return { ...selectRaffleVideo({ manualRaw, enabled, now, season }), readPath: 'kv', refreshMs: IDLE_REFRESH_MS };
    const refreshMs = (activeUntil: number) => Math.max(activeUntil, drawingStartFastUntil(now)) > now.getTime() ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
    try {
        // Year-round: the coordinator snapshot (idle reuse 15 s) lets a newly detected Live appear promptly at any time.
        const coordinator = fresh && liveDay(now) ? cache.read(fresh, now.getTime()) : Promise.resolve(null);
        const [snapshot, verificationRaw] = await Promise.all([coordinator, store.get(VERIFICATION_KEY)]);
        const refresh = refreshMs(snapshot?.activeUntil ?? 0);
        if (snapshot?.pair) return { ...selectRaffleVideo({ manualRaw, ...snapshot.pair, verificationRaw, enabled, now, season }), readPath: 'durable-object', refreshMs: refresh };
        const [automaticRaw, stateRaw] = await Promise.all([store.get(AUTOMATIC_KEY), store.get(STATE_KEY)]);
        return { ...selectRaffleVideo({ manualRaw, automaticRaw, stateRaw, verificationRaw, enabled, now, season }), readPath: 'kv', refreshMs: refresh };
    } catch {
        return { ...selectRaffleVideo({ manualRaw, enabled: false, now, season }), reason: 'detection-unavailable', readPath: 'kv', refreshMs: refreshMs(0) };
    }
}
