// Only the confirmed November 2026 drawing schedule. Never extrapolate a future season.
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Temporary November-only schedule, including the entire 18:10 minute.
const START = 17 * 60 + 50, END = 18 * 60 + 11;
function localTime(now: Date): { day: string; minute: number } | null {
    if (!Number.isFinite(now.getTime())) return null;
    const parts = Object.fromEntries(clock.formatToParts(now).map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
export function inDiscoveryWindow(now: Date): boolean {
    const local = localTime(now);
    return !!local && local.day.startsWith('2026-11-') && local.minute >= START && local.minute < END;
}
/** Latest due slot; missed slots are never replayed as a catch-up burst. */
export function discoverySlot(now: Date): number | null {
    if (!inDiscoveryWindow(now)) return null;
    const minute = localTime(now)!.minute;
    const interval = minute >= 17 * 60 + 59 && minute <= 18 * 60 + 1 ? 15_000 : 60_000;
    return Math.floor(now.getTime() / interval) * interval;
}
export function nextDiscoverySlot(now: Date): number | null {
    const slot = discoverySlot(now);
    if (slot === null) return null;
    // Probe quarter-minute boundaries to handle cadence transitions exactly.
    for (let next = Math.floor(now.getTime() / 15_000) * 15_000 + 15_000; next <= slot + 60_000; next += 15_000) {
        if (discoverySlot(new Date(next)) === next) return next;
    }
    return null;
}
/** Off-hours playback may retain a healthy verification from the last
 * scheduled window. The next window requires fresh health again. Failure/identity/
 * receipt checks remain in the resolver; this never manufactures a heartbeat. */
export function offHoursReplayHealthy(now: Date, verifiedAt: Date, attemptedAt: Date): boolean {
    const local = localTime(now), verified = localTime(verifiedAt), attempted = localTime(attemptedAt);
    if (!local || !verified || !attempted || !local.day.startsWith('2026-11-') || inDiscoveryWindow(now)) return false;
    const lastDay = local.minute >= END ? local.day : new Date(Date.parse(local.day + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    return lastDay.startsWith('2026-11-') && verified.day === lastDay && attempted.day === lastDay
        && verified.minute >= START && verified.minute < END && attempted.minute >= START && attempted.minute < END
        && verifiedAt.getTime() <= now.getTime() && attemptedAt.getTime() <= now.getTime();
}
