// Offline preflight for the separate winner-photo Worker. Never authenticates, uploads or deploys.
// Its main job is to make it impossible to aim this config at the Live discovery Worker and drop its
// DiscoveryScheduler Durable Object, migration or cron.
import { readFile } from 'node:fs/promises';
export function checkPhotoWorker(config) {
    const allowed = new Set(['$schema', 'name', 'main', 'compatibility_date', 'account_id', 'workers_dev', 'preview_urls', 'triggers', 'vars', 'd1_databases', 'ai']);
    if (Object.keys(config).some(k => !allowed.has(k))) throw Error('Unexpected settings: this Worker must not declare Durable Objects, migrations, KV or routes.');
    if (config.name !== 'folh-facebook-winner-photos') throw Error('Worker name must be folh-facebook-winner-photos; never folh-facebook-live-discovery.');
    if (config.main !== 'index.ts') throw Error('Unexpected entry point.');
    if (config.account_id !== 'aa86268490e681cccb3a41a62093e2aa') throw Error('Unexpected account.');
    if (config.preview_urls !== false) throw Error('Preview URLs must stay disabled.');
    if (JSON.stringify(config.d1_databases) !== JSON.stringify([{ binding: 'DB', database_name: 'folh-db', database_id: '527df871-e876-4924-81d0-5d0572b4dd7b' }])) throw Error('Only the folh-db D1 binding is allowed.');
    if (config.ai?.binding !== 'AI') throw Error('AI binding required.');
    const crons = config.triggers?.crons ?? [];
    if (crons.length > 1 || (crons[0] && !/^\*\/[1-9]\d? \* \* \* \*$/.test(crons[0]))) throw Error('Only one simple minute cron is expected.');
    const vars = config.vars ?? {};
    const known = new Set(['FB_PHOTO_AUTOMATION_ENABLED', 'FB_PHOTO_AUTOPUBLISH', 'FB_PHOTO_POLL_ENABLED', 'FB_PHOTO_EXTRACTION_PASSES', 'FB_RAFFLE_MARKER', 'FB_SEASON_START', 'FB_SEASON_END']);
    if (Object.keys(vars).some(k => !known.has(k))) throw Error('Unexpected variables or inline credentials; tokens and secrets must be Worker secrets.');
    if (vars.FB_RAFFLE_MARKER !== '#LakeHenryRaffle') throw Error('Raffle hashtag changed.');
    const start = Date.parse(vars.FB_SEASON_START), end = Date.parse(vars.FB_SEASON_END);
    if (!(start < end && end - start <= 62 * 86400000)) throw Error('Season must be a bounded window.');
    return true;
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/facebook-photos/check-deployment.mjs')) {
    try {
        checkPhotoWorker(JSON.parse(await readFile(new URL('./wrangler.json', import.meta.url), 'utf8')));
        console.log('Photo Worker preflight passed: separate Worker name, no Durable Object/migration changes, D1 folh-db + AI only.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
