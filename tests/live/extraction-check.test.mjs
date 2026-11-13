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
import { readDates, WINDOW_MAX_TOKENS } from '../../workers/facebook-photos/reads.ts';
import { parseExtraction, PHOTO_MODEL } from '../../src/lib/raffle-photo-import.ts';

const { CF_TOKEN, LIVE_OUT } = process.env;
const ACCOUNT = 'aa86268490e681cccb3a41a62093e2aa';
const NIGHTS = (process.env.NIGHTS ?? '13,30').split(',').map(Number);
const NEURON_CAP = Number(process.env.NEURON_CAP ?? 1500);

test('live extraction check', { skip: !CF_TOKEN || !LIVE_OUT ? 'needs CF_TOKEN and LIVE_OUT' : false, timeout: 3600000 }, async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule, { realistic: true });
    const column = r => r.prize === 'Firearm' ? 1 : r.prize === 'Gift Card' ? 2 : 3;
    const cells = Object.fromEntries(NIGHTS.map(n => [n, read(n, truth).rows.map(r => [r.drawDate, column(r), r.cellText])]));
    await writeFile(`${LIVE_OUT}/expected-cells.json`, JSON.stringify(cells, null, 1)); // recorded before any model call
    console.log(execFileSync('python', ['-I', fileURLToPath(new URL('./render_tables.py', import.meta.url)), `${LIVE_OUT}/expected-cells.json`, LIVE_OUT]).toString());
    let neurons = 0;
    const ai = async (image, prompt) => {
        if (neurons + 550 > NEURON_CAP) throw Error(`neuron cap ${NEURON_CAP} reached; stopping to protect the production allocation`);
        const bytes = await readFile(`${LIVE_OUT}/${image}`), started = Date.now();
        const body = { ...visionRequest(PHOTO_MODEL, prompt, 'data:image/jpeg;base64,' + bytes.toString('base64')), max_tokens: WINDOW_MAX_TOKENS };
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${PHOTO_MODEL}`,
            { method: 'POST', headers: { Authorization: 'Bearer ' + CF_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json();
        neurons += json.result?.usage?.neurons ?? 0;
        if (!json.success) throw Error(JSON.stringify(json.errors));
        return { read: parseExtraction(json.result), ms: Date.now() - started, usage: json.result.usage };
    };
    const report = [];
    for (const n of NIGHTS) {
        const image = `table-${n}-1540.jpg`; // as enlarged for reading
        // Exactly the Worker's primary reads: the window and its anchor dates, row by row and column by column.
        const dates = readDates(day(n)), full = [];
        for (const pass of [0, 1]) full.push(await ai(image, focusPrompt(dates, pass)));
        await writeFile(`${LIVE_OUT}/reads-${n}.json`, JSON.stringify({ windowPasses: full.map(f => f.read), dates, usage: full.map(f => f.usage) }, null, 1));
        const printed = read(n, truth).rows.filter(r => r.drawDate >= day(n - 2));
        const isBonus = c => !c.ticketNumber && c.prize !== 'Gift Card';
        const exact = p => printed.filter(c => p.rows.some(r => r.drawDate === c.drawDate && (r.cellText ?? '').trim() === c.cellText.trim() && r.name === c.name));
        const wrongDate = p => printed.filter(c => p.rows.some(r => (r.cellText ?? '').trim() === c.cellText.trim() && r.drawDate !== c.drawDate
            && !printed.some(o => o !== c && o.cellText === c.cellText))).length;
        const stored = [...storedThrough11, ...truth.filter(r => r.drawDate < day(n)).map(r => ({ id: r.slot, drawDate: r.drawDate,
            ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
        const decision = decidePhoto(full.map(f => f.read), stored, schedule, day(n));
        const wrong = inserted(decision).filter(r => { const x = truth.find(t => t.slot === r.prizeSlotId);
            return !x || x.drawDate !== r.row.drawDate || x.name !== r.row.name || x.ticketNumber !== r.row.ticketNumber || x.town !== r.row.town; });
        const expected = tonight(truth, n), published = inserted(decision).map(r => r.prizeSlotId);
        report.push({ night: n, windowCells: printed.length, windowBonus: printed.filter(isBonus).length,
            exactPerRead: full.map(f => exact(f.read).length), bonusPerRead: full.map(f => exact(f.read).filter(isBonus).length),
            wrongDatesPerRead: full.map(f => wrongDate(f.read)), tonightExpected: expected.length,
            tonightPublished: published.filter(s => expected.includes(s)).length, falsePublications: wrong.length, status: decision.status,
            alertWouldFire: ['held', 'partial', 'rejected'].includes(decision.status),
            notPublished: decision.rows.filter(r => r.row.drawDate === day(n) && r.outcome !== 'insert').map(r => [r.row.name, r.outcome, r.reasons[0]]),
            msPerRead: full.map(f => f.ms), neuronsSoFar: Math.round(neurons) });
        console.log('LIVE', JSON.stringify(report.at(-1)));
        assert.equal(wrong.length, 0, `Nov ${n}: a wrong winner, date or prize would have been published`);
    }
    await writeFile(`${LIVE_OUT}/report.json`, JSON.stringify(report, null, 1));
});
