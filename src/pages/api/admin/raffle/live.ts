import type { APIRoute } from "astro";
import type { KVNamespace } from "@cloudflare/workers-types";
import { json } from "../../../../lib/http";
import { normalizeFacebookVideoUrl, parseLiveConfig, RAFFLE_LIVE_KEY, type LiveConfig } from "../../../../lib/facebook";
import { loadRaffleSelection, readRecord, verificationValid, VERIFICATION_KEY } from '../../../../lib/server/raffle-selection';

import { raffleSeason, type SeasonEnv } from '../../../../lib/server/raffle-season';

type Env = SeasonEnv & { CONFIG?: KVNamespace; RAFFLE_AUTOMATIC_SELECTION_ENABLED?: string };

export const GET: APIRoute = async (context) => {
    const env = context.locals.runtime?.env as Env | undefined;
    if (!env?.CONFIG) return json({ ok: false, error: "KV not bound (CONFIG)" }, 500);
    const selection = await loadRaffleSelection(env.CONFIG, env.RAFFLE_AUTOMATIC_SELECTION_ENABLED === 'true', new Date(), env);
    return json({ ok: true, config: selection.manualConfig, selectionMode: selection.selectionMode,
        automaticAllowed: selection.automaticAllowed, source: selection.source, reason: selection.reason });
};

export const POST: APIRoute = async (context) => {
    const env = context.locals.runtime?.env as Env | undefined;
    if (!env?.CONFIG) return json({ ok: false, error: "KV not bound (CONFIG)" }, 500);
    let body: unknown;
    try { body = await context.request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
    if (body && typeof body === 'object' && 'action' in body && body.action === 'setMode') {
        const mode = 'selectionMode' in body ? body.selectionMode : null;
        if (mode !== 'manual' && mode !== 'automatic') return json({ ok: false, error: 'Select Manual or Automatic.' }, 400);
        if (mode === 'automatic') {
            if (env.RAFFLE_AUTOMATIC_SELECTION_ENABLED !== 'true') return json({ ok: false, error: 'Automatic selection is not enabled for this deployment. Manual selection is unchanged.' }, 409);
            if (!verificationValid(await env.CONFIG.get(VERIFICATION_KEY), new Date(), raffleSeason(env))) return json({ ok: false, error: 'The tagged-video selection policy and rollback must be approved before Automatic mode is enabled.' }, 409);
        }
        const raw = await env.CONFIG.get(RAFFLE_LIVE_KEY);
        const stored = readRecord(raw);
        if (raw !== null && (!stored || !('latestVideoUrl' in stored) || (stored.latestVideoUrl !== null && (typeof stored.latestVideoUrl !== 'string' || !normalizeFacebookVideoUrl(stored.latestVideoUrl))))) return json({ ok: false, error: 'Saved manual configuration is invalid. Save the manual video first.' }, 409);
        const record = stored ?? { latestVideoUrl: null, updatedAt: null };
        await env.CONFIG.put(RAFFLE_LIVE_KEY, JSON.stringify({ ...record, selectionMode: mode }));
        return json({ ok: true, config: parseLiveConfig(JSON.stringify(record)), selectionMode: mode });
    }
    if (body && typeof body === 'object' && 'action' in body && body.action !== 'saveVideo') return json({ ok: false, error: 'Unknown action' }, 400);
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
    // Every save, even an unchanged URL or deliberate blank, explicitly restores Manual.
    // Mode and manual fallback live in one record. Automation never writes this key.
    const config: LiveConfig = { latestVideoUrl, updatedAt: new Date().toISOString() };
    await env.CONFIG.put(RAFFLE_LIVE_KEY, JSON.stringify({ ...readRecord(stored), ...config, selectionMode: 'manual' }));
    return json({ ok: true, config, selectionMode: 'manual' });
};
