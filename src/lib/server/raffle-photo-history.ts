import type { D1Database } from '@cloudflare/workers-types';
import { reviewContext, REVIEWABLE } from './raffle-photo-review';

// Paged history for Admin > Raffle > Photo imports. Read-only: nothing is deleted or summarised away; every photo, row and
// review stays in raffle_photo_auto_imports / raffle_photo_auto_rows / raffle_photo_row_resolutions.
//
// "Needs review" means a photo still has a held or rejected row with no administrator resolution (migration 010). A photo whose
// held/rejected rows were all resolved is "completed", like every other photo. Photo-level outcomes with no rows (an image-wide
// rejection, a failed download) offer nothing to approve or resolve here, so they are completed history; their posts can still be
// requeued from the Posts list.

export type HistoryFilter = 'needs-review' | 'completed' | 'all';
export const FILTERS: readonly HistoryFilter[] = ['needs-review', 'completed', 'all'];
export const PAGE_SIZE = 20, MAX_PAGE_SIZE = 50, MAX_QUERY = 48;
// D1 refuses LIKE patterns over 50 bytes ("LIKE or GLOB pattern too complex"), so every pattern is kept within it.
const MAX_PATTERN_BYTES = 50;
const bytes = (v: string) => new TextEncoder().encode(v).length;
export type PhotoSummary = { photoId: string; postId: string; status: string; createdAt: string; reasons: string[];
    firstDrawDate: string | null; lastDrawDate: string | null; rows: number; published: number; unresolved: number; resolved: number };

async function resolutionsAvailable(db: D1Database) {
    try { await db.prepare('SELECT 1 FROM raffle_photo_row_resolutions LIMIT 1').first(); return true; } catch { return false; }
}
const parse = (v: string | null) => { try { return JSON.parse(v ?? '[]'); } catch { return []; } };
const like = (v: string) => v.replace(/[\\%_]/g, c => '\\' + c);

/**
 * Search terms: a photo or post ID (any part), a drawing date (2026-11-16, 2026-11, or 11/16 and 11/16/2026), or part of a
 * winner name as the AI read it. Returns the SQL condition on photo `i` and its binds, or null for no search.
 */
export function searchCondition(q: string): { sql: string; binds: string[] } | null {
    let text = [...q.trim()].slice(0, MAX_QUERY).join('');
    while (text && bytes('%' + like(text.toLowerCase()) + '%') > MAX_PATTERN_BYTES) text = [...text].slice(0, -1).join('');
    if (!text) return null;
    const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
    const date = slash ? `${slash[3] ?? '%'}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}` : /^\d{4}(?:-\d{2}){0,2}$/.test(text) ? like(text) + '%' : null;
    const any = '%' + like(text.toLowerCase()) + '%';
    const conditions = [`i.photo_id LIKE ? ESCAPE '\\'`, `i.post_id LIKE ? ESCAPE '\\'`,
        `EXISTS (SELECT 1 FROM raffle_photo_auto_rows x WHERE x.photo_id=i.photo_id AND lower(json_extract(x.row_json,'$.name')) LIKE ? ESCAPE '\\')`];
    const binds = [any, any, any];
    if (date) {
        conditions.push(`EXISTS (SELECT 1 FROM raffle_photo_auto_rows x WHERE x.photo_id=i.photo_id AND json_extract(x.row_json,'$.drawDate') LIKE ? ESCAPE '\\')`);
        binds.push(date);
    }
    return { sql: '(' + conditions.join(' OR ') + ')', binds };
}

/** One page of photo summaries plus the count for each filter (with the same search). Aggregated in D1; no row bodies are sent. */
export async function photoSummaries(db: D1Database, options: { filter?: unknown; q?: unknown; page?: unknown; pageSize?: unknown }) {
    const filter: HistoryFilter = FILTERS.includes(options.filter as HistoryFilter) ? options.filter as HistoryFilter : 'needs-review';
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(String(options.pageSize ?? PAGE_SIZE), 10) || PAGE_SIZE));
    const requested = Math.max(1, Number.parseInt(String(options.page ?? 1), 10) || 1);
    const q = typeof options.q === 'string' ? options.q.trim().slice(0, MAX_QUERY) : '';
    const available = await resolutionsAvailable(db);
    const search = searchCondition(q);
    // Without migration 010 nothing can have been resolved, so every held/rejected row is outstanding.
    const resolutionJoin = available ? 'LEFT JOIN raffle_photo_row_resolutions r ON r.photo_id=a.photo_id AND r.row_number=a.row_number' : 'LEFT JOIN (SELECT NULL AS id) r ON 0';
    const summary = `SELECT i.photo_id AS photoId, i.post_id AS postId, i.status, i.created_at AS createdAt, i.reasons_json AS reasons,
            min(json_extract(a.row_json,'$.drawDate')) AS firstDrawDate, max(json_extract(a.row_json,'$.drawDate')) AS lastDrawDate,
            count(a.row_number) AS rows, count(*) FILTER (WHERE a.outcome='inserted') AS published,
            count(*) FILTER (WHERE a.outcome IN (${REVIEWABLE.map(() => '?').join(',')}) AND r.id IS NULL) AS unresolved, count(r.id) AS resolved
        FROM raffle_photo_auto_imports i LEFT JOIN raffle_photo_auto_rows a ON a.photo_id=i.photo_id ${resolutionJoin}
        ${search ? 'WHERE ' + search.sql : ''} GROUP BY i.photo_id`;
    const binds = [...REVIEWABLE, ...(search?.binds ?? [])];
    const counts = await db.prepare(`SELECT count(*) FILTER (WHERE unresolved>0) AS needsReview, count(*) FILTER (WHERE unresolved=0) AS completed, count(*) AS total
        FROM (${summary})`).bind(...binds).first<{ needsReview: number; completed: number; total: number }>();
    const total = filter === 'needs-review' ? counts?.needsReview ?? 0 : filter === 'completed' ? counts?.completed ?? 0 : counts?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requested, pages);
    const where = filter === 'needs-review' ? 'WHERE unresolved>0' : filter === 'completed' ? 'WHERE unresolved=0' : '';
    const result = await db.prepare(`SELECT * FROM (${summary}) ${where} ORDER BY createdAt DESC, photoId DESC LIMIT ? OFFSET ?`)
        .bind(...binds, pageSize, (page - 1) * pageSize).all<any>();
    return { filter, q, page, pages, pageSize, total, reviewAvailable: available,
        counts: { 'needs-review': counts?.needsReview ?? 0, completed: counts?.completed ?? 0, all: counts?.total ?? 0 },
        photos: result.results.map(p => ({ ...p, reasons: parse(p.reasons) })) as PhotoSummary[] };
}

/** One photo with every row, its review context (versions, resolutions, stored-winner matches) and the approved slots for its dates. */
export async function photoDetail(db: D1Database, photoId: string) {
    const photo = await db.prepare(`SELECT photo_id AS photoId, post_id AS postId, status, reasons_json AS reasons, created_at AS createdAt, updated_at AS updatedAt
        FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(photoId).first<any>();
    if (!photo) return null;
    const rows = (await db.prepare(`SELECT photo_id AS photoId, row_number AS rowNumber, outcome, winner_id AS winnerId, prize, reasons_json AS reasons, row_json AS row
        FROM raffle_photo_auto_rows WHERE photo_id=? ORDER BY row_number`).bind(photoId).all<any>()).results;
    const review = await reviewContext(db, rows);
    return { photo: { ...photo, reasons: parse(photo.reasons) }, review: { available: review.available, slots: review.slots },
        rows: rows.map(r => ({ ...r, reasons: parse(r.reasons), row: JSON.parse(r.row), ...review.rows.get(r) })) };
}

/** The latest posts for the Posts list (requeue). Same columns as the full log. */
export async function recentPosts(db: D1Database, limit = 40) {
    const posts = await db.prepare(`SELECT post_id AS postId, source, status, attempts, error_code AS errorCode, last_error_code AS lastErrorCode, last_error_at AS lastErrorAt,
        publication_status AS publicationStatus, publication_json AS publication, next_attempt_at AS nextAttemptAt, created_at AS createdAt, updated_at AS updatedAt
        FROM raffle_photo_auto_posts ORDER BY created_at DESC LIMIT ?`).bind(limit).all<any>();
    return posts.results.map(p => ({ ...p, publication: p.publication ? JSON.parse(p.publication) : null }));
}
