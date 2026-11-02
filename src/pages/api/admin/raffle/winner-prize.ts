import type { APIRoute } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { json } from '../../../../lib/http';
import { composeWinnerPrize } from '../../../../lib/winner-prize';

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
        const row = await db.prepare('SELECT id,prize FROM raffle_winners WHERE id=?').bind(body.id).first<{id:string;prize:string|null}>();
        if (!row) return json({ ok: false, error: 'Winner not found.' }, 404);
        if (row.prize !== body.expectedPrize) return json({ ok: false, error: 'This prize changed. Reload before saving.' }, 409);
        // Only one column changes, on the existing ID. Never delete/reinsert a winner.
        const result = await db.prepare('UPDATE raffle_winners SET prize=? WHERE id=? AND prize IS ?').bind(prize,body.id,body.expectedPrize).run();
        if (result.meta.changes !== 1) return json({ ok: false, error: 'This prize changed. Reload before saving.' }, 409);
        return json({ ok: true, id: body.id, prize });
    } catch { return json({ ok: false, error: 'Unable to save the prize.' }, 503); }
};
