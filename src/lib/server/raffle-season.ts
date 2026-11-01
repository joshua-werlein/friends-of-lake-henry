/** Explicit ISO instants include the intended Central offset and DST boundary. End is exclusive. */
export type Season = { start: number; end: number };
export type SeasonEnv = { FB_SEASON_START?: string; FB_SEASON_END?: string };
export const DEFAULT_SEASON_START = '2026-11-01T00:00:00-05:00';
export const DEFAULT_SEASON_END = '2026-12-01T00:00:00-06:00';
export function raffleSeason(env: SeasonEnv = {}): Season | null {
    const startText = env.FB_SEASON_START ?? DEFAULT_SEASON_START;
    const endText = env.FB_SEASON_END ?? DEFAULT_SEASON_END;
    const instant = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(v)
        && Number.isFinite(Date.parse(v)) && new Date(v.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === v.slice(0, 10);
    if (!instant(startText) || !instant(endText)) return null;
    const start = Date.parse(startText), end = Date.parse(endText);
    return start < end && end - start <= 366 * 86400000 ? { start, end } : null;
}
