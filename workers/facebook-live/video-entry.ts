/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { verifyAndStage } from './diagnostics';
import { pageAccessToken } from './credentials';
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
import {liveDay} from '../../src/lib/server/raffle-discovery-schedule';
import {timingEntry} from './timing';
export class LiveEvents extends WorkerEntrypoint<Env> {
    /** Private service-binding diagnostic sink. No public HTTP endpoint or scheduling side effects. */
    async recordDiagnostic(value:unknown) {
        const entry=timingEntry(value);
        if(!entry || !['webhook-received','webhook-forward','public-visible'].includes(entry.stage) || !this.env.DISCOVERY_SCHEDULER) return;
        // Bound old/replayed diagnostic input; retrieval remains available all month and afterward.
        if(Math.abs(Date.now()-entry.at)>120000) return;
        const ns=this.env.DISCOVERY_SCHEDULER;
        await ns.get(ns.idFromName('november-2026')).fetch('https://discovery.internal/diagnostic',{method:'POST',body:JSON.stringify(entry)});
    }
    async notify(id:string) {
        // Signed Live hints are accepted at any time on a November day; outside the backup window each runs one check.
        if(!liveDay(new Date())||this.env.FB_AUTOMATION_ENABLED!=='true') return {accepted:false};
        if(!/^[a-f0-9]{64}$/.test(id)||!this.env.DISCOVERY_SCHEDULER) throw Error('invalid-event');
        const ns=this.env.DISCOVERY_SCHEDULER;
        const response=await ns.get(ns.idFromName('november-2026')).fetch('https://discovery.internal/event',{method:'POST',body:id});
        if(!response.ok) throw Error('event-queue-unavailable');
        return response.json();
    }
    /** Read-only, strongly consistent automatic selection + state for the public resolver. No scheduling side effects. */
    async selection() {
        if(!this.env.DISCOVERY_SCHEDULER) return {};
        const ns=this.env.DISCOVERY_SCHEDULER;
        const response=await ns.get(ns.idFromName('november-2026')).fetch('https://discovery.internal/selection');
        if(!response.ok) throw Error('selection-unavailable');
        return response.json();
    }
    /** Read-only per-day detection timeline (first webhook, first Live evidence, first selection). */
    async timeline(day:string) {
        if(!/^2026-11-\d{2}$/.test(day)||!this.env.DISCOVERY_SCHEDULER) return {timeline:null};
        const ns=this.env.DISCOVERY_SCHEDULER;
        const response=await ns.get(ns.idFromName('november-2026')).fetch('https://discovery.internal/timeline?day='+day);
        return response.ok?response.json():{timeline:null};
    }
    /** Explicit administrator diagnostic: no scheduler calls, state writes or publication. */
    async testDiscovery() {
        const previous=this.env.CONFIG?await this.env.CONFIG.get('raffle_live_automatic'):null;
        const state=this.env.CONFIG?await this.env.CONFIG.get('raffle_live_automation_state'):null;
        const prior=(state?JSON.parse(state).lastLiveObservation:null)??(previous?JSON.parse(previous):null);
        const result=await discoverLivestreams({token:pageAccessToken(this.env)??'',prior});
        return {status:result.ok?'checked':'error',checkedAt:new Date().toISOString(),selectionChanged:false,result};

    }
}
