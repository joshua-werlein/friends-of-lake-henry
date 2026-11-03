import { readFile } from 'node:fs/promises';
import { checkDeployment } from './check-deployment.mjs';
export function checkVideoDeployment(config, account, profile = 'existing-approved') {
    if (config.main !== 'video-entry.ts') throw Error('The explicit private video verification entry is required.');
    return checkDeployment({ ...config, main: 'index.ts' }, account, profile);
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/check-video-deployment.mjs')) {
    try {
        const config = JSON.parse(await readFile(new URL('./wrangler.video.existing-account.json', import.meta.url), 'utf8'));
        checkVideoDeployment(config, process.env.FB_TARGET_ACCOUNT_ID);
        console.log('Video-only private verification preflight passed; polling/probes, Cron and public routes remain disabled.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
