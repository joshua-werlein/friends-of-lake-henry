import type { APIRoute } from 'astro';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { json } from '../../../../lib/http';
import { draftRows, monthValid, numericId, photoUrl, hashBytes, type PhotoService } from '../../../../lib/raffle-photo-import';
import { approveImport, existingWinners, reviewRows } from '../../../../lib/server/raffle-photo-review';
import { FACEBOOK_GRAPH_PAGE_ID } from '../../../../lib/facebook';

export type ImportEnv = { DB?: D1Database; IMPORT_IMAGES?: R2Bucket; FACEBOOK_PHOTOS?: PhotoService; RAFFLE_PHOTO_IMPORT_ENABLED?: string };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const ready = (env: ImportEnv | undefined): env is ImportEnv & { DB: D1Database } => env?.RAFFLE_PHOTO_IMPORT_ENABLED === 'true' && !!env.DB;
async function detail(db: D1Database, id: string) {
    const item = await db.prepare('SELECT * FROM raffle_photo_imports WHERE id=?').bind(id).first<any>();
    if (!item) return null;
    const existing = await existingWinners(db, item.month_hint);
    return { id: item.id, photoId: item.photo_id, postId: item.post_id, sourceUrl: item.source_url, monthHint: item.month_hint,
        status: item.status, version: item.version, attempts: item.attempts, createdAt: item.created_at,
        imageUrl: item.image_key ? `/api/admin/raffle/import-image?id=${item.id}` : null,
        imageWidth: item.image_width, imageHeight: item.image_height, imageHash: item.image_sha256,
        model: item.model, error: item.error_code, extraction: JSON.parse(item.extraction_json),
        rows: reviewRows(item.rows_json, existing), existing };
}
export const GET: APIRoute = async ({ locals, url }) => {
    const env = locals.runtime?.env as ImportEnv | undefined;
    if (!ready(env)) return json({ ok: false, error: 'Photo importing is not enabled. Manual winner entry is available.' }, 503);
    try {
        const id = url.searchParams.get('id');
        if (id) {
            if (!uuid(id)) return json({ ok: false, error: 'Invalid import ID.' }, 400);
            const item = await detail(env.DB, id);
            return item ? json({ ok: true, item }) : json({ ok: false, error: 'Import not found.' }, 404);
        }
        const items = await env.DB.prepare(`SELECT id,photo_id AS photoId,month_hint AS monthHint,status,created_at AS createdAt
            FROM raffle_photo_imports ORDER BY created_at DESC LIMIT 50`).all();
        return json({ ok: true, items: items.results });
    } catch { return json({ ok: false, error: 'Import storage unavailable. Verify the additive import migration.' }, 503); }
};
async function requestBody(request: Request): Promise<Record<string, any>> {
    if (!request.headers.get('content-type')?.includes('application/json') || !request.body) throw Error('body');
    const reader = request.body.getReader(); let size = 0, text = ''; const decoder = new TextDecoder();
    try {
        while (true) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength;
            if (size > 160000) { await reader.cancel(); throw Error('body'); }
            text += decoder.decode(next.value, { stream: true });
        }
    } finally { reader.releaseLock(); }
    const value = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('body');
    return value;
}
async function extract(env: ImportEnv & { DB: D1Database }, id: string, photoId: string, month: string, version: number) {
    try {
        const capture = await env.FACEBOOK_PHOTOS!.extract(photoId, month);
        if (capture.photoId !== photoId || !(capture.bytes instanceof Uint8Array) || capture.bytes.byteLength > 8 * 1024 * 1024
            || !['image/jpeg','image/png','image/webp'].includes(capture.mime) || capture.sha256 !== await hashBytes(capture.bytes)) throw Error('capture');
        const rows = draftRows(capture.extraction.rows);
        if (typeof capture.extraction.containsWinners !== 'boolean' || (!capture.extraction.containsWinners && rows.length)) throw Error('capture');
        const key = `raffle-imports/${id}/${capture.sha256}`;
        await env.IMPORT_IMAGES!.put(key, capture.bytes, { httpMetadata: { contentType: capture.mime }, onlyIf: { etagDoesNotMatch: '*' } });
        const update = await env.DB.prepare(`UPDATE raffle_photo_imports SET status='pending', image_key=?,image_sha256=?,image_mime=?,
            image_width=?,image_height=?,model=?,extraction_json=?,rows_json=?,error_code=NULL,version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='processing' AND version=?`)
            .bind(key,capture.sha256,capture.mime,capture.width,capture.height,capture.model,JSON.stringify(capture.extraction),JSON.stringify(rows),id,version).run();
        if (update.meta.changes !== 1) throw Error('stale');
        return json({ ok: true, item: await detail(env.DB,id) });
    } catch {
        await env.DB.prepare(`UPDATE raffle_photo_imports SET status='failed',error_code='Extraction unavailable; check Page access, AI configuration or image availability.',
            version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='processing' AND version=?`).bind(id,version).run();
        return json({ ok: false, id, error: 'Extraction failed. No winners were published. Review the failed import before retrying.' }, 502);
    }
}
export const POST: APIRoute = async ({ locals, request }) => {
    const env = locals.runtime?.env as ImportEnv | undefined;
    if (!ready(env)) return json({ ok: false, error: 'Photo importing is not enabled. Manual winner entry is available.' }, 503);
    let body;
    try { body = await requestBody(request); } catch { return json({ ok: false, error: 'Invalid or oversized JSON request.' }, 400); }
    try {
        if (body.action === 'discover') {
            if (!env.FACEBOOK_PHOTOS) return json({ ok: false, error: 'Private Facebook photo service is not bound.' }, 503);
            if (body.source !== undefined && (typeof body.source !== 'string' || body.source.length > 2000)) return json({ ok: false, error: 'Invalid Facebook source.' }, 400);
            const photos = await env.FACEBOOK_PHOTOS.discover(body.source || undefined);
            return json({ ok: true, photos });
        }
        if (body.action === 'extract') {
            if (!env.FACEBOOK_PHOTOS || !env.IMPORT_IMAGES) return json({ ok: false, error: 'Private photo service or image storage is not bound.' }, 503);
            if (!numericId(body.photoId) || !monthValid(body.monthHint)) return json({ ok: false, error: 'Photo ID and correct raffle month are required.' }, 400);
            if (body.postId != null && (typeof body.postId !== 'string' || !new RegExp(`^${FACEBOOK_GRAPH_PAGE_ID}_\\d+$`).test(body.postId))) return json({ ok: false, error: 'Invalid source post.' }, 400);
            const previous = await env.DB.prepare('SELECT id FROM raffle_photo_imports WHERE photo_id=?').bind(body.photoId).first<{ id: string }>();
            if (previous) return json({ ok: true, existing: true, item: await detail(env.DB,previous.id) });
            const count = await env.DB.prepare(`SELECT count(*) AS total FROM raffle_photo_imports WHERE created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')`).first<{ total: number }>();
            if ((count?.total ?? 0) >= 12) return json({ ok: false, error: 'Import limit reached. Try again in ten minutes.' }, 429);
            const id = crypto.randomUUID();
            try { await env.DB.prepare(`INSERT INTO raffle_photo_imports(id,photo_id,post_id,source_url,month_hint,status) VALUES(?,?,?,?,?,'processing')`)
                .bind(id,body.photoId,body.postId ?? null,photoUrl(body.photoId),body.monthHint).run(); }
            catch { return json({ ok: false, error: 'Photo already queued or import storage unavailable. Refresh the import list.' }, 409); }
            return await extract(env,id,body.photoId,body.monthHint,1);
        }
        if (!uuid(body.id) || !Number.isSafeInteger(body.version)) return json({ ok: false, error: 'Import ID and version are required.' }, 400);
        if (body.action === 'save') {
            const rows = draftRows(body.rows);
            const result = await env.DB.prepare(`UPDATE raffle_photo_imports SET rows_json=?,version=version+1,
                updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='pending' AND version=?`)
                .bind(JSON.stringify(rows),body.id,body.version).run();
            if (result.meta.changes !== 1) return json({ ok: false, error: 'Draft changed or was already reviewed. Reload it.' }, 409);
        } else if (body.action === 'reject') {
            const result = await env.DB.prepare(`UPDATE raffle_photo_imports SET status='rejected',version=version+1,
                reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('pending','failed') AND version=?`)
                .bind(body.id,body.version).run();
            if (result.meta.changes !== 1) return json({ ok: false, error: 'Draft changed or was already reviewed.' }, 409);
        } else if (body.action === 'approve') {
            if (body.confirmReviewed !== true) return json({ ok: false, error: 'Confirm that the selected rows were checked against the original image.' }, 400);
            try { const result = await approveImport(env.DB,body.id,body.version,body.rows); return json({ ok: true, ...result, item: await detail(env.DB,body.id) }); }
            catch { return json({ ok: false, error: 'Approval stopped: an existing, incomplete, conflicting or changed row needs review. Refresh and select only valid new rows or verified blank-field fills. No values were overwritten.' }, 409); }
        } else if (body.action === 'retry') {
            if (!env.FACEBOOK_PHOTOS || !env.IMPORT_IMAGES) return json({ ok: false, error: 'Photo service unavailable.' }, 503);
            const item = await env.DB.prepare('SELECT photo_id,month_hint FROM raffle_photo_imports WHERE id=?').bind(body.id).first<any>();
            const result = await env.DB.prepare(`UPDATE raffle_photo_imports SET status='processing',attempts=attempts+1,version=version+1,
                updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=? AND attempts<3
                AND (status='failed' OR (status='processing' AND updated_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')))`)
                .bind(body.id,body.version).run();
            if (!item || result.meta.changes !== 1) return json({ ok: false, error: 'Import is still processing, already reviewed or reached three attempts.' }, 409);
            return await extract(env,body.id,item.photo_id,item.month_hint,body.version+1);
        } else return json({ ok: false, error: 'Unknown import action.' }, 400);
        return json({ ok: true, item: await detail(env.DB,body.id) });
    } catch { return json({ ok: false, error: 'Import service unavailable or draft data invalid. No winners were published.' }, 503); }
};
