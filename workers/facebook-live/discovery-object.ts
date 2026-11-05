/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import { DiscoveryCoordinator } from './coordinator';
import type { Env } from './poller';

/** Private singleton. No public routes and no discovery in fetch(). */
export class DiscoveryScheduler extends DurableObject<Env> {
    private coordinator = new DiscoveryCoordinator(this.ctx.storage, this.env);
    async fetch(request:Request): Promise<Response> {
        if(new URL(request.url).pathname==='/event' && request.method==='POST') {
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
