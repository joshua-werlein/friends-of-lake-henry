import type { APIRoute } from 'astro';
import type { KVNamespace } from '@cloudflare/workers-types';
import { json } from '../../../../lib/http';
import { dimensions, videoId } from '../../../../lib/video-presentation';

// Existing middleware provides admin session authorization and same-origin CSRF.
export const GET: APIRoute = async ({ request, locals }) => {
    const store = (locals.runtime?.env as { CONFIG?: KVNamespace } | undefined)?.CONFIG;
    const id = videoId(new URL(request.url).searchParams.get('videoUrl'));
    if (!store || !id) return json({ ok: false, error: 'Select a valid video first.' }, 400);
    let value = null;
    try { value = JSON.parse(await store.get(`raffle_video_presentation:${id}`) ?? 'null'); } catch { /* safe fallback */ }
    return json({ ok: true, override: value?.override ?? 'auto' });
};
export const POST: APIRoute = async ({ request, locals }) => {
    const store = (locals.runtime?.env as { CONFIG?: KVNamespace } | undefined)?.CONFIG;
    let body;
    if (Number(request.headers.get('content-length')) > 32768) return json({ ok: false, error: 'Settings too large.' }, 413);
    try { const text = await request.text(); if (text.length > 32768) throw Error(); body = JSON.parse(text); }
    catch { return json({ ok: false, error: 'Invalid settings.' }, 400); }
    const id = videoId(typeof body?.videoUrl === 'string' ? body.videoUrl : null);
    if (!store || !id || !['auto', 'portrait', 'landscape'].includes(body.override)) return json({ ok: false, error: 'Select a valid video and layout.' }, 400);
    let saved = {};
    try { saved = JSON.parse(await store.get(`raffle_video_presentation:${id}`) ?? '{}'); } catch { /* replace invalid presentation only */ }
    const d = body.metadata ? dimensions(body.metadata) : null;
    if (body.metadata && (body.metadata.id !== id || !d)) return json({ ok: false, error: 'Metadata must match this video and contain unambiguous format dimensions or media.image dimensions.' }, 400);
    // All fields are whitelisted; the selected URL, mode and timestamp are untouched.
    const old = dimensions({ format: [saved] });
    await store.put(`raffle_video_presentation:${id}`, JSON.stringify({ videoId: id, override: body.override, ...(d ?? old ?? {}) }));
    return json({ ok: true });
};
