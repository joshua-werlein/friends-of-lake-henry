const TZ = "America/Chicago";

function partsInTZ(d: Date, timeZone = TZ) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: 'h23', // Midnight must be 00, not Intl's locale-dependent 24.
    });

    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";

    return {
        year: Number(get("year")),
        month: Number(get("month")),
        day: Number(get("day")),
        hour: Number(get("hour")),
        minute: Number(get("minute")),
    };
}

function pad2(n: number) {
    return String(n).padStart(2, "0");
}

/**
 * Convert a datetime-local string that should be interpreted in America/Chicago
 * into a UTC ISO string with Z.
 *
 * Input:  "YYYY-MM-DDTHH:MM"
 * Output: "YYYY-MM-DDTHH:MM:SS.sssZ"
 */
export function chicagoDatetimeLocalToUtcIso(local: string): string | null {
    const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!m) return null;

    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);

    // Initial guess: treat the components as if they were UTC.
    let guessMs = Date.UTC(y, mo - 1, d, h, mi, 0, 0);

    // One or two iterations is enough in practice (handles DST offsets correctly).
    for (let i = 0; i < 2; i++) {
        const got = partsInTZ(new Date(guessMs), TZ);

        const desiredTotal = (((y * 12 + mo) * 31 + d) * 24 + h) * 60 + mi;
        const gotTotal = (((got.year * 12 + got.month) * 31 + got.day) * 24 + got.hour) * 60 + got.minute;

        const diffMinutes = desiredTotal - gotTotal;
        if (diffMinutes === 0) break;

        guessMs += diffMinutes * 60_000;
    }

    return new Date(guessMs).toISOString();
}

/**
 * Convert a stored UTC ISO string (with Z) to a datetime-local value string
 * (YYYY-MM-DDTHH:MM) in America/Chicago for <input type="datetime-local">.
 */
export function utcIsoToChicagoDatetimeLocal(utcIso: string): string | null {
    const d = new Date(utcIso);
    if (!Number.isFinite(d.getTime())) return null;

    const p = partsInTZ(d, TZ);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * Convert stored UTC ISO to YYYY-MM-DD in Chicago (for bucketing).
 */
export function utcIsoToChicagoDateKey(utcIso: string): string | null {
    const d = new Date(utcIso);
    if (!Number.isFinite(d.getTime())) return null;

    const p = partsInTZ(d, TZ);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}
