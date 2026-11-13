// Live Workers AI check of winner-photo extraction on rendered November tables. NOT part of npm test: it spends the account's
// daily Workers AI allocation (Workers Free: 10,000 neurons/day, shared with production; one night here costs ~350-420, the two window
// reads the Worker makes). Nov 11 testing used the whole Nov 12 UTC allocation, so keep runs small and run them only after the night's
// drawing has been processed (after ~00:30 UTC), never before a drawing:
//   CF_TOKEN=... LIVE_OUT=<empty dir> NIGHTS=13,30 NEURON_CAP=1500 node --import ./tests/register.mjs --test tests/live/extraction-check.test.mjs
// Expected cells are recorded from the simulated truth before any AI call; the model only ever sees the rendered image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calendar, day, futureTruth, read, storedThrough11, tonight, inserted } from '../november-table.mjs';
import { decidePhoto } from '../../src/lib/server/raffle-photo-autopublish.ts';
import { visionRequest } from '../../workers/facebook-live/photos.ts';
import { focusPrompt } from '../../workers/facebook-photos/focus.ts';
import { readDates, WINDOW_MAX_TOKENS, estimateNeurons, isQuotaExhausted } from '../../workers/facebook-photos/reads.ts';
import { parseExtraction, PHOTO_MODEL } from '../../src/lib/raffle-photo-import.ts';

const { CF_TOKEN, LIVE_OUT } = process.env;
const ACCOUNT = 'aa86268490e681cccb3a41a62093e2aa';
const NIGHTS = (process.env.NIGHTS ?? '13,30').split(',').map(Number);
const NEURON_CAP = Number(process.env.NEURON_CAP ?? 1500);

test('live extraction check', { skip: !CF_TOKEN || !LIVE_OUT ? 'needs CF_TOKEN and LIVE_OUT' : false, timeout: 3600000 }, async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule, { realistic: true });
    const col = r => r.prize === 'Firearm' ? 1 : r.prize === 'Gift Card' ? 2 : 3;
    const cells = Object.fromEntries(NIGHTS.map(n => [n, read(n, truth).rows.map(r => [r.drawDate, col(r), r.cellText])]));
    await writeFile(`${LIVE_OUT}/expected-cells.json`, JSON.stringify(cells, null, 1)); // recorded before any model call
    console.log(execFileSync('python', ['-I', fileURLToPath(new URL('./render_tables.py', import.meta.url)), `${LIVE_OUT}/expected-cells.json`, LIVE_OUT]).toString());
    // Cap: before every call the worst case of that call (its prompt plus the full output cap) must still fit. Billing comes from the
    // response's own usage; a response without usage stops the run because the cap could no longer be enforced.
    let neurons = 0, calls = 0;
    const MAX_PROMPT_TOKENS = 4000; // enlarged 1540 px tables measure 2,158-3,390 prompt tokens
    const worstCall = estimateNeurons(MAX_PROMPT_TOKENS, WINDOW_MAX_TOKENS);
    const ai = async (image, prompt) => {
        if (neurons + worstCall > NEURON_CAP) throw Error(`neuron cap: ${Math.round(neurons)} used, next call could cost ${worstCall}, cap ${NEURON_CAP}; stopping`);
        const bytes = await readFile(`${LIVE_OUT}/${image}`), started = Date.now();
        const body = { ...visionRequest(PHOTO_MODEL, prompt, 'data:image/jpeg;base64,' + bytes.toString('base64')), max_tokens: WINDOW_MAX_TOKENS };
        calls++;
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${PHOTO_MODEL}`,
            { method: 'POST', headers: { Authorization: 'Bearer ' + CF_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json().catch(() => ({ success: false, errors: [{ message: 'non-JSON response ' + res.status }] }));
        const u = json.result?.usage;
        if (!json.success) {
            const text = JSON.stringify(json.errors ?? []);
            // 4006 = daily allocation used up: stop at once, never retry.
            throw Error((isQuotaExhausted(text) ? 'QUOTA 4006, stopped without retry: ' : 'AI call failed, stopped: ') + text.slice(0, 300));
        }
        const cost = Number.isFinite(u?.neurons) ? u.neurons : Number.isFinite(u?.prompt_tokens) ? estimateNeurons(u.prompt_tokens, u.completion_tokens) : NaN;
        if (!Number.isFinite(cost)) throw Error('response has no usage; stopping because the cap cannot be enforced');
        neurons += cost;
        if (u.prompt_tokens > MAX_PROMPT_TOKENS) throw Error(`prompt used ${u.prompt_tokens} tokens, above the cap's assumption; stopping`);
        let parsed = null, parseError = null;
        try { parsed = parseExtraction(json.result); } catch (e) { parseError = String(e.message ?? e); }
        return { read: parsed, parseError, ms: Date.now() - started, usage: { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, neurons: cost } };
    };
    const report = [];
    const column = r => r.prize === 'Firearm' ? 'Firearm' : r.prize === 'Gift Card' ? 'Gift Card' : 'Bonus';
    for (const n of NIGHTS) {
        const image = `table-${n}-1540.jpg`; // as enlarged for reading
        // Exactly the Worker's primary reads: the window and its anchor dates, row by row and column by column.
        const dates = readDates(day(n)), reads = [];
        for (const pass of [0, 1]) reads.push(await ai(image, focusPrompt(dates, pass)));
        await writeFile(`${LIVE_OUT}/reads-${n}.json`, JSON.stringify({ dates, reads }, null, 1));
        const requested = read(n, truth).rows.filter(r => dates.includes(r.drawDate));
        const windowCells = requested.filter(r => r.drawDate >= day(n - 2));
        // Per read and per field, against the cells printed on the requested rows (anchors included: they prove the column dates).
        const score = p => {
            if (!p) return null;
            const found = c => p.rows.find(r => r.drawDate === c.drawDate && (r.cellText ?? '').trim() === c.cellText.trim());
            const fieldErrors = [];
            for (const c of requested) { const r = found(c); if (!r) continue;
                for (const k of ['ticketNumber', 'name', 'town']) if ((r[k] ?? '') !== (c[k] ?? '')) fieldErrors.push(`${c.drawDate} ${column(c)} ${k}: read "${r[k]}" printed "${c[k]}"`);
                if (column(c) === 'Bonus' && r.prize !== c.prize) fieldErrors.push(`${c.drawDate} Bonus prize: read "${r.prize}" printed "${c.prize}"`); }
            const missing = requested.filter(c => !found(c)).map(c => `${c.drawDate} ${column(c)}`);
            const extra = p.rows.filter(r => !requested.some(c => c.drawDate === r.drawDate && (r.cellText ?? '').trim() === c.cellText.trim())).map(r => `${r.drawDate} ${r.cellText}`);
            return { cellsFound: requested.length - missing.length, of: requested.length, windowFound: windowCells.filter(c => found(c)).length, windowOf: windowCells.length,
                bonusFound: requested.filter(c => column(c) === 'Bonus' && found(c)).length, bonusOf: requested.filter(c => column(c) === 'Bonus').length,
                missing, extra, fieldErrors, warnings: p.warnings.length };
        };
        const passes = reads.map(r => r.read);
        const wouldFallback = passes.some(p => !p) || (passes.every(p => p.containsWinners) && !passes.some(p => p.rows.some(r => dates.includes(r.drawDate))));
        const stored = [...storedThrough11, ...truth.filter(r => r.drawDate < day(n)).map(r => ({ id: r.slot, drawDate: r.drawDate,
            ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
        const decision = passes.every(Boolean) ? decidePhoto(passes, stored, schedule, day(n)) : { status: 'unparseable', rows: [] };
        const wrong = inserted(decision).filter(r => { const x = truth.find(t => t.slot === r.prizeSlotId);
            return !x || x.drawDate !== r.row.drawDate || x.name !== r.row.name || x.ticketNumber !== r.row.ticketNumber || x.town !== r.row.town; });
        const expected = tonight(truth, n), published = inserted(decision).map(r => r.prizeSlotId);
        report.push({ night: n, dates, perRead: reads.map((r, i) => ({ pass: i, ...r.usage, ms: r.ms, parseError: r.parseError, ...score(r.read) })),
            wouldFallback, fallbackCalls: 0, status: decision.status, tonightExpected: expected.length, tonightPublished: published.filter(s => expected.includes(s)).length,
            missingExpected: expected.filter(s => !published.includes(s)), falsePublications: wrong.map(r => r.prizeSlotId),
            notPublished: decision.rows.filter(r => r.row.drawDate === day(n) && r.outcome !== 'insert').map(r => [r.row.name, r.outcome, r.reasons[0]]),
            neuronsSoFar: Math.round(neurons * 10) / 10, callsSoFar: calls });
        console.log('LIVE', JSON.stringify(report.at(-1)));
        await writeFile(`${LIVE_OUT}/report.json`, JSON.stringify(report, null, 1));
    }
    for (const r of report) {
        assert.deepEqual(r.falsePublications, [], `Nov ${r.night}: a wrong winner, date or prize would have been published`);
        assert.deepEqual(r.missingExpected, [], `Nov ${r.night}: an expected winner was not published`);
    }
});
