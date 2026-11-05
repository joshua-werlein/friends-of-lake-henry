import { readFile } from 'node:fs/promises';
import { checkVideoDeployment } from './check-video-deployment.mjs';
import { checkDeployment } from './check-deployment.mjs';
import { verificationValid } from '../../src/lib/server/raffle-selection.ts';
import { raffleSeason } from '../../src/lib/server/raffle-season.ts';

/** Separate activation review; the original disabled-only deployment guard stays intact. */
export function checkActivation(config, receipt, account, approval, now = new Date()) {
    if (approval !== 'page-video-live-origin-v3') throw Error('Explicit approval of the Page livestream policy is required.');
    if (!config.durable_objects || !config.migrations) throw Error('The singleton discovery coordinator is required to prevent overlapping checks.');
    if (config.vars?.FB_AUTOMATION_ENABLED !== 'true' || config.vars?.FB_VIDEO_PROBE_ENABLED !== 'true'
        || JSON.stringify(config.triggers?.crons) !== JSON.stringify(['* * * * *'])) throw Error('Activation requires exactly one every-minute Cron and both reviewed flags.');
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
