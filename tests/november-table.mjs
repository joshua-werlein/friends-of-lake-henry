// The November 2026 cumulative winner table, simulated night by night for the Nov 12-30 tests and the live extraction check.
// History is the real stored Nov 1-11 winners and the real Nov 11 cell reads; Nov 12+ winners fill the approved calendar's slots.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { prizeSchedule } from '../src/lib/server/raffle-prizes.ts';

export const fixture = name => readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8').then(JSON.parse);
export const { events } = await fixture('november-2026-published-raffle-events.json');
export const { winners: storedThrough11 } = await fixture('november-2026-winners-through-11.json');
export const nov11 = await fixture('facebook-winners-2026-11-11.extraction.json');

export async function calendar(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    // Migration 009 (approved calendars, reviewed recurring prizes) exists only once the future-season code is merged. It records
    // November 2026 exactly as production computes it without 009, so the same expectations hold on both schemas.
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql']) {
        const file = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8').catch(e => { if (e.code === 'ENOENT' && name.startsWith('009')) return null; throw e; });
        if (file === null) continue;
        for (const s of file.replace(/--[^\n]*/g, '').split(';').filter(v => v.trim())) await DB.prepare(s).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind ?? 'raffle', e.status, e.date_start, e.summary ?? null).run();
    return prizeSchedule(DB, '2026-11');
}

export const day = n => `2026-11-${String(n).padStart(2, '0')}`;
// Short labels as the Page writes bonus cells ("Cutting Board", "Paddle board"), including one-word and joined forms.
export const LABELS = { 13: 'Panfish Rod', 14: 'Walleye Rod', 15: 'Griddle', 20: 'Fillet Knife', 21: 'Ice Augur', 22: 'Fish Finder',
    26: 'Gun Safe', 27: 'Chain Saw', 28: 'Life Jacket', 29: 'Gun Vise' };
// The labels as the Page actually printed them where they differ from the calendar's spelling (Nov 15 "Blackstone", Nov 20 "Bubba Filet
// Knife", Nov 21 "Ice Auger"). LABELS copy the calendar's words, so a simulation using only them could never catch a spelling hold.
// Nov 27 keeps "Chain Saw": the joined "Chainsaw" stays in manual review by the owner's decision of 2026-11-15.
export const PAGE_LABELS = { ...LABELS, 15: 'Blackstone', 20: 'Bubba Filet Knife', 21: 'Ice Auger', 22: 'Vexilar Fish Finder' };
export const cell = (date, column, ticket, name, town, label) => ({ drawDate: date, position: null, ticketNumber: ticket, ticketStatus: ticket ? 'readable' : 'blank',
    name, town, townStatus: town ? 'readable' : 'blank', prize: label ?? column, notes: '',
    cellText: (label ? `${label} - ` : '') + (ticket ? `${ticket} - ` : '') + name + (town ? `, ${town}` : '') });

// The truth for Nov 12–30: one winner per approved slot, with repeat winners mixed in (a gift card and a bonus won again by stored
// winners, a stored ticket drawn again for a firearm).
// Realistic names (no digits) for live model checks: "Winner 28G" style names made real focused reads return name "Winner".
const FIRST = ['Sam', 'Lena', 'Mark', 'Ruth', 'Dale', 'Erin', 'Gus', 'Ida', 'Owen', 'Faye', 'Neil', 'Jo', 'Carl', 'Bea', 'Hank', 'Vera', 'Lyle', 'Nora', 'Wes'];
const LAST = ['Olson', 'Hagen', 'Brekke', 'Lund', 'Moe', 'Sather', 'Thorson', 'Ekern', 'Kvam', 'Rude', 'Gilbertson', 'Nyhus', 'Skaar', 'Haugen', 'Tollefson', 'Vold', 'Berge', 'Dahl', 'Ness'];
const realName = (n, column) => `${FIRST[(n * 3 + (column === 'Firearm' ? 0 : column ? 1 : 2)) % FIRST.length]} ${LAST[(n * 7 + (column === 'Firearm' ? 0 : column ? 5 : 11)) % LAST.length]}`;
// bonusTickets: bonus cells print the winner's ticket after the label ("Bubba Filet Knife - 628 - John Wickum, Wilson, WI"), as from Nov 20.
export function futureTruth(schedule, { realistic = false, bonusTickets = false, labels = LABELS } = {}) {
    const truth = [];
    let ticket = 400;
    for (let n = 12; n <= 30; n++) for (const p of schedule.filter(p => p.drawDate === day(n))) {
        const column = p.category === 'Main prize' ? 'Firearm' : p.category === 'Gift card' ? 'Gift Card' : null;
        let who = { name: realistic ? realName(n, column) : `Winner ${n}${column === 'Firearm' ? 'F' : column ? 'G' : 'B'}`, town: n % 2 ? 'Blair, WI' : 'Taylor, WI', ticket: String(ticket++) };
        if (n === 16 && column === 'Gift Card') who = { name: 'Gary Gran', town: 'Osseo, WI', ticket: '105' };
        if (n === 20 && !column) who = { name: 'John Kraemer', town: 'Neillsville, WI', ticket: '' };
        if (n === 25 && column === 'Firearm') who = { name: 'Dennis McHenry', town: 'LaCrosse, WI', ticket: '698' };
        if (!column && !bonusTickets) who.ticket = '';
        truth.push({ slot: p.id, ...cell(day(n), column, who.ticket, who.name, who.town, column ? undefined : labels[n]) });
    }
    return truth;
}
// Nov 1–11 exactly as the real Nov 11 pass read the Firearm and Gift Card cells, with the bonus cells on their true rows.
export const BONUS_HISTORY = [cell(day(6), null, '', 'Kent Johnson', 'Blair, Wi', 'Cutting Board'), cell(day(7), null, '', 'Gage Everson', 'Independence, WI', 'Meat Bundle'),
    cell(day(8), null, '', 'John Kraemer', 'Neillsville, WI', 'Paddle board')];
export const history = [...nov11.extractionPasses[0].rows.filter(r => r.ticketNumber || r.prize === 'Gift Card'), ...BONUS_HISTORY];

export const sorted = rows => rows.sort((a, b) => a.drawDate.localeCompare(b.drawDate));
/** The cumulative table posted on night `n`, read by one AI pass with the given failure modes. */
export function read(n, truth, mode = {}) {
    let rows = [...history, ...truth.filter(r => r.drawDate <= day(n))].map(({ slot, ...r }) => ({ ...r }));
    const isBonus = r => !r.ticketNumber && r.prize !== 'Gift Card';
    // Sparse bonus cells read k rows late (never past the last row), as on Nov 9–11.
    if (mode.bonusLate) rows = rows.map(r => isBonus(r) ? { ...r, drawDate: day(Math.min(n, Number(r.drawDate.slice(8)) + mode.bonusLate)) } : r);
    if (mode.dropOldBonus) rows = rows.filter(r => !isBonus(r) || r.drawDate >= day(n - 1));
    if (mode.dropTonight) rows = rows.filter(r => !(r.drawDate === day(n) && mode.dropTonight(r)));
    if (mode.changeTonight) rows = rows.map(r => r.drawDate === day(n) && mode.changeTonight.match(r) ? { ...r, ...mode.changeTonight.to(r) } : r);
    // The whole Firearm column read one row late: every cell lands on the next date and tonight's falls off.
    // The measured whole-table omission on large tables: sparse bonus cells are not returned at all (real reads kept 0 of 12/13).
    if (mode.noBonus) rows = rows.filter(r => !isBonus(r));
    if (mode.firearmLate) rows = rows.filter(r => !(r.prize === 'Firearm' && r.drawDate === day(n)))
        .map(r => r.prize === 'Firearm' ? { ...r, drawDate: day(Number(r.drawDate.slice(8)) + 1) } : r);
    const warnings = mode.warning ? [{ scope: 'image', code: mode.warning, drawDate: '', ticketNumber: '', name: '',
        message: mode.warning === 'clipped' ? 'The right edge is cut off.' : 'The layout of the table is ambiguous, with multiple prize columns and no clear association between dates and prizes.' }] : [];
    return { containsWinners: true, rows: sorted(rows), warnings };
}
/** A focused read of night `n`: only the announcement window's rows (the stage-B prompt), with the same failure modes. */
export const focus = (n, truth, mode = {}) => { const p = read(n, truth, mode); return { ...p, rows: p.rows.filter(r => r.drawDate >= day(n - 2)) }; };
export const inserted = d => d.rows.filter(r => r.outcome === 'insert');
export const asStored = d => inserted(d).map(r => ({ id: r.winnerId, drawDate: r.row.drawDate, ticketNumber: r.row.ticketNumber ? Number(r.row.ticketNumber) : null,
    name: r.row.name, town: r.row.town, prize: r.prize, prizeSlotId: r.prizeSlotId }));
// Every insert must be exactly one true winner in exactly its approved slot. Nothing else may ever be written.
export function assertTrue(d, truth) {
    for (const r of inserted(d)) {
        const t = truth.find(t => t.slot === r.prizeSlotId);
        assert.ok(t, `inserted into an unexpected slot ${r.prizeSlotId}`);
        assert.deepEqual([r.row.drawDate, r.row.ticketNumber, r.row.name, r.row.town], [t.drawDate, t.ticketNumber, t.name, t.town], r.prizeSlotId);
    }
}
export const tonight = (truth, n) => truth.filter(t => t.drawDate === day(n)).map(t => t.slot).sort();
export const slots = d => inserted(d).map(r => r.prizeSlotId).sort();
