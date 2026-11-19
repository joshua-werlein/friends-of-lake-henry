import type { D1Database } from '@cloudflare/workers-types';
import { cleanPrizeDescription, placementLabel } from '../winner-prize';
import { calendarPosition, prizeSchedule, type ScheduledPrize } from './raffle-prizes';
import { composePrize } from './raffle-photo-autopublish';
import { conflictingWinners, guardedInsertWinner, isRealIsoDate, prepareNewWinner, type NewWinner, type StoredWinner, type WinnerInput } from './raffle-winner-write';

// Administrator review of winner-photo rows the importer held or rejected. Publication goes through the same validation as manual entry
// (prepareNewWinner) and the importer's own duplicate guard; every review is one atomic batch guarded by the row's current state and the
// one-resolution-per-row constraint (migration 010). Stored winners are never changed: an already-corrected row is marked resolved instead.

export const REVIEWABLE = ['held', 'rejected'] as const;
const fold = (v: unknown) => String(v ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

type AutoRow = { photoId: string; rowNumber: number; outcome: string; winnerId: string | null; prize: string | null; reasons: string; row: string };
/** Changes whenever the importer or another review changes the row, so a stale page cannot act on it. */
export const rowVersion = (r: Pick<AutoRow, 'outcome' | 'prize' | 'reasons' | 'row' | 'winnerId'>) => sha256(JSON.stringify([r.outcome, r.prize, r.reasons, r.row, r.winnerId]));

/** Audit identity. Sessions carry only role "admin", so the actor is that role plus a short hash of the session (never the session itself). */
export async function reviewActor(request: Request) {
    const cookie = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('admin_session='));
    const session = cookie ? decodeURIComponent(cookie.slice('admin_session='.length)) : '';
    return session ? `admin:${(await sha256(session)).slice(0, 12)}` : 'admin';
}

export type SlotOption = { id: string; description: string; place: string | null; prize: string | null };
const slotOptions = (schedule: ScheduledPrize[], drawDate: string): SlotOption[] => schedule
    .filter(p => p.status === 'approved' && p.drawDate === drawDate)
    .map(p => { const position = calendarPosition(p, schedule); return { id: p.id, description: p.description, place: placementLabel(position), prize: composePrize(position, p.description) }; });

type Match = StoredWinner & { by: string[] };
/** Review context for the admin page: row versions, resolutions, approved slots per date and stored winners that look like the same winner. */
export async function reviewContext(db: D1Database, rows: AutoRow[]) {
    let resolutions: any[] = [], available = true;
    try {
        resolutions = (await db.prepare(`SELECT photo_id AS photoId, row_number AS rowNumber, action, final_status AS finalStatus, original_outcome AS originalOutcome,
            original_row_json AS originalRow, original_prize AS originalPrize, published_json AS published, corrections_json AS corrections, winner_id AS winnerId,
            note, actor, created_at AS createdAt FROM raffle_photo_row_resolutions WHERE photo_id IN (SELECT DISTINCT value FROM json_each(?))`)
            .bind(JSON.stringify([...new Set(rows.map(r => r.photoId))])).all<any>()).results;
    } catch { available = false; }
    const pending = rows.filter(r => (REVIEWABLE as readonly string[]).includes(r.outcome));
    const parsed = new Map(pending.map(r => { try { return [r, JSON.parse(r.row)]; } catch { return [r, {}]; } }));
    const months = [...new Set([...parsed.values()].map(v => String(v.drawDate ?? '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))];
    const winners = new Map<string, StoredWinner[]>(), schedules = new Map<string, ScheduledPrize[]>();
    for (const month of months) {
        winners.set(month, (await db.prepare(`SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId
            FROM raffle_winners WHERE raffle_key=? ORDER BY draw_date, id`).bind(month).all<StoredWinner>()).results);
        try { schedules.set(month, await prizeSchedule(db, month)); } catch { /* Without a calendar the editor offers a free-text prize. */ }
    }
    const slots: Record<string, SlotOption[]> = {};
    for (const [month, schedule] of schedules) for (const date of new Set(schedule.map(p => p.drawDate))) if (date.startsWith(month)) slots[date] = slotOptions(schedule, date);
    const out = new Map<AutoRow, { version: string; resolution: any; matches: Match[] }>();
    for (const r of rows) {
        const resolution = resolutions.find(v => v.photoId === r.photoId && v.rowNumber === r.rowNumber) ?? null;
        const v = parsed.get(r) ?? {};
        const ticket = /^\d{1,9}$/.test(String(v.ticketNumber ?? '')) ? Number(v.ticketNumber) : null;
        const matches: Match[] = [];
        if (parsed.has(r)) for (const w of winners.get(String(v.drawDate ?? '').slice(0, 7)) ?? []) {
            const by: string[] = [];
            const sameDate = w.drawDate === v.drawDate;
            if (sameDate && ticket !== null && w.ticketNumber === ticket) by.push('same ticket');
            if (fold(w.name).length >= 2 && fold(w.name) === fold(v.name)) by.push(sameDate ? 'same name' : `same name on ${w.drawDate}`);
            if (sameDate && r.prize && w.prize && fold(w.prize) === fold(r.prize)) by.push('same prize');
            if (by.length) matches.push({ ...w, by });
        }
        out.set(r, { version: await rowVersion(r), resolution, matches });
    }
    return { available, slots, rows: out };
}

type Body = { action?: unknown; photoId?: unknown; rowNumber?: unknown; version?: unknown; winner?: any; winnerId?: unknown; note?: unknown; ticketMissingVerified?: unknown };
export type ReviewResult = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ReviewResult => ({ status, body: { ok: false, error, ...extra } });
const ALREADY = 'This row was already resolved or changed. Reload the page.';

// Recomputes the photo's status as the importer does, counting resolved rows as settled. Runs only if the resolution was just written.
const statusAfterReview = (db: D1Database, photoId: string) => db.prepare(`UPDATE raffle_photo_auto_imports SET status=(
    SELECT CASE WHEN inserted>0 AND blocked>0 THEN 'partial' WHEN inserted>0 THEN 'published' WHEN rejected>0 THEN 'rejected'
        WHEN blocked>0 THEN 'held' WHEN duplicate>0 THEN 'duplicate' ELSE raffle_photo_auto_imports.status END
    FROM (SELECT count(*) FILTER (WHERE a.outcome='inserted') AS inserted,
        count(*) FILTER (WHERE a.outcome IN ('held','rejected') AND r.id IS NULL) AS blocked,
        count(*) FILTER (WHERE a.outcome='rejected' AND r.id IS NULL) AS rejected,
        count(*) FILTER (WHERE a.outcome='duplicate' OR r.final_status='resolved') AS duplicate
        FROM raffle_photo_auto_rows a LEFT JOIN raffle_photo_row_resolutions r ON r.photo_id=a.photo_id AND r.row_number=a.row_number WHERE a.photo_id=?)),
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE photo_id=? AND status<>'failed' AND changes()=1`).bind(photoId, photoId);

/** approve = publish the stored AI values; edit = publish corrected values; resolve = record that the website already has this winner. */
export async function reviewRow(db: D1Database, body: Body, actor: string): Promise<ReviewResult> {
    const action = body?.action;
    if (action !== 'approve' && action !== 'edit' && action !== 'resolve') return fail(400, 'Unknown review action.');
    if (typeof body.photoId !== 'string' || !/^\d{1,40}$/.test(body.photoId) || !Number.isInteger(body.rowNumber) || (body.rowNumber as number) < 1 || (body.rowNumber as number) > 1000
        || typeof body.version !== 'string' || !/^[0-9a-f]{64}$/.test(body.version)) return fail(400, 'Reload the page before reviewing this row.');
    const photoId = body.photoId, rowNumber = body.rowNumber as number;
    try { await db.prepare('SELECT 1 FROM raffle_photo_row_resolutions LIMIT 1').first(); }
    catch { return fail(503, 'Apply migration 010 before reviewing photo rows.'); }
    const current = await db.prepare(`SELECT a.photo_id AS photoId, a.row_number AS rowNumber, a.outcome, a.winner_id AS winnerId, a.prize, a.reasons_json AS reasons,
        a.row_json AS row, i.status AS importStatus, (SELECT count(*) FROM raffle_photo_row_resolutions r WHERE r.photo_id=a.photo_id AND r.row_number=a.row_number) AS resolved
        FROM raffle_photo_auto_rows a JOIN raffle_photo_auto_imports i ON i.photo_id=a.photo_id WHERE a.photo_id=? AND a.row_number=?`).bind(photoId, rowNumber).first<AutoRow & { importStatus: string; resolved: number }>();
    if (!current) return fail(404, 'This row no longer exists. Reload the page.');
    if (current.resolved || !(REVIEWABLE as readonly string[]).includes(current.outcome) || current.importStatus === 'failed') return fail(409, ALREADY);
    if (await rowVersion(current) !== body.version) return fail(409, ALREADY);
    let original: any, reasons: string[];
    try { original = JSON.parse(current.row); reasons = JSON.parse(current.reasons); } catch { return fail(409, 'This row cannot be reviewed here. Enter the winner in raffle admin.'); }
    // Every later statement requires the row to be exactly what this request reviewed and still unresolved.
    const rowGuard = { sql: `SELECT 1 FROM raffle_photo_auto_rows WHERE photo_id=? AND row_number=? AND outcome=? AND row_json=? AND reasons_json=? AND prize IS ?
        AND NOT EXISTS (SELECT 1 FROM raffle_photo_row_resolutions WHERE photo_id=? AND row_number=?)`,
        binds: [photoId, rowNumber, current.outcome, current.row, current.reasons, current.prize, photoId, rowNumber] };
    const audit = (finalStatus: 'published' | 'resolved', winnerId: string | null, published: unknown, corrections: unknown, note: string | null) => db.prepare(
        `INSERT INTO raffle_photo_row_resolutions (photo_id, row_number, action, final_status, original_outcome, original_row_json, original_reasons_json, original_prize,
            published_json, corrections_json, winner_id, note, actor) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`)
        .bind(photoId, rowNumber, action, finalStatus, current.outcome, current.row, current.reasons, current.prize,
            published === null ? null : JSON.stringify(published), JSON.stringify(corrections), winnerId, note, actor);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';

    if (action === 'resolve') {
        const winnerId = typeof body.winnerId === 'string' && body.winnerId ? body.winnerId : null;
        if (winnerId !== null && !/^[\w-]{1,150}$/.test(winnerId)) return fail(400, 'Select a stored winner.');
        if (winnerId === null && note.length < 3) return fail(400, 'Select the stored winner this row matches, or explain why it needs no winner.');
        if (winnerId !== null && !(await db.prepare('SELECT 1 FROM raffle_winners WHERE id=?').bind(winnerId).first())) return fail(409, 'That winner is no longer stored. Reload the page.');
        // The stored winner is only linked, never changed.
        const [link, rec] = await db.batch([
            db.prepare(`UPDATE raffle_photo_auto_rows SET winner_id=COALESCE(?, winner_id) WHERE photo_id=? AND row_number=? AND EXISTS (${rowGuard.sql})
                AND (? IS NULL OR EXISTS (SELECT 1 FROM raffle_winners WHERE id=?))`).bind(winnerId, photoId, rowNumber, ...rowGuard.binds, winnerId, winnerId),
            audit('resolved', winnerId, null, {}, note || null),
            statusAfterReview(db, photoId)]);
        if (link.meta.changes !== 1 || rec.meta.changes !== 1) return fail(409, ALREADY);
        return { status: 200, body: { ok: true, action, photoId, rowNumber, winnerId } };
    }

    // approve publishes exactly what the importer read; edit publishes the administrator's corrections of it.
    let input: WinnerInput, slotId: string | null = null;
    if (action === 'approve') {
        if (!current.prize) return fail(400, 'No approved prize was matched for this row. Use Edit to choose the prize.');
        input = { drawDate: original.drawDate, ticketNumber: original.ticketNumber, name: original.name, town: original.town, prize: current.prize, ticketMissingVerified: body.ticketMissingVerified };
    } else {
        const w = body.winner;
        if (!w || typeof w !== 'object') return fail(400, 'Enter the corrected winner.');
        for (const k of ['drawDate', 'ticketNumber', 'name', 'town']) if (typeof w[k] !== 'string') return fail(400, 'Enter the corrected winner.');
        const drawDate = w.drawDate.trim();
        if (!isRealIsoDate(drawDate)) return fail(400, 'drawDate must be a valid date');
        let prize: string | null = null;
        let schedule: ScheduledPrize[] = [];
        try { schedule = await prizeSchedule(db, drawDate.slice(0, 7)); } catch { /* No calendar: free text only. */ }
        const options = slotOptions(schedule, drawDate);
        if (typeof w.slotId === 'string' && w.slotId) {
            const option = options.find(o => o.id === w.slotId);
            if (!option) return fail(400, 'That prize is not an approved prize for the selected date.');
            slotId = option.id; prize = option.prize;
        } else if (options.length) return fail(400, 'Select the approved prize for this date.');
        else {
            prize = typeof w.prize === 'string' ? cleanPrizeDescription(w.prize) : '';
            if (prize.length < 2 || prize.length > 250) return fail(400, 'Enter the prize (2–250 characters).');
        }
        input = { drawDate, ticketNumber: w.ticketNumber, name: w.name, town: w.town, prize, ticketMissingVerified: w.ticketMissingVerified };
    }
    const prepared = await prepareNewWinner(db, input);
    if (!prepared.ok) return fail(prepared.status, prepared.error);
    const winner: NewWinner = prepared.winner;
    if (slotId !== null && winner.slotId !== slotId) return fail(400, 'That prize does not match its approved calendar slot. Select it again.');
    const conflicts = await conflictingWinners(db, winner);
    if (conflicts.length) return fail(409, 'A winner for this date already has this ticket, name, place or prize. Nothing was published; mark this row resolved if it is the same winner.', { conflicts });
    const published = { id: winner.id, drawDate: winner.drawDate, ticketNumber: winner.ticketText, name: winner.name, town: winner.town, prize: winner.prize, prizeSlotId: winner.slotId };
    const before: Record<string, unknown> = { drawDate: original.drawDate, ticketNumber: String(original.ticketNumber ?? ''), name: original.name, town: original.town, prize: current.prize };
    const after: Record<string, unknown> = { drawDate: winner.drawDate, ticketNumber: winner.ticketText ?? '', name: winner.name, town: winner.town, prize: winner.prize };
    const corrections = Object.fromEntries(Object.keys(before).filter(k => before[k] !== after[k]).map(k => [k, { from: before[k] ?? null, to: after[k] }]));
    let results;
    try {
        results = await db.batch([
            guardedInsertWinner(db, winner, rowGuard),
            db.prepare(`UPDATE raffle_photo_auto_rows SET outcome='inserted', winner_id=?, prize=?, reasons_json=? WHERE photo_id=? AND row_number=? AND changes()=1 AND EXISTS (${rowGuard.sql})`)
                .bind(winner.id, winner.prize, JSON.stringify([`published by an administrator after review (${action})`, ...reasons]), photoId, rowNumber, ...rowGuard.binds),
            audit('published', winner.id, published, corrections, note || null),
            statusAfterReview(db, photoId)]);
    } catch (error) {
        const msg = String((error as Error)?.message ?? '');
        if (msg.includes('UNIQUE') || msg.includes('constraint')) return fail(409, ALREADY);
        throw error;
    }
    if (results[0].meta.changes !== 1 || results[2].meta.changes !== 1) {
        const again = await conflictingWinners(db, winner);
        return again.length ? fail(409, 'Another winner was stored for this date first. Nothing was published.', { conflicts: again }) : fail(409, ALREADY);
    }
    return { status: 200, body: { ok: true, action, photoId, rowNumber, winnerId: winner.id, prize: winner.prize } };
}
