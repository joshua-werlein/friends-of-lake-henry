// Disposable built-site preview. No Wrangler config, remote IDs, secrets or persistence.
// Run npm run build, then node tests/local-preview.mjs. Ctrl+C discards all data.
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';

const workerFiles = await readdir('dist/_worker.js', { recursive: true });
const modules = ['index.js', ...workerFiles.filter(f => f !== 'index.js' && /\.(mjs|js)$/.test(f))]
    .map(f => ({ type: 'ESModule', path: `dist/_worker.js/${f.replaceAll('\\', '/')}` }));
const mf = new Miniflare({
    modules, modulesRoot: 'dist/_worker.js', scriptPath: 'dist/_worker.js/index.js',
    compatibilityDate: '2025-09-15', compatibilityFlags: ['nodejs_compat', 'disable_nodejs_process_v2'],
    host: '127.0.0.1', port: 8788,
    d1Databases: ['DB'], kvNamespaces: ['CONFIG', 'SESSION'], r2Buckets: ['PHOTOS_BUCKET'],
    d1Persist: false, kvPersist: false, r2Persist: false,
    bindings: { ADMIN_USERNAME: 'preview', ADMIN_PASSWORD: 'local-preview-only' },
    serviceBindings: { ASSETS: async request => {
        const pathname = new URL(request.url).pathname;
        if (pathname.includes('..') || pathname.includes('_worker.js')) return new Response('Not found', { status: 404 });
        try {
            const bytes = await readFile(`dist${pathname}`);
            const type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.png') ? 'image/png' : 'application/octet-stream';
            return new Response(bytes, { headers: { 'Content-Type': type } });
        } catch { return new Response('Not found', { status: 404 }); }
    } },
});
const DB = await mf.getD1Database('DB');
for (const file of ['migrations/001_schema.sql', 'migrations/migrations/00x_raffle_poster.sql']) {
    const sql = (await readFile(file, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(s => s.trim())) await DB.prepare(statement).run();
}
await DB.prepare("INSERT INTO events (id,title,kind,status,date_start) VALUES ('preview-event','Local preview event','Event','published','2026-11-01T23:00:00Z')").run();
await DB.prepare("INSERT INTO donors (name,amount_cents) VALUES ('Local preview donor',2500)").run();
await DB.prepare("INSERT INTO raffle_winners (id,raffle_key,draw_date,ticket_number,winner_name,town,prize) VALUES ('preview-winner','2026-11','2026-11-01',999,'Local preview winner','Blair','1st place — Sample prize')").run();
console.log(`Disposable preview ready: ${await mf.ready}`);
console.log('Local login only: preview / local-preview-only');
process.on('SIGINT', async () => { await mf.dispose(); process.exit(); });
