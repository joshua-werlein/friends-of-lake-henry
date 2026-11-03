// Offline preflight only; never authenticates, creates resources, uploads or deploys.
import { readFile } from 'node:fs/promises';
const raffleSeason = vars => {
    const start = Date.parse(vars?.FB_SEASON_START), end = Date.parse(vars?.FB_SEASON_END);
    return Number.isFinite(start) && Number.isFinite(end) && start < end && end - start <= 366 * 86400000;
};
export function checkDeployment(config, expectedAccount, profile = 'new-account') {
    const fields = new Set(['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'triggers', 'vars', 'kv_namespaces', 'account_id']);
    if (Object.keys(config).some(key => !fields.has(key)) || config.main !== 'index.ts') throw Error('Unexpected deployment settings or entry point. Review isolation before deployment.');
    const oldAccount = 'aa86268490e681cccb3a41a62093e2aa';
    const oldConfig = 'b70df87ff3db4230a621d4a39ab24ff7';
    if (!['new-account', 'existing-approved'].includes(profile)) throw Error('Unknown deployment profile.');
    const existing = profile === 'existing-approved';
    if (!/^[a-f0-9]{32}$/.test(expectedAccount ?? '') || /^0+$/.test(expectedAccount)
        || (existing ? expectedAccount !== oldAccount : expectedAccount === oldAccount)) throw Error('Target account does not match the explicitly selected deployment profile.');
    if (config.account_id !== expectedAccount) throw Error('Config account_id does not match the independently verified target.');
    if (config.name !== 'folh-facebook-live-discovery' || config.workers_dev !== false || config.preview_urls !== false
        || config.routes?.length || config.triggers?.crons?.length || config.vars?.FB_AUTOMATION_ENABLED !== 'false'
        || config.vars?.FB_VIDEO_PROBE_ENABLED !== 'false') throw Error('Initial deployment must have polling/probes, Cron and public routes disabled.');
    if (config.kv_namespaces?.length !== 1 || config.kv_namespaces[0].binding !== 'CONFIG') throw Error('Only an isolated CONFIG namespace is allowed.');
    const id = config.kv_namespaces[0].id;
    if (!/^[a-f0-9]{32}$/.test(id) || /^0+$/.test(id) || (existing ? id !== oldConfig : id === oldConfig)) throw Error('CONFIG must match the verified namespace for this deployment profile.');
    const vars = new Set(['FB_AUTOMATION_ENABLED', 'FB_VIDEO_PROBE_ENABLED', 'FB_GRAPH_PAGE_ID', 'FB_PUBLIC_PAGE_ID', 'FB_RAFFLE_MARKER', 'FB_POLL_INTERVAL_SECONDS', 'FB_ACCESS_REVISION', 'FB_SEASON_START', 'FB_SEASON_END']);
    if (Object.keys(config.vars ?? {}).some(key => !vars.has(key))) throw Error('Unexpected variables or inline credentials. Use an encrypted secret.');
    if (config.vars?.FB_GRAPH_PAGE_ID !== '144051422124740' || config.vars?.FB_PUBLIC_PAGE_ID !== '61552199315213'
        || config.vars?.FB_RAFFLE_MARKER !== '#LakeHenryRaffle' || !raffleSeason(config.vars)
        || config.vars?.FB_POLL_INTERVAL_SECONDS !== '60') throw Error('Verify Page identities, required hashtag, season and one-minute interval.');
    return true;
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/check-deployment.mjs')) {
    try {
        const profile = process.argv[2] ?? 'new-account';
        const file = profile === 'existing-approved' ? './wrangler.existing-account.json' : './wrangler.json';
        checkDeployment(JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8')), process.env.FB_TARGET_ACCOUNT_ID, profile);
        console.log('Offline preflight passed. Independently verify account ownership of the namespace before an approved deployment.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
