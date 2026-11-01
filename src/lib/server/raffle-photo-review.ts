import type { D1Database } from '@cloudflare/workers-types';
import { approvalRows, compareWinner, draftRows, hashBytes, positionPrize,
    type DraftWinner, type ExistingWinner } from '../raffle-photo-import';

export async function existingWinners(db: D1Database, month: string): Promise<ExistingWinner[]> {
    const result = await db.prepare(`SELECT id,draw_date AS drawDate,ticket_number AS ticketNumber,
        winner_name AS name,town,prize FROM raffle_winners WHERE raffle_key=? ORDER BY draw_date`).bind(month).all<ExistingWinner>();
    return result.results;
}
/** One atomic D1 batch: claim exact draft version, insert/fill only, then enforce audit consistency.
 * The migration's audit trigger aborts the entire batch on duplicates/concurrent conflicts.
 */
export async function approveImport(db: D1Database, id: string, version: number, rawRows: unknown) {
    const draft = await db.prepare('SELECT * FROM raffle_photo_imports WHERE id=?').bind(id).first<any>();
    if (!draft || draft.status !== 'pending' || draft.version !== version) throw Error('stale-draft');
    const rows = approvalRows(rawRows, draft.month_hint);
    const existing = await existingWinners(db, draft.month_hint);
    const prepared = [];
    const matchedIds = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i], comparison = compareWinner(row, existing);
        if (comparison.status === 'complete') throw Error('already-complete');
        if (comparison.status === 'conflicting') throw Error('conflicting-winner');
        const found = existing.find(v => v.id === comparison.existingId);
        if (found && matchedIds.has(found.id)) throw Error('conflicting-winner');
        if (found) matchedIds.add(found.id);
        // Preserve populated values byte for byte. Only blank values can be filled.
        const final: DraftWinner = { ...row, drawDate: found?.drawDate?.trim() ? found.drawDate : row.drawDate,
            ticketNumber: found?.ticketNumber && found.ticketNumber > 0 ? String(found.ticketNumber) : row.ticketNumber,
            name: found?.name?.trim() ? found.name : row.name, town: found?.town?.trim() ? found.town : row.town };
        const fingerprint = await hashBytes(new TextEncoder().encode(JSON.stringify([final.drawDate, Number(final.ticketNumber),
            final.name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '), final.town.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ')])));
        prepared.push({ ...final, ticketNumber: Number(final.ticketNumber), id: found?.id ?? crypto.randomUUID(),
            action: found ? 'fill' : 'insert', prize: found ? found.prize : positionPrize(row.position),
            fingerprint, rowNumber: i });
    }
    const nonce = crypto.randomUUID(), payload = JSON.stringify(prepared);
    const claim = `EXISTS(SELECT 1 FROM raffle_photo_imports WHERE id=? AND status='approved' AND review_nonce=?)`;
    const results = await db.batch([
        db.prepare(`UPDATE raffle_photo_imports SET status='approved',review_nonce=?,version=version+1,
            approved_rows_json=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id=? AND status='pending' AND version=?`).bind(nonce, JSON.stringify(rows), id, version),
        db.prepare(`INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize)
            SELECT json_extract(j.value,'$.id'),?,json_extract(j.value,'$.drawDate'),json_extract(j.value,'$.ticketNumber'),
            json_extract(j.value,'$.name'),json_extract(j.value,'$.town'),json_extract(j.value,'$.prize')
            FROM json_each(?) j WHERE json_extract(j.value,'$.action')='insert' AND ${claim}
            AND NOT EXISTS(SELECT 1 FROM raffle_winners w WHERE w.raffle_key=? AND
                ((w.draw_date=json_extract(j.value,'$.drawDate') AND w.ticket_number=json_extract(j.value,'$.ticketNumber'))
                OR (w.draw_date=json_extract(j.value,'$.drawDate') AND lower(trim(w.winner_name))=lower(trim(json_extract(j.value,'$.name'))))))`)
            .bind(draft.month_hint, payload, id, nonce, draft.month_hint),
        db.prepare(`UPDATE raffle_winners SET
            draw_date=CASE WHEN trim(coalesce(draw_date,''))='' THEN json_extract(j.value,'$.drawDate') ELSE draw_date END,
            ticket_number=CASE WHEN coalesce(ticket_number,0)<=0 THEN json_extract(j.value,'$.ticketNumber') ELSE ticket_number END,
            winner_name=CASE WHEN trim(coalesce(winner_name,''))='' THEN json_extract(j.value,'$.name') ELSE winner_name END,
            town=CASE WHEN trim(coalesce(town,''))='' THEN json_extract(j.value,'$.town') ELSE town END
            FROM json_each(?) j WHERE raffle_winners.id=json_extract(j.value,'$.id')
            AND json_extract(j.value,'$.action')='fill' AND ${claim}`).bind(payload, id, nonce),
        db.prepare(`INSERT INTO raffle_photo_import_rows(import_id,row_number,review_nonce,winner_id,fingerprint,
            draw_date,ticket_number,winner_name,town,action)
            SELECT ?,json_extract(value,'$.rowNumber'),?,json_extract(value,'$.id'),json_extract(value,'$.fingerprint'),
            json_extract(value,'$.drawDate'),json_extract(value,'$.ticketNumber'),json_extract(value,'$.name'),
            json_extract(value,'$.town'),json_extract(value,'$.action') FROM json_each(?) WHERE ${claim}`)
            .bind(id, nonce, payload, id, nonce),
    ]);
    if (results[0].meta.changes !== 1) throw Error('stale-draft');
    return { inserted: prepared.filter(v => v.action === 'insert').length, filled: prepared.filter(v => v.action === 'fill').length };
}

export function reviewRows(raw: string, existing: ExistingWinner[]) {
    const rows = draftRows(JSON.parse(raw));
    return rows.map(row => ({ ...row, comparison: compareWinner(row, existing) }));
}
