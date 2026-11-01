import type { APIRoute } from 'astro';
import type { KVNamespace } from '@cloudflare/workers-types';
import { parseLiveConfig, RAFFLE_LIVE_KEY } from '../../../lib/facebook';
import { json } from '../../../lib/http';

// Public, read-only view of the existing manual selection. Never reads automation staging.
export const GET: APIRoute = async ({ locals }) => {
    const env = locals.runtime?.env as { CONFIG?: KVNamespace } | undefined;
    if (!env?.CONFIG) return json({ ok: false, error: 'Live settings unavailable' }, 503);
    try {
        return json({ ok: true, config: parseLiveConfig(await env.CONFIG.get(RAFFLE_LIVE_KEY)) });
    } catch {
        return json({ ok: false, error: 'Live settings unavailable' }, 503);
    }
};
