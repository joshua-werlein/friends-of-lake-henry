import type { D1Database } from '@cloudflare/workers-types';
import { chicagoDate } from './raffle-photo-autopublish';
import { reviewContext, rowVersion, REVIEWABLE } from './raffle-photo-review';

// Paged history for Admin > Raffle > Photo imports. Read-only except for the audited "Mark handled" action below: nothing is
// deleted or summarised away; every photo, row and review stays in raffle_photo_auto_imports / raffle_photo_auto_rows /
// raffle_photo_row_resolutions.
//
// Filters:
// - Needs review: a photo still has a held or rejected winner row with no administrator resolution (migration 010).
// - Issues: a whole-photo problem with no winner rows to review (the photo was rejected as a whole, its processing failed, or it
//   was held as a whole) that an administrator has not marked handled since the photo last changed. A retry that fails again
//   updates the photo and reopens the issue.
// - Completed: everything else (published, duplicate, ignored, resolved rows, handled issues).
// - All: every photo.
//
// A photo-level "handled" record reuses raffle_photo_row_resolutions (no migration): row_number 0 for the first handling, then
// -1, -2 … so earlier handlings stay in the audit trail. Winner rows are numbered from 1, so the two never collide, and the
// row review refuses row numbers below 1.

export type HistoryFilter = 'needs-review' | 'issues' | 'completed' | 'all';
export const FILTERS: readonly HistoryFilter[] = ['needs-review', 'issues', 'completed', 'all'];
export const ISSUE_STATUSES = ['rejected', 'failed', 'held'] as const;
export const PAGE_SIZE = 20, MAX_PAGE_SIZE = 50, MAX_QUERY = 48;
// D1 refuses LIKE patterns over 50 bytes ("LIKE or GLOB pattern too complex"), so every pattern is kept within it.
const MAX_PATTERN_BYTES = 50;
const bytes = (v: string) => new TextEncoder().encode(v).length;
export type PhotoSummary = { photoId: string; postId: string; status: string; createdAt: string; updatedAt: string; reasons: string[];
    firstDrawDate: string | null; lastDrawDate: string | null; rows: number; published: number; unresolved: number; resolved: number;
    issue: 0 | 1; handled: 0 | 1; handledAt: string | null; postStatus: string | null; category: 'needs-review' | 'issues' | 'completed' };

async function resolutionsAvailable(db: D1Database) {
    try { await db.prepare('SELECT 1 FROM raffle_photo_row_resolutions LIMIT 1').first(); return true; } catch { return false; }
}
const parse = (v: string | null) => { try { return JSON.parse(v ?? '[]'); } catch { return []; } };
const like = (v: string) => v.replace(/[\\%_]/g, c => '\\' + c);

/**
 * Search terms: a photo or post ID (any part), a date (2026-11-16, 2026-11, or 11/16 and 11/16/2026) matching a winner row's
 * drawing date or the photo's announcement date, or part of a winner name as the AI read it. Returns the SQL condition on
 * photo `i` and its binds, or null for no search.
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
        // A photo without rows is found by its announcement date (America/Chicago is UTC-5 or UTC-6).
        conditions.push(`date(i.created_at,'-5 hours') LIKE ? ESCAPE '\\'`, `date(i.created_at,'-6 hours') LIKE ? ESCAPE '\\'`);
        binds.push(date, date, date);
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
    // Without migration 010 nothing can have been resolved or handled.
    const resolutionJoin = available ? 'LEFT JOIN raffle_photo_row_resolutions r ON r.photo_id=a.photo_id AND r.row_number=a.row_number' : 'LEFT JOIN (SELECT NULL AS id) r ON 0';
    const handledJoin = available
        ? 'LEFT JOIN (SELECT photo_id, max(created_at) AS handledAt FROM raffle_photo_row_resolutions WHERE row_number<=0 GROUP BY photo_id) h ON h.photo_id=i.photo_id'
        : 'LEFT JOIN (SELECT NULL AS photo_id, NULL AS handledAt) h ON 0';
    const rowsSummary = `SELECT i.photo_id AS photoId, i.post_id AS postId, i.status, i.created_at AS createdAt, i.updated_at AS updatedAt, i.reasons_json AS reasons,
            min(json_extract(a.row_json,'$.drawDate')) AS firstDrawDate, max(json_extract(a.row_json,'$.drawDate')) AS lastDrawDate,
            count(a.row_number) AS rows, count(*) FILTER (WHERE a.outcome='inserted') AS published,
            count(*) FILTER (WHERE a.outcome IN (${REVIEWABLE.map(() => '?').join(',')}) AND r.id IS NULL) AS unresolved, count(r.id) AS resolved,
            max(h.handledAt) AS handledAt, max(p.status) AS postStatus
        FROM raffle_photo_auto_imports i LEFT JOIN raffle_photo_auto_rows a ON a.photo_id=i.photo_id ${resolutionJoin} ${handledJoin}
        LEFT JOIN raffle_photo_auto_posts p ON p.post_id=i.post_id
        ${search ? 'WHERE ' + search.sql : ''} GROUP BY i.photo_id`;
    const summary = `SELECT s.*, CASE WHEN rows=0 AND status IN (${ISSUE_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END AS issue,
            CASE WHEN handledAt IS NOT NULL AND handledAt>=updatedAt THEN 1 ELSE 0 END AS handled FROM (${rowsSummary}) s`;
    const categorised = `SELECT c.*, CASE WHEN unresolved>0 THEN 'needs-review' WHEN issue=1 AND handled=0 THEN 'issues' ELSE 'completed' END AS category FROM (${summary}) c`;
    // Positional binds follow the SQL text: the issue CASE (outer) comes before the row summary and its search condition.
    const binds = [...ISSUE_STATUSES, ...REVIEWABLE, ...(search?.binds ?? [])];
    const counts = await db.prepare(`SELECT count(*) FILTER (WHERE category='needs-review') AS needsReview, count(*) FILTER (WHERE category='issues') AS issues,
        count(*) FILTER (WHERE category='completed') AS completed, count(*) FILTER (WHERE category='completed' AND issue=1) AS handledIssues, count(*) AS total
        FROM (${categorised})`).bind(...binds).first<{ needsReview: number; issues: number; completed: number; handledIssues: number; total: number }>();
    const byFilter = { 'needs-review': counts?.needsReview ?? 0, issues: counts?.issues ?? 0, completed: counts?.completed ?? 0, all: counts?.total ?? 0 };
    const total = byFilter[filter];
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requested, pages);
    const where = filter === 'all' ? '' : 'WHERE category=?';
    const result = await db.prepare(`SELECT * FROM (${categorised}) ${where} ORDER BY createdAt DESC, photoId DESC LIMIT ? OFFSET ?`)
        .bind(...binds, ...(filter === 'all' ? [] : [filter]), pageSize, (page - 1) * pageSize).all<any>();
    return { filter, q, page, pages, pageSize, total, reviewAvailable: available, counts: byFilter, handledIssues: counts?.handledIssues ?? 0,
        photos: result.results.map(p => ({ ...p, reasons: parse(p.reasons) })) as PhotoSummary[] };
}

/** The drawing dates a photo announced on `createdAt` may report: its America/Chicago date and the two days before. */
export const announcementWindow = (createdAt: string) => {
    const day = chicagoDate(new Date(createdAt));
    return [0, 1, 2].map(n => new Date(Date.parse(day + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10)).reverse();
};
/** Changes whenever the importer rewrites the photo record, so a stale page cannot mark it handled. */
const photoVersion = (p: { status: string; reasons: string; updatedAt: string }) => rowVersion({ outcome: p.status, prize: null, reasons: p.reasons, row: p.updatedAt, winnerId: null });

/** One photo with every row, its review context, the approved slots for its dates, and for whole-photo issues the handling history. */
export async function photoDetail(db: D1Database, photoId: string) {
    const photo = await db.prepare(`SELECT photo_id AS photoId, post_id AS postId, status, reasons_json AS reasons, created_at AS createdAt, updated_at AS updatedAt
        FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(photoId).first<any>();
    if (!photo) return null;
    const rows = (await db.prepare(`SELECT photo_id AS photoId, row_number AS rowNumber, outcome, winner_id AS winnerId, prize, reasons_json AS reasons, row_json AS row
        FROM raffle_photo_auto_rows WHERE photo_id=? ORDER BY row_number`).bind(photoId).all<any>()).results;
    const review = await reviewContext(db, rows);
    const post = await db.prepare(`SELECT status, attempts, error_code AS errorCode, last_error_code AS lastErrorCode, last_error_at AS lastErrorAt, next_attempt_at AS nextAttemptAt
        FROM raffle_photo_auto_posts WHERE post_id=?`).bind(photo.postId).first<any>();
    let handlings: any[] = [];
    if (review.available) handlings = (await db.prepare(`SELECT row_number AS rowNumber, original_outcome AS originalOutcome, note, actor, created_at AS createdAt
        FROM raffle_photo_row_resolutions WHERE photo_id=? AND row_number<=0 ORDER BY created_at DESC`).bind(photoId).all<any>()).results;
    const issue = rows.length === 0 && (ISSUE_STATUSES as readonly string[]).includes(photo.status);
    // Stored winners for the dates this announcement could cover, to help decide whether the issue was already handled by hand.
    const window = announcementWindow(photo.createdAt);
    const stored = issue ? (await db.prepare(`SELECT draw_date AS drawDate, winner_name AS name, ticket_number AS ticketNumber, prize FROM raffle_winners
        WHERE draw_date IN (?,?,?) ORDER BY draw_date, id`).bind(...window).all<any>()).results : [];
    const handled = handlings.length > 0 && handlings[0].createdAt >= photo.updatedAt;
    return { photo: { ...photo, reasons: parse(photo.reasons), version: await photoVersion(photo) }, post, review: { available: review.available, slots: review.slots },
        issue: issue ? { handled, handlings, window, storedWinners: stored } : null,
        rows: rows.map(r => ({ ...r, reasons: parse(r.reasons), row: JSON.parse(r.row), ...review.rows.get(r) })) };
}

/**
 * Mark a whole-photo issue handled (for example after entering its winners by hand or confirming nothing was drawn). Records an
 * audit row and changes nothing else: the photo keeps its importer status and reasons, and a later failure reopens the issue.
 */
export async function handlePhotoIssue(db: D1Database, body: { photoId?: unknown; version?: unknown; note?: unknown }, actor: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });
    if (typeof body.photoId !== 'string' || !/^\d{1,40}$/.test(body.photoId) || typeof body.version !== 'string' || !/^[0-9a-f]{64}$/.test(body.version))
        return fail(400, 'Reload the page before marking this photo handled.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (note.length < 3) return fail(400, 'Explain how this photo was handled (for example: winners entered manually).');
    if (!await resolutionsAvailable(db)) return fail(503, 'Apply migration 010 before marking photos handled.');
    const photo = await db.prepare(`SELECT photo_id AS photoId, status, reasons_json AS reasons, updated_at AS updatedAt,
            (SELECT count(*) FROM raffle_photo_auto_rows WHERE photo_id=i.photo_id) AS rows,
            (SELECT max(created_at) FROM raffle_photo_row_resolutions WHERE photo_id=i.photo_id AND row_number<=0) AS handledAt,
            (SELECT coalesce(min(row_number), 1) - 1 FROM raffle_photo_row_resolutions WHERE photo_id=i.photo_id AND row_number<=0) AS nextNumber
        FROM raffle_photo_auto_imports i WHERE photo_id=?`).bind(body.photoId).first<any>();
    if (!photo) return fail(404, 'This photo no longer exists. Reload the page.');
    if (photo.rows > 0 || !(ISSUE_STATUSES as readonly string[]).includes(photo.status)) return fail(409, 'This photo has no whole-photo issue to handle. Reload the page.');
    if (photo.handledAt && photo.handledAt >= photo.updatedAt) return fail(409, 'This issue was already marked handled. Reload the page.');
    if (await photoVersion(photo) !== body.version) return fail(409, 'This photo changed since the page loaded. Reload the page.');
    // Guarded insert: the photo must be exactly as reviewed; the unique (photo, row) key stops a concurrent second handling.
    try {
        const result = await db.prepare(`INSERT INTO raffle_photo_row_resolutions (photo_id, row_number, action, final_status, original_outcome, original_row_json, original_reasons_json, note, actor)
            SELECT ?,?,'resolve','resolved',?,'{}',?,?,? WHERE EXISTS (SELECT 1 FROM raffle_photo_auto_imports WHERE photo_id=? AND status=? AND updated_at=? AND reasons_json=?)
            AND NOT EXISTS (SELECT 1 FROM raffle_photo_auto_rows WHERE photo_id=?)
            AND NOT EXISTS (SELECT 1 FROM raffle_photo_row_resolutions WHERE photo_id=? AND row_number<=0 AND created_at>=?)`)
            .bind(photo.photoId, photo.nextNumber, photo.status, photo.reasons, note, actor, photo.photoId, photo.status, photo.updatedAt, photo.reasons,
                photo.photoId, photo.photoId, photo.updatedAt).run();
        if (result.meta.changes !== 1) return fail(409, 'This photo changed or was already handled. Reload the page.');
    } catch (error) {
        if (/UNIQUE|constraint/.test(String((error as Error)?.message ?? ''))) return fail(409, 'This issue was already marked handled. Reload the page.');
        throw error;
    }
    return { status: 200, body: { ok: true, photoId: photo.photoId } };
}

/** The latest posts for the Posts list (requeue). Same columns as the full log. */
export async function recentPosts(db: D1Database, limit = 40) {
    const posts = await db.prepare(`SELECT post_id AS postId, source, status, attempts, error_code AS errorCode, last_error_code AS lastErrorCode, last_error_at AS lastErrorAt,
        publication_status AS publicationStatus, publication_json AS publication, next_attempt_at AS nextAttemptAt, created_at AS createdAt, updated_at AS updatedAt
        FROM raffle_photo_auto_posts ORDER BY created_at DESC LIMIT ?`).bind(limit).all<any>();
    return posts.results.map(p => ({ ...p, publication: p.publication ? JSON.parse(p.publication) : null }));
}
