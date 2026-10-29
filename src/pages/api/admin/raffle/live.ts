import type { APIRoute } from "astro";
import type { KVNamespace } from "@cloudflare/workers-types";
import { json } from "../../../../lib/http";
import { normalizeFacebookVideoUrl, parseLiveConfig, RAFFLE_LIVE_KEY, type LiveConfig } from "../../../../lib/facebook";

type Env = { CONFIG?: KVNamespace };

export const GET: APIRoute = async (context) => {
    const env = context.locals.runtime?.env as Env | undefined;
    if (!env?.CONFIG) return json({ ok: false, error: "KV not bound (CONFIG)" }, 500);
    return json({ ok: true, config: parseLiveConfig(await env.CONFIG.get(RAFFLE_LIVE_KEY)) });
};

export const POST: APIRoute = async (context) => {
    const env = context.locals.runtime?.env as Env | undefined;
    if (!env?.CONFIG) return json({ ok: false, error: "KV not bound (CONFIG)" }, 500);
    let body: unknown;
    try { body = await context.request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
    if (!body || typeof body !== 'object' || !('latestVideoUrl' in body)
        || (body.latestVideoUrl !== null && typeof body.latestVideoUrl !== 'string')) {
        return json({ ok: false, error: "latestVideoUrl must be a string or null" }, 400);
    }
    const raw = (body.latestVideoUrl ?? '').trim();
    const latestVideoUrl = raw ? normalizeFacebookVideoUrl(raw) : null;
    if (raw && !latestVideoUrl) {
        return json({ ok: false, error: "Paste the full Facebook video or reel URL (videos/<id>, watch?v=<id>, or reel/<id>). Open short/share links in Facebook and copy the full video URL first." }, 400);
    }
    const stored = await env.CONFIG.get(RAFFLE_LIVE_KEY);
    const previous = parseLiveConfig(stored);
    // Even a blank manual selection is an override. Never delete this key.
    if (stored && previous.latestVideoUrl === latestVideoUrl) {
        return json({ ok: true, config: previous });
    }
    const config: LiveConfig = { latestVideoUrl, updatedAt: new Date().toISOString() };
    await env.CONFIG.put(RAFFLE_LIVE_KEY, JSON.stringify(config));
    return json({ ok: true, config });
};
