/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import { DiscoveryCoordinator } from './coordinator';
import type { Env } from './poller';

/** Private singleton. No public routes and no discovery in fetch(). */
export class DiscoveryScheduler extends DurableObject<Env> {
    private coordinator = new DiscoveryCoordinator(this.ctx.storage, this.env);
    async fetch(request:Request): Promise<Response> {
        const url=new URL(request.url);
        // Read-only drawing timeline for administrators (service binding only; the DO has no public route).
        if(url.pathname==='/timeline' && request.method==='GET') return Response.json({timeline:await this.coordinator.timeline(url.searchParams.get('day')??'')});
        if(url.pathname==='/alerts/claim' && request.method==='POST') return Response.json(await this.coordinator.claimAlerts());
        if(url.pathname==='/alerts/result' && request.method==='POST') {
            const body=await request.json() as {id?:unknown;key?:unknown;result?:unknown};
            if(typeof body.id!=='string'||typeof body.key!=='string'||!body.result||typeof body.result!=='object') return new Response(null,{status:400});
            return Response.json({applied:await this.coordinator.recordAlert(body.id,body.key,body.result as never)});
        }
        if(url.pathname==='/event' && request.method==='POST') {
            const id=await request.text();return Response.json({accepted:await this.ctx.blockConcurrencyWhile(()=>this.coordinator.event(id))});
        }
        await this.coordinator.kick();
        return new Response(null, { status: 204 });
    }
    async alarm(): Promise<void> {
        const result = await this.coordinator.alarm();
        console.log(JSON.stringify({ component: 'facebook-live', ...result }));
    }
}
