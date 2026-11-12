// Stage B of winner-photo reading, kept apart from the Worker entry so it can be tested without the Workers runtime:
// enlarge the photo, run the whole-table reads, then focused reads of the announcement window, renewing the lease before each read.
import { base64Image, visionRequest, winnerPrompt } from '../facebook-live/photos';
import { PHOTO_MODEL, parseExtraction, type Extraction } from '../../src/lib/raffle-photo-import';
import { recordAttempts, renewLease, sanitizeCode, windowDates } from '../../src/lib/server/raffle-photo-autopublish';
import { focusPrompt } from './focus';

export type ReadEnv = {
    DB: D1Database;
    AI?: { run(model: string, input: unknown): Promise<unknown> };
    /** Cloudflare Images binding: enlarges the photo outside the Worker's CPU budget. Optional: without it the original is read. */
    IMAGES?: { input(stream: ReadableStream<Uint8Array>): { transform(t: Record<string, unknown>): { output(o: Record<string, unknown>): Promise<{ response(): Response }> } } };
    FB_PHOTO_EXTRACTION_PASSES?: string;
};
const log = (event: string, detail: Record<string, string | number | boolean> = {}) => console.log(JSON.stringify({ event, ...detail }));

export type AttemptContext = { postId: string; photoId: string; attempt: number | null };
// The cumulative month table reaches 70+ cells. A real read of a rendered Nov 28 table needed 8,650 output tokens: past the shared
// 8,192 default, the reply is cut off mid-JSON, can never parse and fails identically on every retry. Same prompt and model.
export const PHOTO_MAX_TOKENS = 16384;
// Each pass of a 60-cell table took ~108 s (6,580 tokens); two sequential passes outlast a 180 s lease, so the next cron tick would
// reclaim a post that is still being read. The claim takes 600 s and every AI read first renews it for another 600 s (renewLease),
// so up to four reads of an enlarged month table (~310 s measured, more on a slow day) are never reclaimed while still running.
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
type Reads = { passes: Extraction[]; focused: Extraction[] };
export async function extractPasses(env: ReadEnv, bytes: Uint8Array, mime: string, announcementDate: string, context: AttemptContext): Promise<Reads> {
    const passes = Math.min(3, Math.max(2, Number(env.FB_PHOTO_EXTRACTION_PASSES) || 2));
    const out: Extraction[] = [], dataUrl = `data:${mime};base64,${base64Image(bytes)}`; // Encode once for all passes.
    for (let i = 0; i < passes; i++) {
        await holdLease(env, context);
        const started = Date.now(), passNumber = i + 1;
        try {
            const pass = parseExtraction(await env.AI!.run(PHOTO_MODEL, { ...visionRequest(PHOTO_MODEL, winnerPrompt(announcementDate.slice(0, 7), announcementDate, i), dataUrl),
                max_tokens: PHOTO_MAX_TOKENS }));
            out.push(pass);
            const detail = { containsWinners: pass.containsWinners, rows: pass.rows.length, warnings: pass.warnings.length, durationMs: Date.now() - started };
            log('extraction-pass', { ...context, attempt: context.attempt ?? 0, passNumber, ...detail });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'ok', detail }]);
        } catch (e) {
            const code = sanitizeCode(e);
            log('extraction-pass-failed', { ...context, attempt: context.attempt ?? 0, passNumber, code, durationMs: Date.now() - started });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'failed', code, detail: { durationMs: Date.now() - started } }]);
            throw e;
        }
        if (i === 0 && !out[0].containsWinners) break; // A non-winner photo needs no confirmation pass.
    }
    return { passes: out, focused: await focusedPasses(env, dataUrl, announcementDate, out, context) };
}
/**
 * Stage B for a cumulative month table: one focused read per whole-table pass, asking only for the announcement window's rows.
 * They are told which dates to read, never which winners or prizes to expect. A failed focused read leaves the decision to the
 * whole-table reads (as before this stage existed) instead of retrying the post, which would repeat every AI read.
 */
async function focusedPasses(env: ReadEnv, dataUrl: string, announcementDate: string, full: Extraction[], context: AttemptContext): Promise<Extraction[]> {
    const dates = windowDates(announcementDate);
    // Only a table that also shows older drawings needs it: a single-night announcement is already all window rows.
    if (!full.length || !full.every(p => p.containsWinners) || !full.some(p => p.rows.some(r => /^\d{4}-\d{2}-\d{2}$/.test(r.drawDate) && r.drawDate < dates[0]))) return [];
    const out: Extraction[] = [];
    for (let i = 0; i < full.length; i++) {
        await holdLease(env, context); // Outside the try: a lost lease stops the run rather than falling back.
        const started = Date.now(), passNumber = full.length + i + 1;
        try {
            const pass = parseExtraction(await env.AI!.run(PHOTO_MODEL, { ...visionRequest(PHOTO_MODEL, focusPrompt(dates, i), dataUrl), max_tokens: PHOTO_MAX_TOKENS }));
            out.push(pass);
            const detail = { focus: true, containsWinners: pass.containsWinners, rows: pass.rows.length, warnings: pass.warnings.length, durationMs: Date.now() - started };
            log('extraction-pass', { ...context, attempt: context.attempt ?? 0, passNumber, ...detail });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'ok', detail }]);
        } catch (e) {
            const code = sanitizeCode(e);
            log('extraction-pass-failed', { ...context, attempt: context.attempt ?? 0, passNumber, focus: true, code, durationMs: Date.now() - started });
            await recordAttempts(env.DB, [{ ...context, stage: 'pass', passNumber, outcome: 'failed', code, detail: { focus: true, fallback: 'whole-table reads', durationMs: Date.now() - started } }]);
            return [];
        }
    }
    return out;
}
