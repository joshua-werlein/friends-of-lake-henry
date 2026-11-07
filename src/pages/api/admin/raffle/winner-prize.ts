import type { APIRoute } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { json } from '../../../../lib/http';
import { BONUS, composeWinnerPrize, placementLabel } from '../../../../lib/winner-prize';
import { calendarPosition, matchApprovedSlot, prizeSchedule } from '../../../../lib/server/raffle-prizes';

// Existing middleware requires an authenticated admin and same-origin CSRF.
export const POST: APIRoute = async ({ request, locals }) => {
    const db = (locals.runtime?.env as { DB?: D1Database } | undefined)?.DB;
    if (!db) return json({ ok: false, error: 'Winner storage unavailable.' }, 503);
    let body;
    try { const text = await request.text(); if (text.length > 4096) throw Error(); body = JSON.parse(text); }
    catch { return json({ ok: false, error: 'Invalid prize update.' }, 400); }
    if (!body || typeof body.id !== 'string' || !/^[\w-]{1,150}$/.test(body.id)
        || !Object.hasOwn(body, 'expectedPrize') || (body.expectedPrize !== null && typeof body.expectedPrize !== 'string')) return json({ ok: false, error: 'Reload the winner before editing.' }, 400);
    let prize: string;
    try { prize = composeWinnerPrize(body); }
    catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Invalid prize.' }, 400); }
    try {
        const row = await db.prepare('SELECT * FROM raffle_winners WHERE id=?').bind(body.id).first<any>();
        if (!row) return json({ ok: false, error: 'Winner not found.' }, 404);
        if (row.prize !== body.expectedPrize) return json({ ok: false, error: 'This prize changed. Reload before saving.' }, 409);
        let schedule = null;
        try { schedule = await prizeSchedule(db, row.draw_date.slice(0, 7)); } catch { /* Without a calendar only ticketed winners can be saved, with no slot. */ }
        const slot = schedule ? matchApprovedSlot(schedule, row.draw_date, body.description) : null;
        const place = slot && schedule ? calendarPosition(slot, schedule) : null;
        if (row.ticket_number === null && (!(place === 1 || place === 2 || place === BONUS) || body.position !== place))
            return json({ ok: false, error: 'A winner without a ticket must stay in one approved main, gift card or bonus prize at its calendar place. Add the verified ticket first.' }, 400);
        if (place !== null && body.position !== null && body.position !== place) return json({ ok: false, error: `That prize is ${placementLabel(place)} on the approved calendar. Select that place.` }, 400);
        // Only the prize columns change, on the existing ID. Never delete/reinsert a winner.
        const [result] = await db.batch([db.prepare('UPDATE raffle_winners SET prize=?, prize_slot_id=? WHERE id=? AND prize IS ?').bind(prize, slot?.id ?? null, body.id, body.expectedPrize),
            db.prepare(`INSERT INTO raffle_winner_corrections (winner_id, action, before_json, after_json) SELECT ?,'prize',?,? WHERE changes()=1`)
                .bind(body.id, JSON.stringify(row), JSON.stringify({ prize, prizeSlotId: slot?.id ?? null }))]);
        if (result.meta.changes !== 1) return json({ ok: false, error: 'This prize changed. Reload before saving.' }, 409);
        return json({ ok: true, id: body.id, prize });
    } catch (error) {
        if (String((error as Error)?.message ?? '').includes('prize_slot')) return json({ ok: false, error: 'That prize already has a winner for that day.' }, 409);
        return json({ ok: false, error: 'Unable to save the prize.' }, 503);
    }
};
