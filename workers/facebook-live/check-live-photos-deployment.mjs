// Combined live-video + private photo RPC profile. Reuses the approved activation checks unchanged
// after removing only the photo additions (entry, AI binding, two photo flags).
import { readFile } from 'node:fs/promises';
import { checkActivation } from './check-activation.mjs';
export function checkLivePhotosActivation(config, receipt, account, approval, now = new Date()) {
    const flag = v => v === 'true' || v === 'false';
    if (config.main !== 'live-photos-entry.ts' || JSON.stringify(config.ai) !== JSON.stringify({ binding: 'AI' })
        || !flag(config.vars?.FB_PHOTO_IMPORT_ENABLED) || !flag(config.vars?.FB_VISION_MODEL_LICENSE_ACCEPTED)
        || (config.vars.FB_PHOTO_IMPORT_ENABLED === 'true' && config.vars.FB_VISION_MODEL_LICENSE_ACCEPTED !== 'true'))
        throw Error('Combined profile requires the combined entry, AI binding and explicit photo flags; imports need the confirmed model license.');
    const base = structuredClone(config);
    delete base.ai;
    delete base.vars.FB_PHOTO_IMPORT_ENABLED;
    delete base.vars.FB_VISION_MODEL_LICENSE_ACCEPTED;
    base.main = 'video-entry.ts';
    return checkActivation(base, receipt, account, approval, now);
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/check-live-photos-deployment.mjs')) {
    try {
        const [configPath, receiptPath] = process.argv.slice(2);
        if (!configPath || !receiptPath) throw Error('Pass the combined config and non-secret receipt paths. No deployment is performed.');
        checkLivePhotosActivation(JSON.parse(await readFile(configPath, 'utf8')), JSON.parse(await readFile(receiptPath, 'utf8')),
            process.env.FB_TARGET_ACCOUNT_ID, process.env.FB_ACTIVATION_APPROVAL);
        console.log('Combined live-video/photo preflight passed. Video Cron and flags match the approved activation profile.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
