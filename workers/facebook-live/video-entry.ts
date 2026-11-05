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

import { inspectGraph, inspectOriginMetadata } from './inspect';
export class LiveDiagnostics extends WorkerEntrypoint<Env> { async inspect() { return inspectGraph(this.env); } async inspectOrigin(){return inspectOriginMetadata(this.env);} }

export { FacebookPhotoReads } from './photo-reads';

import {discoverLivestreams} from './livestream';
import {inDiscoveryWindow} from '../../src/lib/server/raffle-discovery-schedule';
export class LiveEvents extends WorkerEntrypoint<Env> {
    async notify(id:string) {
        if(!inDiscoveryWindow(new Date())||this.env.FB_AUTOMATION_ENABLED!=='true') return {accepted:false};
        if(!/^[a-f0-9]{64}$/.test(id)||!this.env.DISCOVERY_SCHEDULER) throw Error('invalid-event');
        const ns=this.env.DISCOVERY_SCHEDULER;
        const response=await ns.get(ns.idFromName('november-2026')).fetch('https://discovery.internal/event',{method:'POST',body:id});
        if(!response.ok) throw Error('event-queue-unavailable');
        return response.json();
    }
    /** Explicit administrator diagnostic: no scheduler calls, state writes or publication. */
    async testDiscovery() {
        const previous=this.env.CONFIG?await this.env.CONFIG.get('raffle_live_automatic'):null;
        const state=this.env.CONFIG?await this.env.CONFIG.get('raffle_live_automation_state'):null;
        const prior=(state?JSON.parse(state).lastLiveObservation:null)??(previous?JSON.parse(previous):null);
        const result=await discoverLivestreams({token:this.env.FB_PAGE_ACCESS_TOKEN??'',prior});
        return {status:result.ok?'checked':'error',checkedAt:new Date().toISOString(),selectionChanged:false,result};

    }
}
