// Separate opt-in profile. The existing disabled Live-only config and guard remain intact.
import { readFile } from 'node:fs/promises';
import { checkDeployment } from './check-deployment.mjs';
export function checkPhotoDeployment(config, account, profile = 'existing-approved') {
    if (config.main !== 'photos-entry.ts' || JSON.stringify(config.ai) !== JSON.stringify({binding:'AI'})
        || config.vars?.FB_PHOTO_IMPORT_ENABLED !== 'false' || config.vars?.FB_VISION_MODEL_LICENSE_ACCEPTED !== 'false') throw Error('Initial photo deployment requires the explicit private RPC entry, AI binding, disabled imports and unconfirmed license flag.');
    const base = structuredClone(config);
    delete base.ai;
    delete base.vars.FB_PHOTO_IMPORT_ENABLED;
    delete base.vars.FB_VISION_MODEL_LICENSE_ACCEPTED;
    base.main='index.ts';
    return checkDeployment(base,account,profile);
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/check-photo-deployment.mjs')) {
    try {
        const profile=process.argv[2]??'existing-approved';
        const file=profile==='existing-approved'?'./wrangler.photos.existing-account.json':'./wrangler.photos.json';
        const config=JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'));
        checkPhotoDeployment(config,process.env.FB_TARGET_ACCOUNT_ID,profile);
        console.log('Offline photo preflight passed. Imports, video polling and Cron are disabled. Verify private service binding, storage migration and model terms before activation.');
    } catch(error) { console.error(error.message);process.exitCode=1; }
}
