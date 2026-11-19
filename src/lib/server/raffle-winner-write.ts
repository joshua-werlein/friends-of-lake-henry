import type { D1Database } from '@cloudflare/workers-types';
import { canonicalWinnerPrize, cleanPrizeDescription, parseWinnerPrize, placementLabel, ticketlessWinnerId, BONUS } from '../winner-prize';
import { calendarPosition, matchApprovedSlot, prizeSchedule } from './raffle-prizes';

// One set of winner rules for manual entry (raffle admin) and for administrator review of held winner-photo rows.
// Nothing here deletes or overwrites a stored winner.

export function isRealIsoDate(s: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return false;
    // Ensure it didn’t roll over (e.g., 2025-02-30 -> March 2)
    return d.toISOString().slice(0, 10) === s;
}

/**
 * Resolves the approved calendar slot this prize names. A missing ticket needs explicit confirmation plus one approved main, gift card or bonus
 * slot whose place matches the calendar. Never fabricates a ticket. A changed prize also cannot claim a place the calendar contradicts;
 * an unrelated edit to an older record keeps its stored text.
 */
export async function resolveSlot(DB: D1Database, drawDate: string, prize: string | null, ticketless: boolean, verified: unknown, previousPrize?: unknown): Promise<{ slotId: string | null; error?: string }> {
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

export type NewWinner = { id: string; raffleKey: string; drawDate: string; ticketNumber: number | null; ticketText: string | null;
    name: string; town: string; prize: string | null; slotId: string | null };
export type WinnerInput = { drawDate?: unknown; ticketNumber?: unknown; name?: unknown; town?: unknown; prize?: unknown; ticketMissingVerified?: unknown };

/** The manual-entry validation (same order and messages as raffle admin's Add winner), producing the deterministic winner ID. */
export async function prepareNewWinner(DB: D1Database, data: WinnerInput): Promise<{ ok: true; winner: NewWinner } | { ok: false; status: number; error: string }> {
    const drawDate = (data?.drawDate ?? "").toString().trim();
    const raffleKey = drawDate.slice(0, 7); // "YYYY-MM"
    const ticketNumberRaw = (data?.ticketNumber ?? "").toString().trim();
    const name = (data?.name ?? "").toString().trim();
    const town = (data?.town ?? "").toString().trim();
    const prize = canonicalWinnerPrize(cleanPrizeDescription((data?.prize ?? "").toString()) || null);
    const fail = (error: string, status = 400) => ({ ok: false as const, status, error });

    if (!drawDate) return fail("drawDate required");
    if (!raffleKey) return fail("raffleKey required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) return fail("drawDate must be YYYY-MM-DD");
    if (!isRealIsoDate(drawDate)) return fail("drawDate must be a valid date");

    const ticketNumber = ticketNumberRaw === "" ? null : Number(ticketNumberRaw);
    if (ticketNumber !== null && (!/^\d{1,9}$/.test(ticketNumberRaw) || ticketNumber <= 0)) return fail("ticketNumber must be a positive whole number");
    if (name.length < 2) return fail("name required");
    if (name.length > 200 || town.length > 200 || (prize?.length ?? 0) > 250) return fail("Name, hometown or prize is too long");

    // Deterministic ID helps avoid duplicates; allow same ticket across different dates.
    const resolved = await resolveSlot(DB, drawDate, prize, ticketNumber === null, data?.ticketMissingVerified);
    if (resolved.error) return fail(resolved.error, resolved.error === "Prize calendar unavailable." ? 503 : 400);
    const id = ticketNumber === null ? ticketlessWinnerId(drawDate, resolved.slotId!)
        : `${raffleKey}-${drawDate}-${ticketNumber}`.replace(/[^\w-]/g, "");
    return { ok: true, winner: { id, raffleKey, drawDate, ticketNumber, ticketText: ticketNumber === null ? null : ticketNumberRaw, name, town, prize, slotId: resolved.slotId } };
}

/** Manual entry: a plain insert whose unique indexes reject a second winner for the same ticket or slot. */
export const insertWinner = (DB: D1Database, w: NewWinner) => DB.prepare(
    `INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text, prize_slot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(w.id, w.raffleKey, w.drawDate, w.ticketNumber, w.name, w.town, w.prize, w.ticketText, w.slotId);

// The photo importer's publication guard: one winner per date for a ticket, a numbered place, a slot or a name.
const placePrefix = (prize: string | null) => { const label = placementLabel(parseWinnerPrize(prize).position); return label === null || label === BONUS ? null : label + '%'; };
const CONFLICT_SQL = `raffle_key=? AND draw_date=? AND (ticket_number=? OR prize LIKE ? OR prize_slot_id=? OR lower(winner_name)=lower(?))`;
const conflictBinds = (w: NewWinner) => [w.raffleKey, w.drawDate, w.ticketNumber, placePrefix(w.prize), w.slotId, w.name];

export type StoredWinner = { id: string; drawDate: string; ticketNumber: number | null; name: string; town: string; prize: string | null; prizeSlotId: string | null };
/** Stored winners that the importer's guard would treat as the same winner or the same place. */
export async function conflictingWinners(DB: D1Database, w: NewWinner): Promise<StoredWinner[]> {
    return (await DB.prepare(`SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId
        FROM raffle_winners WHERE ${CONFLICT_SQL} ORDER BY id LIMIT 10`).bind(...conflictBinds(w)).all<StoredWinner>()).results;
}

/**
 * Review publication: inserts only while `rowGuard` (an EXISTS subquery with its own binds) still holds and no stored winner conflicts.
 * The caller follows it with statements conditioned on changes()=1 in the same batch, so the winner and its audit land together or not at all.
 */
export const guardedInsertWinner = (DB: D1Database, w: NewWinner, rowGuard: { sql: string; binds: unknown[] }) => DB.prepare(
    `INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text, prize_slot_id)
     SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM raffle_winners WHERE ${CONFLICT_SQL}) AND EXISTS (${rowGuard.sql})
     ON CONFLICT DO NOTHING`).bind(w.id, w.raffleKey, w.drawDate, w.ticketNumber, w.name, w.town, w.prize, w.ticketText, w.slotId,
        ...conflictBinds(w), ...rowGuard.binds);
