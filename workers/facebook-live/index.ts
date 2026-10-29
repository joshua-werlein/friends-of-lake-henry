import { pollBroadcasts } from '../../src/lib/server/facebook-automation';

/** Dormant shell only. No source, secrets, bindings, HTTP routes, or Cron Trigger. */
export default {
    async scheduled(): Promise<void> {
        await pollBroadcasts({ enabled: false });
    },
};
