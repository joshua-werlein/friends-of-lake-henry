import { activeSeason, type Season } from './raffle-season';
import { FACEBOOK_PAGE_ID, normalizeFacebookVideoUrl, RAFFLE_LIVE_KEY } from '../facebook';

/** Application contract, NOT a claimed Meta response schema. A verified adapter is still required. */
export type Broadcast = {
    id: string;
    pageId: string;
    url: string;
    startedAt: string;
    status: 'live' | 'replay';
    isRaffle: true;
};
export type DiscoveryFailure = 'token-expired' | 'rate-limited' | 'api-failure' | 'unavailable';
export type DiscoveryResult = { ok: true; broadcasts: unknown } | { ok: false; reason: DiscoveryFailure };
export type BroadcastSource = () => Promise<DiscoveryResult>;
export const AUTOMATIC_KEY = 'raffle_live_automatic';
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
// The fundraiser window is the configured raffle season; these remain only as the no-configuration defaults.
export { DEFAULT_SEASON_START as FUNDRAISER_START, DEFAULT_SEASON_END as FUNDRAISER_END } from './raffle-season';

// Strict validation at the future provider boundary; ordinary uploads must never be selected.
export function validateBroadcast(value: unknown): Broadcast | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string' || !/^\d+$/.test(v.id) || v.pageId !== FACEBOOK_PAGE_ID
        || v.isRaffle !== true || (v.status !== 'live' && v.status !== 'replay')
        || typeof v.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v.startedAt)
        || !Number.isFinite(Date.parse(v.startedAt)) || typeof v.url !== 'string') return null;
    const day = v.startedAt.slice(0, 10);
    if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
    const url = normalizeFacebookVideoUrl(v.url);
    if (url !== `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${v.id}/`) return null;
    return { id: v.id, pageId: FACEBOOK_PAGE_ID, url, startedAt: v.startedAt,
        status: v.status as Broadcast['status'], isRaffle: true };
}

export type PollOutcome = { status: 'updated' | 'unchanged' | 'empty' | 'disabled' | 'outside-window'
    | 'manual-override' | 'unverified-source' | 'not-due' | 'invalid-response' | 'storage-failure' | DiscoveryFailure };
// A tiny KV interface permits tests without credentials or Cloudflare resources.
export type ConfigStore = { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };

export async function pollBroadcasts(options: {
    enabled?: boolean;
    store?: ConfigStore;
    source?: BroadcastSource;
    now?: Date;
    lastAttemptAt?: number;
    pollIntervalSeconds?: number;
    season?: Season | null;
}): Promise<PollOutcome> {
    if (options.enabled !== true) return { status: 'disabled' };
    const now = options.now ?? new Date();
    const time = now.getTime();
    const season = options.season === undefined ? activeSeason() : options.season;
    if (!season || !Number.isFinite(time) || time < season.start || time >= season.end) {
        return { status: 'outside-window' };
    }
    // There is deliberately no production Graph client until Meta feasibility is verified.
    if (!options.source) return { status: 'unverified-source' };
    const interval = options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    if (!Number.isInteger(interval) || interval < 60 || interval > 86400) return { status: 'disabled' };
    if (options.lastAttemptAt !== undefined && time - options.lastAttemptAt < interval * 1000) return { status: 'not-due' };
    const store = options.store;
    if (!store) return { status: 'storage-failure' };
    try {
        // Presence, including an explicitly cleared selection, always protects the manual workflow.
        if (await store.get(RAFFLE_LIVE_KEY) !== null) return { status: 'manual-override' };
    } catch { return { status: 'storage-failure' }; }
    let response: DiscoveryResult;
    try { response = await options.source(); }
    catch { return { status: 'api-failure' }; } // Never log raw errors, request URLs or tokens.
    if (!response || typeof response !== 'object') return { status: 'invalid-response' };
    if (response.ok === false) {
        const reasons: readonly string[] = ['token-expired', 'rate-limited', 'api-failure', 'unavailable'];
        return { status: reasons.includes(response.reason) ? response.reason : 'api-failure' };
    }
    if (response.ok !== true || !Array.isArray(response.broadcasts)) return { status: 'invalid-response' };
    const broadcasts = response.broadcasts.map(validateBroadcast);
    // Reject a partially malformed response rather than falling back to an older drawing.
    if (broadcasts.some(b => !b)) return { status: 'invalid-response' };
    const candidate = (broadcasts as Broadcast[])
        .filter(b => Date.parse(b.startedAt) >= season.start && Date.parse(b.startedAt) <= time)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
            || (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'live' ? -1 : 1))[0];
    if (!candidate) return { status: 'empty' };
    try {
        const raw = await store.get(AUTOMATIC_KEY);
        if (raw) {
            let previous: Broadcast | null;
            try { previous = validateBroadcast(JSON.parse(raw)); }
            catch { return { status: 'invalid-response' }; }
            if (!previous) return { status: 'invalid-response' };
            if (Date.parse(previous.startedAt) > Date.parse(candidate.startedAt)
                || (previous.id === candidate.id && previous.url === candidate.url)) return { status: 'unchanged' };
        }
        if (await store.get(RAFFLE_LIVE_KEY) !== null) return { status: 'manual-override' };
        // Isolated staging key prevents any race from overwriting an administrator's choice.
        // Public rendering does not consume this key until an approved integration is completed.
        await store.put(AUTOMATIC_KEY, JSON.stringify(candidate));
        return { status: 'updated' };
    } catch { return { status: 'storage-failure' }; }
}
