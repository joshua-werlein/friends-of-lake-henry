import type { D1Database } from '@cloudflare/workers-types';
import { compareWinner, numericId, type DraftWinner, type Extraction, type ExistingWinner } from '../raffle-photo-import';
import { parseWinnerPrize, cleanPrizeDescription } from '../winner-prize';
import { prizeSchedule, type ScheduledPrize } from './raffle-prizes';

// Unattended publication of Facebook winner photos. A row is published only when every extraction pass agrees
// on it, every field validates, it is dated for the announcement's own drawing window and it neither duplicates
// nor contradicts an existing winner. Anything else is recorded with a reason and never guessed or overwritten.

export type RowOutcome = 'insert' | 'duplicate' | 'rejected' | 'outside-window';
export type RowDecision = { rowNumber: number; outcome: RowOutcome; reasons: string[]; row: DraftWinner;
    winnerId: string | null; prize: string | null; prizeMatch: 'scheduled' | 'unmatched' | 'none' };
export type PhotoDecision = { status: 'published' | 'partial' | 'duplicate' | 'rejected' | 'ignored';
    reasons: string[]; rows: RowDecision[] };

const WINDOW_DAYS = 2; // An announcement may report today's or the previous two days' drawings.
const MAX_AUTO_ROWS = 12; // Bound the eligible rows even when the Page posts a cumulative table.
const fold = (v: string) => v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();
const same = (a: string | null | undefined, b: string | null | undefined) => fold(a ?? '') === fold(b ?? '');
export const chicagoDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const realDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T12:00:00Z'))
    && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
export const winnerId = (date: string, ticket: number) => `${date.slice(0, 7)}-${date}-${ticket}`.replace(/[^\w-]/g, ''); // Same as manual entry.
const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : 'rd'} place`;

function identifyPrize(text: string | undefined, drawDate: string, schedule: ScheduledPrize[]) {
    const visible = fold(text ?? '');
    if (visible.length < 3) return null;
    const eligible = schedule.filter(p => p.status === 'approved' && p.drawDate === drawDate);
    const categories: Record<string, string> = { 'gift card': 'Gift card', firearm: 'Firearm',
        'bonus drawing': 'Bonus drawing', '2nd drawing': 'Bonus drawing' };
    const category = Object.hasOwn(categories, visible) ? categories[visible] : null;
    if (category) {
        // The November 2026 giveaway calendar's published Day N main events are the daily firearm.
        const matches = eligible.filter(p => p.category === category || (category === 'Firearm'
            && drawDate.startsWith('2026-11-') && p.category === 'Main prize' && p.source === 'event'));
        return matches.length === 1 ? matches[0] : null;
    }
    const words = (v: string) => new Set(fold(v).split(' ').filter(w => w.length > 1 || /\d/.test(w)));
    const seen = words(visible);
    const scored = eligible.map(p => {
        const want = [...words(p.description)];
        const hits = want.filter(w => seen.has(w)).length;
        return { p, exact: fold(p.description) === visible, score: want.length ? hits / want.length : 0 };
    });
    const exact = scored.filter(v => v.exact);
    if (exact.length) return exact.length === 1 ? exact[0].p : null;
    // Strong token overlap ("Savage 110 30-06" vs "Savage 110 High Country 30-06"), unique to one scheduled prize.
    const strong = scored.filter(v => v.score >= 0.6).sort((a, b) => b.score - a.score);
    return strong.length === 1 || (strong.length > 1 && strong[0].score - strong[1].score >= 0.3) ? strong[0].p : null;
}

/** Visible text must identify one approved prize for the date. Place alone is insufficient. */
export function matchPrize(text: string | undefined, drawDate: string, schedule: ScheduledPrize[]): { description: string | null; match: RowDecision['prizeMatch'] } {
    const prize = identifyPrize(text, drawDate, schedule);
    return prize ? { description: prize.description, match: 'scheduled' }
        : { description: null, match: fold(text ?? '').length < 3 ? 'none' : 'unmatched' };
}

function calendarPosition(prize: ScheduledPrize, schedule: ScheduledPrize[]): number | null {
    if (prize.position !== null) return prize.position;
    if (!prize.drawDate.startsWith('2026-11-')) return null;
    const day = schedule.filter(p => p.status === 'approved' && p.drawDate === prize.drawDate);
    const main = day.filter(p => p.category === 'Main prize' && p.source === 'event');
    const gifts = day.filter(p => p.category === 'Gift card' && p.source === 'daily');
    const bonus = day.filter(p => p.category === 'Bonus drawing' && p.source === 'event' && /2nd drawing\s*:/i.test(p.notes));
    if (main.length !== 1 || gifts.length !== 1 || bonus.length > 1 || day.length !== 2 + bonus.length) return null;
    if (prize === main[0]) return 1;
    if (prize === bonus[0]) return 2;
    return prize === gifts[0] ? day.length : null;
}
export function composePrize(position: number | null, description: string | null) {
    const prize = (position === null ? '' : ordinal(position) + (description ? ' — ' : '')) + (description ? cleanPrizeDescription(description) : '');
    return prize || null;
}

function rowProblems(row: DraftWinner, announcementDate: string): { reasons: string[]; outside: boolean } {
    const reasons: string[] = [];
    if (!realDate(row.drawDate)) reasons.push('draw date missing or invalid');
    if (!/^\d{1,9}$/.test(row.ticketNumber) || Number(row.ticketNumber) <= 0) reasons.push('ticket number missing or invalid');
    if (row.name.length < 2 || /[?…]|\.\.\./.test(row.name)) reasons.push('name missing or uncertain');
    if ((row.town.length < 2 && !(row.town === '' && row.townStatus === 'blank'))
        || /[?…]|\.\.\./.test(row.town) || row.townStatus === 'uncertain'
        || (row.town !== '' && row.townStatus === 'blank')) reasons.push('hometown missing or uncertain');
    if (row.notes) reasons.push('model flagged uncertainty: ' + row.notes);
    let outside = false;
    if (realDate(row.drawDate)) {
        const age = daysBetween(row.drawDate, announcementDate);
        if (age < 0) reasons.push('draw date is after the announcement');
        else if (age > WINDOW_DAYS) outside = true;
    }
    return { reasons, outside };
}

/**
 * Pure decision step. `passes` are independent extractions of the same image; `existing` are the stored winners for
 * the affected months; `announcementDate` is the post's America/Chicago date.
 */
export function decidePhoto(passes: Extraction[], existing: ExistingWinner[], schedule: ScheduledPrize[], announcementDate: string): PhotoDecision {
    if (!passes.length) return { status: 'rejected', reasons: ['no extraction'], rows: [] };
    const [first, ...others] = passes;
    if (passes.some(p => p.containsWinners !== first.containsWinners)) return { status: 'rejected', reasons: ['extraction passes disagree about whether this is a winner announcement'], rows: [] };
    if (!first.containsWinners) return { status: 'ignored', reasons: ['not a winner announcement'], rows: [] };
    if (passes.length < 2) return { status: 'rejected', reasons: ['winner publication requires at least two extraction passes'], rows: [] };
    const warnings = passes.flatMap(p => p.warnings).filter(w => w.trim() && !/^no (?:warnings|issues)[.!]?$/i.test(w.trim()));
    if (warnings.length) return { status: 'rejected', reasons: ['image has unresolved extraction warnings; review required', ...new Set(warnings)], rows: [] };
    if (!first.rows.length) return { status: 'rejected', reasons: ['announcement contains no readable winner rows'], rows: [] };
    if (others.some(p => p.rows.length !== first.rows.length)) return { status: 'rejected', reasons: ['extraction passes found different numbers of winners'], rows: [] };
    const currentRows = first.rows.filter(row => !rowProblems(row, announcementDate).outside).length;
    if (currentRows > MAX_AUTO_ROWS) return { status: 'rejected', reasons: [`${currentRows} rows exceeds the ${MAX_AUTO_ROWS}-row drawing window limit; review required`], rows: [] };

    const rows: RowDecision[] = first.rows.map((row, i) => {
        const { reasons, outside } = rowProblems(row, announcementDate);
        for (const other of others) {
            const o = other.rows[i];
            const differs = (['drawDate', 'name', 'town', 'prize'] as const).filter(f => !same(row[f], o[f]));
            if (Number(row.ticketNumber) !== Number(o.ticketNumber)) differs.push('ticketNumber' as never);
            if (row.ticketNumber !== o.ticketNumber && Number(row.ticketNumber) === Number(o.ticketNumber)) reasons.push('extraction passes disagree on printed ticket label');
            if (!row.town && row.townStatus !== o.townStatus) reasons.push('extraction passes disagree on whether hometown is visibly blank');
            if (o.notes || o.townStatus === 'uncertain') reasons.push('another extraction pass flagged uncertainty');
            if (row.position !== o.position) differs.push('position' as never);
            if (differs.length) reasons.push('extraction passes disagree on ' + differs.join(', '));
        }
        return { rowNumber: i + 1, outcome: reasons.length ? 'rejected' : outside ? 'outside-window' : 'insert', reasons, row,
            winnerId: null, prize: null, prizeMatch: 'none' as const };
    });

    // Conflicts inside the image itself reject every involved row rather than picking one.
    const groups = new Map<string, RowDecision[]>();
    for (const d of rows) {
        if (!realDate(d.row.drawDate)) continue;
        const keys = [`t:${d.row.drawDate}:${Number(d.row.ticketNumber)}`, ...(d.row.position ? [`p:${d.row.drawDate}:${d.row.position}`] : [])];
        for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    for (const [k, list] of groups) if (list.length > 1) for (const d of list) {
        d.outcome = 'rejected'; d.reasons.push(k.startsWith('t:') ? 'ticket appears twice for this date in the image' : 'place appears twice for this date in the image');
    }

    for (const d of rows) {
        if (d.outcome === 'rejected') continue;
        const cmp = compareWinner(d.row, existing);
        if (cmp.status === 'complete') { d.outcome = 'duplicate'; d.winnerId = cmp.existingId; continue; }
        if (d.outcome === 'outside-window') continue;
        if (cmp.status !== 'missing') {
            d.outcome = 'rejected';
            d.reasons.push(cmp.status === 'incomplete' ? 'existing winner record is incomplete; correct it in admin'
                : 'conflicts with existing winner (' + cmp.conflicts.join(', ') + ')');
            continue;
        }
        const prize = identifyPrize(d.row.prize, d.row.drawDate, schedule);
        if (!prize) {
            d.outcome = 'rejected';
            d.prizeMatch = fold(d.row.prize ?? '').length < 3 ? 'none' : 'unmatched';
            d.reasons.push('prize or column header must identify exactly one approved scheduled prize; review required');
            continue;
        }
        d.prizeMatch = 'scheduled';
        const scheduledPosition = calendarPosition(prize, schedule);
        const position = d.row.position ?? scheduledPosition;
        if (position === null || (scheduledPosition !== null && position !== scheduledPosition)) {
            d.outcome = 'rejected';
            d.reasons.push('place is missing or conflicts with the approved drawing schedule; review required');
            continue;
        }
        const holder = existing.find(w => w.drawDate === d.row.drawDate && parseWinnerPrize(w.prize ?? null).position === position);
        if (holder) { d.outcome = 'rejected'; d.reasons.push(`${ordinal(position)} for ${d.row.drawDate} already belongs to another winner`); continue; }
        d.prize = composePrize(position, prize.description);
        d.winnerId = winnerId(d.row.drawDate, Number(d.row.ticketNumber));
    }

    const placements = new Map<string, RowDecision[]>();
    for (const d of rows.filter(d => d.outcome === 'insert')) {
        const key = `${d.row.drawDate}:${parseWinnerPrize(d.prize).position}`;
        placements.set(key, [...(placements.get(key) ?? []), d]);
    }
    for (const list of placements.values()) if (list.length > 1) for (const d of list) {
        d.outcome = 'rejected'; d.reasons.push('multiple new winners match the same scheduled place');
    }

    const inserted = rows.filter(d => d.outcome === 'insert').length, rejected = rows.filter(d => d.outcome === 'rejected').length;
    const status = inserted && rejected ? 'partial' : inserted ? 'published' : rejected ? 'rejected'
        : rows.some(d => d.outcome === 'duplicate') ? 'duplicate' : 'ignored';
    return { status, reasons: status === 'ignored' ? ['no rows for the current drawing window'] : [], rows };
}

export async function loadContext(db: D1Database, months: string[]) {
    const existing: ExistingWinner[] = [], schedule: ScheduledPrize[] = [];
    for (const month of [...new Set(months)]) {
        const res = await db.prepare(`SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize
            FROM raffle_winners WHERE raffle_key=?`).bind(month).all<ExistingWinner>();
        existing.push(...res.results);
        try { schedule.push(...await prizeSchedule(db, month)); } catch { /* No calendar: new winners stay held for review. */ }
    }
    return { existing, schedule };
}

/**
 * Atomically writes the decision. Each insert is conditional, so a winner entered manually (or by a concurrent run)
 * between decision and write turns into a recorded duplicate instead of an error or overwrite.
 */
export async function writeDecision(db: D1Database, photo: { photoId: string; postId: string; sha256: string | null;
    width: number | null; height: number | null; model: string | null; passes: Extraction[] }, decision: PhotoDecision, publish: boolean) {
    const statements = [];
    for (const d of decision.rows) {
        const row = JSON.stringify(d.row);
        if (d.outcome === 'insert' && publish) {
            const month = d.row.drawDate.slice(0, 7);
            const ticket = Number(d.row.ticketNumber);
            const place = parseWinnerPrize(d.prize).position;
            statements.push(db.prepare(`INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text)
                SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM raffle_winners WHERE raffle_key=? AND draw_date=? AND (ticket_number=? OR prize LIKE ?))
                ON CONFLICT DO NOTHING`).bind(d.winnerId, month, d.row.drawDate, ticket,
                d.row.name, d.row.town, d.prize, d.row.ticketNumber, month, d.row.drawDate, ticket,
                place === null ? null : ordinal(place) + '%'));
            statements.push(db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
                SELECT ?,?,CASE WHEN changes()=1 THEN 'inserted' WHEN w.id IS NOT NULL THEN 'duplicate' ELSE 'rejected' END,
                    w.id,?,CASE WHEN w.id IS NULL THEN ? ELSE '[]' END,?
                FROM (SELECT 1) LEFT JOIN raffle_winners w ON w.raffle_key=? AND w.draw_date=? AND w.ticket_number=?
                WHERE true
                ON CONFLICT(photo_id, row_number) DO UPDATE SET outcome=excluded.outcome, winner_id=excluded.winner_id, prize=excluded.prize, reasons_json=excluded.reasons_json, row_json=excluded.row_json`)
                .bind(photo.photoId, d.rowNumber, d.prize, JSON.stringify(['scheduled place became unavailable before publication']),
                    row, month, d.row.drawDate, ticket));
        } else {
            const outcome = d.outcome === 'insert' ? 'held' : d.outcome;
            statements.push(db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
                VALUES (?,?,?,?,?,?,?) ON CONFLICT(photo_id, row_number) DO UPDATE SET outcome=excluded.outcome, winner_id=excluded.winner_id, prize=excluded.prize, reasons_json=excluded.reasons_json, row_json=excluded.row_json`)
                .bind(photo.photoId, d.rowNumber, outcome, d.winnerId, d.prize, JSON.stringify(d.reasons), row));
        }
    }
    const status = !publish && decision.rows.some(d => d.outcome === 'insert') ? 'held' : decision.status;
    statements.push(db.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, image_sha256, image_width, image_height, model, extraction_json, reasons_json)
        SELECT ?,?,CASE
            WHEN ? IN ('published','partial') AND inserted=0 THEN CASE WHEN rejected>0 THEN 'rejected' ELSE 'duplicate' END
            WHEN ? IN ('published','partial') AND rejected>0 THEN 'partial' ELSE ? END,?,?,?,?,?,?
        FROM (SELECT count(*) FILTER (WHERE outcome='inserted') AS inserted, count(*) FILTER (WHERE outcome='rejected') AS rejected
            FROM raffle_photo_auto_rows WHERE photo_id=?) WHERE true
        ON CONFLICT(photo_id) DO UPDATE SET status=excluded.status, image_sha256=excluded.image_sha256,
        image_width=excluded.image_width, image_height=excluded.image_height, model=excluded.model, extraction_json=excluded.extraction_json,
        reasons_json=excluded.reasons_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE raffle_photo_auto_imports.status='failed' RETURNING status`)
        .bind(photo.photoId, photo.postId, status, status, status, photo.sha256, photo.width, photo.height, photo.model,
            JSON.stringify(photo.passes).slice(0, 200000), JSON.stringify(decision.reasons), photo.photoId));
    const results = await db.batch<{ status: string }>(statements);
    return results.at(-1)?.results[0]?.status ?? status;
}

export async function recordPhotoFailure(db: D1Database, photoId: string, postId: string, code: string) {
    await db.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, reasons_json) VALUES (?,?,'failed',?)
        ON CONFLICT(photo_id) DO UPDATE SET reasons_json=excluded.reasons_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE raffle_photo_auto_imports.status='failed'`).bind(photoId, postId, JSON.stringify([code])).run();
}

export async function photoAlreadyFinal(db: D1Database, photoId: string) {
    const row = await db.prepare(`SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(photoId).first<{ status: string }>();
    return !!row && row.status !== 'failed';
}

// ---- Durable post queue shared by the webhook, the polling fallback and admin requeues ----
export type QueueSource = 'webhook' | 'poll' | 'admin';
const BACKOFF_MINUTES = [1, 2, 5, 10, 30, 60];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

export async function enqueuePost(db: D1Database, postId: string, source: QueueSource, requeue = false) {
    if (!/^\d{1,40}_\d{1,40}$/.test(postId)) throw Error('invalid-post-id');
    const result = await db.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source) VALUES (?,?)
        ON CONFLICT(post_id) DO UPDATE SET source=excluded.source, status='queued', attempts=0, next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        locked_until=NULL, error_code=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE ? AND raffle_photo_auto_posts.status IN ('done','ignored','failed','retry')`).bind(postId, source, requeue ? 1 : 0).run();
    return result.meta.changes === 1;
}

/** Lease-based claim: concurrent webhook and cron runs can never process one post twice at the same time. */
export async function claimPost(db: D1Database, postId: string, now = new Date(), leaseSeconds = 180) {
    const until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const res = await db.prepare(`UPDATE raffle_photo_auto_posts SET status='processing', locked_until=?, attempts=attempts+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE post_id=? AND (status IN ('queued','retry') AND next_attempt_at<=?
        OR status='processing' AND locked_until<?)`).bind(until, postId, now.toISOString(), now.toISOString()).run();
    return res.meta.changes === 1;
}
export async function duePosts(db: D1Database, now = new Date(), limit = 5) {
    const res = await db.prepare(`SELECT post_id AS postId FROM raffle_photo_auto_posts WHERE (status IN ('queued','retry') AND next_attempt_at<=?)
        OR (status='processing' AND locked_until<?) ORDER BY next_attempt_at LIMIT ?`).bind(now.toISOString(), now.toISOString(), limit).all<{ postId: string }>();
    return res.results.map(r => r.postId);
}
export async function finishPost(db: D1Database, postId: string, status: 'done' | 'ignored') {
    await db.prepare(`UPDATE raffle_photo_auto_posts SET status=?, locked_until=NULL, error_code=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE post_id=?`).bind(status, postId).run();
}
/** Transient failures retry with backoff; after MAX_ATTEMPTS the post is parked as failed for admin requeue. */
export async function failPost(db: D1Database, postId: string, code: string, now = new Date(), retryAfterSeconds = 0, permanent = false) {
    const row = await db.prepare(`SELECT attempts FROM raffle_photo_auto_posts WHERE post_id=?`).bind(postId).first<{ attempts: number }>();
    const attempts = row?.attempts ?? MAX_ATTEMPTS;
    const delay = Math.max(retryAfterSeconds, BACKOFF_MINUTES[Math.min(attempts, MAX_ATTEMPTS) - 1] * 60);
    await db.prepare(`UPDATE raffle_photo_auto_posts SET status=?, error_code=?, locked_until=NULL, next_attempt_at=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE post_id=?`)
        .bind(permanent || attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', code.slice(0, 120), new Date(now.getTime() + delay * 1000).toISOString(), postId).run();
}
export const validPostId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,40}_\d{1,40}$/.test(v) && v.split('_').every(numericId);
