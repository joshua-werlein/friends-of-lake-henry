/** Explicit ISO instants include the intended Central offset and DST boundary. End is exclusive. */
export type Season = { start: number; end: number };
export type SeasonEnv = { FB_SEASON_START?: string; FB_SEASON_END?: string };
// Used only when a runtime provides no season settings (tests and local tools). Every deployed config sets both
// variables explicitly; a new year is activated by changing them, never by the calendar or this fallback.
export const DEFAULT_SEASON_START = '2026-11-01T00:00:00-05:00';
export const DEFAULT_SEASON_END = '2026-12-01T00:00:00-06:00';
export function raffleSeason(env: SeasonEnv = {}): Season | null {
    const startText = env.FB_SEASON_START ?? DEFAULT_SEASON_START;
    const endText = env.FB_SEASON_END ?? DEFAULT_SEASON_END;
    const instant = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
        && Number.isFinite(Date.parse(v)) && new Date(v.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === v.slice(0, 10);
    if (!instant(startText) || !instant(endText)) return null;
    const start = Date.parse(startText), end = Date.parse(endText);
    return start < end && end - start <= 366 * 86400000 ? { start, end } : null;
}

const central = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
const centralDay = (t: number) => central.format(new Date(t));
/** Central calendar days covered by the season: first day inclusive, end day exclusive. */
export function seasonDays(season: Season) { return { first: centralDay(season.start), end: centralDay(season.end) }; }
/** A Central YYYY-MM-DD drawing day inside the season. */
export function inSeasonDay(day: string, season: Season | null = activeSeason()): boolean {
    if (!season || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const { first, end } = seasonDays(season);
    return day >= first && day < end;
}
/** The raffle month key (YYYY-MM) the season starts in, e.g. "2026-11". */
export const seasonKey = (season: Season) => seasonDays(season).first.slice(0, 7);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Durable Object name for the season's Live coordinator: "november-2026" for the 2026 season. Each season gets fresh state. */
export function seasonObjectName(season: Season | null = activeSeason()): string {
    const key = season ? seasonKey(season) : '0000-00';
    return `${MONTHS[Number(key.slice(5, 7)) - 1] ?? 'none'}-${key.slice(0, 4)}`;
}
/** Human label such as "November 1–30, 2026". */
export function seasonLabel(season: Season | null = activeSeason()): string {
    if (!season) return '';
    const { first, end } = seasonDays(season);
    const last = new Date(Date.parse(end + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    const month = (d: string) => MONTHS[Number(d.slice(5, 7)) - 1].replace(/^./, c => c.toUpperCase());
    const day = (d: string) => String(Number(d.slice(8, 10)));
    return first.slice(0, 7) === last.slice(0, 7) ? `${month(first)} ${day(first)}–${day(last)}, ${first.slice(0, 4)}`
        : `${month(first)} ${day(first)}, ${first.slice(0, 4)} – ${month(last)} ${day(last)}, ${last.slice(0, 4)}`;
}

// Each isolate serves one deployment, whose variables never change while it runs, so every entry point
// (fetch, scheduled, RPC, Durable Object, Pages middleware) records them here before season-dependent code runs.
let configured: { env: string; season: Season | null } | null = null;
export function configureSeason(env: SeasonEnv | undefined) {
    const key = `${env?.FB_SEASON_START ?? ''}|${env?.FB_SEASON_END ?? ''}`;
    if (configured?.env !== key) configured = { env: key, season: raffleSeason(env ?? {}) };
}
export function activeSeason(): Season | null { return configured ? configured.season : raffleSeason(); }
