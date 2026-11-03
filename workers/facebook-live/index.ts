import { runPoll, type Env } from './poller';

/** No public trigger or administrative endpoint. Cron and API access default OFF. */
export default {
    async scheduled(_controller?: unknown, env: Env = {}): Promise<void> {
        const result = await runPoll(env);
        if (result.status !== 'disabled') console.log(JSON.stringify({ component: 'facebook-live', ...result }));
    },
    fetch(): Response { return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }); },
};
