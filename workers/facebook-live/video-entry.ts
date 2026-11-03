/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { verifyAndStage } from './diagnostics';
import type { Env } from './poller';
export { default } from './index';
export { DiscoveryScheduler } from './discovery-object';

/** Account-authenticated service binding only; no HTTP route or secret export. */
export class VideoVerification extends WorkerEntrypoint<Env> {
    async verifyAndStage(expectedVideoId: string) {
        try { return await verifyAndStage(this.env, expectedVideoId); }
        catch { return { ok: false, status: 'verification-storage-or-runtime-failure' }; }
    }
}
