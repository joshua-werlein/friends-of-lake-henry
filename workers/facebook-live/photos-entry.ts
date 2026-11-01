/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { photoService, type PhotoEnv } from './photos';
export { default } from './index';

/** Private RPC only: no fetch handler, no public URL, no token in Pages or browser. */
export class PhotoImports extends WorkerEntrypoint<PhotoEnv> {
    async discover(source?: string) {
        try { return await photoService(this.env).discover(source); }
        catch { throw Error('Photo discovery unavailable. Check Page access and supported source URL.'); }
    }
    async extract(photoId: string, monthHint: string) {
        try { return await photoService(this.env).extract(photoId, monthHint); }
        catch { throw Error('Photo extraction unavailable. Check Page access, image availability, AI binding and model license.'); }
    }
}
