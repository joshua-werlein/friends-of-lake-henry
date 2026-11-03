import type { APIRoute } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { json } from '../../../../lib/http';
import { parsePhotoSource } from '../../../../lib/raffle-photo-import';
import { enqueuePost, validPostId } from '../../../../lib/server/raffle-photo-autopublish';

// Read-only log of the unattended importer plus requeue. Publication itself happens only in the photo Worker;
// a requeued post is picked up by its next cron tick (every two minutes).
const parse = (v: string | null) => { try { return JSON.parse(v ?? '[]'); } catch { return []; } };
export const GET: APIRoute = async ({ locals }) => {
    const db = (locals.runtime?.env as { DB?: D1Database } | undefined)?.DB;
    if (!db) return json({ ok: false, error: 'DB binding missing' }, 500);
    try {
        const posts = await db.prepare(`SELECT post_id AS postId, source, status, attempts, error_code AS errorCode, next_attempt_at AS nextAttemptAt,
            created_at AS createdAt, updated_at AS updatedAt FROM raffle_photo_auto_posts ORDER BY created_at DESC LIMIT 40`).all<any>();
        const imports = await db.prepare(`SELECT photo_id AS photoId, post_id AS postId, status, reasons_json AS reasons, created_at AS createdAt
            FROM raffle_photo_auto_imports ORDER BY created_at DESC LIMIT 40`).all<any>();
        const rows = await db.prepare(`SELECT r.photo_id AS photoId, r.row_number AS rowNumber, r.outcome, r.winner_id AS winnerId, r.prize,
            r.reasons_json AS reasons, r.row_json AS row FROM raffle_photo_auto_rows r
            WHERE r.photo_id IN (SELECT photo_id FROM raffle_photo_auto_imports ORDER BY created_at DESC LIMIT 40) ORDER BY r.photo_id, r.row_number`).all<any>();
        return json({ ok: true, posts: posts.results,
            imports: imports.results.map(i => ({ ...i, reasons: parse(i.reasons),
                rows: rows.results.filter(r => r.photoId === i.photoId).map(r => ({ ...r, reasons: parse(r.reasons), row: JSON.parse(r.row) })) })) });
    } catch { return json({ ok: false, error: 'Apply migration 004_raffle_photo_autopublish.sql before using photo imports.' }, 503); }
};
export const POST: APIRoute = async ({ locals, request }) => {
    const db = (locals.runtime?.env as { DB?: D1Database } | undefined)?.DB;
    if (!db) return json({ ok: false, error: 'DB binding missing' }, 500);
    let body: any;
    try { const text = await request.text(); if (text.length > 4000) throw Error(); body = JSON.parse(text); }
    catch { return json({ ok: false, error: 'Invalid request.' }, 400); }
    let postId: string | null = null;
    if (body?.action === 'requeue' && validPostId(body.postId)) postId = body.postId;
    if (body?.action === 'queue') {
        const source = parsePhotoSource(body.source);
        if (source?.kind === 'post') postId = source.id;
        else return json({ ok: false, error: 'Paste the Facebook post link (facebook.com/<page>/posts/<id> or permalink.php). Single photo links cannot be traced to their post.' }, 400);
    }
    if (!postId) return json({ ok: false, error: 'Unknown action.' }, 400);
    try {
        // A requeue re-reads photos that failed, were rejected or were held (dry run) — e.g. after correcting an
        // existing winner. Published/partial/duplicate photos stay final; any re-read row that already exists is a duplicate.
        await db.prepare(`UPDATE raffle_photo_auto_imports SET status='failed' WHERE post_id=? AND status IN ('rejected','held','ignored')`).bind(postId).run();
        const queued = await enqueuePost(db, postId, 'admin', true);
        return json({ ok: true, postId, queued });
    } catch { return json({ ok: false, error: 'Unable to queue this post.' }, 503); }
};
