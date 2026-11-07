import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { alertConfig, runAlerts, safeDetail, resendSender, composeEnvelope, DEFAULT_ALERT_FROM } from '../src/lib/server/alerts.ts';
import { evaluatePhotoAlerts, photoSignals, recordWebhookReceipts, ACTIVE_LOAD_LIMIT, WEBHOOK_GRACE_MS } from '../workers/facebook-photos/alerts.ts';
import { liveSignals, deliverLiveAlerts, GRAPH_FAILURE_STREAK, SELECTION_GRACE_MS } from '../workers/facebook-live/alerts.ts';
import { DiscoveryCoordinator } from '../workers/facebook-live/coordinator.ts';
import { runPoll, VERIFICATION_KEY } from '../workers/facebook-live/poller.ts';
import { FACEBOOK_API_VERSION, FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_LIVE_CONTRACT, FACEBOOK_PAGE_ID, RAFFLE_LIVE_KEY } from '../src/lib/facebook.ts';

// All Resend traffic in this file is mocked. No test reads a real key or sends a real email.
const LIVE = { ALERTS_ENABLED: 'true', ALERTS_MODE: 'live', ALERT_RESEND_API_KEY: 're_test_placeholder', ALERT_EMAIL_TO: 'ops@example.test' };
const signal = (over = {}) => ({ id: 'photo:test', system: 'photo-automation', title: 'Test problem', problem: 'Something failed.', action: 'Fix it.', ...over });
const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

/** Resend-like mock: a repeated key with the same body returns the original result; a different body is a 409. */
function resendMock(behavior = () => 'ok') {
    const accepted = new Map(), calls = [], conflicts = [];
    const fetcher = async (url, init) => {
        const key = init.headers['Idempotency-Key'], body = init.body;
        calls.push({ url: String(url), key, body, init });
        const b = behavior(calls.length, { key, body });
        if (accepted.has(key)) {
            if (accepted.get(key) !== body) { conflicts.push(key); return new Response('{"name":"invalid_idempotent_request"}', { status: 409 }); }
            if (b !== 'timeout-after-accept') return new Response('{"id":"original"}', { status: 200 });
        }
        if (b === 'ok') { accepted.set(key, body); return new Response('{"id":"new"}', { status: 200 }); }
        if (b === 'timeout-after-accept') { accepted.set(key, body); throw timeoutError(); }
        if (b === 'timeout') throw timeoutError();
        if (b === 'hang') return new Promise((_, reject) => {
            // A real pending socket keeps Node alive; AbortSignal.timeout's timer alone does not (Node 20). Hold a ref'd
            // timer for exactly as long as the request is pending, and release it when the abort fires.
            const hold = setInterval(() => {}, 1000);
            init.signal.addEventListener('abort', () => { clearInterval(hold); reject(timeoutError()); }, { once: true });
        });
        if (typeof b === 'object') return new Response('{}', { status: b.status, headers: b.headers ?? {} });
        return new Response('{"message":"x"}', { status: b });
    };
    return { fetcher, calls, accepted, conflicts, emails: () => [...accepted.values()].map(b => JSON.parse(b).subject) };
}
/** In-memory incident store around runAlerts. `failSaves` names save calls (1-based) that throw. */
function harness(env = LIVE, mock = resendMock(), records = new Map()) {
    const logs = [], failSaves = new Set(); let saves = 0;
    const save = async writes => {
        saves++; if (failSaves.has(saves)) throw Error('d1 down');
        return writes.map(({ before, after }) => {
            const stored = records.get(after.id);
            const ok = before ? !!stored && JSON.stringify(stored) === JSON.stringify(before) : !stored;
            if (ok) records.set(after.id, structuredClone(after));
            return ok;
        });
    };
    const run = (signals, now, quiet, runEnv = env) => runAlerts({ env: runEnv, system: 'photo-automation', now, fetcher: mock.fetcher, log: l => logs.push(l),
        prepare: async () => ({ signals, records: [...records.values()].map(r => structuredClone(r)), quiet }), save });
    return { records, logs, run, mock, failSaves, saveCount: () => saves };
}
const T = Date.parse('2026-11-07T00:05:00Z'), at = s => new Date(T + s * 1000);

test('configuration: off by default, dry run unless live mode has a key and recipients', () => {
    assert.equal(alertConfig({}).enabled, false);
    assert.deepEqual([alertConfig({ ALERTS_ENABLED: 'true' }).mode, alertConfig({ ALERTS_ENABLED: 'true', ALERTS_MODE: 'live' }).mode], ['test', 'test']);
    const c = alertConfig({ ...LIVE, ALERT_EMAIL_TO: 'ops@example.test, not-an-email ,second@example.test' });
    assert.deepEqual([c.mode, c.to, c.from], ['live', ['ops@example.test', 'second@example.test'], DEFAULT_ALERT_FROM]);
    assert.equal(alertConfig({ ...LIVE, ALERT_EMAIL_TO: 'nobody' }).mode, 'test');
});

test('deduplication: one alert after the threshold, no repeat emails or writes while it persists, one recovery', async () => {
    const h = harness(), s = signal({ threshold: 2 });
    await h.run([s], at(0));
    assert.equal(h.mock.calls.length, 0); // First sighting: pending, no email.
    await h.run([s], at(120));
    assert.deepEqual(h.mock.emails(), ['[FOLH alert] Test problem']);
    const saves = h.saveCount();
    for (let i = 2; i < 30; i++) await h.run([s], at(i * 120)); // Scheduled polling: silent and write-free.
    assert.equal(h.saveCount(), saves);
    await h.run([], at(4000));
    assert.deepEqual(h.mock.emails(), ['[FOLH alert] Test problem', '[FOLH resolved] Test problem']);
    assert.equal(h.records.get('photo:test').status, 'resolved');
    for (let i = 0; i < 5; i++) await h.run([], at(5000 + i));
    assert.equal(h.mock.calls.length, 2);
    // The same problem later is a new incident with its own idempotency key.
    await h.run([s], at(9000)); await h.run([s], at(9120));
    assert.equal(h.mock.accepted.size, 3);
    assert.equal(new Set(h.mock.calls.map(c => c.key)).size, 3);
});

test('transient problems below the threshold close silently; informational notices never send a recovery', async () => {
    const h = harness();
    await h.run([signal({ threshold: 3 })], at(0));
    await h.run([signal({ threshold: 3 })], at(60));
    await h.run([], at(120));
    assert.equal(h.mock.calls.length, 0);
    assert.equal(h.records.get('photo:test').status, 'resolved');
    const review = signal({ id: 'photo:review:1', recovery: false });
    await h.run([review], at(200)); await h.run([], at(300));
    assert.deepEqual(h.mock.emails(), ['[FOLH alert] Test problem']);
    const slow = signal({ id: 'photo:slow', minDurationMs: 60_000 });
    await h.run([slow], at(400)); await h.run([slow], at(430));
    assert.equal(h.mock.calls.length, 1);
    await h.run([slow], at(461));
    assert.equal(h.mock.calls.length, 2);
});

test('P1 persist before send: when the incident/envelope write fails, nothing is sent', async () => {
    const h = harness();
    h.failSaves.add(1);
    const result = await h.run([signal()], at(0));
    assert.equal(result.status, 'error');
    assert.equal(h.mock.calls.length, 0);
    await h.run([signal()], at(60)); // Storage healthy again: exactly one email.
    assert.equal(h.mock.accepted.size, 1);
});

test('P1 accepted but timed out: the retry reuses the identical key and bytes, so Resend delivers it once', async () => {
    const h = harness(LIVE, resendMock(n => n === 1 ? 'timeout-after-accept' : 'ok'));
    await h.run([signal()], at(0));
    const envelope = h.records.get('photo:test').envelope;
    assert.deepEqual([envelope.uncertain, envelope.lastError, h.records.get('photo:test').notifiedAt], [true, 'resend-timeout', null]);
    await h.run([signal()], at(60)); // Before the retry time: no request.
    assert.equal(h.mock.calls.length, 1);
    await h.run([signal()], at(300));
    assert.equal(h.mock.calls.length, 2);
    assert.equal(h.mock.calls[0].key, h.mock.calls[1].key);
    assert.equal(h.mock.calls[0].body, h.mock.calls[1].body);
    assert.equal(h.mock.accepted.size, 1);
    const record = h.records.get('photo:test');
    assert.deepEqual([record.envelope, record.alertOutcome, record.ledger.map(l => l.outcome)], [null, 'delivered', ['deferred', 'delivered']]);
});

test('P1 failed save after a successful send: within the window the stored claim is resent verbatim and deduplicated', async () => {
    const h = harness();
    h.failSaves.add(3); // 1 = planned envelope, 2 = dispatch claim (both succeed), 3 = delivery result (fails).
    await h.run([signal()], at(0));
    assert.ok(h.logs.some(l => l.includes('alert-ledger-save-failed')));
    const claim = h.records.get('photo:test').envelope;
    assert.deepEqual([!!claim.dispatchedAt, claim.firstAttemptAt, claim.uncertain], [true, at(0).toISOString(), true], 'stored before the request');
    await h.run([signal()], at(120)); // Inside the claim lease: not re-sent.
    assert.equal(h.mock.calls.length, 1);
    await h.run([signal()], at(400));
    assert.equal(h.mock.calls.length, 2);
    assert.deepEqual([h.mock.calls[0].key, h.mock.calls[0].body], [h.mock.calls[1].key, h.mock.calls[1].body]);
    assert.equal(h.mock.accepted.size, 1);
    assert.equal(h.records.get('photo:test').alertOutcome, 'delivered');
    await h.run([signal()], at(800));
    assert.equal(h.mock.calls.length, 2);
});

test('P1 payload frozen: changed details and a later recovery time never alter a retried body (no 409)', async () => {
    const h = harness(LIVE, resendMock(n => n === 1 || n === 3 ? 500 : 'ok'));
    await h.run([signal({ detail: { attempts: 3 } })], at(0));
    await h.run([signal({ detail: { attempts: 4 }, problem: 'Changed wording.' })], at(300));
    assert.equal(h.mock.calls[0].body, h.mock.calls[1].body);
    assert.match(JSON.parse(h.mock.calls[1].body).text, /attempts: 3/);
    // Recovery: rendered once from the stored resolvedAt; the retry minutes later is byte-identical.
    await h.run([], at(1000));
    await h.run([], at(1500));
    assert.equal(h.mock.calls[2].body, h.mock.calls[3].body);
    assert.ok(JSON.parse(h.mock.calls[3].body).text.includes(`(${at(1000).toISOString()})`));
    assert.deepEqual(h.mock.conflicts, []);
    assert.deepEqual(h.mock.emails(), ['[FOLH alert] Test problem', '[FOLH resolved] Test problem']);
});

test('P1 24-hour key window: possibly-accepted envelopes are never resent after it; definite rejections are re-keyed', async () => {
    // First attempt may have been accepted (timeout); later attempts are definite 401s every six hours.
    let h = harness(LIVE, resendMock(n => n === 1 ? 'timeout' : 401));
    await h.run([signal()], at(0));
    for (let hours = 1; hours <= 30; hours++) await h.run([signal()], at(hours * 3600));
    const uncertain = h.records.get('photo:test');
    assert.ok(h.mock.calls.every(c => c.key === h.mock.calls[0].key && c.body === h.mock.calls[0].body), 'one key and payload, never re-keyed');
    assert.deepEqual([uncertain.envelope, uncertain.alertOutcome], [null, 'uncertain']);
    assert.ok(uncertain.ledger.some(l => l.outcome === 'uncertain-expired'));
    const lastCall = h.mock.calls.length;
    await h.run([signal()], at(40 * 3600));
    assert.equal(h.mock.calls.length, lastCall);
    // Every attempt definitely rejected: after the window a new key (v2) is safe.
    let accept = false;
    h = harness(LIVE, resendMock(() => accept ? 'ok' : 401));
    await h.run([signal()], at(0));
    for (let hours = 6; hours <= 18; hours += 6) await h.run([signal()], at(hours * 3600 + 1));
    accept = true;
    await h.run([signal()], at(25 * 3600)); // Past the 23-hour reuse limit and past the next retry time.
    const keys = [...new Set(h.mock.calls.map(c => c.key))];
    assert.equal(keys.length, 2);
    assert.match(keys[1], /:v2$/);
    assert.equal(h.mock.accepted.size, 1);
    assert.ok(h.records.get('photo:test').ledger.some(l => l.outcome === 'rekeyed'));
});

test('Resend failure classes: 5xx/timeout/409 are uncertain, 429 honors Retry-After, 4xx waits six hours; nothing throws', async () => {
    const h = harness(LIVE, resendMock(n => [{ status: 429, headers: { 'retry-after': '1800' } }, 500, 401][n - 1] ?? 'ok'));
    await h.run([signal()], at(0));
    let e = h.records.get('photo:test').envelope;
    assert.deepEqual([e.uncertain, e.lastError], [false, 'resend-429']);
    assert.ok(Date.parse(e.nextAttemptAt) >= at(1800).getTime());
    await h.run([signal()], at(1801));
    e = h.records.get('photo:test').envelope;
    assert.deepEqual([e.uncertain, e.lastError], [true, 'resend-500']);
    await h.run([signal()], at(1801 + 8 * 60));
    e = h.records.get('photo:test').envelope;
    assert.equal(e.lastError, 'resend-401');
    assert.ok(Date.parse(e.nextAttemptAt) >= at(1801 + 8 * 60 + 6 * 3600 - 1).getTime());
    const sender = resendSender(alertConfig(LIVE), async () => { throw new TypeError('network'); });
    assert.deepEqual(await sender(e), { ok: false, uncertain: true, code: 'resend-transport' });
    const conflict = resendSender(alertConfig(LIVE), async () => new Response('{}', { status: 409 }));
    assert.equal((await conflict(e)).uncertain, true);
    const broken = await runAlerts({ env: LIVE, system: 'photo-automation', now: at(0), prepare: async () => { throw Error('no such table: ops_alert_incidents'); }, save: async () => {}, log: () => {} });
    assert.equal(broken.status, 'error');
});

test('request shape: Resend API with idempotency key, sanitized body, no secrets or private data', async () => {
    const h = harness();
    await h.run([signal({ detail: { postId: '144051422124740_122333284658073310', code: 'token-expired', leaked: 'https://graph.facebook.com/x?access_token=abc', opaque: 'EAAB' + 'x1'.repeat(30) } })], at(0));
    const [{ url, init, body }] = h.mock.calls, json = JSON.parse(body);
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.headers.Authorization, 'Bearer re_test_placeholder');
    assert.equal(init.headers['Idempotency-Key'], 'folh:photo:test:2026-11-07T00:05:00.000Z:alert:live:v1');
    assert.deepEqual([json.from, json.to], [DEFAULT_ALERT_FROM, ['ops@example.test']]);
    for (const field of ['System: Winner-photo automation', 'Incident: photo:test', 'First detected: Nov 6, 2026', 'Problem: Something failed.', 'Suggested action: Fix it.', 'postId: 144051422124740_122333284658073310'])
        assert.ok(json.text.includes(field), field);
    assert.ok(!body.includes('access_token') && !body.includes('re_test') && !body.includes('EAAB'));
    assert.deepEqual(safeDetail({ 'bad key': 1, ok: '<b>x</b>' }), { ok: '-b-x-b-' });
});

test('safe test mode: never calls Resend; switching to live sends each still-open incident once', async () => {
    const env = { ALERTS_ENABLED: 'true', ALERTS_MODE: 'test', ALERT_RESEND_API_KEY: 're_test_placeholder', ALERT_EMAIL_TO: 'ops@example.test' };
    const h = harness(env);
    await h.run([signal()], at(0)); await h.run([signal()], at(60));
    assert.equal(h.mock.calls.length, 0);
    assert.ok(h.logs.some(l => l.includes('"event":"alert-test-mode"') && l.includes('[TEST]')));
    assert.ok(!h.logs.join().includes('ops@example.test'));
    const off = harness({});
    assert.equal((await off.run([signal()], at(0))).status, 'disabled');
    assert.equal(off.records.size, 0);
    const live = harness(LIVE); for (const [k, v] of h.records) live.records.set(k, v);
    await live.run([signal()], at(120)); await live.run([signal()], at(180));
    assert.equal(live.mock.accepted.size, 1);
    assert.match(live.mock.calls[0].key, /:alert:live:v1$/);
});

test('send budget: at most three emails per evaluation, the rest follow on later checks', async () => {
    const h = harness();
    const many = Array.from({ length: 5 }, (_, i) => signal({ id: 'photo:post:' + i }));
    await h.run(many, at(0)); assert.equal(h.mock.calls.length, 3);
    await h.run(many, at(120)); assert.equal(h.mock.calls.length, 5);
    await h.run(many, at(240)); assert.equal(h.mock.calls.length, 5);
});

// ---------- Winner-photo signals on the real D1 schema ----------
const PHOTO_MIGRATIONS = ['004_raffle_photo_autopublish.sql', '007_photo_import_diagnostics.sql', '008_ops_alert_incidents.sql'];
async function applyMigrations(DB, names) {
    for (const name of names) {
        const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const statement of sql.split(';').filter(v => v.trim())) await DB.prepare(statement).run();
    }
}
async function photoDb(t, migrations = PHOTO_MIGRATIONS) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    await applyMigrations(DB, migrations);
    return DB;
}
const SEASON = '2026-11-01T05:00:00.000Z';
const input = (over = {}) => ({ webhookConfigured: true, automationEnabled: true, pollError: null, seasonStart: SEASON, ...over });
const post = (DB, id, fields) => DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source, status, attempts, error_code, last_error_code, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, fields.source ?? 'webhook', fields.status, fields.attempts ?? 1, fields.code ?? null, fields.code ?? null, fields.created).run();
const iso = ms => new Date(ms).toISOString();
const tables = async DB => (await DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all()).results.map(r => r.name);

test('migration 008: additive, idempotent, D1-compatible, and its rollback leaves every other table intact', async t => {
    const DB = await photoDb(t);
    await applyMigrations(DB, ['008_ops_alert_incidents.sql']); // Re-applying is a no-op.
    assert.deepEqual(await tables(DB), ['ops_alert_incidents', 'ops_webhook_receipts', 'raffle_photo_auto_attempts', 'raffle_photo_auto_imports', 'raffle_photo_auto_posts', 'raffle_photo_auto_rows']);
    await assert.rejects(DB.prepare(`INSERT INTO ops_alert_incidents (incident_id, system, status, first_seen_at, record_json) VALUES ('x','photo-automation','bogus','t','{}')`).run());
    await post(DB, '1_1', { status: 'done', created: '2026-11-07T00:00:00Z' });
    await applyMigrations(DB, ['rollback/008_ops_alert_incidents.down.sql']);
    assert.deepEqual(await tables(DB), ['raffle_photo_auto_attempts', 'raffle_photo_auto_imports', 'raffle_photo_auto_posts', 'raffle_photo_auto_rows']);
    assert.equal((await DB.prepare(`SELECT count(*) AS n FROM raffle_photo_auto_posts`).first()).n, 1);
});

test('photo signals: absence never alerts; stuck, repeated AI, failed, auth and review problems do', async t => {
    const DB = await photoDb(t);
    const now = new Date('2026-11-07T01:00:00Z');
    assert.deepEqual((await photoSignals(DB, now, input())).signals, []); // No announcement published: nothing to report.
    await post(DB, '1_1', { status: 'queued', attempts: 0, created: '2026-11-07T00:55:00Z' });
    await post(DB, '1_2', { status: 'retry', attempts: 1, created: '2026-11-07T00:30:00Z', code: 'api-failure' });
    await post(DB, '1_3', { status: 'retry', attempts: 3, created: '2026-11-07T00:55:00Z', code: 'invalid-extraction' });
    await post(DB, '1_4', { status: 'failed', attempts: 6, created: '2026-11-07T00:00:00Z', code: 'photo-download-unavailable' });
    await post(DB, '1_5', { status: 'retry', attempts: 1, created: '2026-11-07T00:58:00Z', code: 'token-expired' });
    await post(DB, '1_6', { status: 'failed', attempts: 6, created: '2026-10-01T00:00:00Z' }); // Before the season.
    await DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, updated_at) VALUES ('9','1_7','partial','2026-11-07T00:50:00Z')`).run();
    await DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, row_json) VALUES ('9',1,'inserted','{}'),('9',2,'held','{}'),('9',3,'rejected','{}')`).run();
    await post(DB, '1_8', { status: 'done', source: 'poll', created: '2026-11-06T00:20:00Z' });
    await post(DB, '1_9', { status: 'done', source: 'poll', created: '2026-11-07T00:20:00Z' });
    const { signals } = await photoSignals(DB, now, input());
    const byId = Object.fromEntries(signals.map(s => [s.id, s]));
    // Two poll-first posts no longer imply a webhook failure: that alert is receipt-based and switched off by default.
    assert.deepEqual(Object.keys(byId).sort(), ['photo:graph-auth', 'photo:post:1_2', 'photo:post:1_3', 'photo:post:1_4', 'photo:review:9']);
    assert.match(byId['photo:post:1_3'].title, /AI extraction/);
    assert.match(byId['photo:post:1_4'].title, /stopped/);
    assert.deepEqual([byId['photo:review:9'].detail.held, byId['photo:review:9'].detail.rejected, byId['photo:review:9'].recovery], [1, 1, false]);
    assert.deepEqual([byId['photo:graph-auth'].threshold, byId['photo:graph-auth'].detail.affectedPosts], [2, 1]);
    const other = await photoSignals(DB, now, input({ webhookConfigured: false, pollError: 'permission-denied' }));
    assert.ok(other.signals.some(s => s.id === 'photo:webhook-config'));
    assert.equal(other.signals.find(s => s.id === 'photo:graph-auth').detail.code, 'permission-denied');
    // A tick outside the Graph poll window has no poll evidence: graph-auth is unknown, never a recovery.
    await DB.prepare(`DELETE FROM raffle_photo_auto_posts WHERE error_code='permission-denied' OR error_code='token-expired' OR error_code='missing-token'`).run();
    assert.ok((await photoSignals(DB, now, input({ pollRan: false }))).unknown.has('photo:graph-auth'));
    assert.ok(!(await photoSignals(DB, now, input({ pollRan: true }))).unknown.has('photo:graph-auth'));
});

test('photo alerts end to end: one email per incident across scheduled ticks, recovery once, healthy ticks write nothing', async t => {
    const DB = await photoDb(t);
    const mock = resendMock(), env = { ...LIVE, DB };
    let now = new Date('2026-11-07T01:00:00Z');
    const tick = async (minutes = 2) => { now = new Date(now.getTime() + minutes * 60_000); return evaluatePhotoAlerts(env, now, input(), mock.fetcher); };
    await tick();
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM ops_alert_incidents').first()).n, 0);
    await post(DB, '1_4', { status: 'failed', attempts: 6, created: '2026-11-07T00:00:00Z', code: 'invalid-extraction' });
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual(mock.emails(), ['[FOLH alert] Winner photo AI extraction failed repeatedly']);
    const before = await DB.prepare('SELECT updated_at FROM ops_alert_incidents').first();
    await tick();
    assert.deepEqual(await DB.prepare('SELECT updated_at FROM ops_alert_incidents').first(), before); // No write while unchanged.
    await DB.prepare(`UPDATE raffle_photo_auto_posts SET status='done' WHERE post_id='1_4'`).run();
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(mock.emails(), ['[FOLH alert] Winner photo AI extraction failed repeatedly', '[FOLH resolved] Winner photo AI extraction failed repeatedly']);
    const old = await photoDb(t, PHOTO_MIGRATIONS.slice(0, 2)); // Before migration 008: fails closed and quietly.
    await post(old, '1_4', { status: 'failed', attempts: 6, created: '2026-11-07T00:00:00Z' });
    const logs = []; const orig = console.log; console.log = l => logs.push(l);
    try { assert.equal((await evaluatePhotoAlerts({ ...LIVE, DB: old }, now, input(), mock.fetcher)).status, 'error'); } finally { console.log = orig; }
    assert.ok(logs.some(l => l.includes('alerts-unavailable')));
});

test('P2 no false recovery: a failed post pushed out of the newest-20 sample is re-checked by ID and stays open', async t => {
    const DB = await photoDb(t);
    const mock = resendMock(), env = { ...LIVE, DB };
    let now = new Date('2026-11-07T01:00:00Z');
    const tick = async () => { now = new Date(now.getTime() + 120_000); return evaluatePhotoAlerts(env, now, input(), mock.fetcher); };
    await post(DB, '1_100', { status: 'failed', attempts: 6, created: '2026-11-07T00:00:00Z', code: 'photo-download-unavailable' });
    await tick();
    assert.deepEqual(mock.emails(), ['[FOLH alert] Winner photo processing stopped']);
    // Reviewer's probe: twenty newer, fresh queue entries push the failed post out of the bounded discovery read.
    for (let i = 0; i < 20; i++) await post(DB, `1_${200 + i}`, { status: 'queued', attempts: 0, created: iso(now.getTime() + i) });
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(mock.calls.length, 1, 'no recovery while the post is still failed');
    assert.equal(JSON.parse((await DB.prepare(`SELECT record_json FROM ops_alert_incidents WHERE incident_id='photo:post:1_100'`).first()).record_json).status, 'open');
    // Actually fixed: exactly one recovery. (The fresh entries finish too, so none of them is stuck.)
    await DB.prepare(`UPDATE raffle_photo_auto_posts SET status='done'`).run();
    await tick(); await tick();
    assert.deepEqual(mock.emails(), ['[FOLH alert] Winner photo processing stopped', '[FOLH resolved] Winner photo processing stopped']);
    // A queue row that disappears entirely gives no basis for a recovery claim: it closes silently.
    await post(DB, '1_300', { status: 'failed', attempts: 6, created: '2026-11-07T00:00:01Z' });
    await tick();
    const sent = mock.calls.length;
    for (let i = 0; i < 25; i++) await post(DB, `1_${400 + i}`, { status: 'queued', attempts: 0, created: iso(now.getTime() + i) });
    await DB.prepare(`DELETE FROM raffle_photo_auto_posts WHERE post_id='1_300'`).run();
    await tick(); await tick();
    assert.equal(mock.calls.length, sent);
    assert.equal(JSON.parse((await DB.prepare(`SELECT record_json FROM ops_alert_incidents WHERE incident_id='photo:post:1_300'`).first()).record_json).status, 'resolved');
});

test('P2 active-incident load limit: an unloaded incident is left untouched and never recreated or re-emailed', async t => {
    const DB = await photoDb(t);
    const mock = resendMock(), env = { ...LIVE, DB };
    const now = new Date('2026-11-07T02:00:00Z');
    // ACTIVE_LOAD_LIMIT + 1 already-reported incidents, each for a still-failed post.
    const stmts = [];
    for (let i = 0; i <= ACTIVE_LOAD_LIMIT; i++) {
        const id = `1_${1000 + i}`, first = iso(Date.parse('2026-11-07T00:00:00Z') + i * 1000);
        // The incident beyond the limit (newest first_seen) belongs to the OLDEST post, outside the newest-20 discovery.
        const created = iso(Date.parse('2026-11-06T12:00:00Z') + (ACTIVE_LOAD_LIMIT - i) * 1000);
        stmts.push(DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source, status, attempts, created_at) VALUES (?, 'webhook', 'failed', 6, ?)`).bind(id, created));
        const record = { id: 'photo:post:' + id, system: 'photo-automation', status: 'open', occurrences: 1, firstSeenAt: first, lastSeenAt: first, notifiedAt: first, notifiedMode: 'live',
            alertOutcome: 'delivered', recoveryNotifiedAt: null, resolvedAt: null, title: 't', problem: 'p', action: 'a', detail: {}, recovery: true, envelope: null, ledger: [] };
        stmts.push(DB.prepare(`INSERT INTO ops_alert_incidents (incident_id, system, status, first_seen_at, notified_at, record_json) VALUES (?,?,?,?,?,?)`)
            .bind(record.id, record.system, 'open', first, first, JSON.stringify(record)));
    }
    await DB.batch(stmts);
    const beyond = `photo:post:1_${1000 + ACTIVE_LOAD_LIMIT}`;
    const row = () => DB.prepare(`SELECT updated_at, record_json FROM ops_alert_incidents WHERE incident_id=?`).bind(beyond).first();
    const before = await row();
    const logs = []; const orig = console.log; console.log = l => logs.push(l);
    try { for (let i = 0; i < 3; i++) await evaluatePhotoAlerts(env, new Date(now.getTime() + i * 120_000), input(), mock.fetcher); } finally { console.log = orig; }
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(await row(), before);
    assert.ok(logs.some(l => l.includes('alerts-active-limit')));
});

test('P2 webhook delivery: receipt-based, grace period, excludes admin/backfill, off by default, no false recovery on expiry', async t => {
    const DB = await photoDb(t);
    const mock = resendMock(), env = { ...LIVE, DB };
    let now = new Date('2026-11-07T00:00:00Z');
    const on = input({ webhookDeliveryAlert: true });
    const tick = async minutes => { now = new Date(now.getTime() + minutes * 60_000); return evaluatePhotoAlerts(env, now, on, mock.fetcher); };
    const ids = async flags => (await photoSignals(DB, now, flags)).signals.map(s => s.id);
    // Posts from before tracking started (backfill) never count.
    await post(DB, '1_1', { status: 'done', source: 'poll', created: '2026-11-06T20:00:00Z' });
    await post(DB, '1_2', { status: 'done', source: 'poll', created: '2026-11-06T21:00:00Z' });
    await tick(1); // Records tracking start.
    assert.deepEqual(await ids(on), []);
    // A poll-first post whose signed webhook arrived later: the receipt proves delivery regardless of queue source.
    await post(DB, '1_3', { status: 'done', source: 'poll', created: iso(now.getTime() + 60_000) });
    await recordWebhookReceipts(DB, ['1_3'], new Date(now.getTime() + 5 * 60_000));
    await post(DB, '1_4', { status: 'done', source: 'admin', created: iso(now.getTime() + 120_000) }); // Admin requeue: excluded.
    await tick(30);
    assert.deepEqual(await ids(on), []);
    // Two later announcements without any receipt, still inside the grace period: unknown, no alert.
    await post(DB, '1_5', { status: 'done', source: 'poll', created: iso(now.getTime() + 60_000) });
    await post(DB, '1_6', { status: 'done', source: 'poll', created: iso(now.getTime() + 120_000) });
    await tick(WEBHOOK_GRACE_MS / 60_000 - 1);
    assert.equal(mock.calls.length, 0);
    // Both older than the grace period and still no receipt: one alert, careful wording.
    await tick(5); await tick(2);
    assert.deepEqual(mock.emails(), ['[FOLH alert] Polling found the last two winner posts first']);
    // Switched off (the default): the same evidence never produces the signal.
    assert.ok(!(await ids(input())).includes('photo:webhook-delivery'));
    // Evidence ages out of the 7-day sample: closes silently, not as a confirmed recovery.
    now = new Date(now.getTime() + 8 * 86400_000);
    await tick(1);
    assert.equal(mock.calls.length, 1);
    assert.equal(JSON.parse((await DB.prepare(`SELECT record_json FROM ops_alert_incidents WHERE incident_id='photo:webhook-delivery'`).first()).record_json).status, 'resolved');
    // Failing again, then a real receipt on the newest eligible post: a confirmed recovery.
    await post(DB, '1_7', { status: 'done', source: 'poll', created: iso(now.getTime() - 40 * 60_000) });
    await post(DB, '1_8', { status: 'done', source: 'poll', created: iso(now.getTime() - 30 * 60_000) });
    await tick(1);
    assert.equal(mock.accepted.size, 2);
    await post(DB, '1_9', { status: 'done', source: 'poll', created: iso(now.getTime() - 20 * 60_000) });
    await recordWebhookReceipts(DB, ['1_9'], now);
    await tick(2);
    assert.deepEqual(mock.emails().slice(-1), ['[FOLH resolved] Polling found the last two winner posts first']);
});

test('photo Worker: signed webhook records a receipt without changing queue ownership; failing Resend never interrupts processing', async t => {
    const bundle = await build({ entryPoints: ['workers/facebook-photos/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
    let resend = 0, graph = 0;
    const outbound = async request => {
        const url = new URL(request.url);
        if (url.hostname === 'api.resend.com') { resend++; return new Response('{"message":"down"}', { status: 503 }); }
        graph++;
        return Response.json({ id: '144051422124740_42', message: 'Hello lake', created_time: new Date().toISOString().replace('Z', '+0000').replace(/\.\d+/, ''), attachments: { data: [] } });
    };
    const mf = new Miniflare({ workers: [
        { name: 'photos', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-09-15', d1Databases: ['DB'], outboundService: outbound,
            wrappedBindings: { AI: { scriptName: 'ai-shim' } },
            bindings: { ...LIVE, ALERT_WEBHOOK_DELIVERY_ENABLED: 'true', FB_PAGE_ACCESS_TOKEN: 'page-token', FB_APP_SECRET: 'k', FB_WEBHOOK_VERIFY_TOKEN: 'v', FB_PHOTO_AUTOMATION_ENABLED: 'true',
                FB_PHOTO_AUTOPUBLISH: 'true', FB_PHOTO_POLL_ENABLED: 'false', FB_RAFFLE_MARKER: '#LakeHenryRaffle', FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2030-12-01T00:00:00-06:00' } },
        { name: 'ai-shim', modules: true, script: `export default function(){return {async run(){throw new Error('not expected');}}}` },
    ], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB', 'photos');
    await applyMigrations(DB, PHOTO_MIGRATIONS);
    // A post the poll queued first, then its signed webhook arrives: receipt recorded, source unchanged.
    await DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source, status) VALUES ('144051422124740_41','poll','done')`).run();
    const body = JSON.stringify({ object: 'page', entry: [{ id: '144051422124740', changes: [{ field: 'feed', value: { item: 'photo', verb: 'add', post_id: '144051422124740_41' } }] }] });
    const signed = 'sha256=' + createHmac('sha256', 'k').update(body).digest('hex');
    assert.equal((await mf.dispatchFetch('https://x.test/facebook/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': signed } })).status, 200);
    assert.ok((await DB.prepare(`SELECT first_received_at FROM ops_webhook_receipts WHERE post_id='144051422124740_41'`).first())?.first_received_at);
    assert.equal((await DB.prepare(`SELECT source FROM raffle_photo_auto_posts WHERE post_id='144051422124740_41'`).first()).source, 'poll');
    // A delivery whose signature does not match its body records nothing.
    const forged = body.replace('_41', '_40');
    assert.equal((await mf.dispatchFetch('https://x.test/facebook/webhook', { method: 'POST', body: forged, headers: { 'X-Hub-Signature-256': signed } })).status, 403);
    assert.equal(await DB.prepare(`SELECT 1 FROM ops_webhook_receipts WHERE post_id='144051422124740_40'`).first(), null);

    await DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source) VALUES ('144051422124740_42','webhook')`).run();
    await post(DB, '144051422124740_43', { status: 'failed', attempts: 6, created: new Date(Date.now() - 3600_000).toISOString() });
    const worker = await mf.getWorker('photos');
    const offTick = new Date(Math.max(Date.now(), Date.parse('2026-11-07T16:10:00Z'))); offTick.setUTCMinutes(10);
    await worker.scheduled({ scheduledTime: offTick, cron: '*/2 * * * *' });
    for (let i = 0; i < 100 && (await DB.prepare(`SELECT status FROM raffle_photo_auto_posts WHERE post_id='144051422124740_42'`).first()).status !== 'ignored'; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal((await DB.prepare(`SELECT status FROM raffle_photo_auto_posts WHERE post_id='144051422124740_42'`).first()).status, 'ignored');
    assert.equal(resend, 0); // Not a poll tick: alerts not evaluated.
    const onTick = new Date(offTick); onTick.setUTCMinutes(0);
    await worker.scheduled({ scheduledTime: onTick, cron: '*/2 * * * *' });
    let incident;
    for (let i = 0; i < 100; i++) {
        incident = await DB.prepare(`SELECT record_json FROM ops_alert_incidents WHERE incident_id='photo:post:144051422124740_43'`).first();
        if (incident && JSON.parse(incident.record_json).envelope?.lastError) break;
        await new Promise(r => setTimeout(r, 50));
    }
    const record = JSON.parse(incident.record_json);
    assert.deepEqual([record.status, record.notifiedAt, record.envelope.lastError, record.envelope.uncertain], ['open', null, 'resend-503', true]);
    assert.equal(resend, 1);
    assert.equal((await DB.prepare(`SELECT status FROM raffle_photo_auto_posts WHERE post_id='144051422124740_42'`).first()).status, 'ignored');
    assert.ok(graph >= 1);
});

// ---------- Facebook Live ----------
const VIDEO = '1234567890', POST = `${FACEBOOK_GRAPH_PAGE_ID}_555`;
const atLive = (m, s = 0) => Date.UTC(2026, 10, 6, 23, 58) + (m - 58) * 60_000 + s * 1000; // m=60 is 6:00 PM Central
const liveEnv = (store, extra = {}) => ({ FB_AUTOMATION_ENABLED: 'true', FB_VIDEO_PROBE_ENABLED: 'true', FB_GRAPH_PAGE_ID: FACEBOOK_GRAPH_PAGE_ID, FB_PUBLIC_PAGE_ID: FACEBOOK_PAGE_ID,
    FB_PAGE_ACCESS_TOKEN: 'test-token', FB_ACCESS_REVISION: '1', FB_POLL_INTERVAL_SECONDS: '60', CONFIG: store,
    FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2026-12-01T00:00:00-06:00', ...extra });
const receipt = (expiresAt = '2026-12-01T05:59:00Z') => JSON.stringify({ schemaVersion: 5, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID, apiVersion: FACEBOOK_API_VERSION,
    contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '222', evidence: 'page-video-live-origin-policy-reviewed', publicPlaybackVerified: true, rollbackTested: true,
    verifiedAt: '2026-11-01T23:00:00Z', expiresAt });
const kv = (verification = receipt()) => {
    const data = new Map([[VERIFICATION_KEY, verification], [RAFFLE_LIVE_KEY, JSON.stringify({ latestVideoUrl: null, automaticEnabled: true, selectionMode: 'automatic', updatedAt: '2026-11-01T22:00:00Z' })]]);
    return { data, writes: [], reads: 0, async get(k) { this.reads++; return data.get(k) ?? null; }, async put(k, v) { this.writes.push(k); data.set(k, v); } };
};
const doStorage = () => { const data = new Map(); let alarm = null;
    return { data, alarm: () => alarm, async get(k) { return structuredClone(data.get(k)); }, async put(k, v) { data.set(k, structuredClone(v)); }, async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; } }; };
const graph = ({ now, visibleFrom = -Infinity, fail = () => false, calls }) => async request => {
    const url = new URL(String(request.url ?? request));
    calls.push(url.hostname);
    const path = url.pathname.split('/').slice(2).join('/'), time = now();
    if (fail(time)) return new Response('{}', { status: 500 });
    if (path === FACEBOOK_GRAPH_PAGE_ID) return Response.json({ id: FACEBOOK_GRAPH_PAGE_ID });
    if (path.endsWith('published_posts')) return Response.json({ data: time >= visibleFrom ? [{ id: POST, created_time: new Date(atLive(58, 48)).toISOString().replace('.000Z', '+0000'),
        attachments: { data: [{ type: 'video_inline', target: { id: VIDEO }, url: `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${VIDEO}/` }] } }] : [] });
    if (path === VIDEO && url.searchParams.get('fields') === 'id,format') return Response.json({ id: VIDEO });
    if (path === VIDEO) return Response.json({ id: VIDEO, from: { id: FACEBOOK_GRAPH_PAGE_ID }, live_status: 'LIVE', embeddable: true, published: true });
    return Response.json({ error: { code: 100 } }, { status: 400 });
};
/** The DO's claim/result routes, served by the coordinator in-process (Miniflare covers the real routes below). */
const namespace = (coordinator, options = {}) => {
    let queue = Promise.resolve(); // A Durable Object handles one storage-only request at a time.
    const serial = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
    return { idFromName: () => 'november-2026', get: () => ({ async fetch(url, init) {
        const path = new URL(url).pathname;
        if (path === '/alerts/claim') return serial(async () => { try { return Response.json(await coordinator.claimAlerts()); } catch { return new Response(null, { status: 500 }); } });
        if (path === '/alerts/result') {
            if (options.loseResults?.()) throw new TypeError('network connection lost');
            const b = JSON.parse(init.body); return serial(async () => Response.json({ applied: await coordinator.recordAlert(b.id, b.key, b.result) }));
        }
        return new Response(null, { status: 404 });
    } }) };
};
/** Runs every alarm through the drawing; the cron delivers once per minute, outside the alarm. */
async function drawing({ start = atLive(58) - 60_000, end = atLive(59 + 4), fail, verification, alertEnv = LIVE, visibleFrom = atLive(58, 48), resend = resendMock(), cron = true, loseResults } = {}) {
    let clock = start;
    const store = kv(verification), storage = doStorage(), alarmHosts = [];
    const coordinator = new DiscoveryCoordinator(storage, liveEnv(store, alertEnv), () => clock, runPoll, graph({ now: () => clock, fail, visibleFrom, calls: alarmHosts }));
    const env = { ...alertEnv, DISCOVERY_SCHEDULER: namespace(coordinator, { loseResults }) };
    const logs = [], alarms = []; const orig = console.log; console.log = l => logs.push(l);
    try {
        await storage.setAlarm(start);
        let minute = Math.floor(start / 60_000);
        while (storage.alarm() !== null && storage.alarm() < end) {
            clock = storage.alarm() + 40;
            await storage.setAlarm(null);
            const outcome = await coordinator.alarm();
            alarms.push({ at: clock, status: outcome.status });
            if (cron && Math.floor(clock / 60_000) !== minute) { minute = Math.floor(clock / 60_000); await deliverLiveAlerts(env, resend.fetcher, () => {}, 50); }
        }
    } finally { console.log = orig; }
    return { store, storage, resend, logs, alarms, alarmHosts, coordinator, env, setClock: t => { clock = t; }, clock: () => clock };
}

test('Live signals: no stream scheduled never alerts; confirmed Live without selection does after the grace period', () => {
    const now = new Date(atLive(59 + 1));
    assert.deepEqual(liveSignals(undefined, { status: 'no-eligible-video', monitor: { failures: 0, paused: false, selected: false } }, now).signals, []);
    const first = liveSignals(undefined, { status: 'verification-required', monitor: { failures: 0, paused: false, liveVideoId: VIDEO, selected: false } }, now);
    assert.equal(first.signals[0].id, 'live:selection:2026-11-06');
    assert.equal(first.signals[0].minDurationMs, SELECTION_GRACE_MS);
    assert.deepEqual(liveSignals(first.monitor, { status: 'staged', monitor: { failures: 0, paused: false, liveVideoId: VIDEO, selected: true } }, now).signals, []);
    let m;
    for (let i = 1; i <= GRAPH_FAILURE_STREAK; i++) ({ monitor: m } = liveSignals(m, { status: 'api-failure', monitor: { failures: i, paused: false, reason: 'api-failure', selected: false } }, now));
    assert.equal(liveSignals(m, { status: 'api-failure', monitor: { failures: 4, paused: false, reason: 'api-failure', selected: false } }, now).signals[0].id, 'live:graph-failures');
    assert.equal(liveSignals(undefined, { status: 'access-paused', monitor: { failures: 1, paused: true, reason: 'token-expired', selected: false } }, now).signals[0].id, 'live:access-paused');
});

test('Live drawing, healthy: no emails, unchanged selection timing, and no extra KV operations from alerts', async () => {
    const on = await drawing(), off = await drawing({ alertEnv: {} });
    assert.equal(on.resend.calls.length, 0);
    assert.deepEqual(on.store.writes, off.store.writes);
    assert.equal(on.store.reads, off.store.reads);
    assert.deepEqual(on.alarms, off.alarms);
    const timing = on.logs.map(l => JSON.parse(l)).filter(l => l.event === 'live-timing');
    assert.ok(timing.length > 10 && timing.every(l => Number.isFinite(l.wakeLagMs) && Number.isFinite(l.graphMs) && Number.isFinite(l.stateWriteMs)));
    assert.equal(timing.find(l => l.status === 'staged').alarmAt, new Date(atLive(59) + 40).toISOString());
    const timeline = await on.coordinator.timeline('2026-11-06');
    assert.deepEqual([timeline.firstLiveEvidenceAt, timeline.firstSelectedTrigger], [new Date(atLive(59) + 40).toISOString(), 'poll']);
});

test('P2 Live scheduler isolation: the alarm never contacts Resend, so hanging or failing sends cannot delay detection', async () => {
    const failing = t => t >= atLive(59) && t < atLive(59 + 2, 30);
    const quiet = await drawing({ fail: failing, alertEnv: {} });
    for (const behavior of ['hang', 500]) {
        const sim = await drawing({ fail: failing, resend: resendMock(() => behavior) });
        assert.ok(!sim.alarmHosts.includes('api.resend.com'), 'no Resend request from inside the alarm');
        assert.deepEqual(sim.alarms, quiet.alarms, `alarm schedule and outcomes identical with Resend ${behavior}`);
        assert.ok(sim.resend.calls.length >= 1, 'the cron did attempt delivery');
        // Detection healed at 6:01:45 while the alert was still unconfirmed: it counts as possibly delivered, so a
        // recovery envelope follows; it, too, is still failing. Neither was marked delivered.
        const incident = (await sim.storage.get('alerts:incidents'))['live:graph-failures'];
        assert.deepEqual([incident.status, incident.alertOutcome, incident.envelope.kind, incident.envelope.uncertain], ['recovering', 'uncertain', 'recovery', true]);
        assert.ok(incident.ledger.some(l => l.outcome === 'uncertain-expired'));
        const bodies = new Map(); for (const c of sim.resend.calls) bodies.set(c.key, [...(bodies.get(c.key) ?? []), c.body]);
        for (const list of bodies.values()) assert.equal(new Set(list).size, 1); // Each key is always sent with identical bytes.
    }
    // While a cron delivery is still waiting on a slow Resend, the next alarm runs to completion.
    let release;
    const gate = new Promise(r => { release = r; });
    const slow = resendMock(() => 'ok');
    const sim = await drawing({ fail: t => t >= atLive(59), end: atLive(59, 50), cron: false });
    assert.ok(Object.values(await sim.storage.get('alerts:incidents')).some(r => r.envelope), 'an envelope is waiting for the cron');
    const pending = deliverLiveAlerts(sim.env, async (...args) => { await gate; return slow.fetcher(...args); }, () => {}, 60_000);
    sim.setClock(atLive(59 + 1, 0) + 40);
    let alarmDone = false;
    await sim.coordinator.alarm().then(() => { alarmDone = true; });
    assert.equal(alarmDone, true, 'alarm finished while delivery was blocked');
    assert.equal(slow.calls.length, 0);
    release();
    assert.equal((await pending).sent, 1);
    assert.equal(slow.accepted.size, 1);
});

test('Live delivery from the cron: one alert during the drawing, one recovery after it heals, identical retry payloads', async () => {
    const resend = resendMock(n => n === 1 ? 'timeout-after-accept' : 'ok');
    // Graph fails from 5:59 to 6:08, long enough for the timed-out alert's four-minute retry to fall inside the outage.
    const sim = await drawing({ fail: t => t >= atLive(59) && t < atLive(59 + 9), resend, end: atLive(59 + 20) });
    assert.deepEqual(resend.emails(), ['[FOLH alert] Facebook Live detection failing repeatedly', '[FOLH resolved] Facebook Live detection failing repeatedly']);
    assert.equal(resend.calls[0].body, resend.calls[1].body); // The timed-out alert was retried verbatim and deduplicated.
    assert.equal((await sim.storage.get('alerts:incidents'))['live:graph-failures'].status, 'resolved');
});

test('Live drawing, broadcast confirmed but selection blocked (expired receipt): alert after the grace period, once', async () => {
    const sim = await drawing({ verification: receipt('2026-11-02T00:00:00Z') });
    assert.deepEqual(sim.resend.emails(), ['[FOLH alert] Live broadcast confirmed but not shown on the website']);
    assert.equal((await sim.storage.get('alerts:monitor')).evidenceVideoId, VIDEO);
    assert.equal((await sim.storage.get('alerts:incidents'))['live:selection:2026-11-06'].status, 'open');
});

test('Live Worker bundle: DO alert routes are storage-only, validate input, and have no public route', async t => {
    const b = await build({ entryPoints: ['workers/facebook-live/video-entry.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
    const mf = new Miniflare({ modules: true, script: b.outputFiles[0].text, compatibilityDate: '2025-09-15', durableObjects: { DISCOVERY_SCHEDULER: { className: 'DiscoveryScheduler', useSQLite: true } },
        durableObjectsPersist: false, kvNamespaces: ['CONFIG'], kvPersist: false, bindings: { FB_AUTOMATION_ENABLED: 'false', ...LIVE },
        outboundService: () => { throw Error('DO alert routes must not contact external services'); } });
    t.after(() => mf.dispose());
    const ns = await mf.getDurableObjectNamespace('DISCOVERY_SCHEDULER'), stub = ns.get(ns.idFromName('november-2026'));
    assert.deepEqual(await (await stub.fetch('https://discovery.internal/alerts/claim', { method: 'POST' })).json(), []);
    assert.equal((await stub.fetch('https://discovery.internal/alerts/result', { method: 'POST', body: '{"id":1}' })).status, 400);
    assert.deepEqual(await (await stub.fetch('https://discovery.internal/alerts/result', { method: 'POST', body: JSON.stringify({ id: 'live:x', key: 'k', result: { ok: true } }) })).json(), { applied: false });
    assert.equal((await mf.dispatchFetch('https://example.test/alerts/claim')).status, 404);
});

test('envelope rendering is deterministic from stored fields', () => {
    const record = { id: 'live:x', system: 'facebook-live', firstSeenAt: '2026-11-07T00:00:00.000Z', resolvedAt: '2026-11-07T00:05:00.000Z', title: 'T', problem: 'P', action: 'A', detail: { a: 1 } };
    const who = { from: DEFAULT_ALERT_FROM, to: ['ops@example.test'] };
    assert.deepEqual(composeEnvelope(record, 'recovery', 'live', '2026-11-07T00:05:00.000Z', 1, who), composeEnvelope(record, 'recovery', 'live', '2026-11-07T00:05:00.000Z', 1, who));
    assert.ok(composeEnvelope(record, 'recovery', 'live', '2026-11-08T00:00:00.000Z', 1, who).text.includes('(2026-11-07T00:05:00.000Z)'));
});

// ---------- Final release blockers: dispatch claim stored before every request ----------
const subjectCount = mock => mock.calls.length;

test('blocker 1+3: successful send, lost result save, retry 25 hours later: one email, never re-keyed', async () => {
    const h = harness();
    h.failSaves.add(3); // The send succeeds; recording its result fails.
    await h.run([signal()], at(0));
    assert.equal(h.mock.accepted.size, 1);
    const claim = h.records.get('photo:test').envelope;
    assert.deepEqual([claim.firstAttemptAt, claim.uncertain, !!claim.dispatchedAt], [at(0).toISOString(), true, true]);
    await h.run([signal()], at(25 * 3600)); // Resend has forgotten the key by now.
    assert.equal(subjectCount(h.mock), 1, 'no second request after the idempotency window');
    const record = h.records.get('photo:test');
    assert.deepEqual([record.envelope, record.alertOutcome, record.ledger.at(-1).outcome], [null, 'uncertain', 'uncertain-expired']);
    for (let hours = 26; hours < 60; hours += 6) await h.run([signal()], at(hours * 3600));
    assert.equal(subjectCount(h.mock), 1);
    assert.ok(!h.mock.calls.some(c => /:v2$/.test(c.key)));
    // Its recovery still follows exactly once (the alert was possibly delivered).
    await h.run([], at(61 * 3600));
    assert.deepEqual(h.mock.emails(), ['[FOLH alert] Test problem', '[FOLH resolved] Test problem']);
});

test('blocker 5: failed pre-send persistence of the dispatch claim means no request at all', async () => {
    const h = harness();
    h.failSaves.add(2); // Plan saved; the dispatch claim write fails.
    await h.run([signal()], at(0));
    assert.equal(h.mock.calls.length, 0);
    assert.ok(h.logs.some(l => l.includes('alert-dispatch-save-failed')));
    const e = h.records.get('photo:test').envelope;
    assert.deepEqual([e.dispatchedAt, e.firstAttemptAt, e.uncertain], [null, null, false], 'nothing recorded as attempted');
    await h.run([signal()], at(60));
    assert.equal(h.mock.accepted.size, 1);
    assert.equal(h.mock.calls.length, 1);
});

test('blocker 4: sender and recipient changes never alter a pending email; new incidents use the new configuration', async () => {
    const mock = resendMock(n => n === 1 ? 500 : 'ok'), records = new Map();
    const first = harness({ ...LIVE, ALERT_EMAIL_FROM: 'Old <alerts@friendsoflakehenry.com>', ALERT_EMAIL_TO: 'old@example.test' }, mock, records);
    await first.run([signal()], at(0));
    const changed = { ...LIVE, ALERT_EMAIL_FROM: 'New <ops@friendsoflakehenry.com>', ALERT_EMAIL_TO: 'new@example.test,other@example.test' };
    const second = harness(changed, mock, records);
    await second.run([signal(), signal({ id: 'photo:other' })], at(600));
    const [original, retry, fresh] = mock.calls;
    assert.equal(retry.key, original.key);
    assert.equal(retry.body, original.body);
    assert.deepEqual([JSON.parse(retry.body).from, JSON.parse(retry.body).to], ['Old <alerts@friendsoflakehenry.com>', ['old@example.test']]);
    assert.deepEqual([JSON.parse(fresh.body).from, JSON.parse(fresh.body).to], ['New <ops@friendsoflakehenry.com>', ['new@example.test', 'other@example.test']]);
    assert.deepEqual(mock.conflicts, []);
});

test('blocker 6: concurrent runs over the same store cannot both send (compare-and-set claim)', async () => {
    let release; const gate = new Promise(r => { release = r; });
    const mock = resendMock(), records = new Map();
    const slow = { ...resendMock(), fetcher: async (...args) => { await gate; return mock.fetcher(...args); } };
    const a = harness(LIVE, slow, records), b = harness(LIVE, slow, records);
    const runs = [a.run([signal()], at(0)), b.run([signal()], at(0)), a.run([signal()], at(0))];
    await new Promise(r => setImmediate(r));
    release();
    await Promise.all(runs);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.accepted.size, 1);
    // An already-planned envelope due for retry, claimed concurrently.
    const retryMock = resendMock(n => n === 1 ? 500 : 'ok'), shared = new Map();
    const c = harness(LIVE, retryMock, shared), d = harness(LIVE, retryMock, shared);
    await c.run([signal()], at(0));
    await Promise.all([c.run([signal()], at(600)), d.run([signal()], at(600)), c.run([signal()], at(600))]);
    assert.equal(retryMock.calls.length, 2);
    assert.equal(retryMock.accepted.size, 1);
});

test('blocker 6 on real D1: concurrent photo evaluations send each email once', async t => {
    const DB = await photoDb(t);
    let release; const gate = new Promise(r => { release = r; });
    const mock = resendMock();
    const slow = async (...args) => { await gate; return mock.fetcher(...args); };
    await post(DB, '1_4', { status: 'failed', attempts: 6, created: '2026-11-07T00:00:00Z' });
    const env = { ...LIVE, DB }, now = new Date('2026-11-07T01:00:00Z');
    const runs = [0, 1, 2].map(() => evaluatePhotoAlerts(env, now, input(), slow));
    await new Promise(r => setTimeout(r, 200));
    release();
    await Promise.all(runs);
    assert.equal(mock.calls.length, 1);
    const record = JSON.parse((await DB.prepare(`SELECT record_json FROM ops_alert_incidents WHERE incident_id='photo:post:1_4'`).first()).record_json);
    assert.equal(record.alertOutcome, 'delivered');
    // Lost result on D1, then 25 hours later: never resent.
    await post(DB, '1_5', { status: 'failed', attempts: 6, created: '2026-11-07T00:00:00Z' });
    const lossy = async (...args) => { const response = await mock.fetcher(...args);
        await DB.prepare(`CREATE TRIGGER block_result BEFORE UPDATE ON ops_alert_incidents BEGIN SELECT RAISE(ABORT, 'd1 down'); END`).run(); return response; };
    await evaluatePhotoAlerts(env, new Date('2026-11-07T02:00:00Z'), input(), lossy);
    await DB.prepare(`DROP TRIGGER block_result`).run();
    assert.equal(mock.accepted.size, 2);
    const stuck = JSON.parse((await DB.prepare(`SELECT record_json FROM ops_alert_incidents WHERE incident_id='photo:post:1_5'`).first()).record_json);
    assert.deepEqual([!!stuck.envelope.dispatchedAt, stuck.envelope.uncertain], [true, true]);
    await evaluatePhotoAlerts(env, new Date('2026-11-08T03:00:00Z'), input(), mock.fetcher);
    assert.equal(mock.calls.length, 2, 'no duplicate after 25 hours');
});

test('blocker 2+3+6 Live: lost result RPC, concurrent cron claims and a retry 25 hours later never duplicate', async () => {
    let lose = true;
    const resend = resendMock();
    // Graph fails through the burst so an alert is planned; every result report is lost.
    const sim = await drawing({ fail: t => t >= atLive(59), end: atLive(59 + 3), resend, loseResults: () => lose });
    assert.deepEqual(resend.emails(), ['[FOLH alert] Facebook Live detection failing repeatedly']);
    const first = resend.calls.length;
    const incident = (await sim.storage.get('alerts:incidents'))['live:graph-failures'];
    assert.deepEqual([!!incident.envelope.dispatchedAt, incident.envelope.uncertain, incident.envelope.firstAttemptAt !== null], [true, true, true]);
    // Concurrent cron invocations after the lease: the DO hands the claim to exactly one of them.
    sim.setClock(sim.clock() + 6 * 60_000);
    await Promise.all([deliverLiveAlerts(sim.env, resend.fetcher, () => {}, 50), deliverLiveAlerts(sim.env, resend.fetcher, () => {}, 50)]);
    assert.equal(resend.calls.length, first + 1);
    assert.equal(resend.calls.at(-1).body, resend.calls[0].body);
    assert.equal(resend.accepted.size, 1);
    // 25 hours after the first attempt: possibly delivered, so it is retired instead of resent or re-keyed.
    lose = false;
    sim.setClock(atLive(59) + 25 * 3600_000);
    await deliverLiveAlerts(sim.env, resend.fetcher, () => {}, 50);
    assert.equal(resend.calls.length, first + 1);
    const after = (await sim.storage.get('alerts:incidents'))['live:graph-failures'];
    assert.deepEqual([after.envelope, after.alertOutcome], [null, 'uncertain']);
});

test('blocker 5 Live: a failed claim write returns an error and the cron sends nothing', async () => {
    const resend = resendMock();
    const sim = await drawing({ fail: t => t >= atLive(59), end: atLive(59 + 3), resend, cron: false });
    const put = sim.storage.put;
    sim.storage.put = async () => { throw Error('storage unavailable'); };
    const result = await deliverLiveAlerts(sim.env, resend.fetcher, () => {}, 50);
    assert.deepEqual([result.status, resend.calls.length], ['error', 0]);
    sim.storage.put = put;
    await deliverLiveAlerts(sim.env, resend.fetcher, () => {}, 50);
    assert.equal(resend.accepted.size, 1);
});
