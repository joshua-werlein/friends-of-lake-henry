// Winner-photo reading, kept apart from the Worker entry so it can be tested without the Workers runtime: enlarge the photo, read the
// announcement window plus a few anchor dates twice, and reuse any read this exact image already completed. Every AI read renews the lease.
import type { D1Database } from '@cloudflare/workers-types';
import { base64Image, visionRequest, winnerPrompt } from '../facebook-live/photos';
import { PHOTO_MODEL, draftRows, hashBytes, parseExtraction, type DraftWinner, type Extraction } from '../../src/lib/raffle-photo-import';
import { recordAttempts, renewLease, sanitizeCode, WINDOW_DAYS } from '../../src/lib/server/raffle-photo-autopublish';
import { cellPrompt, focusPrompt } from './focus';

export type ReadEnv = {
    DB: D1Database;
    AI?: { run(model: string, input: unknown): Promise<unknown> };
    /** Cloudflare Images binding: enlarges the photo outside the Worker's CPU budget. Optional: without it the original is read. */
    IMAGES?: { input(stream: ReadableStream<Uint8Array>): { transform(t: Record<string, unknown>): { output(o: Record<string, unknown>): Promise<{ response(): Response }> } } };
    FB_PHOTO_EXTRACTION_PASSES?: string;
};
const log = (event: string, detail: Record<string, string | number | boolean> = {}) => console.log(JSON.stringify({ event, ...detail }));

export type AttemptContext = { postId: string; photoId: string; attempt: number | null };
// The fallback whole-table read of a 70+ cell month table needed 8,650 output tokens (cut off mid-JSON at 8,192), so it keeps 16,384.
export const PHOTO_MAX_TOKENS = 16384;
// A window read transcribes at most ~7 date rows. Real reads cost 109-119 output tokens per cell (154 for one verbose read); 28 cells,
// more than any November night, fit with margin. Tokens are billed as generated, so the cap only stops a runaway reply.
export const WINDOW_MAX_TOKENS = 6144;
// Dates before the window that are read with it. Their stored winners let each pass prove its date-to-column association
// (columnConfirmed needs 3 per column, redatedRows needs the stored date to be read): the window's two older dates plus these four
// give up to six stored winners per daily column. The table's other rows add nothing that can publish tonight.
export const ANCHOR_DAYS = 4;
// Each pass of a 60-cell table took ~108 s (6,580 tokens); two sequential passes outlast a 180 s lease, so the next cron tick would
// reclaim a post that is still being read. The claim takes 600 s and every AI read first renews it for another 600 s (renewLease).
export const PHOTO_LEASE_SECONDS = 600;
/** Before each AI read: keep this run's lease, or stop if another run has taken the post (it will finish the work). */
async function holdLease(env: ReadEnv, context: AttemptContext) {
    if (context.attempt !== null && !(await renewLease(env.DB, context.postId, context.attempt, new Date(), PHOTO_LEASE_SECONDS))) throw Error('lease-lost');
}
// Mistral Small 3.1 encodes an image at its own resolution, about one token per 28 x 28 pixels. The Page's table arrives about
// 960 px wide with 22 px rows, so a row of small text gets under one token of height: whole-table reads of rendered Nov 28/30 tables
// kept 0 of 12 and 0 of 13 bonus cells, and the same tables enlarged 1.6x kept 11 of 12 and 12 of 13. The photo is enlarged to
// this width (aspect kept, never reduced) by the Images binding, so no decoding runs on the Worker's CPU.
const READ_WIDTH = 1540;
const MAX_READ_BYTES = 8 * 1024 * 1024;
export async function readableImage(env: ReadEnv, bytes: Uint8Array, mime: string, width: number | null, context: AttemptContext) {
    if (!env.IMAGES || !width || width >= READ_WIDTH) return { bytes, mime, enlarged: false };
    try {
        const out = await env.IMAGES.input(new Blob([bytes as BufferSource]).stream()).transform({ width: READ_WIDTH, fit: 'contain' })
            .output({ format: 'image/jpeg', quality: 90 });
        const larger = new Uint8Array(await out.response().arrayBuffer());
        if (larger.length < 3 || larger[0] !== 255 || larger[1] !== 216 || larger.length > MAX_READ_BYTES) throw Error('enlarged-image-invalid');
        return { bytes: larger, mime: 'image/jpeg', enlarged: true };
    } catch (e) {
        // The original photo is still read: enlarging only improves legibility, so its failure never blocks or retries a post.
        log('image-enlarge-failed', { ...context, attempt: context.attempt ?? 0, code: sanitizeCode(e) });
        return { bytes, mime, enlarged: false };
    }
}

// ---- Workers AI cost ----
// Published Mistral Small 3.1 rates; they reproduce every recorded neuron count exactly (e.g. 1,294 in + 796 out = 81.44).
export const NEURONS_PER_INPUT_TOKEN = 0.031876, NEURONS_PER_OUTPUT_TOKEN = 0.050488;
export const estimateNeurons = (input: number, output: number) => Math.round((input * NEURONS_PER_INPUT_TOKEN + output * NEURONS_PER_OUTPUT_TOKEN) * 10) / 10;
export type Usage = { promptTokens: number; completionTokens: number; estNeurons: number };
function usageOf(raw: unknown): Usage | null {
    const u = (raw as { usage?: Record<string, unknown> } | null)?.usage;
    const input = Number(u?.prompt_tokens), output = Number(u?.completion_tokens);
    return u && Number.isFinite(input) && Number.isFinite(output) ? { promptTokens: input, completionTokens: output, estNeurons: estimateNeurons(input, output) } : null;
}
/** Workers AI 4006: the account's daily free neuron allocation is used up. Retrying before it resets only repeats the refusal. */
export const isQuotaExhausted = (e: unknown) => /(?:^|\D)4006(?:\D|$)|daily[\s-]free[\s-]allocation|neurons/i.test(e instanceof Error ? e.message : String(e ?? ''));
export class QuotaExhausted extends Error {}

// ---- Reads, checkpointed per image ----
export type ReadKind = 'window' | 'table' | 'cell';
/** `target` (cell reads only) is the re-read cell, `date:ticket`. */
export type ReadMeta = { version: string; kind: ReadKind; pass: number; dates: string[]; enlarged: boolean; usage: Usage | null; target?: string };
export type StoredRead = Extraction & { read: ReadMeta };
export type Reads = { passes: Extraction[]; reads: StoredRead[]; aiCalls: number; reused: number; fallback: 'no-window-dates' | 'unparseable' | null };
type ReadPlan = { kind: ReadKind; pass: number; dates: string[]; prompt: string; maxTokens: number };

const shift = (iso: string, days: number) => new Date(Date.parse(iso + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
/** The anchor dates and the window's dates, oldest first, never before the announcement's month (the table's first row). */
export function readDates(announcementDate: string, anchors = ANCHOR_DAYS) {
    const span = anchors + WINDOW_DAYS;
    return Array.from({ length: span + 1 }, (_, i) => shift(announcementDate, i - span)).filter(d => d.slice(0, 7) === announcementDate.slice(0, 7));
}
const windowPlan = (dates: string[], pass: number): ReadPlan => ({ kind: 'window', pass, dates, prompt: focusPrompt(dates, pass), maxTokens: WINDOW_MAX_TOKENS });
const tablePlan = (announcementDate: string, pass: number): ReadPlan => ({ kind: 'table', pass, dates: [], prompt: winnerPrompt(announcementDate.slice(0, 7), announcementDate, pass), maxTokens: PHOTO_MAX_TOKENS });
// A stored read is reused only when the model, image width and both prompt templates are unchanged: at temperature 0 the same prompt on the
// same bytes returns the same reply (repeat production reads were identical), so reading it again costs neurons and adds no evidence.
let versionMemo: Promise<string> | null = null;
export function readVersion() {
    return versionMemo ??= hashBytes(new TextEncoder().encode(JSON.stringify([PHOTO_MODEL, READ_WIDTH, WINDOW_MAX_TOKENS, PHOTO_MAX_TOKENS,
        focusPrompt(['2000-01-01'], 0), focusPrompt(['2000-01-01'], 1), winnerPrompt('2000-01', '2000-01-01', 0), winnerPrompt('2000-01', '2000-01-01', 1)]))).then(h => h.slice(0, 16));
}
const sameRead = (r: StoredRead, plan: ReadPlan, version: string, enlarged: boolean) => r.read?.version === version && r.read.kind === plan.kind
    && r.read.pass === plan.pass && r.read.enlarged === enlarged && JSON.stringify(r.read.dates) === JSON.stringify(plan.dates);

/** Reads of this exact image (same SHA-256) left by an unfinished or requeued run. A decided photo is never reopened here. */
export async function storedReads(db: D1Database, photoId: string, sha256: string): Promise<StoredRead[]> {
    try {
        const row = await db.prepare(`SELECT extraction_json AS json FROM raffle_photo_auto_imports WHERE photo_id=? AND status='failed' AND image_sha256=?`)
            .bind(photoId, sha256).first<{ json: string }>();
        const reads = JSON.parse(row?.json ?? '[]');
        return Array.isArray(reads) ? reads.filter(r => r && typeof r === 'object' && r.read && Array.isArray(r.rows)) : [];
    } catch { return []; }
}
/** Checkpoint after every completed read, so a later failure (quota, timeout, lost lease) never pays for the same read twice. */
async function checkpoint(db: D1Database, photo: { photoId: string; postId: string } & ImageInfo, reads: StoredRead[]) {
    try {
        await db.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, image_sha256, image_width, image_height, model, extraction_json)
            VALUES (?,?,'failed',?,?,?,?,?) ON CONFLICT(photo_id) DO UPDATE SET image_sha256=excluded.image_sha256, image_width=excluded.image_width,
            image_height=excluded.image_height, model=excluded.model, extraction_json=excluded.extraction_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE raffle_photo_auto_imports.status='failed'`)
            .bind(photo.photoId, photo.postId, photo.sha256, photo.width, photo.height, PHOTO_MODEL, JSON.stringify(reads).slice(0, 200000)).run();
    } catch { /* A lost checkpoint only means the read is paid for again. */ }
}

export type ImageInfo = { sha256: string; width: number | null; height: number | null };
/**
 * Two differently instructed reads (row by row, column by column) of the announcement window and its anchor dates. They are told dates
 * only, never winners or prizes, and every existing agreement, cell-text, calendar, column and duplicate check applies to them unchanged.
 * Only when neither read finds any of those dates (a table without printed dates, or an unparseable reply) are the whole-table reads used.
 */
export async function extractPasses(env: ReadEnv, bytes: Uint8Array, mime: string, announcementDate: string, context: AttemptContext,
    image: ImageInfo | null = null, enlarged = false): Promise<Reads> {
    const passes = Math.min(3, Math.max(2, Number(env.FB_PHOTO_EXTRACTION_PASSES) || 2));
    const version = await readVersion();
    const saved = image ? await storedReads(env.DB, context.photoId, image.sha256) : [];
    const done: StoredRead[] = [];
    let dataUrl: string | null = null, aiCalls = 0, reused = 0;
    const read = async (plan: ReadPlan, passNumber: number): Promise<StoredRead | 'unparseable'> => {
        const prior = saved.find(r => sameRead(r, plan, version, enlarged));
        if (prior) {
            reused++;
            log('extraction-pass-reused', { ...context, attempt: context.attempt ?? 0, passNumber, kind: plan.kind });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'reused', detail: { kind: plan.kind, rows: prior.rows.length } }]);
            return prior;
        }
        await holdLease(env, context); // Outside the try: a lost lease stops the run.
        const started = Date.now();
        let raw: unknown;
        try {
            aiCalls++;
            raw = await env.AI!.run(PHOTO_MODEL, { ...visionRequest(PHOTO_MODEL, plan.prompt, dataUrl ??= imageDataUrl(bytes, mime)), max_tokens: plan.maxTokens });
        } catch (e) {
            const code = sanitizeCode(e), quota = isQuotaExhausted(e);
            log('extraction-pass-failed', { ...context, attempt: context.attempt ?? 0, passNumber, kind: plan.kind, code, quota, durationMs: Date.now() - started });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'failed', code, detail: { kind: plan.kind, quota, durationMs: Date.now() - started } }]);
            throw quota ? new QuotaExhausted(code) : e;
        }
        const usage = usageOf(raw);
        let pass: Extraction;
        try { pass = parseExtraction(raw); } catch (e) {
            // A cut-off or malformed reply is deterministic at temperature 0: repeating the same read would fail the same way.
            const code = sanitizeCode(e);
            log('extraction-pass-unparseable', { ...context, attempt: context.attempt ?? 0, passNumber, kind: plan.kind, code, ...(usage ?? {}) });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'failed', code, detail: { kind: plan.kind, unparseable: true, usage, durationMs: Date.now() - started } }]);
            return 'unparseable';
        }
        const detail = { kind: plan.kind, dates: plan.dates.length, containsWinners: pass.containsWinners, rows: pass.rows.length, warnings: pass.warnings.length,
            durationMs: Date.now() - started, ...(usage ?? {}) };
        log('extraction-pass', { ...context, attempt: context.attempt ?? 0, passNumber, ...detail });
        await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'ok', detail }]);
        return { ...pass, read: { version, kind: plan.kind, pass: plan.pass, dates: plan.dates, enlarged, usage } };
    };
    const run = async (plan: (i: number) => ReadPlan, offset: number) => {
        const out: StoredRead[] = [];
        for (let i = 0; i < passes; i++) {
            const result = await read(plan(i), offset + i + 1);
            if (result === 'unparseable') return null;
            out.push(result);
            done.push(result);
            if (image && !saved.includes(result)) await checkpoint(env.DB, { photoId: context.photoId, postId: context.postId, ...image }, done);
            if (i === 0 && !result.containsWinners) break; // A non-winner photo needs no confirmation pass.
        }
        return out;
    };
    const dates = readDates(announcementDate);
    const window = await run(i => windowPlan(dates, i), 0);
    const found = (p: Extraction) => p.rows.some(r => dates.includes(r.drawDate));
    let chosen = window, fallback: Reads['fallback'] = null;
    // Fall back once to the whole-table reads when the window reads cannot be used at all; window reads that merely hold a row never do.
    if (!window || (window.every(p => p.containsWinners) && !window.some(found))) {
        fallback = window ? 'no-window-dates' : 'unparseable';
        log('extraction-fallback', { ...context, attempt: context.attempt ?? 0, reason: fallback });
        chosen = await run(i => tablePlan(announcementDate, i), passes);
    }
    return { passes: (chosen ?? []).map(({ read: _read, ...p }) => p), reads: done, aiCalls, reused, fallback };
}

// The photo is base64-encoded once per invocation, however many reads (window, month, cell) use it: encoding costs Worker CPU.
const dataUrls = new WeakMap<Uint8Array, string>();
export function imageDataUrl(bytes: Uint8Array, mime: string) {
    let url = dataUrls.get(bytes);
    if (!url) dataUrls.set(bytes, url = `data:${mime};base64,${base64Image(bytes)}`);
    return url;
}

// ---- Month-wide correction scan: the whole cumulative table, read only to verify stored hometowns ----
// The window reads (above) stay the only reads that can publish a winner: whole-table reads of large tables drop sparse bonus cells. These
// two whole-table reads run after tonight's decision is written, so they can never delay, block or retry publication, and their rows can
// only ever propose a hometown correction (which a targeted cell re-read must still confirm). Cost, from measured rates: about 210-510
// neurons per read as the month grows (27 to 73 cells), so at most ~1,000 a night of the 10,000 daily allocation. Whole-table reads the
// window step already made (its fallback) are reused, not repeated. Any failure (quota, timeout, unparseable reply, lost lease) ends the
// scan quietly; the next night's cumulative table is scanned again, so nothing is lost.
export async function extractMonthPasses(env: ReadEnv, bytes: Uint8Array, mime: string, announcementDate: string, context: AttemptContext,
    image: ImageInfo | null, enlarged: boolean, reads: StoredRead[], deadline = Infinity): Promise<{ passes: Extraction[] | null; aiCalls: number; reused: number }> {
    const count = Math.min(3, Math.max(2, Number(env.FB_PHOTO_EXTRACTION_PASSES) || 2));
    const version = await readVersion();
    const out: Extraction[] = [];
    let aiCalls = 0, reused = 0;
    for (let i = 0; i < count; i++) {
        const plan = tablePlan(announcementDate, i), passNumber = 100 + i + 1; // pass numbers 101+ mark month-scan reads in diagnostics
        const prior = reads.find(r => sameRead(r, plan, version, enlarged));
        if (prior) { reused++; const { read: _r, ...p } = prior; out.push(p); continue; }
        // No read starts after the deadline: the invocation keeps a wide margin under Cloudflare's wall-clock limit for scheduled Workers.
        if (Date.now() >= deadline) { log('month-scan-read-skipped', { ...context, attempt: context.attempt ?? 0, passNumber, reason: 'invocation-time-budget' });
            await keepReads(env.DB, context.photoId, image, reads); return { passes: null, aiCalls, reused }; }
        const started = Date.now();
        try {
            await holdLease(env, context);
            aiCalls++;
            const raw = await env.AI!.run(PHOTO_MODEL, { ...visionRequest(PHOTO_MODEL, plan.prompt, imageDataUrl(bytes, mime)), max_tokens: plan.maxTokens });
            const usage = usageOf(raw), pass = parseExtraction(raw);
            reads.push({ ...pass, read: { version, kind: plan.kind, pass: plan.pass, dates: plan.dates, enlarged, usage } });
            out.push(pass);
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'ok', detail: { kind: 'month', rows: pass.rows.length,
                warnings: pass.warnings.length, durationMs: Date.now() - started, ...(usage ?? {}) } }]);
        } catch (e) {
            const code = sanitizeCode(e);
            log('month-scan-read-failed', { ...context, attempt: context.attempt ?? 0, passNumber, code, durationMs: Date.now() - started });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'failed', code, detail: { kind: 'month', quota: isQuotaExhausted(e) } }]);
            await keepReads(env.DB, context.photoId, image, reads);
            return { passes: null, aiCalls, reused };
        }
    }
    await keepReads(env.DB, context.photoId, image, reads);
    return { passes: out, aiCalls, reused };
}
/** The photo is already decided, so its stored extraction is updated directly (the checkpoint only writes undecided photos). */
export async function keepReads(db: D1Database, photoId: string, image: ImageInfo | null, reads: StoredRead[]) {
    try {
        await db.prepare(`UPDATE raffle_photo_auto_imports SET extraction_json=? WHERE photo_id=? AND (? IS NULL OR image_sha256=?)`)
            .bind(JSON.stringify(reads).slice(0, 200000), photoId, image?.sha256 ?? null, image?.sha256 ?? null).run();
    } catch { /* Diagnostics only. */ }
}

// ---- Targeted cell re-reads, only to confirm a proposed hometown correction ----
// decidePhoto proposes a correction only for a stored, automatically read hometown that every pass reads differently while date, ticket,
// name and prize slot all match (at most two per photo). Each such cell costs one small read (~2,600 input and ~150 output tokens, about
// 90 neurons); a photo without such a cell makes no extra AI call. A failed or unparseable re-read never blocks or retries the post: the
// row just keeps its ordinary outcome (rejected for review) as it would without this step.
export const CELL_MAX_TOKENS = 512;
export type TownTarget = { rowNumber: number; drawDate: string; ticketNumber: string; name: string };
let cellVersionMemo: Promise<string> | null = null;
const cellVersion = () => cellVersionMemo ??= hashBytes(new TextEncoder().encode(JSON.stringify([PHOTO_MODEL, READ_WIDTH, CELL_MAX_TOKENS,
    cellPrompt('2000-01-01', '1', 'A B')]))).then(h => h.slice(0, 16));
/** The re-read as a draft row of the asked date (null when the cell was not found), or 'unparseable'. */
export function parseCellRead(response: unknown, drawDate: string): DraftWinner | null | 'unparseable' {
    const body = (response as { response?: unknown } | null)?.response;
    const raw = typeof body === 'string' ? body : body && typeof body === 'object' ? JSON.stringify(body) : null;
    if (raw === null || raw.length > 4000) return 'unparseable';
    try {
        const v = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
        if (!v || typeof v !== 'object' || typeof v.found !== 'boolean') return 'unparseable';
        if (!v.found) return null;
        return draftRows([{ drawDate, position: null, prize: '', ticketStatus: 'readable', cellText: typeof v.cellText === 'string' ? v.cellText : '',
            ticketNumber: v.ticketNumber, name: v.name, town: v.town, townStatus: v.townStatus, notes: v.notes }])[0];
    } catch { return 'unparseable'; }
}
/**
 * One targeted read per target cell. Completed re-reads are appended to `reads` (stored with the photo's extraction) and checkpointed,
 * and a requeued run of the same image reuses them instead of paying again. Returns the re-read row per target row number (null = none).
 */
export async function rereadTownCells(env: ReadEnv, bytes: Uint8Array, mime: string, context: AttemptContext, image: ImageInfo | null,
    enlarged: boolean, targets: TownTarget[], reads: StoredRead[], deadline = Infinity) {
    const results = new Map<number, DraftWinner | null>();
    if (!targets.length) return { results, aiCalls: 0, reused: 0 };
    const version = await cellVersion();
    const saved = image ? await storedReads(env.DB, context.photoId, image.sha256) : [];
    let dataUrl: string | null = null, aiCalls = 0, reused = 0;
    for (const t of targets) {
        const target = `${t.drawDate}:${Number(t.ticketNumber)}`;
        const same = (r: StoredRead) => r.read?.kind === 'cell' && r.read.version === version && r.read.target === target && r.read.enlarged === enlarged;
        let stored = reads.find(same) ?? saved.find(same);
        if (stored) reused++;
        else if (Date.now() >= deadline) { log('cell-read-skipped', { ...context, attempt: context.attempt ?? 0, reason: 'invocation-time-budget' }); continue; }
        else {
            const started = Date.now();
            try {
                await holdLease(env, context);
                aiCalls++;
                const raw = await env.AI!.run(PHOTO_MODEL, { ...visionRequest(PHOTO_MODEL, cellPrompt(t.drawDate, t.ticketNumber, t.name),
                    dataUrl ??= imageDataUrl(bytes, mime)), max_tokens: CELL_MAX_TOKENS });
                const row = parseCellRead(raw, t.drawDate), usage = usageOf(raw);
                if (row === 'unparseable') throw Error('cell-read-unparseable');
                stored = { containsWinners: true, rows: row ? [row] : [], warnings: [], read: { version, kind: 'cell', pass: 0, dates: [t.drawDate], enlarged, usage, target } };
                await recordAttempts(env.DB, [{ ...context, stage: 'pass', outcome: 'ok', detail: { kind: 'cell', found: !!row, durationMs: Date.now() - started, ...(usage ?? {}) } }]);
            } catch (e) {
                const code = sanitizeCode(e);
                log('cell-read-failed', { ...context, attempt: context.attempt ?? 0, code, durationMs: Date.now() - started });
                await recordAttempts(env.DB, [{ ...context, stage: 'pass', outcome: 'failed', code, detail: { kind: 'cell', quota: isQuotaExhausted(e) } }]);
                if (code === 'lease-lost') throw e; // Another run owns the post now and will finish it.
                continue; // Not in results: the correction is "not available" and the row keeps its ordinary outcome.
            }
        }
        if (!reads.includes(stored)) reads.push(stored);
        if (image) await checkpoint(env.DB, { photoId: context.photoId, postId: context.postId, ...image }, reads);
        results.set(t.rowNumber, stored.rows[0] ?? null);
    }
    return { results, aiCalls, reused };
}
