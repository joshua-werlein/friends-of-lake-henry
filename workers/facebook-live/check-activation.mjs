import { readFile } from 'node:fs/promises';
import { checkVideoDeployment } from './check-video-deployment.mjs';
import { checkDeployment } from './check-deployment.mjs';
import { verificationValid } from '../../src/lib/server/raffle-selection.ts';
import { raffleSeason } from '../../src/lib/server/raffle-season.ts';

export const EVENING_CRONS = ['50-59 23 * 11 *', '* 0-1 * 11,12 *'];
/** Separate activation review; the original disabled-only deployment guard stays intact. */
export function checkActivation(config, receipt, account, approval, now = new Date()) {
    if (approval !== 'page-video-live-origin-v3') throw Error('Explicit approval of the Page livestream policy is required.');
    if (!config.durable_objects || !config.migrations) throw Error('The singleton discovery coordinator is required to prevent overlapping checks.');
    // Every minute 5:50-7:59 PM Central (23:50-01:59 UTC) in November: backup discovery until 6:15 PM, alert delivery until 8 PM.
    if (config.vars?.FB_AUTOMATION_ENABLED !== 'true' || config.vars?.FB_VIDEO_PROBE_ENABLED !== 'true'
        || JSON.stringify(config.triggers?.crons) !== JSON.stringify(EVENING_CRONS)) throw Error('Activation requires exactly the November evening Crons and both reviewed flags.');
    const check = config.main === 'video-entry.ts' ? checkVideoDeployment : checkDeployment;
    check({ ...config, vars: { ...config.vars, FB_AUTOMATION_ENABLED: 'false', FB_VIDEO_PROBE_ENABLED: 'false' },
        triggers: { crons: [] } }, account, 'existing-approved');
    if (!verificationValid(JSON.stringify(receipt), now, raffleSeason(config.vars))) throw Error('A current reviewed policy/playback/rollback receipt is required.');
    return true;
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/check-activation.mjs')) {
    try {
        const [configPath, receiptPath] = process.argv.slice(2);
        if (!configPath || !receiptPath) throw Error('Pass reviewed activation config and non-secret receipt paths. No deployment is performed.');
        checkActivation(JSON.parse(await readFile(configPath, 'utf8')), JSON.parse(await readFile(receiptPath, 'utf8')),
            process.env.FB_TARGET_ACCOUNT_ID, process.env.FB_ACTIVATION_APPROVAL);
        console.log('Offline activation preflight passed. Independently verify deployed bindings, secret, single Cron ownership and explicit publish approval.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
