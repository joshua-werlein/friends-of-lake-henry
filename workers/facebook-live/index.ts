import { type Env } from './poller';
import { inAlertDeliveryWindow, inDiscoveryWindow } from '../../src/lib/server/raffle-discovery-schedule';
import { deliverLiveAlerts } from './alerts';
type ScheduledEnv = Env & { DISCOVERY_SCHEDULER?: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } } };

/** No public trigger or administrative endpoint. Cron and API access default OFF. */
export default {
    async scheduled(_controller?: unknown, env: ScheduledEnv = {}): Promise<void> {
        const now = new Date();
        // Gate before even contacting the coordinator. Delayed cron uses actual
        // time rather than replaying controller.scheduledTime.
        if (env.FB_AUTOMATION_ENABLED === 'true' && inDiscoveryWindow(now)) {
            if (!env.DISCOVERY_SCHEDULER) throw Error('Missing discovery coordinator binding');
            const namespace = env.DISCOVERY_SCHEDULER;
            await namespace.get(namespace.idFromName('november-2026')).fetch('https://discovery.internal/kick');
        }
        // Alert emails leave from this stateless cron invocation, never from the serialized detection alarm.
        if (env.ALERTS_ENABLED === 'true' && inAlertDeliveryWindow(now)) await deliverLiveAlerts(env);
    },
    fetch(): Response { return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }); },
};
