import type { APIRoute } from "astro";
import type { D1Database } from "@cloudflare/workers-types";
import { json } from "../../../../lib/http";
import { BONUS, canonicalWinnerPrize, cleanPrizeDescription, parseWinnerPrize, placementLabel, ticketlessWinnerId, WINNER_PLACEMENT_ORDER_SQL } from "../../../../lib/winner-prize";
import { calendarPosition, matchApprovedSlot, prizeSchedule } from "../../../../lib/server/raffle-prizes";
import { winnerTicketLabels } from '../../../../lib/server/raffle-ticket-labels';

function mustBeIsoDate(s: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isRealIsoDate(s: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return false;
    // Ensure it didn’t roll over (e.g., 2025-02-30 -> March 2)
    return d.toISOString().slice(0, 10) === s;
}

function chicagoCurrentMonthKey(d = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
    }).format(d).slice(0, 7);
}

/**
 * Resolves the approved calendar slot this prize names. A missing ticket needs explicit confirmation plus one approved main, gift card or bonus
 * slot whose place matches the calendar. Never fabricates a ticket. A changed prize also cannot claim a place the calendar contradicts;
 * an unrelated edit to an older record keeps its stored text.
 */
async function resolveSlot(DB: D1Database, drawDate: string, prize: string | null, ticketless: boolean, verified: unknown, previousPrize?: unknown): Promise<{ slotId: string | null; error?: string }> {
    if (ticketless && verified !== true) return { slotId: null, error: "Enter a ticket number, or confirm the official announcement published no ticket for this winner." };
    let schedule;
    try { schedule = await prizeSchedule(DB, drawDate.slice(0, 7)); }
    catch { return ticketless ? { slotId: null, error: "Prize calendar unavailable." } : { slotId: null }; }
    const parsed = parseWinnerPrize(prize);
    const slot = prize === null ? null : matchApprovedSlot(schedule, drawDate, parsed.description);
    const place = slot ? calendarPosition(slot, schedule) : null;
    if (ticketless) {
        if (!slot || !(place === 1 || place === 2 || place === BONUS)) return { slotId: null, error: "A winner without a ticket must match one approved main, gift card or bonus prize for that date." };
        if (parsed.position !== place) return { slotId: null, error: `That prize is ${placementLabel(place)} on the approved calendar. Select that place.` };
    } else if (place !== null && parsed.position !== null && parsed.position !== place && prize !== previousPrize) {
        return { slotId: null, error: `That prize is ${placementLabel(place)} on the approved calendar. Select that place.` };
    }
    return { slotId: slot?.id ?? null };
}
const duplicateMessage = (msg: string) => msg.includes("prize_slot") ? "That prize already has a winner for that day." : "That ticket number already exists for that day.";
const logCorrection = (DB: D1Database, id: string, action: "update" | "delete", before: unknown, after: unknown) => DB.prepare(
    `INSERT INTO raffle_winner_corrections (winner_id, action, before_json, after_json) SELECT ?,?,?,? WHERE changes()=1`)
    .bind(id, action, JSON.stringify(before), after === null ? null : JSON.stringify(after));

export const GET: APIRoute = async ({ request, locals }) => {
    const env = (locals as any).runtime?.env as any;

    const DB = env.DB as D1Database | undefined;
    if (!DB) return json({ ok: false, error: "DB binding missing" }, 500);

    const url = new URL(request.url);
    const raffleKey = (url.searchParams.get("raffleKey") ?? "").trim();

    if (!/^\d{4}-\d{2}$/.test(raffleKey)) {
        return json({ ok: false, error: "raffleKey (YYYY-MM) required" }, 400);
    }

    const includeMonths = url.searchParams.get("includeMonths") === "1";
    const includeMeta = url.searchParams.get("includeMeta") === "1";

    const { results } = await DB
        .prepare(
            `SELECT id, raffle_key as raffleKey, draw_date as drawDate, ticket_number as ticketNumber, winner_name as name, town, prize, created_at as createdAt
       FROM raffle_winners
       WHERE raffle_key = ?
       ORDER BY draw_date DESC, ${WINNER_PLACEMENT_ORDER_SQL}, created_at DESC`
        )
        .bind(raffleKey)
        .all();

    let months: string[] | undefined;
    if (includeMonths) {
        const currentMonth = chicagoCurrentMonthKey();

        const winnerMonthsRes = await DB.prepare(
            `SELECT DISTINCT raffle_key as monthKey
     FROM raffle_winners
     ORDER BY raffle_key DESC`
        ).all();

        const activeMonths = (winnerMonthsRes.results ?? [])
            .map((r: any) => String(r.monthKey ?? "").trim())
            .filter((s) => /^\d{4}-\d{2}$/.test(s))
            .sort((a, b) => b.localeCompare(a));

        months = Array.from(new Set([currentMonth, ...activeMonths]))
            .filter((s) => /^\d{4}-\d{2}$/.test(s))
            .sort((a, b) => b.localeCompare(a));
    }

    let meta: { title: string | null } | undefined;
    if (includeMeta) {
        const row = await DB.prepare(
            `SELECT title FROM raffle_months WHERE month_key = ?`
        ).bind(raffleKey).first();

        meta = { title: row ? String((row as any).title ?? "") || null : null };
    }

    return json({ ok: true, winners: await winnerTicketLabels(DB,(results ?? []) as any),raffleKey, months, meta}, 200);
};

export const POST: APIRoute = async ({ request, locals }) => {
    const env = (locals as any).runtime?.env as any;

    const DB = env.DB as D1Database | undefined;
    if (!DB) return json({ ok: false, error: "DB binding missing" }, 500);

    let data: any = null;
    try {
        data = await request.json();
    } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const action = (data?.action ?? "add").toString();

    if (action === "setMeta") {
        const monthKey = (data?.raffleKey ?? "").toString().trim();
        const titleRaw = (data?.title ?? "").toString();
        const title = titleRaw.trim();

        if (!/^\d{4}-\d{2}$/.test(monthKey)) {
            return json({ ok: false, error: "raffleKey (YYYY-MM) required" }, 400);
        }

        // Clear only the title: the month may still own a poster and rules.
        if (!title) {
            await DB.prepare(`UPDATE raffle_months SET title = '',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE month_key = ?`)
                .bind(monthKey)
                .run();
            return json({ ok: true, meta: { title: "" } }, 200);
        }

        await DB.prepare(
            `INSERT INTO raffle_months (month_key, title, updated_at)
             VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ','now')))
                 ON CONFLICT(month_key) DO UPDATE SET
                title = excluded.title,
                                               updated_at = excluded.updated_at`
        )
            .bind(monthKey, title)
            .run();

        return json({ ok: true, meta: { title } }, 200);
    }

    if (action === "delete") {
        const id = (data?.id ?? "").toString().trim();
        if (!id) return json({ ok: false, error: "Missing id" }, 400);

        // The removed row stays in the correction log, so a deletion never destroys evidence.
        const removed = await DB.prepare(`SELECT * FROM raffle_winners WHERE id = ?`).bind(id).first();
        await DB.batch([DB.prepare(`DELETE FROM raffle_winners WHERE id = ?`).bind(id), logCorrection(DB, id, "delete", removed, null)]);
        return json({ ok: true }, 200);
    }
    if (action === "update") {
        // Update all editable fields together on the existing ID, refusing stale edits.
        const id = (data?.id ?? "").toString().trim();
        const next = data?.winner ?? {}, expected = data?.expected ?? {};
        const drawDate = String(next.drawDate ?? "").trim(), ticketText = String(next.ticketNumber ?? "").trim();
        const ticketNumber = ticketText === "" ? null : Number(ticketText);
        const name = String(next.name ?? "").trim(), town = String(next.town ?? "").trim();
        const prize = canonicalWinnerPrize(cleanPrizeDescription(String(next.prize ?? '')) || null);
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        if (!isRealIsoDate(drawDate)) return json({ ok: false, error: "drawDate must be a valid YYYY-MM-DD date" }, 400);
        if (ticketNumber !== null && (!/^\d{1,9}$/.test(ticketText) || ticketNumber <= 0)) return json({ ok: false, error: "ticketNumber must be 1–9 digits and positive" }, 400);
        if (name.length < 2 || name.length > 200 || town.length > 200 || (prize?.length ?? 0)>250) return json({ ok: false, error: "Name is required; name/hometown allow 200 characters and prize 250" }, 400);
        if (!Object.hasOwn(expected,'prize') || !Object.hasOwn(expected,'ticketNumberText')) return json({ok:false,error:'Reload this winner before editing.'},400);
        try {
            const resolved = await resolveSlot(DB, drawDate, prize, ticketNumber === null, next.ticketMissingVerified, expected.prize);
            if (resolved.error) return json({ ok: false, error: resolved.error }, 400);
            const stored=await DB.prepare('SELECT * FROM raffle_winners WHERE id=?').bind(id).first<any>();
            const current=await winnerTicketLabels(DB, (await DB.prepare('SELECT id,ticket_number AS ticketNumber FROM raffle_winners WHERE id=?').bind(id).all<any>()).results);
            if(current[0]?.ticketNumberText!==expected.ticketNumberText) return json({ok:false,error:'This winner changed or was removed. Reload and try again.'},409);
            const duplicate=ticketNumber===null?null:await DB.prepare('SELECT id FROM raffle_winners WHERE draw_date=? AND ticket_number=? AND id<>?').bind(drawDate,ticketNumber,id).first();
            if(duplicate) return json({ok:false,error:'That ticket number already exists for that day.'},409);
            // The prior values, including any ticket being cleared, are kept in the same atomic write.
            const [result] = await DB.batch([DB.prepare(`UPDATE raffle_winners SET raffle_key=?, draw_date=?, ticket_number=?, ticket_number_text=?, winner_name=?, town=?, prize=?, prize_slot_id=?
                WHERE id=? AND draw_date=? AND ticket_number IS ? AND winner_name=? AND town=? AND prize IS ?
                AND ticket_number_text IS ?`)
                .bind(drawDate.slice(0, 7), drawDate, ticketNumber, ticketNumber === null ? null : ticketText, name, town, prize, resolved.slotId, id,
                    String(expected.drawDate ?? ""), expected.ticketNumber === null ? null : Number(expected.ticketNumber), String(expected.name ?? ""), String(expected.town ?? ""),expected.prize,
                    stored?.ticket_number_text??null),
                logCorrection(DB, id, "update", stored, { drawDate, ticketNumber, ticketText: ticketNumber === null ? null : ticketText, name, town, prize, prizeSlotId: resolved.slotId })]);
            if (result.meta.changes !== 1) return json({ ok: false, error: "This winner changed or was removed. Reload and try again." }, 409);
        } catch (err: any) {
            const msg = String(err?.message ?? "");
            if (msg.includes("UNIQUE") || msg.includes("constraint")) return json({ ok: false, error: duplicateMessage(msg) }, 409);
            return json({ ok: false, error: "DB update failed" }, 500);
        }
        return json({ ok: true, id }, 200);
    }
    if (action !== "add") return json({ ok: false, error: "Unknown action" }, 400);
    const drawDate = (data?.drawDate ?? "").toString().trim();
    const raffleKey = drawDate.slice(0, 7); // "YYYY-MM"
    const ticketNumberRaw = (data?.ticketNumber ?? "").toString().trim();
    const name = (data?.name ?? "").toString().trim();
    const town = (data?.town ?? "").toString().trim();
    const prize = canonicalWinnerPrize(cleanPrizeDescription((data?.prize ?? "").toString()) || null);

    if (!drawDate) return json({ ok: false, error: "drawDate required" }, 400);
    if (!raffleKey) return json({ ok: false, error: "raffleKey required" }, 400);
    if (!mustBeIsoDate(drawDate)) return json({ ok: false, error: "drawDate must be YYYY-MM-DD" }, 400);
    if (!isRealIsoDate(drawDate)) return json({ ok: false, error: "drawDate must be a valid date" }, 400);

    const ticketNumber = ticketNumberRaw === "" ? null : Number(ticketNumberRaw);
    if (ticketNumber !== null && (!/^\d{1,9}$/.test(ticketNumberRaw) || ticketNumber <= 0)) {
        return json({ ok: false, error: "ticketNumber must be a positive whole number" }, 400);
    }
    if (name.length < 2) return json({ ok: false, error: "name required" }, 400);

    if (name.length > 200 || town.length > 200 || (prize?.length ?? 0) > 250) return json({ ok: false, error: "Name, hometown or prize is too long" }, 400);

    // Deterministic ID helps avoid duplicates; allow same ticket across different dates.
    const resolved = await resolveSlot(DB, drawDate, prize, ticketNumber === null, data?.ticketMissingVerified);
    if (resolved.error) return json({ ok: false, error: resolved.error }, resolved.error === "Prize calendar unavailable." ? 503 : 400);
    const id = ticketNumber === null ? ticketlessWinnerId(drawDate, resolved.slotId!)
        : `${raffleKey}-${drawDate}-${ticketNumber}`.replace(/[^\w-]/g, "");

    try {
        await DB.prepare(
            `INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text, prize_slot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(id, raffleKey, drawDate, ticketNumber, name, town, prize, ticketNumber === null ? null : ticketNumberRaw, resolved.slotId)
            .run();
    } catch (err: any) {
        const msg = String(err?.message ?? "");
        if (msg.includes("UNIQUE") || msg.includes("constraint")) {
            return json({ ok: false, error: msg.includes("prize_slot") || ticketNumber === null ? "That prize already has a winner for that day." : "That ticket number already exists for that day/month." }, 409);
        }
        return json({ ok: false, error: "DB insert failed" }, 500);
    }
    return json({ ok: true, id }, 200);
};
