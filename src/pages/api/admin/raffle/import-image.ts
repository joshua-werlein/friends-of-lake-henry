import type { APIRoute } from 'astro';
import { json, SECURITY_HEADERS_NOSTORE } from '../../../../lib/http';
import type { ImportEnv } from './imports';
export const GET: APIRoute = async ({ locals, url }) => {
    const env = locals.runtime?.env as ImportEnv | undefined;
    if (env?.RAFFLE_PHOTO_IMPORT_ENABLED !== 'true' || !env.DB || !env.IMPORT_IMAGES) return json({ ok: false, error: 'Import images unavailable.' },503);
    const id = url.searchParams.get('id') ?? '';
    if (!/^[a-f0-9-]{36}$/.test(id)) return json({ ok: false, error: 'Invalid import ID.' },400);
    try {
    const item = await env.DB.prepare('SELECT image_key,image_mime FROM raffle_photo_imports WHERE id=?').bind(id).first<{ image_key: string; image_mime: string }>();
    if (!item?.image_key?.startsWith(`raffle-imports/${id}/`)) return json({ ok: false, error: 'Image unavailable.' },404);
    const object = await env.IMPORT_IMAGES.get(item.image_key);
    if (!object || !['image/jpeg','image/png','image/webp'].includes(item.image_mime)) return json({ ok: false, error: 'Image unavailable.' },404);
    return new Response(object.body as unknown as BodyInit, { headers: { ...SECURITY_HEADERS_NOSTORE,
        'Content-Type':item.image_mime, 'Content-Disposition':'inline', 'Cross-Origin-Resource-Policy':'same-origin' } });
    } catch { return json({ ok: false, error: 'Import image storage unavailable.' },503); }
};
