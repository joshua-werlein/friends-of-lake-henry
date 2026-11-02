import type { APIRoute } from 'astro';
import type { KVNamespace } from '@cloudflare/workers-types';
import { json } from '../../../lib/http';
import { loadRaffleSelection } from '../../../lib/server/raffle-selection';

import { loadPresentation } from '../../../lib/video-presentation';
import type { SeasonEnv } from '../../../lib/server/raffle-season';

// Read-only resolver. Default-off gate + explicit admin mode + verified healthy data.
export const GET: APIRoute = async ({ locals }) => {
    const env = locals.runtime?.env as SeasonEnv & { CONFIG?: KVNamespace; RAFFLE_AUTOMATIC_SELECTION_ENABLED?: string } | undefined;
    if (!env?.CONFIG) return json({ ok: false, error: 'Live settings unavailable' }, 503);
    try {
        const selection = await loadRaffleSelection(env.CONFIG, env.RAFFLE_AUTOMATIC_SELECTION_ENABLED === 'true', new Date(), env);
        return json({ ok: true, config: selection.config, selectionMode: selection.selectionMode,
            source: selection.source, reason: selection.reason, presentation: await loadPresentation(env.CONFIG, selection.config.latestVideoUrl, selection.videoMetadata) });
    } catch {
        return json({ ok: false, error: 'Live settings unavailable' }, 503);
    }
};
