import type { APIRoute } from 'astro';
import type { KVNamespace } from '@cloudflare/workers-types';
import { json } from '../../../lib/http';
import { freshSelectionFrom, loadRaffleSelection } from '../../../lib/server/raffle-selection';

import { loadPresentation } from '../../../lib/video-presentation';
import type { SeasonEnv } from '../../../lib/server/raffle-season';
import {liveDay} from '../../../lib/server/raffle-discovery-schedule';

// At most one report per selection per isolate; DO deduplicates across isolates/viewers.
const reported=new Set<string>();

// Read-only resolver. Default-off gate + explicit admin mode + verified healthy data.
export const GET: APIRoute = async ({ locals }) => {
    const env = locals.runtime?.env as SeasonEnv & { CONFIG?: KVNamespace; RAFFLE_AUTOMATIC_SELECTION_ENABLED?: string;
        FACEBOOK_LIVE?:{recordDiagnostic(value:unknown):Promise<unknown>;selection?():Promise<unknown>} } | undefined;
    if (!env?.CONFIG) return json({ ok: false, error: 'Live settings unavailable' }, 503);
    try {
        const now = new Date();
        const selection = await loadRaffleSelection(env.CONFIG, env.RAFFLE_AUTOMATIC_SELECTION_ENABLED === 'true', now, env, freshSelectionFrom(env.FACEBOOK_LIVE));
        const presentation=await loadPresentation(env.CONFIG, selection.config.latestVideoUrl, selection.videoMetadata);
        const at=Date.now(), metadata=selection.videoMetadata as {videoId?:string}|undefined;
        const key=metadata?.videoId+':'+selection.config.updatedAt;
        if(selection.source==='automatic' && liveDay(new Date(at)) && metadata?.videoId && env.FACEBOOK_LIVE && locals.runtime?.ctx && !reported.has(key)){
            if(reported.size>=32)reported.clear();
            reported.add(key);
            locals.runtime.ctx.waitUntil(Promise.resolve().then(()=>env.FACEBOOK_LIVE!.recordDiagnostic({stage:'public-visible',at,
                videoId:metadata.videoId,observedAt:selection.config.updatedAt,reason:selection.readPath})).catch(()=>{reported.delete(key);}));
        }
        return json({ ok: true, config: selection.config, selectionMode: selection.selectionMode,
            source: selection.source, reason: selection.reason, presentation, refreshMs: selection.refreshMs });
    } catch {
        return json({ ok: false, error: 'Live settings unavailable' }, 503);
    }
};
