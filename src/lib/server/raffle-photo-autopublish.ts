import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { compareWinner, numericId, townKey, type DraftWinner, type Extraction, type ExtractionWarning, type ExistingWinner, type StructuredWarning } from '../raffle-photo-import';
import { BONUS, parseWinnerPrize, cleanPrizeDescription, placementLabel, ticketlessWinnerId, type WinnerPosition } from '../winner-prize';
import { calendarPosition, prizeSchedule, type ScheduledPrize } from './raffle-prizes';

// Unattended publication of Facebook winner photos. A row is published only when every extraction pass agrees
// on it, every field validates, it is dated for the announcement's own drawing window and it neither duplicates
// nor contradicts an existing winner. Anything else is recorded with a reason and never guessed or overwritten.
// held = the evidence is ambiguous, so a person should review it. rejected = it contradicts stored data.

// correct = a stored, automatically read hometown is replaced (see TownCorrection); every other field of the winner stays as stored.
export type RowOutcome = 'insert' | 'duplicate' | 'held' | 'rejected' | 'outside-window' | 'correct';
/**
 * A candidate correction of a stored winner's hometown. decidePhoto proposes it and leaves the row at `fallback` (the outcome it has
 * without a correction); only confirmTownCorrections, given an independent targeted re-read of the cell, turns it into 'correct'.
 */
export type TownCorrection = { winnerId: string; drawDate: string; ticketNumber: string; name: string; prizeSlotId: string;
    from: string; to: string; fallback: 'rejected' | 'outside-window' };
export type RowDecision = { rowNumber: number; outcome: RowOutcome; reasons: string[]; row: DraftWinner;
    winnerId: string | null; prize: string | null; prizeSlotId?: string | null; prizeMatch: 'scheduled' | 'unmatched' | 'none';
    derivedPosition?: 1 | 2; correction?: TownCorrection };
export type PhotoDecision = { status: 'published' | 'partial' | 'duplicate' | 'held' | 'rejected' | 'ignored';
    reasons: string[]; rows: RowDecision[] };

export const WINDOW_DAYS = 2; // An announcement may report today's or the previous two days' drawings.
/** The announcement window, oldest first: the dates a photo posted on `announcementDate` may publish. */
export const windowDates = (announcementDate: string) => Array.from({ length: WINDOW_DAYS + 1 }, (_, i) =>
    new Date(Date.parse(announcementDate + 'T12:00:00Z') - (WINDOW_DAYS - i) * 86400000).toISOString().slice(0, 10));
const MAX_AUTO_ROWS = 12; // Bound the eligible rows even when the Page posts a cumulative table.
// fold and realDate run on the same few hundred strings thousands of times per decision; a bounded cache keeps CPU low (Workers Free).
const cached = <T>(f: (v: string) => T) => { const memo = new Map<string, T>();
    return (v: string) => { let r = memo.get(v); if (r === undefined) { if (memo.size > 20000) memo.clear(); memo.set(v, r = f(v)); } return r; }; };
const fold = cached(v => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim());
const same = (a: string | null | undefined, b: string | null | undefined) => fold(a ?? '') === fold(b ?? '');
export const chicagoDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const realDate = cached(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T12:00:00Z'))
    && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
export const winnerId = (date: string, ticket: number) => `${date.slice(0, 7)}-${date}-${ticket}`.replace(/[^\w-]/g, ''); // Same as manual entry.

const CATEGORY_HEADINGS: Record<string, string> = { 'gift card': 'Gift card', firearm: 'Firearm',
    bonus: 'Bonus drawing', 'bonus prize': 'Bonus drawing', 'bonus drawing': 'Bonus drawing', '2nd drawing': 'Bonus drawing' };
// Prize identification is a pure function of (label, date, calendar). A full month table asks it for every cell against every date,
// which cost ~13 ms of CPU per decision on a 73-cell table, more than the Workers Free 10 ms budget; each answer is computed once.
const prizeMemo = new WeakMap<ScheduledPrize[], Map<string, ScheduledPrize | null>>();
function identifyPrize(text: string | undefined, drawDate: string, schedule: ScheduledPrize[]): ScheduledPrize | null {
    let memo = prizeMemo.get(schedule);
    if (!memo) prizeMemo.set(schedule, memo = new Map());
    const key = drawDate + '\u0000' + (text ?? '');
    if (!memo.has(key)) memo.set(key, findPrize(text, drawDate, schedule));
    return memo.get(key) ?? null;
}
// The prize's own opening words with different spacing: "Blackstone" for Black Stone 28" Griddle (Nov 15, both passes). The label with its
// spaces removed must equal the description's first whole words joined, at least 6 characters, and the spacing must actually differ.
// Words from the middle of a description ("Chainsaw" for Stihl Chain Saw MS 170), a brand next to other words or part of a word stay
// unmatched and are held for review. One-letter spelling variants are handled only by spelledRun and the one-word rule below.
function respaced(visible: string, description: string) {
    const want = visible.replace(/ /g, ''), words = fold(description).split(' ');
    if (want.length < 6) return false;
    for (let j = 0, run = ''; j < words.length && run.length < want.length; j++) {
        run += words[j];
        if (run === want) return j > 0 || visible.includes(' ');
    }
    return false;
}
// The Page's spelling of a word and the calendar's can differ by one letter, in either direction: Nov 20 "Filet" for the calendar's
// Fillet, Nov 21 "Auger" for the calendar's Augur, Nov 22 "Vexliar" for Vexilar. A spelling variant is exactly one inserted, deleted or
// replaced letter, or two neighbouring letters swapped, in a word of at least 5 letters with the same first letter and no digits
// ("28", "30-06", "5.7x28" must match exactly; "Rod", "Vise" never vary).
function oneEdit(a: string, b: string) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5 || a[0] !== b[0]) return false;
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
        || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
const spelledAs = (w: string, own: string) => w === own || (!/\d/.test(w) && !/\d/.test(own) && oneEdit(w, own));
// An abbreviated word is the opening 3+ letters of a description word of at least 6 letters ("Jack" for Jacket, "Cert" for Certificate).
// It is accepted only inside a run of the description's words with at least one exact word, never as a label on its own.
const abbreviates = (w: string, own: string) => w.length >= 3 && own.length >= 6 && w !== own && own.startsWith(w) && !/\d/.test(own);
// A shortened label with one word spelled differently is a run of the description's consecutive words: "Ice Auger" for Strike Master
// Ice Augur (Nov 21), "Filet Knife" for Bubba Fillet Knife. Every label word is the next description word, at most one is a spelling
// variant and at least one is exact. Only the description's first two words may be joined ("Strikemaster Ice Auger"), as in the spacing
// rule above; words joined from the middle ("Chainsaw MS 170" for Stihl Chain Saw MS 170) and added or reordered words never match here.
function spelledRun(visible: string, description: string) {
    const label = visible.split(' '), own = fold(description).split(' ');
    for (let start = 0; start < own.length; start++) {
        let j = start, exact = 0, varied = 0, ok = true;
        for (const w of label) {
            if (j === 0 && own.length > 2 && w === own[0] + own[1]) { j += 2; exact++; continue; }
            if (j >= own.length || !(spelledAs(w, own[j]) || abbreviates(w, own[j]))) { ok = false; break; }
            if (w === own[j]) exact++; else varied++;
            j++;
        }
        if (ok && exact >= 1 && varied <= 1) return true;
    }
    return false;
}
/**
 * A one-word label that is a description's final word or, for a description of at least two words, its opening brand word of at least
 * 6 letters ("Vexilar"). Shorter opening words are often a common word or half of a two-word brand ("Black" of Black Stone) and stay held.
 */
function endWord(visible: string, description: string) {
    const own = fold(description).split(' ');
    return spelledAs(visible, own.at(-1)!) || (own.length >= 2 && own[0].length >= 6 && visible.length >= 6 && spelledAs(visible, own[0]));
}
// Used only to place a winner by elimination (decidePhoto), never to identify a prize: a label word loosely belongs to a description word
// when it is a spelling variant, a prefix abbreviation, a consonant abbreviation (the word's letters in order, same first letter, 3+
// letters: "Vxlr" for Vexilar, "Fndr" for Finder) or at most two letters off in a word of 5+ letters with the same first letter.
// Words with digits must match exactly.
function editDistance(a: string, b: string) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
}
const inOrder = (w: string, own: string) => { let i = 0; for (const c of own) if (c === w[i]) i++; return i === w.length; };
function loosely(w: string, own: string) {
    if (spelledAs(w, own) || abbreviates(w, own)) return true;
    if (/\d/.test(w) || /\d/.test(own) || w[0] !== own[0] || w.length < 3) return false;
    return inOrder(w, own) || (Math.min(w.length, own.length) >= 5 && editDistance(w, own) <= 2);
}
/**
 * Every word of a printed label loosely belongs to the description: no added word names something else ("Ice Shelter", "Auger Set").
 * A one-word label must be at least 5 letters and loosely the prize's final noun or its 6+ letter opening brand word: a generic fragment
 * from the middle ("Ice", "Master" of Strike Master Ice Augur) or a very short word is no evidence and stays held.
 */
function compatibleLabel(label: string, description: string) {
    const own = fold(description).split(' '), joined = own.slice(0, -1).map((w, i) => w + own[i + 1]);
    const words = fold(label).split(' ').filter(w => w.length > 1 || /\d/.test(w));
    if (words.length === 1) {
        const [w] = words;
        return w.length >= 5 && (loosely(w, own.at(-1)!) || (own.length >= 2 && own[0].length >= 6 && loosely(w, own[0])) || (joined[0] === w));
    }
    return words.length > 0 && words.every(w => joined.includes(w) || own.some(o => loosely(w, o)));
}
function findPrize(text: string | undefined, drawDate: string, schedule: ScheduledPrize[]) {
    const visible = fold(text ?? '');
    if (visible.length < 3) return null;
    const eligible = schedule.filter(p => p.status === 'approved' && p.drawDate === drawDate);
    const category = Object.hasOwn(CATEGORY_HEADINGS, visible) ? CATEGORY_HEADINGS[visible] : null;
    // A column heading names a prize by its category or by the month's reviewed main-prize heading ("Firearm" in 2026).
    const aliased = (p: ScheduledPrize) => (p.aliases ?? []).some(a => fold(a) === visible);
    if (category || eligible.some(aliased)) {
        const matches = eligible.filter(p => (category !== null && p.category === category) || aliased(p));
        return matches.length === 1 ? matches[0] : null;
    }
    const words = (v: string) => new Set(fold(v).split(' ').filter(w => w.length > 1 || /\d/.test(w)));
    const seen = words(visible);
    const scored = eligible.map(p => {
        const want = [...words(p.description)];
        const hits = want.filter(w => seen.has(w)).length;
        return { p, exact: fold(p.description) === visible, score: want.length ? hits / want.length : 0 };
    });
    const exact = scored.filter(v => v.exact);
    if (exact.length) return exact.length === 1 ? exact[0].p : null;
    // A shortened label ("Cutting Board") is a whole-word phrase of one approved description. Display keeps the full description.
    if (visible.split(' ').length >= 2) {
        const phrase = eligible.filter(p => ` ${fold(p.description)} `.includes(` ${visible} `));
        // Another of the date's prizes with the same words spelled one letter differently ("Ice Auger" and "Ice Augur") makes it ambiguous.
        if (phrase.length) return phrase.length === 1 && !eligible.some(p => p !== phrase[0] && spelledRun(visible, p.description)) ? phrase[0] : null;
    }
    // A differently spaced label names a prize only when exactly one of the date's approved prizes contains it, in either spacing.
    const spaced = eligible.filter(p => respaced(visible, p.description));
    if (spaced.length) return spaced.length === 1 && !eligible.some(p => p !== spaced[0] && ` ${fold(p.description)} `.includes(` ${visible} `)) ? spaced[0] : null;
    // A shortened label with one spelling variant ("Ice Auger"), when exactly one of the date's approved prizes has that run of words.
    if (visible.includes(' ')) {
        const runs = eligible.filter(p => spelledRun(visible, p.description));
        if (runs.length) return runs.length === 1 ? runs[0] : null;
    }
    // A one-word label names a bonus prize only as that prize's final noun or its opening brand word, spelled as printed or with one
    // letter different: "Griddle" for Black Stone 28" Griddle, "Auger" for Strike Master Ice Augur, "Vexliar" for Vexilar Fish Finder
    // (Nov 22), the day's only bonus with that word. Any other single word stays unmatched, including a word of a multi-item prize
    // ("Cutting", "Board" of the Nov 6 cutting board set), a word another of the day's prizes also uses, or a joined spelling
    // ("Chainsaw"), and the winner is held for review.
    if (!visible.includes(' ') && visible.length >= 5 && !/\d/.test(visible)) {
        const holders = eligible.filter(p => !/[,&]| and /i.test(p.description) && endWord(visible, p.description));
        if (holders.length === 1 && holders[0].category === 'Bonus drawing'
            && !eligible.some(p => p !== holders[0] && fold(p.description).split(' ').some(o => spelledAs(visible, o)))) return holders[0];
    }
    // Strong token overlap ("Savage 110 30-06" vs "Savage 110 High Country 30-06"), unique to one scheduled prize.
    // A single word never identifies a prize by overlap alone; one-word labels have only the stricter rules above.
    if (seen.size < 2) return null;
    const strong = scored.filter(v => v.score >= 0.6).sort((a, b) => b.score - a.score);
    return strong.length === 1 || (strong.length > 1 && strong[0].score - strong[1].score >= 0.3) ? strong[0].p : null;
}

/** Visible text must identify one approved prize for the date. Place alone is insufficient. */
export function matchPrize(text: string | undefined, drawDate: string, schedule: ScheduledPrize[]): { description: string | null; match: RowDecision['prizeMatch'] } {
    const prize = identifyPrize(text, drawDate, schedule);
    return prize ? { description: prize.description, match: 'scheduled' }
        : { description: null, match: fold(text ?? '').length < 3 ? 'none' : 'unmatched' };
}

export function composePrize(position: WinnerPosition, description: string | null) {
    const prize = (placementLabel(position) ?? '') + (position !== null && description ? ' — ' : '') + (description ? cleanPrizeDescription(description) : '');
    return prize || null;
}

// ---- Extraction warnings: only row or cell problems that can be pinned to one row may stay row-level ----
const IMAGE_WIDE_CODES = new Set<StructuredWarning['code']>(['clipped', 'ambiguous-layout', 'uncertain-association', 'missing-heading']);
const LAYOUT_TEXT = /clip|cut[\s-]?off|truncat|crop|layout|column|associat|ambigu|misalign|merged|overlap|split|heading|which (?:date|row)|does not indicate/i;
const UNREADABLE_TEXT = /illegib|unreadable|blur|obscur|unclear|faint|uncertain|not (?:visible|legible|readable)/i;
const BLANK_TEXT = /\b(?:blank|empty|missing|no (?:ticket|hometown|town)|not (?:listed|printed|shown|provided|published)|without (?:a )?(?:ticket|hometown|town))\b/i;
const NO_WARNING = /^no (?:warnings|issues)[.!]?$/i;
const warningText = (w: ExtractionWarning) => typeof w === 'string' ? w : w.message || w.code;
type RowWarning = { row: DraftWinner; reason: string | null; blankField?: 'ticketNumber' | 'town' | 'prize' };
const withoutLayout = (p: Extraction): Extraction => ({ ...p, warnings: p.warnings.filter(w => !OUTVOTABLE(w)) });
function classifyWarnings(passes: Extraction[]): { imageWide: string[]; rowWarnings: RowWarning[] } {
    const imageWide: string[] = [], rowWarnings: RowWarning[] = [];
    for (const pass of passes) for (const warning of pass.warnings) {
        const text = warningText(warning).trim();
        if (typeof warning === 'string' && (!text || NO_WARNING.test(text))) continue;
        if (typeof warning !== 'string') {
            const matches = pass.rows.filter(r => (!!warning.drawDate || !!warning.ticketNumber || !!warning.name)
                && (!warning.drawDate || r.drawDate === warning.drawDate || r.readDate === warning.drawDate)
                && (!warning.ticketNumber || Number(r.ticketNumber) === Number(warning.ticketNumber))
                && (!warning.name || same(r.name, warning.name)));
            if (warning.scope === 'image' || IMAGE_WIDE_CODES.has(warning.code) || matches.length !== 1) { imageWide.push(text); continue; }
            const blankField = warning.code === 'blank-cell' && (warning.field === 'ticketNumber' || warning.field === 'town' || warning.field === 'prize') ? warning.field : undefined;
            rowWarnings.push({ row: matches[0], reason: blankField ? null : 'row warning: ' + text, blankField });
            continue;
        }
        // Free text is image-wide unless it clearly names exactly one row and says nothing about the layout.
        const words = fold(text);
        const named = pass.rows.filter(r => (fold(r.name).length >= 3 && words.includes(fold(r.name)))
            || (/^\d{1,9}$/.test(r.ticketNumber) && new RegExp(`(?:^|\\D)${r.ticketNumber}(?:\\D|$)`).test(text)));
        if (LAYOUT_TEXT.test(text) || named.length !== 1) { imageWide.push(text); continue; }
        const field = /ticket/i.test(text) ? 'ticketNumber' as const : /town|home/i.test(text) ? 'town' as const : undefined;
        const blank = !!field && BLANK_TEXT.test(text) && !UNREADABLE_TEXT.test(text);
        rowWarnings.push({ row: named[0], reason: blank ? null : 'row warning: ' + text, ...(blank ? { blankField: field } : {}) });
    }
    return { imageWide: [...new Set(imageWide)], rowWarnings };
}

// A lone ambiguous-layout remark (November 8: "additional prize labels within cells", which the prompt calls normal) is
// outvoted only when another pass read the image with no image-wide warning and every publishable row, raw cell text
// included, reads identically in every pass. Clipping and legibility remarks always block: identical reads cannot disprove them.
// The Page posts a cumulative month table (November 10: 23 cells from Nov 1–10). Rows older than the announcement window
// can never publish, so a differing read of an old bonus cell must not block today's identical reads. Undated rows, and
// rows a pass dates inside the window, always count, so a pass that moves a row between dates still blocks.
const ROW_FIELDS = ['drawDate', 'position', 'ticketNumber', 'ticketStatus', 'name', 'town', 'townStatus', 'prize', 'notes', 'cellText'] as const;
const OUTVOTABLE = (w: ExtractionWarning) => typeof w !== 'string' && w.scope === 'image' && w.code === 'ambiguous-layout'
    && !/clip|cut[\s-]?off|truncat|crop/i.test(w.message ?? '') && !UNREADABLE_TEXT.test(w.message ?? '');
const publishable = (r: DraftWinner, announcementDate: string) => !realDate(r.drawDate) || daysBetween(r.drawDate, announcementDate) <= WINDOW_DAYS;
// Row-level remarks (blank-cell notes) are judged per row as usual; only image-wide ones decide the vote.
// A stored winner a pass reads under the wrong date (below) is not a current row: it is never written, and its column is held instead.
function outvotedLayoutWarning(passes: Extraction[], announcementDate: string, redated: Map<DraftWinner, Redated>) {
    const imageWide = (p: Extraction) => classifyWarnings([p]).imageWide.length > 0;
    const flagged = passes.filter(imageWide);
    if (flagged.length !== 1 || flagged.length === passes.length || !flagged[0].warnings.some(OUTVOTABLE)
        || imageWide(withoutLayout(flagged[0]))) return false;
    const current = (p: Extraction) => p.rows.filter(r => publishable(r, announcementDate) && !redated.has(r));
    const read = (p: Extraction) => JSON.stringify(current(p).map(r => ROW_FIELDS.map(f => r[f] ?? null)));
    return passes.every(p => current(p).length > 0 && read(p) === read(passes[0]));
}

// ---- Date-to-column association, checked against the reviewed winners already stored ----
// November 11: the cumulative table's bonus column does not hold one cell per date row. Both passes dated the stored
// Nov 6–8 bonus winners one or two days late, differently, and one moved two of them onto Nov 9, inside the window,
// while every Firearm and Gift Card cell matched its stored date. A stored winner that a pass reads under another date,
// and not under its stored date although the pass reads that date, proves the pass misplaces dates in that prize column.
// Such a row is recognised (never written), and new winners in that column are held; other columns still publish.
// A real repeat winner keeps its old row at the old date, so it is not mistaken for one.
type Redated = { winner: ExistingWinner; category: string | null };
const storedSlot = (w: ExistingWinner, schedule: ScheduledPrize[]) => w.prizeSlotId
    ?? identifyPrize(parseWinnerPrize(w.prize ?? null).description, w.drawDate ?? '', schedule)?.id ?? null;
function redatedRows(passes: Extraction[], existing: ExistingWinner[], schedule: ScheduledPrize[]) {
    const found = new Map<DraftWinner, Redated>();
    for (const pass of passes) {
        const dates = new Set(pass.rows.map(r => r.drawDate));
        for (const row of pass.rows) {
            if (!realDate(row.drawDate) || fold(row.name).length < 2) continue;
            const matches = existing.filter(w => !!w.drawDate && w.drawDate !== row.drawDate && dates.has(w.drawDate) && same(w.name, row.name)
                && (row.ticketNumber === '' || Number(row.ticketNumber) === Number(w.ticketNumber))
                && !pass.rows.some(o => o.drawDate === w.drawDate && same(o.name, w.name))
                && (() => { const slot = storedSlot(w, schedule); return !!slot && identifyPrize(row.prize, w.drawDate!, schedule)?.id === slot; })());
            if (matches.length !== 1) continue;
            const slot = storedSlot(matches[0], schedule);
            found.set(row, { winner: matches[0], category: schedule.find(p => p.id === slot)?.category ?? null });
        }
    }
    return found;
}

// ---- Self-labelled bonus cells are dated by the approved calendar, not by the row they appear on ----
// The bonus column holds a few sparse cells with their own labels. Real reads (Nov 9–11) placed them one or two rows late,
// differently in each pass, while the one-cell-per-row Firearm and Gift Card columns were read on the right rows. A label that
// names exactly one approved prize in the whole month, and that prize is a bonus drawing, fixes the drawing it belongs to.
// Labels that fit several drawings ("Rod"), column headings ("Bonus") and recurring prizes keep the row's date and its checks.
const bonusMemo = new WeakMap<ScheduledPrize[], Map<string, ScheduledPrize | null>>();
function calendarBonus(row: Pick<DraftWinner, 'prize'>, schedule: ScheduledPrize[]) {
    let memo = bonusMemo.get(schedule);
    if (!memo) bonusMemo.set(schedule, memo = new Map());
    const key = row.prize ?? '';
    if (!memo.has(key)) memo.set(key, findCalendarBonus(row, schedule));
    return memo.get(key) ?? null;
}
function findCalendarBonus(row: Pick<DraftWinner, 'prize'>, schedule: ScheduledPrize[]) {
    const visible = fold(row.prize ?? '');
    if (visible.length < 3 || Object.hasOwn(CATEGORY_HEADINGS, visible) || schedule.some(p => (p.aliases ?? []).some(a => fold(a) === visible))) return null;
    const dates = [...new Set(schedule.filter(p => p.status === 'approved').map(p => p.drawDate))];
    const hits = dates.map(d => identifyPrize(row.prize, d, schedule)).filter((p): p is ScheduledPrize => !!p);
    if (hits.length !== 1 || hits[0].category !== 'Bonus drawing') return null;
    // A one-word label dates a cell only if no other approved prize of the month uses that word or a one-letter variant of it
    // ("Board": paddle board and cutting board). A lone brand word ("Vexilar") names its own row's prize but never moves a cell to another date.
    if (!visible.includes(' ') && !spelledAs(visible, fold(hits[0].description).split(' ').at(-1)!) && !respaced(visible, hits[0].description)) return null;
    if (!visible.includes(' ') && schedule.some(p => p !== hits[0] && p.status === 'approved'
        && (fold(p.description).split(' ').some(o => spelledAs(visible, o)) || respaced(visible, p.description)))) return null;
    return hits[0];
}
export const calendarDate = (row: Pick<DraftWinner, 'prize'>, schedule: ScheduledPrize[]) => calendarBonus(row, schedule)?.drawDate ?? null;
// A bonus label is a cell's own text ("Life Jacket - Name, Town"). Real reads also attach the row's bonus label to the Gift Card cell
// beside it (Nov 10 "Cutting Board" on Lyle Schlomer's gift cell; a 30-row table put "Life Jacket" on "429 - Name, Town"). A bonus label
// on a cell whose own text carries no label ("ticket - name, town" or "name, town") belongs to a neighbour: it is dropped (kept as
// strayLabel), never used to date or price the cell. A cell with its own label keeps the read prize and the usual prize checks.
const ownLabel = (cellText: string) => parseCell(cellText).label;
function calendarDated(pass: Extraction, schedule: ScheduledPrize[]): Extraction {
    return { ...pass, rows: pass.rows.map(r => {
        const bonus = calendarBonus(r, schedule) ?? (identifyPrize(r.prize, r.drawDate, schedule)?.category === 'Bonus drawing' && !Object.hasOwn(CATEGORY_HEADINGS, fold(r.prize ?? '')) ? true : null);
        if (!bonus) return r;
        const text = (r.cellText ?? '').trim();
        if (text && !ownLabel(text) && !` ${fold(text)} `.includes(` ${fold(r.prize ?? '')} `)) return { ...r, prize: '', strayLabel: r.prize };
        return bonus === true ? r : { ...r, drawDate: bonus.drawDate, readDate: r.drawDate };
    }) };
}

// A prize column's dates are confirmed when no stored winner of it is read under another date and, in every pass, at least 3 of its
// stored winners, including the latest one (the row next to tonight's), appear on their stored dates in that column (by name or ticket).
// A stored cell read on its own date under a neighbouring label (Nov 10: Lyle Schlomer's gift cell as "Cutting Board") says nothing
// about dates, so it neither confirms nor refutes; a shifted column moves stored winners to other dates, which refutes it.
const MIN_COLUMN_EVIDENCE = 3;
function columnConfirmed(category: string, passes: Extraction[], existing: ExistingWinner[], schedule: ScheduledPrize[], redated: Map<DraftWinner, Redated>) {
    if ([...redated.values()].some(r => r.category === category)) return false;
    const categoryOf = (w: ExistingWinner) => schedule.find(p => p.id === storedSlot(w, schedule))?.category;
    return passes.every(pass => {
        const dates = new Set(pass.rows.map(r => r.drawDate));
        const stored = existing.filter(w => !!w.drawDate && dates.has(w.drawDate) && categoryOf(w) === category)
            .sort((a, b) => b.drawDate!.localeCompare(a.drawDate!));
        const seen = (w: ExistingWinner) => pass.rows.some(r => r.drawDate === w.drawDate
            && (same(r.name, w.name) || (!!r.ticketNumber && Number(r.ticketNumber) === Number(w.ticketNumber)))
            && identifyPrize(r.prize, w.drawDate!, schedule)?.id === storedSlot(w, schedule));
        // Two cells of this column on one date (Nov 9: the stored winner plus a moved cell) mean its rows are not one per date.
        const slots = pass.rows.map(r => identifyPrize(r.prize, r.drawDate, schedule)).filter(p => p?.category === category).map(p => p!.id);
        if (new Set(slots).size !== slots.length) return false;
        return stored.length > 0 && seen(stored[0]) && stored.filter(seen).length >= MIN_COLUMN_EVIDENCE;
    });
}

// ---- Row identity: passes may reorder rows or disagree on how many there are ----
// An empty date is still identity: a row both passes read without a date reaches row-level review, not an image-wide rejection.
const ticketKey = (r: DraftWinner) => /^\d{1,9}$/.test(r.ticketNumber) && Number(r.ticketNumber) > 0 ? `${r.drawDate}:${Number(r.ticketNumber)}` : null;
const nameKey = (r: DraftWinner) => fold(r.name).length >= 2 ? `${r.drawDate}:${fold(r.name)}` : null;
export type RowGroup = { members: (DraftWinner | undefined)[]; tickets: Set<string>; names: Set<string>; issues: string[] };
/** Groups the same winner across passes by date+ticket, falling back to date+name. Anything not one-to-one stays ungrouped and is held. */
export function reconcileRows(passes: Extraction[]): RowGroup[] {
    const groups: RowGroup[] = [];
    passes.forEach((pass, index) => {
        const tally = (key: (r: DraftWinner) => string | null) => {
            const seen = new Map<string, number>();
            for (const r of pass.rows) { const k = key(r); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
            return (k: string | null) => k !== null && seen.get(k) === 1;
        };
        const uniqueTicket = tally(ticketKey), uniqueName = tally(nameKey);
        for (const row of pass.rows) {
            const t = ticketKey(row), n = nameKey(row);
            const byTicket = uniqueTicket(t) ? groups.filter(g => !g.members[index] && g.tickets.has(t!)) : [];
            const byName = uniqueName(n) ? groups.filter(g => !g.members[index] && g.names.has(n!)) : [];
            const split = byTicket.length > 1 || byName.length > 1 || (byTicket.length === 1 && byName.length === 1 && byTicket[0] !== byName[0]);
            const target = split ? undefined : byTicket[0] ?? byName[0];
            const group = target ?? { members: [], tickets: new Set<string>(), names: new Set<string>(), issues: [] };
            if (!target) groups.push(group);
            if (split) for (const g of [group, ...byTicket, ...byName]) g.issues.push('ticket and name point to different rows in another extraction pass');
            group.members[index] = row;
            if (uniqueTicket(t)) group.tickets.add(t!);
            if (uniqueName(n)) group.names.add(n!);
        }
    });
    return groups;
}

/**
 * A winner cell, in one grammar: `[label - ][ticket - ]name, town`. Real cells: "025 - Jason Haen, LaCrosse, WI", "797 -JJ Demaske, …"
 * (Nov 16), "Blackstone - Mike Loeser, Osseo, WI" (Nov 15) and "Bubba Filet Knife - 628 - John Wickum, Wilson, WI" (Nov 20, the first
 * labelled cell with a ticket). A label is any text that is not itself a ticket, followed by a dash spaced on both sides, so a hyphen
 * inside a name ("Smith-Jones") or a label with uneven spacing ("Life Jacket -Name") is never a separator. A ticket is up to 9 digits,
 * optionally after "#", followed by a dash with any spacing. Colons are not separators. The name is the text before the first comma;
 * a cell without a comma has no recognisable name (`name` undefined).
 */
const CELL = /^\s*(?:((?!#?\d{1,9}\s*[-–—])[^,]*?\S)\s+[-–—]\s+(?=\S))?((?:#?(\d{1,9})\s*[-–—]\s*(?=\S))?([\s\S]*))$/;
export type CellParts = { label: string | null; ticket: string | null; name: string | undefined; afterLabel: string };
export function parseCell(cell: string): CellParts {
    const [, label, afterLabel, ticket, rest] = CELL.exec(cell) ?? [];
    const name = (text: string | undefined) => /^([^,]+?)\s*,/.exec(text ?? '')?.[1];
    return { label: label ?? null, ticket: ticket ?? null, name: name(rest), afterLabel: afterLabel ?? cell };
}
/**
 * The name printed in a cell. Only the extracted ticket's own digits are stripped, so a cell whose number differs ("1797-", "798 -",
 * "047" for an extracted "47") keeps that number in front of the name and never matches.
 */
export function printedName(cell: string, ticketNumber: string): string | undefined {
    const c = parseCell(cell);
    return c.ticket === null || c.ticket === ticketNumber ? c.name : /^([^,]+?)\s*,/.exec(c.afterLabel)?.[1];
}

// A printed label names the read prize when it identifies the same single approved prize and every word of it is that prize's own:
// a word of the description, a joined pair of its words ("Blackstone", Nov 15) or a one-letter spelling variant of a word of at least
// 5 letters with the same first letter (spelledAs: "Filet" for Fillet, Nov 20; "Auger" for Augur, Nov 21). Missing words are fine
// ("Fillet Knife"); added words are not ("Bubba Knife Sharpener"). Column headings ("Gift Card", "Bonus") need only identify the same prize.
function labelWordsOf(label: string, description: string) {
    const own = fold(description).split(' ');
    const joined = own.slice(0, -1).map((w, i) => w + own[i + 1]);
    return fold(label).split(' ').filter(w => w.length > 1 || /\d/.test(w))
        .every(w => joined.includes(w) || own.some(o => spelledAs(w, o) || abbreviates(w, o)));
}
/** A cell's own printed label must name the prize the extraction read for it; a label from another prize holds the row. */
function labelProblems(row: DraftWinner, schedule: ScheduledPrize[]) {
    const label = parseCell(row.cellText ?? '').label;
    const read = identifyPrize(row.prize, row.drawDate, schedule);
    if (!label || !read) return []; // No label of its own, or an unidentified prize, which holds the row anyway.
    const named = identifyPrize(label, row.drawDate, schedule);
    if (named === read && (Object.hasOwn(CATEGORY_HEADINGS, fold(label)) || labelWordsOf(label, read.description))) return [];
    return ['the prize label printed in the cell does not name the extracted prize'];
}

/**
 * Real captures show both passes can agree on a false blank (ticket 894 read as blank) and can take a hometown from the next cell.
 * Each pass therefore copies the raw cell, and the parsed fields must be consistent with it. A ticket-free row must supply it.
 */
function cellTextProblems(row: DraftWinner) {
    const cell = (row.cellText ?? '').trim(), words = ` ${fold(cell)} `;
    if (!cell) return row.ticketNumber === '' ? ['a winner without a ticket needs the raw cell text to confirm it'] : [];
    const problems: string[] = [], parts = parseCell(cell);
    // A leading number, after the cell's own label if it has one, is a ticket; a label such as "2nd Drawing" is not.
    if (row.ticketNumber === '' && (parts.ticket !== null || /^\W{0,3}\d+(?:\s*[-–—:#]|\s+[A-Za-z])/.test(parts.afterLabel))) problems.push('cell text shows a ticket number that was not extracted');
    if (row.ticketNumber !== '' && !new RegExp(`(?:^|\\D)${row.ticketNumber.replace(/\D/g, '') || 'x'}(?:\\D|$)`).test(cell)) problems.push('ticket number is not in the cell text');
    // The ticket must be the cell's own: the number in the ticket position, digit for digit (Nov 20: "Bubba Filet Knife - 628 - …").
    // Reasons below say whether the extraction disagrees with the cell or the cell has a layout this check does not know.
    else if (row.ticketNumber !== '' && parts.ticket !== null && parts.ticket !== row.ticketNumber) problems.push('ticket number differs from the ticket printed in the cell');
    else if (row.ticketNumber !== '' && parts.ticket === null) problems.push('cell layout not recognised: the extracted ticket is not in the ticket position of the cell; review required');
    if (fold(row.name) && !words.includes(` ${fold(row.name)} `)) problems.push('name is not in the cell text');
    // The name is the whole text between the ticket or label dash and the first comma ("442 - Winner 28G, Taylor, WI"); a real window
    // read copied that cell exactly but returned name "Winner". A shortened or extended name is held, never repaired from the cell.
    // Names are never put in reasons (they reach alert emails and incident records); the admin review shows the cell beside the read.
    else if (fold(row.name) && parts.name !== undefined && fold(parts.name) !== fold(row.name)) {
        problems.push(/^\W{0,3}\d|\s[-–—]\s/.test(parts.name)
            ? 'cell layout not recognised: the text before the name is neither the ticket nor a prize label in a known form; review required'
            : 'name differs from the name printed in the cell');
    }
    // Spacing around commas differs between reads (Auburn,WA), so hometowns compare without separators.
    if (row.town && !fold(cell).replace(/ /g, '').includes(fold(row.town).replace(/ /g, ''))) problems.push('hometown is not in the cell text');
    if (!row.town && row.townStatus === 'blank' && /,/.test(cell.slice(cell.indexOf(row.name) + row.name.length))) problems.push('cell text shows a hometown that was not extracted');
    return problems;
}

// Reconcile a missing position only from these verified numbered headings. Each pass must read the
// same heading on the same date, and any explicit position must match the calendar.
function numberedColumnPosition(row: DraftWinner, members: DraftWinner[], schedule: ScheduledPrize[]): 1 | 2 | undefined {
    const heading = fold(row.prize ?? '');
    if (heading !== 'firearm' && heading !== 'gift card') return;
    const slot = identifyPrize(row.prize, row.drawDate, schedule);
    if (!slot || (heading === 'firearm' ? slot.category !== 'Main prize' || slot.source !== 'event'
        : slot.category !== 'Gift card' || slot.source !== 'daily')) return;
    const position = calendarPosition(slot, schedule);
    if (position !== 1 && position !== 2) return;
    if (members.every(m => m.drawDate === row.drawDate && fold(m.prize ?? '') === heading
        && m.cellText?.trim() && !m.strayLabel && (m.position === null || m.position === position))) return position;
}

function rowProblems(row: DraftWinner, announcementDate: string): { reasons: string[]; outside: boolean } {
    const reasons: string[] = [];
    if (!realDate(row.drawDate)) reasons.push('draw date missing or invalid');
    const ticketFree = row.ticketNumber === '' && row.ticketStatus === 'blank';
    if (!ticketFree && (!/^\d{1,9}$/.test(row.ticketNumber) || Number(row.ticketNumber) <= 0 || row.ticketStatus === 'uncertain' || row.ticketStatus === 'blank')) reasons.push('ticket number missing or invalid');
    if (row.name.length < 2 || /[?…]|\.\.\./.test(row.name)) reasons.push('name missing or uncertain');
    if ((row.town.length < 2 && !(row.town === '' && row.townStatus === 'blank'))
        || /[?…]|\.\.\./.test(row.town) || row.townStatus === 'uncertain'
        || (row.town !== '' && row.townStatus === 'blank')) reasons.push('hometown missing or uncertain');
    if (row.notes) reasons.push('model flagged uncertainty: ' + row.notes);
    reasons.push(...cellTextProblems(row));
    let outside = false;
    if (realDate(row.drawDate)) {
        const age = daysBetween(row.drawDate, announcementDate);
        if (age < 0) reasons.push('draw date is after the announcement');
        else if (age > WINDOW_DAYS) outside = true;
    }
    return { reasons, outside };
}

/**
 * Pure decision step. `passes` are independent extractions of the same image; `existing` are the stored winners for
 * the affected months; `announcementDate` is the post's America/Chicago date. `removedWinnerIds` are winners this photo
 * already published that an administrator has since deleted: a requeue must not bring them back.
 */
export function decidePhoto(passes: Extraction[], existing: ExistingWinner[], schedule: ScheduledPrize[], announcementDate: string,
    options: { removedWinnerIds?: Set<string> } = {}): PhotoDecision {
    if (!passes.length) return { status: 'rejected', reasons: ['no extraction'], rows: [] };
    const [first] = passes;
    if (passes.some(p => p.containsWinners !== first.containsWinners)) return { status: 'rejected', reasons: ['extraction passes disagree about whether this is a winner announcement'], rows: [] };
    if (!first.containsWinners) return { status: 'ignored', reasons: ['not a winner announcement'], rows: [] };
    if (passes.length < 2) return { status: 'rejected', reasons: ['winner publication requires at least two extraction passes'], rows: [] };
    passes = passes.map(p => calendarDated(p, schedule));
    const { imageWide, rowWarnings } = classifyWarnings(passes);
    const redated = redatedRows(passes, existing, schedule);
    // Layout remarks alone ("ambiguous date/prize association") are checked against stored winners instead of rejecting the image:
    // tonight's cells then publish only in prize columns whose dates the stored winners confirm. Any other image-wide warning rejects.
    const layoutOnly = imageWide.length > 0 && !classifyWarnings(passes.map(withoutLayout)).imageWide.length;
    const layoutPending = imageWide.length > 0 && !outvotedLayoutWarning(passes, announcementDate, redated);
    if (layoutPending && !layoutOnly) return { status: 'rejected', reasons: ['image has unresolved extraction warnings; review required', ...imageWide], rows: [] };
    if (passes.every(p => !p.rows.length)) return { status: 'rejected', reasons: ['announcement contains no readable winner rows'], rows: [] };
    const groups = reconcileRows(passes);
    const agreed = groups.filter(g => passes.every((_, i) => g.members[i]));
    // Rows that barely overlap mean the passes read the table differently; no row association can be trusted.
    if (agreed.length * 2 < Math.max(...passes.map(p => p.rows.length))) return { status: 'rejected', reasons: ['extraction passes could not be reliably matched row to row; review required'], rows: [] };
    const anchor = (g: RowGroup) => g.members.find(Boolean)!;
    // The bound is on rows that could publish: stored winners a cumulative table repeats (or misplaces) do not count.
    const currentRows = groups.filter(g => !rowProblems(anchor(g), announcementDate).outside && !g.members.every(m => !m || redated.has(m))
        && compareWinner(anchor(g), existing).status !== 'complete').length;
    if (currentRows > MAX_AUTO_ROWS) return { status: 'rejected', reasons: [`${currentRows} rows exceeds the ${MAX_AUTO_ROWS}-row drawing window limit; review required`], rows: [] };

    const rows: RowDecision[] = groups.map((group, i) => {
        const row = anchor(group);
        const { reasons, outside } = rowProblems(row, announcementDate);
        reasons.push(...group.issues);
        // Every pass's own copy of the cell must support what that pass read, and its printed label must name the prize it read.
        for (const m of group.members) if (m) for (const p of [...(m === row ? [] : cellTextProblems(m)), ...labelProblems(m, schedule)])
            if (!reasons.includes(p)) reasons.push(p);
        const members = group.members.filter((m): m is DraftWinner => !!m);
        const seen = members.length;
        if (seen < passes.length) reasons.push(`row was read by only ${seen} of ${passes.length} extraction passes`);
        // Existing winners retain the original duplicate and hometown-correction rules.
        const derivedPosition = !outside && seen === passes.length && members.some(m => m.position !== row.position)
            && compareWinner(row, existing).status === 'missing' ? numberedColumnPosition(row, members, schedule) : undefined;
        for (const o of group.members) {
            if (!o || o === row) continue;
            const differs: string[] = (['drawDate', 'name', 'town'] as const).filter(f => !same(row[f], o[f]));
            if (Number(row.ticketNumber) !== Number(o.ticketNumber)) differs.push('ticketNumber');
            if (row.ticketNumber !== o.ticketNumber && Number(row.ticketNumber) === Number(o.ticketNumber)) reasons.push('extraction passes disagree on printed ticket label');
            if (!row.town && row.townStatus !== o.townStatus) reasons.push('extraction passes disagree on whether hometown is visibly blank');
            if (!row.ticketNumber && row.ticketStatus !== o.ticketStatus) reasons.push('extraction passes disagree on whether the ticket is visibly blank');
            if (o.notes || o.townStatus === 'uncertain' || o.ticketStatus === 'uncertain') reasons.push('another extraction pass flagged uncertainty');
            if (row.position !== o.position && derivedPosition === undefined) differs.push('position');
            // Different wording is still agreement when both reads identify the same single approved prize.
            if (!same(row.prize, o.prize)) {
                const a = identifyPrize(row.prize, row.drawDate, schedule), b = identifyPrize(o.prize, o.drawDate, schedule);
                if (!a || a !== b) differs.push('prize');
            }
            if (differs.length) reasons.push('extraction passes disagree on ' + differs.join(', '));
        }
        for (const w of rowWarnings) {
            if (!group.members.includes(w.row)) continue;
            if (w.reason) reasons.push(w.reason);
            // "Prize is missing" on a cell under a Firearm or Gift Card heading means it has no label of its own, which is normal; it matters
            // only when a pass actually read no prize, and then prize matching holds the row anyway.
            else if (w.blankField === 'prize') { if (group.members.some(m => m && fold(m.prize ?? '').length < 3)) reasons.push('row warning: the extraction reports this cell has no prize'); }
            else if (w.blankField === 'town' ? group.members.some(m => m && (m.town !== '' || m.townStatus !== 'blank'))
                : group.members.some(m => m && (m.ticketNumber !== '' || m.ticketStatus !== 'blank'))) reasons.push('a warning reports a blank cell that the extraction passes do not confirm');
        }
        // A stored winner every pass reads only under another date is recognised, never written, whatever else the reads say.
        const moved = group.members.map(m => m && redated.get(m)?.winner);
        if (!outside && moved.every((w, k) => !group.members[k] || (w && w === moved.find(Boolean))) && moved.some(Boolean)) {
            const w = moved.find(Boolean)!;
            return { rowNumber: i + 1, outcome: 'duplicate' as const, reasons: [`already stored under another date; the image places this winner on a different row, nothing changed: stored ${w.drawDate}, read ${row.drawDate}`],
                row, winnerId: w.id, prize: null, prizeMatch: 'none' as const };
        }
        // A stored winner that every pass that saw it reads exactly as stored, on its date and in its slot, is a duplicate even when a pass
        // missed it or flagged it: nothing would be written, so it needs no review.
        if (!outside && reasons.length) {
            const ids = group.members.filter(Boolean).map(m => { const cmp = compareWinner(m!, existing), w = existing.find(v => v.id === cmp.existingId);
                return cmp.status === 'complete' && w && (fold(m!.prize ?? '').length < 3 || identifyPrize(m!.prize, m!.drawDate, schedule)?.id === storedSlot(w, schedule)) ? w.id : null; });
            if (ids.every(id => id && id === ids[0])) return { rowNumber: i + 1, outcome: 'duplicate' as const, reasons: ['already stored; nothing changed'], row,
                winnerId: ids[0], prize: null, prizeMatch: 'none' as const };
        }
        // A row older than this announcement's window can never publish, so reading it imperfectly is not a hold.
        return { rowNumber: i + 1, outcome: outside ? 'outside-window' : reasons.length ? 'held' : 'insert', reasons, row,
            winnerId: null, prize: null, prizeMatch: 'none' as const, derivedPosition };
    });

    // Conflicts inside the image itself hold every involved row rather than picking one.
    const clusters = new Map<string, RowDecision[]>();
    for (const d of rows) {
        if (!realDate(d.row.drawDate) || d.outcome === 'outside-window' || d.outcome === 'duplicate') continue;
        const position = d.derivedPosition ?? d.row.position;
        const keys = [...(d.row.ticketNumber ? [`t:${d.row.drawDate}:${Number(d.row.ticketNumber)}`] : []),
            ...(position !== null && position !== BONUS ? [`p:${d.row.drawDate}:${position}`] : [])];
        for (const k of keys) clusters.set(k, [...(clusters.get(k) ?? []), d]);
    }
    for (const [k, list] of clusters) if (list.length > 1) for (const d of list) {
        d.outcome = 'held'; d.reasons.push(k.startsWith('t:') ? 'ticket appears twice for this date in the image' : 'place appears twice for this date in the image');
    }

    // Places a row in an identified approved slot: place, blank-ticket, slot-holder and removed-winner checks, then the publish reasons.
    const settle = (d: RowDecision, prize: ScheduledPrize, scheduledPosition: WinnerPosition, how = 'prize matches approved calendar entry') => {
        d.prizeMatch = 'scheduled';
        const position = d.derivedPosition ?? d.row.position ?? scheduledPosition;
        if (position === null || (scheduledPosition !== null && position !== scheduledPosition)) {
            d.outcome = 'held';
            d.reasons.push('place is missing or conflicts with the approved drawing schedule; review required');
            return;
        }
        const ticketFree = d.row.ticketNumber === '';
        // A blank ticket needs a slot the calendar proves: main prize, gift card or a bonus drawing. A legacy numbered supplement does not qualify.
        if (ticketFree && !(scheduledPosition === 1 || scheduledPosition === 2 || scheduledPosition === BONUS)) {
            d.outcome = 'held';
            d.reasons.push('a winner without a ticket needs one approved main, gift card or bonus prize on the calendar');
            return;
        }
        // The slot is the identity. Numbered places also stay exclusive for stored rows with no matching description; several bonus drawings may coexist.
        const holder = existing.find(w => w.drawDate === d.row.drawDate && (storedSlot(w, schedule) === prize.id
            || (position !== BONUS && parseWinnerPrize(w.prize ?? null).position === position)));
        if (holder) { d.outcome = 'rejected'; d.reasons.push(`${placementLabel(position)} for ${d.row.drawDate} already belongs to another winner`); return; }
        d.prize = composePrize(position, prize.description);
        d.prizeSlotId = prize.id;
        d.winnerId = ticketFree ? ticketlessWinnerId(d.row.drawDate, prize.id) : winnerId(d.row.drawDate, Number(d.row.ticketNumber));
        if (options.removedWinnerIds?.has(d.winnerId)) {
            d.outcome = 'held'; d.reasons.push('this photo already published this winner and an administrator removed it; not republished');
            return;
        }
        if (d.row.readDate !== undefined) d.reasons.push(d.row.readDate === d.row.drawDate ? "the cell's own label names this date's approved bonus drawing"
            : `date from the approved calendar: the cell's own label names only this date's bonus drawing; the extraction placed it on ${d.row.readDate}`);
        const reconciled = d.derivedPosition !== undefined;
        d.reasons.push(`all ${passes.length} extraction passes agree${reconciled ? ' on the winner and column' : ''}`, `${how} ${prize.id}`,
            reconciled ? `${placementLabel(position)} derived from the agreed column and approved calendar because a pass left position blank`
                : `${placementLabel(position)} from ${d.row.position === null ? 'the approved calendar' : 'the printed label and approved calendar'}`,
            ...(ticketFree ? ['every extraction pass confirms no ticket number is printed'] : []));
    };
    const unidentified = new Set<RowDecision>();
    for (const d of rows) {
        if (d.outcome === 'held' || d.outcome === 'duplicate') continue;
        const cmp = compareWinner(d.row, existing);
        const prize = identifyPrize(d.row.prize, d.row.drawDate, schedule);
        const scheduledPosition = prize ? calendarPosition(prize, schedule) : null;
        if (cmp.status === 'complete') {
            const record = existing.find(w => w.id === cmp.existingId);
            const recordSlot = record ? storedSlot(record, schedule) : null;
            // Same person is not enough: a winner stored in another prize slot contradicts this announcement.
            if (d.outcome !== 'outside-window' && prize && recordSlot && recordSlot !== prize.id) {
                d.outcome = 'rejected'; d.winnerId = cmp.existingId;
                d.reasons.push(`conflicts with existing winner (prize slot: stored ${recordSlot}, announcement ${prize.id}); correct it in admin`);
                continue;
            }
            if (d.outcome !== 'outside-window' && !prize && fold(d.row.prize ?? '').length >= 3) {
                d.outcome = 'held'; d.winnerId = cmp.existingId; d.prizeMatch = 'unmatched';
                d.reasons.push('prize text could not be compared with the stored winner; review required');
                continue;
            }
            d.outcome = 'duplicate'; d.winnerId = cmp.existingId;
            d.reasons.push('already stored; nothing changed');
            const stored = parseWinnerPrize(record?.prize ?? null).position;
            // Never corrected here. A record from the old three-prize mapping is surfaced for an administrator.
            if (stored !== null && scheduledPosition !== null && stored !== scheduledPosition) d.reasons.push(`stored place ${placementLabel(stored)} differs from approved schedule ${placementLabel(scheduledPosition)}; review in admin`);
            continue;
        }
        // Any image-wide remark, even one outvoted above, rules out changing a stored winner.
        const correction = cmp.status === 'conflicting' && !imageWide.length ? townCorrection(d, cmp, existing, prize, groups[d.rowNumber - 1], passes.length) : null;
        if (correction) {
            d.correction = correction; d.winnerId = correction.winnerId; d.outcome = correction.fallback;
            d.reasons.push(correction.fallback === 'rejected' ? 'conflicts with existing winner (town)' : 'draw date is older than this announcement window');
            continue;
        }
        if (d.outcome === 'outside-window') { d.reasons.push('draw date is older than this announcement window'); continue; }
        if (cmp.status !== 'missing') {
            d.outcome = cmp.status === 'incomplete' ? 'held' : 'rejected';
            d.reasons.push(cmp.status !== 'incomplete' ? 'conflicts with existing winner (' + cmp.conflicts.join(', ') + ')'
                : cmp.missingFields.includes('ticketNumber') ? 'the announcement shows a ticket the stored winner lacks; add it in admin'
                : 'existing winner record is incomplete; correct it in admin');
            continue;
        }
        if (!prize) {
            if (d.row.strayLabel) d.reasons.push(`the bonus label read with this cell is not in its own text, so its column is unknown: ${d.row.strayLabel}`);
            d.outcome = 'held';
            d.prizeMatch = fold(d.row.prize ?? '').length < 3 ? 'none' : 'unmatched';
            d.reasons.push('prize or column header must identify exactly one approved scheduled prize; review required');
            if (!d.row.strayLabel) unidentified.add(d); // Every other check passed; the remaining-bonus step below may still place it.
            continue;
        }
        settle(d, prize, scheduledPosition);
    }

    const placements = new Map<string, RowDecision[]>();
    for (const d of rows.filter(d => d.outcome === 'insert')) {
        const key = d.prizeSlotId ?? `${d.row.drawDate}:${parseWinnerPrize(d.prize).position}`;
        placements.set(key, [...(placements.get(key) ?? []), d]);
    }
    for (const list of placements.values()) if (list.length > 1) for (const d of list) {
        d.outcome = 'held'; d.reasons = ['multiple new winners match the same scheduled prize'];
    }

    // A column whose stored winners a pass misdates cannot date tonight's cell either.
    const misdated = new Map<string, Redated & { row: DraftWinner }>();
    for (const [row, r] of redated) if (r.category && !misdated.has(r.category)) misdated.set(r.category, { ...r, row });
    // A cell dated by its own label does not depend on its column's rows.
    const confirmed = new Map<string, boolean>();
    for (const d of rows) {
        if (d.outcome !== 'insert' || d.row.readDate !== undefined) continue;
        const category = schedule.find(p => p.id === d.prizeSlotId)?.category ?? '';
        const evidence = misdated.get(category);
        if (evidence) {
            d.outcome = 'held';
            d.reasons = [`an extraction pass dates an already-stored winner in this prize column differently from the reviewed record, so this column's dates cannot be verified; review required: ${evidence.category} stored ${evidence.winner.drawDate}, read ${evidence.row.drawDate}`];
            continue;
        }
        if (!layoutPending) continue;
        if (!confirmed.has(category)) confirmed.set(category, columnConfirmed(category, passes, existing, schedule, redated));
        if (confirmed.get(category)) { d.reasons.push(`layout remark resolved: stored ${category} winners confirm this column's dates in every pass`); continue; }
        d.outcome = 'held';
        d.reasons = [`an extraction pass reported an ambiguous layout and too few stored winners confirm this prize column's dates; review required: ${category}`];
    }

    // ---- The drawing's one remaining bonus prize, by elimination ----
    // Nov 22: "Vexliar - 781 - …" was held although the firearm and gift card had published and the Vexilar Fish Finder was the only
    // approved prize of the night left. A winner whose every other check passed and whose prize text names no approved prize takes the
    // drawing's remaining bonus only when all of these hold; otherwise it stays held exactly as before:
    //  - it is the only such winner in the announcement window, and every pass places it in a bonus column: an explicit Bonus place, a
    //    bonus heading ("Bonus Drawing", "2nd Drawing"), or a label printed in the cell's own text, never a numbered place or a stray label;
    //  - its text names no approved prize of another date (a misdated cell of another night);
    //  - every numbered-place prize of its date is already stored or published by this photo, and exactly one approved bonus of the date,
    //    which the calendar fully explains, is unaccounted for, with no other bonus of the window unaccounted for;
    //  - the bonus column's dates are not refuted (misdated stored bonus winner) and, under a layout remark, are confirmed.
    // Slot holders, removed winners and the blank-ticket rule are checked exactly as for a named prize (settle).
    const inWindowDates = new Set(windowDates(announcementDate));
    const inWindow = (d: RowDecision) => inWindowDates.has(d.row.drawDate) && d.row.drawDate <= announcementDate;
    const loose = rows.filter(d => inWindow(d) && d.outcome === 'held' && fold(d.row.name).length >= 2 && !d.prizeSlotId
        && !identifyPrize(d.row.prize, d.row.drawDate, schedule));
    const remaining = loose.length === 1 && unidentified.has(loose[0]) ? loose[0] : null;
    if (remaining) {
        const date = remaining.row.drawDate;
        const accounted = (p: ScheduledPrize) => existing.some(w => w.drawDate === p.drawDate && storedSlot(w, schedule) === p.id)
            || rows.some(d => d.row.drawDate === p.drawDate && (d.prizeSlotId === p.id || identifyPrize(d.row.prize, p.drawDate, schedule)?.id === p.id));
        const day = schedule.filter(p => p.status === 'approved' && p.drawDate === date);
        // A numbered place counts only when it is stored or this photo publishes it; a held or rejected cell naming it does not.
        const settled = (p: ScheduledPrize) => existing.some(w => w.drawDate === p.drawDate && storedSlot(w, schedule) === p.id)
            || rows.some(d => d.outcome === 'insert' && d.prizeSlotId === p.id);
        const placed = day.filter(p => p.category !== 'Bonus drawing');
        const open = day.filter(p => p.category === 'Bonus drawing' && !accounted(p));
        const elsewhere = schedule.filter(p => p.status === 'approved' && p.category === 'Bonus drawing' && p.drawDate !== date
            && inWindowDates.has(p.drawDate) && p.drawDate <= announcementDate && !accounted(p));
        const otherDates = [...inWindowDates].filter(v => v !== date);
        const bonusColumn = (m: DraftWinner) => {
            const visible = fold(m.prize ?? ''), label = ownLabel(m.cellText ?? '');
            if (m.position !== null && m.position !== BONUS) return false;
            const heading = Object.hasOwn(CATEGORY_HEADINGS, visible) ? CATEGORY_HEADINGS[visible] : null;
            if (heading && heading !== 'Bonus drawing') return false;
            if (!heading && (calendarBonus(m, schedule) || otherDates.some(v => identifyPrize(m.prize, v, schedule)))) return false;
            // A label printed in the cell must not name something else: a bonus heading, or words that loosely belong to the remaining prize.
            const own = label ? fold(label) : '';
            const labelOk = !label || (Object.hasOwn(CATEGORY_HEADINGS, own) ? CATEGORY_HEADINGS[own] === 'Bonus drawing'
                : open.length === 1 && compatibleLabel(label, open[0].description));
            if (m.position === BONUS || heading === 'Bonus drawing') return labelOk;
            return !!label && visible.length >= 3 && same(label, m.prize) && labelOk;
        };
        const members = groups[remaining.rowNumber - 1]?.members.filter((m): m is DraftWinner => !!m) ?? [];
        const columnSure = !misdated.has('Bonus drawing') && (!layoutPending || columnConfirmed('Bonus drawing', passes, existing, schedule, redated));
        if (members.length === passes.length && members.every(bonusColumn) && placed.length > 0 && placed.every(settled)
            && open.length === 1 && !elsewhere.length && calendarPosition(open[0], schedule) === BONUS && columnSure) {
            remaining.outcome = 'insert'; remaining.reasons = [];
            settle(remaining, open[0], BONUS, 'prize assigned by elimination to approved calendar entry');
            if (remaining.outcome === 'insert') remaining.reasons.push(`prize by elimination: the only approved bonus drawing of ${date} not yet accounted for; every numbered place of the drawing is stored or published and every extraction pass places this winner in the bonus column`);
        }
    }

    // An approved prize of the announcement's own drawing that no cell accounts for (stored, published or held) is reported. Real reads of
    // 56–60-cell tables kept only 1–2 of 13 sparse bonus cells, and a winner no pass reads would otherwise go missing without any alert.
    if (rows.some(d => d.row.drawDate === announcementDate)) {
        const accounted = new Set([...existing.filter(w => w.drawDate === announcementDate).map(w => storedSlot(w, schedule)),
            ...rows.filter(d => d.row.drawDate === announcementDate).map(d => d.prizeSlotId ?? identifyPrize(d.row.prize, announcementDate, schedule)?.id)]);
        const missing = schedule.filter(p => p.status === 'approved' && p.drawDate === announcementDate && !accounted.has(p.id));
        // Nov 15: the held "Blackstone" winner and the griddle nobody was read for were one missing winner reported as two held rows. Held
        // winners of this drawing whose prize could not be identified already cover that many unaccounted prizes: they name the prizes
        // (never assigned by elimination) and no separate row is added. More unaccounted prizes than such winners are still listed one by one.
        const unplaced = rows.filter(d => d.outcome === 'held' && d.row.drawDate === announcementDate && fold(d.row.name).length >= 2
            && !identifyPrize(d.row.prize, announcementDate, schedule));
        if (missing.length && unplaced.length >= missing.length) for (const d of unplaced) d.reasons.push(
            `approved for this drawing with no winner read; check whether this winner belongs to it: ${missing.map(p => p.description).join('; ')}`);
        else for (const p of missing) rows.push({
            rowNumber: rows.length + 1, outcome: 'held', row: { drawDate: announcementDate, position: null, ticketNumber: '', name: '', town: '', notes: '', prize: p.description },
            reasons: [`no winner was read for this approved prize; enter it from the post if it was drawn: ${p.description}`],
            winnerId: null, prize: null, prizeSlotId: p.id, prizeMatch: 'none' });
    }

    // Several hometown conflicts in one photo look like a misread column, not a corrected spreadsheet: none is corrected automatically.
    const proposed = rows.filter(d => d.correction);
    if (proposed.length > MAX_TOWN_CORRECTIONS) for (const d of proposed) {
        delete d.correction;
        if (d.outcome === 'rejected') d.reasons.push(`${proposed.length} hometown conflicts in one photo; automatic correction is limited to ${MAX_TOWN_CORRECTIONS}; review required`);
    }
    return { status: photoStatus(rows), reasons: photoStatus(rows) === 'ignored' ? ['no rows for the current drawing window'] : [], rows };
}

function photoStatus(rows: RowDecision[]): PhotoDecision['status'] {
    const count = (o: RowOutcome) => rows.filter(d => d.outcome === o).length;
    const inserted = count('insert'), held = count('held'), rejected = count('rejected');
    // A confirmed hometown correction changes a stored winner but publishes no new one, so like a duplicate it never needs review.
    return inserted && (held || rejected) ? 'partial' : inserted ? 'published' : rejected ? 'rejected' : held ? 'held'
        : count('duplicate') || count('correct') ? 'duplicate' : 'ignored';
}

// ---- Self-correction of a stored hometown from a later (cumulative) announcement ----
// Nov 22: both passes read the bonus cell as "… Troy Mish, Westby, WI", the town of the Gift Card cell beside it, and it was published.
// Both passes of the Nov 24 cumulative table read "Maple Park, IL" for the same cell (the Page's table was edited between the posts:
// "Brodhead, Wi" also became "WI"), and the row was rejected as a conflict because nothing in this pipeline ever changes a stored winner.
// A stored hometown is replaced only when every one of these holds; otherwise the row is rejected (or outside the window) exactly as before:
//  - the row has no other problem at all (every per-row, cell-text, label and agreement check passed) and the image has no image-wide
//    warning in any pass, not even an outvoted layout remark;
//  - exactly one stored winner matches, on the same date with the same ticket and the same name, and the hometown is the only field that
//    differs; the place does not conflict and the printed prize identifies exactly the stored approved prize slot;
//  - every pass read the cell, all agree on the new hometown (harmless formatting aside) and mark it readable;
//  - the stored hometown is the one a winner photo read (townSource 'automated'), never one an administrator edited or entered;
//  - at most MAX_TOWN_CORRECTIONS such rows in the photo; and finally an independent targeted re-read of that one cell confirms it.
export const MAX_TOWN_CORRECTIONS = 2;
function townCorrection(d: RowDecision, cmp: ReturnType<typeof compareWinner>, existing: ExistingWinner[], prize: ScheduledPrize | null,
    group: RowGroup | undefined, passCount: number): TownCorrection | null {
    if (d.reasons.length || (d.outcome !== 'insert' && d.outcome !== 'outside-window')) return null;
    if (cmp.conflicts.length !== 1 || cmp.conflicts[0] !== 'town' || cmp.missingFields.length) return null;
    const record = existing.find(w => w.id === cmp.existingId), row = d.row;
    if (!record || record.townSource !== 'automated' || !record.prizeSlotId || !prize || prize.id !== record.prizeSlotId) return null;
    if (record.drawDate !== row.drawDate || !/^\d{1,9}$/.test(row.ticketNumber) || Number(row.ticketNumber) !== Number(record.ticketNumber)
        || fold(row.name).length < 2 || !same(row.name, record.name)) return null;
    const members = group?.members.filter((m): m is DraftWinner => !!m) ?? [];
    if (members.length !== passCount || !members.every(m => m.townStatus === 'readable' && townKey(m.town) === townKey(row.town))) return null;
    if (townKey(row.town).length < 2 || !townKey(record.town) || townKey(row.town) === townKey(record.town)) return null;
    return { winnerId: record.id, drawDate: row.drawDate, ticketNumber: row.ticketNumber, name: row.name, prizeSlotId: record.prizeSlotId,
        from: record.town!, to: row.town, fallback: d.outcome === 'insert' ? 'rejected' : 'outside-window' };
}
/** The cells to re-read: one targeted AI read each, requested only when decidePhoto proposed a correction. */
export const townCorrectionTargets = (decision: PhotoDecision) => decision.rows.filter(d => d.correction)
    .map(d => ({ rowNumber: d.rowNumber, drawDate: d.correction!.drawDate, ticketNumber: d.correction!.ticketNumber, name: d.correction!.name }));
/** The targeted re-read confirms the cell: same date, ticket and name, a readable hometown equal to the proposed one, and consistent cell text. */
export function rereadConfirms(c: TownCorrection, r: DraftWinner | null | undefined) {
    return !!r && r.drawDate === c.drawDate && /^\d{1,9}$/.test(r.ticketNumber) && Number(r.ticketNumber) === Number(c.ticketNumber)
        && same(r.name, c.name) && r.townStatus === 'readable' && !r.notes && townKey(r.town) === townKey(c.to) && townKey(r.town) !== townKey(c.from)
        && !!(r.cellText ?? '').trim() && cellTextProblems(r).length === 0;
}
/**
 * Applies the targeted re-reads (by row number; null = the read failed or found nothing). A confirmed candidate becomes 'correct'; any
 * other keeps its fallback outcome and reasons, plus why it was not corrected, so an administrator still reviews a rejected row.
 */
export function confirmTownCorrections(decision: PhotoDecision, rereads: Map<number, DraftWinner | null>): PhotoDecision {
    const rows = decision.rows.map(d => {
        if (!d.correction || d.outcome === 'correct') return d;
        // Shown on Admin > Raffle > Photo imports. A correction row is never held or rejected, so these reasons never reach an alert email;
        // the old and new hometowns follow a colon, which reasonCode drops from logs and diagnostics.
        if (rereadConfirms(d.correction, rereads.get(d.rowNumber))) return { ...d, outcome: 'correct' as const, reasons: [
            `hometown corrected automatically by the photo importer, not by an administrator: “${d.correction.from}” → “${d.correction.to}”`,
            'every extraction pass and a targeted re-read of the cell agree on the new hometown; the stored one was read by the importer and never edited by an administrator',
            `same date, ticket, name and approved prize slot: ${d.correction.prizeSlotId}` ] };
        const why = rereads.has(d.rowNumber) ? 'a targeted re-read of the cell did not confirm the new hometown' : 'the targeted re-read of the cell was not available';
        return { ...d, reasons: [...d.reasons, `${why}; not corrected automatically${d.correction.fallback === 'rejected' ? '; review required' : ''}`] };
    });
    const status = photoStatus(rows);
    return { status, reasons: status === 'ignored' ? ['no rows for the current drawing window'] : decision.reasons, rows };
}

// JSON fields of the audit tables, read without ever failing on a malformed value.
const jsonField = (column: string, path: string) => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END`;
/** An administrator's edit of the winner (any 'update' correction not written by the importer) protects its hometown for good. */
const MANUAL_EDIT = `EXISTS (SELECT 1 FROM raffle_winner_corrections c WHERE c.winner_id=w.id AND c.action='update'
    AND coalesce(${jsonField('c.after_json', '$.source')}, '')<>'photo-auto')`;
/** The stored hometown is exactly what a winner photo read (row_json keeps the read even after an admin review) or an automatic correction wrote. */
const AUTOMATED_TOWN = `(EXISTS (SELECT 1 FROM raffle_photo_auto_rows a WHERE a.winner_id=w.id AND a.outcome='inserted' AND ${jsonField('a.row_json', '$.town')}=w.town)
    OR EXISTS (SELECT 1 FROM raffle_winner_corrections c WHERE c.winner_id=w.id AND ${jsonField('c.after_json', '$.source')}='photo-auto'
        AND ${jsonField('c.after_json', '$.town')}=w.town))`;
/**
 * The month-wide scan (whole-table reads of the cumulative table, made after tonight's post is finished). For winners drawn before
 * tonight's 3-day publication window, in the announcement's own raffle month, it returns:
 *  - correction proposals (with `correction`, outcome 'outside-window' until a targeted re-read confirms them), only for dates that
 *    tonight's window reads did not cover (`covered`: the window decision already handled those);
 *  - display-only conflicts (outcome 'outside-window', no correction): every pass reads a stored winner's ticket and name with the same
 *    other hometown, but the correction rules do not allow changing it. They are shown in Photo imports, never reviewed or alerted.
 * The first reason of each row names the stored and the printed hometown; writeMonthScan uses it to show each conflict only once.
 * Nothing else from these reads is ever written: new winners still publish only from the window reads.
 * Running the whole decidePhoto on a 73-cell table costs ~8 ms of cold CPU on top of the window decision, beyond the Workers Free budget, so
 * a cheap filter first skips every row unless a stored winner of that date has the same ticket and name and another hometown. Only those
 * rows then take the window decision's checks: no image-wide warning, the passes match row to row, every pass read the cell and agrees on
 * every field, no row, cell-text or label problem, no row warning, the ticket appears once for the date, one stored winner, only the town
 * differs, the printed prize identifies the stored approved slot, and the stored hometown is automated (townCorrection).
 * `windowProposed` is how many corrections tonight's window decision proposed for the same photo: the MAX_TOWN_CORRECTIONS limit is shared,
 * and when the two workflows together would exceed it, none of the month scan's proposals is corrected (all are shown as conflicts).
 */
export function monthCorrections(passes: Extraction[], existing: ExistingWinner[], schedule: ScheduledPrize[], announcementDate: string,
    covered: Iterable<string>, windowProposed = 0): PhotoDecision {
    const none: PhotoDecision = { status: 'duplicate', reasons: [], rows: [] };
    const skip = new Set(covered), month = announcementDate.slice(0, 7), publishFrom = windowDates(announcementDate)[0];
    if (passes.length < 2 || passes.some(p => !p.containsWinners)) return none;
    // A typical night ends here: no cell anywhere shows a stored winner's ticket and name with another hometown.
    const byPerson = new Map<string, ExistingWinner[]>();
    for (const w of existing) if (w.ticketNumber && w.drawDate?.startsWith(month)) {
        const k = `${Number(w.ticketNumber)}|${fold(w.name ?? '')}`; byPerson.set(k, [...(byPerson.get(k) ?? []), w]);
    }
    const suspect = (r: DraftWinner) => /^\d{1,9}$/.test(r.ticketNumber)
        && !!byPerson.get(`${Number(r.ticketNumber)}|${fold(r.name)}`)?.some(w => townKey(w.town) !== townKey(r.town));
    if (!passes.every(p => p.rows.some(suspect))) return none;
    // Bonus cells are dated by the calendar exactly as in decidePhoto, but only the suspect ones: the rest are never proposed anyway.
    passes = passes.map(p => { const dated = calendarDated({ ...p, rows: p.rows.filter(suspect) }, schedule).rows;
        let k = 0; return { ...p, rows: p.rows.map(r => suspect(r) ? dated[k++] : r) }; });
    // An unreliable read shows nothing: an image-wide warning, or passes that cannot be matched row to row.
    const { imageWide, rowWarnings } = classifyWarnings(passes);
    if (imageWide.length) return none;
    const groups = reconcileRows(passes);
    if (groups.filter(g => passes.every((_, i) => g.members[i])).length * 2 < Math.max(...passes.map(p => p.rows.length))) return none;
    const byDate = new Map<string, ExistingWinner[]>();
    for (const w of existing) if (w.drawDate) byDate.set(w.drawDate, [...(byDate.get(w.drawDate) ?? []), w]);
    const proposals: RowDecision[] = [], conflicts: RowDecision[] = [];
    groups.forEach((g, i) => {
        const members = g.members.filter((m): m is DraftWinner => !!m), row = members[0];
        if (!row || members.length !== passes.length || !realDate(row.drawDate) || row.drawDate.slice(0, 7) !== month || row.drawDate >= publishFrom) return;
        const sameDay = byDate.get(row.drawDate) ?? [];
        const stored = sameDay.filter(w => Number(w.ticketNumber) === Number(row.ticketNumber) && same(w.name, row.name) && townKey(w.town) !== townKey(row.town));
        // Shown only when every pass prints the same other hometown; reads that disagree with each other are no evidence of anything.
        if (stored.length !== 1 || !members.every(m => townKey(m.town) === townKey(row.town) && m.town.trim())) return;
        const w = stored[0];
        const base: RowDecision = { rowNumber: i + 1, outcome: 'outside-window', row, winnerId: w.id, prize: null, prizeMatch: 'none',
            reasons: [`older hometown differs from the stored winner; not corrected automatically: stored “${w.town}”, printed “${row.town}”`] };
        if (skip.has(row.drawDate)) {
            conflicts.push({ ...base, reasons: [...base.reasons, "read with tonight's announcement window, whose decision did not correct it"] });
            return;
        }
        const reasons = [...rowProblems(row, announcementDate).reasons, ...g.issues];
        const prize = identifyPrize(row.prize, row.drawDate, schedule);
        for (const m of members) {
            reasons.push(...cellTextProblems(m), ...labelProblems(m, schedule));
            const agrees = (['drawDate', 'name', 'town'] as const).every(f => same(row[f], m[f])) && m.ticketNumber === row.ticketNumber && m.position === row.position
                && m.townStatus === row.townStatus && m.ticketStatus === row.ticketStatus && !m.notes && identifyPrize(m.prize, m.drawDate, schedule) === prize;
            if (!agrees) reasons.push('the extraction passes disagree on this cell');
        }
        if (rowWarnings.some(r => members.includes(r.row))) reasons.push('an extraction pass flagged this cell');
        if (passes.some(p => p.rows.filter(r => r.drawDate === row.drawDate && Number(r.ticketNumber) === Number(row.ticketNumber)).length > 1)) reasons.push('the ticket appears twice for this date');
        const cmp = compareWinner(row, sameDay);
        const correction = cmp.status === 'conflicting' ? townCorrection({ ...base, reasons }, cmp, sameDay, prize, g, passes.length) : null;
        if (correction) { proposals.push({ ...base, correction }); return; }
        const why = w.townSource === 'manual' ? 'the stored hometown was edited by an administrator'
            : w.townSource !== 'automated' ? 'the stored winner was not published from a winner photo exactly as read'
            : reasons.length ? `the cell did not pass every extraction check (${[...new Set(reasons)].slice(0, 3).join('; ')})`
            : 'date, ticket, name and approved prize slot do not identify the stored winner unambiguously';
        conflicts.push({ ...base, reasons: [...base.reasons, why] });
    });
    const allowed = Math.max(0, MAX_TOWN_CORRECTIONS - windowProposed);
    if (proposals.length > allowed) return { ...none, rows: [...conflicts, ...proposals.map(({ correction: _c, ...d }) => ({ ...d, reasons: [...d.reasons,
        `${proposals.length + windowProposed} hometown corrections in one photo would exceed its limit of ${MAX_TOWN_CORRECTIONS}`
        + (windowProposed ? ` (${windowProposed} already proposed by tonight's window reads)` : '') + '; review required'] }))] };
    return { ...none, rows: [...proposals, ...conflicts] };
}

/**
 * One month-wide scan per decided photo, in its own cron invocation. The decision's invocation only queues it: a reserved audit row
 * (MONTH_SCAN_ROW, shown in Photo imports) whose first reason is MONTH_SCAN_QUEUED and whose row_json carries what the scan needs. A later
 * invocation with no post to process takes it with an atomic queued → started update; overlapping invocations race on that update and
 * exactly one wins, so the table is read once. The row is created only for a decided (not failed) photo, and never twice.
 */
export const MONTH_SCAN_ROW = 9000;
export const MONTH_SCAN_QUEUED = 'month-wide hometown check queued: it runs in the next cron invocation that has no post to process';
const MONTH_SCAN_STARTED = 'month-wide hometown check started: whole-table reads, used only to verify stored hometowns';
export type QueuedMonthScan = { photoId: string; postId: string; announcementDate: string; windowProposed: number };
export async function queueMonthScan(db: D1Database, scan: QueuedMonthScan) {
    const res = await db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
        SELECT ?, ?, 'outside-window', NULL, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM raffle_photo_auto_imports WHERE photo_id=? AND status<>'failed')
        ON CONFLICT(photo_id, row_number) DO NOTHING`)
        .bind(scan.photoId, MONTH_SCAN_ROW, JSON.stringify([MONTH_SCAN_QUEUED]), JSON.stringify({ monthScan: scan }), scan.photoId).run();
    return res.meta.changes === 1;
}
/** The oldest queued scan, or null. */
export async function nextMonthScan(db: D1Database): Promise<QueuedMonthScan | null> {
    const row = await db.prepare(`SELECT row_json AS json FROM raffle_photo_auto_rows WHERE row_number=? AND reasons_json=? ORDER BY created_at LIMIT 1`)
        .bind(MONTH_SCAN_ROW, JSON.stringify([MONTH_SCAN_QUEUED])).first<{ json: string }>();
    try { const scan = JSON.parse(row?.json ?? 'null')?.monthScan; return scan && numericId(scan.photoId) ? scan : null; } catch { return null; }
}
/** Takes a queued scan: true for exactly one caller. */
export async function startMonthScan(db: D1Database, photoId: string) {
    const res = await db.prepare(`UPDATE raffle_photo_auto_rows SET reasons_json=? WHERE photo_id=? AND row_number=? AND reasons_json=?`)
        .bind(JSON.stringify([MONTH_SCAN_STARTED]), photoId, MONTH_SCAN_ROW, JSON.stringify([MONTH_SCAN_QUEUED])).run();
    return res.meta.changes === 1;
}
export async function finishMonthScan(db: D1Database, photoId: string, summary: string) {
    await db.prepare(`UPDATE raffle_photo_auto_rows SET reasons_json=? WHERE photo_id=? AND row_number=?`)
        .bind(JSON.stringify([`month-wide hometown check: ${summary}`]), photoId, MONTH_SCAN_ROW).run();
}
/** The decided photo's stored image hash and reads, so the scan reuses them and checks that Facebook still serves the same image. */
export async function decidedReads(db: D1Database, photoId: string) {
    const row = await db.prepare(`SELECT image_sha256 AS sha256, extraction_json AS json FROM raffle_photo_auto_imports WHERE photo_id=? AND status<>'failed'`)
        .bind(photoId).first<{ sha256: string | null; json: string }>();
    if (!row) return null;
    try { const reads = JSON.parse(row.json); return { sha256: row.sha256, reads: Array.isArray(reads) ? reads.filter(r => r && typeof r === 'object' && r.read && Array.isArray(r.rows)) : [] }; }
    catch { return { sha256: row.sha256, reads: [] }; }
}
export type MonthScanMode = 'correct' | 'report';
/**
 * Writes a month-wide scan for a photo that is already decided, in one atomic batch after the photo's existing audit rows; the photo's
 * status and its other rows are not touched, so nothing here can open a review or an alert:
 *  - a confirmed correction (mode 'correct', publishing on): the same guarded statements as writeDecision; losing a race leaves an
 *    'outside-window' conflict row, never a rejection;
 *  - every other row, and confirmed corrections in report mode: an 'outside-window' row, written only if no earlier photo already shows
 *    this exact conflict for this winner (same stored and printed hometown), so a cumulative table repeats nothing night after night.
 * Returns how many corrections and how many newly shown conflicts were stored.
 */
export async function writeMonthScan(db: D1Database, photoId: string, decision: PhotoDecision, mode: MonthScanMode, publish: boolean) {
    const result = { corrected: 0, shown: 0 };
    if (!decision.rows.length) return result;
    const done = new Set((await db.prepare(`SELECT winner_id AS id FROM raffle_winner_corrections WHERE ${jsonField('after_json', '$.source')}='photo-auto'
        AND ${jsonField('after_json', '$.photoId')}=?`).bind(photoId).all<{ id: string }>()).results.map(r => r.id));
    const last = (await db.prepare(`SELECT coalesce(max(row_number), 0) AS n FROM raffle_photo_auto_rows WHERE photo_id=?`).bind(photoId).first<{ n: number }>())?.n ?? 0;
    let n = last;
    const statements: D1PreparedStatement[] = [];
    for (const d of decision.rows) {
        if (d.correction && done.has(d.correction.winnerId)) continue;
        const row = JSON.stringify(d.row), key = d.reasons[0];
        if (d.outcome === 'correct' && d.correction && mode === 'correct' && publish) {
            statements.push(...townCorrectionStatements(db, photoId, ++n, d, d.correction, row,
                { outcome: 'outside-window', reasons: [key.startsWith('older hometown') ? key : 'older hometown differs from the stored winner; not corrected automatically',
                    'the stored winner changed before the automatic hometown correction could be written'] }));
            continue;
        }
        const conflict = d.outcome === 'correct' ? `older hometown differs from the stored winner; not corrected automatically: stored “${d.correction!.from}”, printed “${d.correction!.to}”` : key;
        const reasons = d.outcome === 'correct' ? [conflict, mode === 'report' ? 'report-only mode (FB_PHOTO_MONTH_SCAN=report): every check and a targeted re-read confirm the printed hometown; not written'
            : 'dry run: verified but not written (FB_PHOTO_AUTOPUBLISH is off)'] : d.reasons;
        statements.push(db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
            SELECT ?, ?, 'outside-window', ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM raffle_photo_auto_rows a WHERE a.winner_id=? AND a.outcome='outside-window'
                AND ${jsonField('a.reasons_json', '$[0]')}=?)`).bind(photoId, ++n, d.winnerId, JSON.stringify(reasons), row, d.winnerId, conflict));
    }
    if (!statements.length) return result;
    await db.batch(statements);
    const after = await db.prepare(`SELECT count(*) AS n FROM raffle_winner_corrections WHERE ${jsonField('after_json', '$.source')}='photo-auto'
        AND ${jsonField('after_json', '$.photoId')}=?`).bind(photoId).first<{ n: number }>();
    const shown = await db.prepare(`SELECT count(*) AS n FROM raffle_photo_auto_rows WHERE photo_id=? AND row_number>? AND outcome='outside-window'`).bind(photoId, last).first<{ n: number }>();
    return { corrected: (after?.n ?? 0) - done.size, shown: shown?.n ?? 0 };
}

export async function loadContext(db: D1Database, months: string[]) {
    const existing: ExistingWinner[] = [], schedule: ScheduledPrize[] = [];
    for (const month of [...new Set(months)]) {
        const columns = 'id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId';
        const res = await db.prepare(`SELECT ${columns}, CASE WHEN ${MANUAL_EDIT} THEN 'manual' WHEN ${AUTOMATED_TOWN} THEN 'automated' END AS townSource
            FROM raffle_winners w WHERE raffle_key=?`).bind(month).all<ExistingWinner>()
            // Without the audit tables no hometown counts as automated, so nothing is ever corrected.
            .catch(() => db.prepare(`SELECT ${columns}, NULL AS townSource FROM raffle_winners WHERE raffle_key=?`).bind(month).all<ExistingWinner>());
        existing.push(...res.results);
        try { schedule.push(...await prizeSchedule(db, month)); } catch { /* No calendar: new winners stay held for review. */ }
    }
    return { existing, schedule };
}

/** Winners this photo published earlier that no longer exist, i.e. an administrator deleted them. */
export async function removedAutoWinners(db: D1Database, photoId: string) {
    const res = await db.prepare(`SELECT a.winner_id AS id FROM raffle_photo_auto_rows a LEFT JOIN raffle_winners w ON w.id=a.winner_id
        WHERE a.photo_id=? AND a.outcome='inserted' AND a.winner_id IS NOT NULL AND w.id IS NULL`).bind(photoId).all<{ id: string }>();
    return new Set(res.results.map(r => r.id));
}

/**
 * One automatic hometown correction, in the same atomic batch as the rest of the decision:
 *  1. the audit row in raffle_winner_corrections (action 'update', source 'photo-auto', before_json = the full stored row), written only
 *     while the winner still has the reviewed date, ticket, name, slot and old hometown, no administrator edit exists, and this photo
 *     has not corrected it before;
 *  2. the hometown update, only while that audit row exists and the old hometown is still stored (so it runs at most once);
 *  3. the photo's own row audit: 'duplicate' with the correction reasons, or 'rejected' as an ordinary town conflict if anything changed
 *     underneath (an administrator edited the winner between decision and write).
 * Repeating the batch (a requeue, a retried post) changes nothing: the old hometown is no longer stored.
 */
function townCorrectionStatements(db: D1Database, photoId: string, rowNumber: number, d: RowDecision, c: TownCorrection, row: string,
    lost: { outcome: 'rejected' | 'outside-window'; reasons: string[] } = { outcome: 'rejected',
        reasons: ['conflicts with existing winner (town)', 'the stored winner changed before the automatic hometown correction could be written; review required'] }) {
    const after = JSON.stringify({ drawDate: c.drawDate, ticketNumber: Number(c.ticketNumber), name: c.name, town: c.to, prizeSlotId: c.prizeSlotId,
        source: 'photo-auto', photoId, rowNumber, from: c.from,
        note: 'Hometown corrected automatically from a later winner photo: every extraction pass and a targeted re-read of the cell agree' });
    const ours = `SELECT 1 FROM raffle_winner_corrections c WHERE c.winner_id=? AND ${jsonField('c.after_json', '$.source')}='photo-auto'
        AND ${jsonField('c.after_json', '$.photoId')}=? AND ${jsonField('c.after_json', '$.town')}=?`;
    return [
        db.prepare(`INSERT INTO raffle_winner_corrections (winner_id, action, before_json, after_json)
            SELECT w.id, 'update', json_object('id', w.id, 'raffle_key', w.raffle_key, 'draw_date', w.draw_date, 'ticket_number', w.ticket_number,
                'winner_name', w.winner_name, 'town', w.town, 'created_at', w.created_at, 'prize', w.prize, 'ticket_number_text', w.ticket_number_text,
                'prize_slot_id', w.prize_slot_id), ?
            FROM raffle_winners w WHERE w.id=? AND w.town=? AND w.draw_date=? AND w.ticket_number=? AND lower(w.winner_name)=lower(?) AND w.prize_slot_id=?
                AND NOT ${MANUAL_EDIT} AND NOT EXISTS (${ours.replace('c.winner_id=?', 'c.winner_id=w.id')})`)
            .bind(after, c.winnerId, c.from, c.drawDate, Number(c.ticketNumber), c.name, c.prizeSlotId, photoId, c.to),
        db.prepare(`UPDATE raffle_winners SET town=? WHERE id=? AND town=? AND EXISTS (${ours})`).bind(c.to, c.winnerId, c.from, c.winnerId, photoId, c.to),
        db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
            SELECT ?, ?, CASE WHEN ok THEN 'duplicate' ELSE ? END, ?, NULL, CASE WHEN ok THEN ? ELSE ? END, ?
            FROM (SELECT EXISTS (SELECT 1 FROM raffle_winners WHERE id=? AND town=?) AND EXISTS (${ours}) AS ok) WHERE true
            ON CONFLICT(photo_id, row_number) DO UPDATE SET outcome=excluded.outcome, winner_id=excluded.winner_id, prize=excluded.prize, reasons_json=excluded.reasons_json, row_json=excluded.row_json`)
            .bind(photoId, rowNumber, lost.outcome, c.winnerId, JSON.stringify(d.reasons), JSON.stringify(lost.reasons),
                row, c.winnerId, c.to, c.winnerId, photoId, c.to),
    ];
}

/**
 * Atomically writes the decision. Each insert is conditional, so a winner entered manually (or by a concurrent run)
 * between decision and write turns into a recorded duplicate instead of an error or overwrite. An `inserted` audit row
 * is kept across requeues because it is the evidence behind recovered ticket labels and the removed-winner guard.
 */
export async function writeDecision(db: D1Database, photo: { photoId: string; postId: string; sha256: string | null;
    width: number | null; height: number | null; model: string | null; passes: Extraction[] }, decision: PhotoDecision, publish: boolean) {
    const kept = (await db.prepare(`SELECT row_number AS n, winner_id AS id FROM raffle_photo_auto_rows WHERE photo_id=? AND outcome='inserted'`)
        .bind(photo.photoId).all<{ n: number; id: string | null }>()).results;
    const usedNumbers = new Set(kept.map(r => r.n)), keptIds = new Set(kept.map(r => r.id));
    const auditNumber = (n: number) => { while (usedNumbers.has(n)) n++; usedNumbers.add(n); return n; };
    const statements = [db.prepare(`DELETE FROM raffle_photo_auto_rows WHERE photo_id=? AND outcome<>'inserted'`).bind(photo.photoId)];
    for (const d of decision.rows) {
        const row = JSON.stringify(d.row);
        if (d.outcome === 'duplicate' && keptIds.has(d.winnerId)) continue;
        const number = auditNumber(d.rowNumber);
        if (d.outcome === 'insert' && publish) {
            const month = d.row.drawDate.slice(0, 7);
            const ticketFree = d.row.ticketNumber === '';
            const ticket = ticketFree ? null : Number(d.row.ticketNumber);
            const label = placementLabel(parseWinnerPrize(d.prize).position);
            // Several bonus drawings may share a day, so Bonus is exclusive only per slot. The slot index is the final guard for a racing writer.
            const placePrefix = label === null || label === BONUS ? null : label + '%';
            statements.push(db.prepare(`INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text, prize_slot_id)
                SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM raffle_winners WHERE raffle_key=? AND draw_date=? AND (ticket_number=? OR prize LIKE ? OR prize_slot_id=? OR lower(winner_name)=lower(?)))
                ON CONFLICT DO NOTHING`).bind(d.winnerId, month, d.row.drawDate, ticket,
                d.row.name, d.row.town, d.prize, ticketFree ? null : d.row.ticketNumber, d.prizeSlotId ?? null, month, d.row.drawDate, ticket,
                placePrefix, d.prizeSlotId ?? null, ticketFree ? d.row.name : null));
            statements.push(db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
                SELECT ?,?,CASE WHEN changes()=1 THEN 'inserted' WHEN w.id IS NOT NULL THEN 'duplicate' ELSE 'rejected' END,
                    w.id,?,CASE WHEN changes()=1 THEN ? WHEN w.id IS NOT NULL THEN ? ELSE ? END,?
                FROM (SELECT 1) LEFT JOIN raffle_winners w ON w.raffle_key=? AND w.draw_date=? AND lower(w.winner_name)=lower(?) AND (? IS NULL OR w.ticket_number=?)
                WHERE true
                ON CONFLICT(photo_id, row_number) DO UPDATE SET outcome=excluded.outcome, winner_id=excluded.winner_id, prize=excluded.prize, reasons_json=excluded.reasons_json, row_json=excluded.row_json`)
                .bind(photo.photoId, number, d.prize, JSON.stringify(d.reasons), JSON.stringify(['entered by another writer before publication; nothing changed']),
                    JSON.stringify(['scheduled place became unavailable before publication']), row, month, d.row.drawDate, d.row.name, ticket, ticket));
        } else if (d.outcome === 'correct' && publish && d.correction) {
            statements.push(...townCorrectionStatements(db, photo.photoId, number, d, d.correction, row));
        } else {
            const outcome = d.outcome === 'insert' || d.outcome === 'correct' ? 'held' : d.outcome;
            const reasons = d.outcome === 'insert' || d.outcome === 'correct' ? ['dry run: verified but not published (FB_PHOTO_AUTOPUBLISH is off)', ...d.reasons] : d.reasons;
            statements.push(db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
                VALUES (?,?,?,?,?,?,?) ON CONFLICT(photo_id, row_number) DO UPDATE SET outcome=excluded.outcome, winner_id=excluded.winner_id, prize=excluded.prize, reasons_json=excluded.reasons_json, row_json=excluded.row_json`)
                .bind(photo.photoId, number, outcome, d.winnerId, d.prize, JSON.stringify(reasons), row));
        }
    }
    const dryRun = !publish && decision.rows.some(d => d.outcome === 'insert' || d.outcome === 'correct');
    // With no rows (or a dry run) the decision stands. Otherwise the stored audit decides: writes may have lost a race,
    // and rows published by an earlier run of this photo still count.
    const fallback = dryRun ? 'held' : decision.status, decided = dryRun || !decision.rows.length ? 0 : 1;
    statements.push(db.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, image_sha256, image_width, image_height, model, extraction_json, reasons_json)
        SELECT ?,?,CASE WHEN ?=0 THEN ?
            WHEN inserted>0 AND blocked>0 THEN 'partial' WHEN inserted>0 THEN 'published'
            WHEN rejected>0 THEN 'rejected' WHEN blocked>0 THEN 'held' WHEN duplicate>0 THEN 'duplicate' ELSE ? END,?,?,?,?,?,?
        FROM (SELECT count(*) FILTER (WHERE outcome='inserted') AS inserted, count(*) FILTER (WHERE outcome IN ('rejected','held')) AS blocked,
            count(*) FILTER (WHERE outcome='rejected') AS rejected, count(*) FILTER (WHERE outcome='duplicate') AS duplicate
            FROM raffle_photo_auto_rows WHERE photo_id=?) WHERE true
        ON CONFLICT(photo_id) DO UPDATE SET status=excluded.status, image_sha256=excluded.image_sha256,
        image_width=excluded.image_width, image_height=excluded.image_height, model=excluded.model, extraction_json=excluded.extraction_json,
        reasons_json=excluded.reasons_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE raffle_photo_auto_imports.status='failed' RETURNING status`)
        .bind(photo.photoId, photo.postId, decided, fallback, fallback, photo.sha256, photo.width, photo.height, photo.model,
            JSON.stringify(photo.passes).slice(0, 200000), JSON.stringify(decision.reasons), photo.photoId));
    const results = await db.batch<{ status: string }>(statements);
    return results.at(-1)?.results[0]?.status ?? fallback;
}

export async function recordPhotoFailure(db: D1Database, photoId: string, postId: string, code: string) {
    await db.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, reasons_json) VALUES (?,?,'failed',?)
        ON CONFLICT(photo_id) DO UPDATE SET reasons_json=excluded.reasons_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE raffle_photo_auto_imports.status='failed'`).bind(photoId, postId, JSON.stringify([code])).run();
}

/** The stored outcome of an already decided photo, or null while it still needs processing. */
export async function photoFinalStatus(db: D1Database, photoId: string) {
    const row = await db.prepare(`SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(photoId).first<{ status: string }>();
    return row && row.status !== 'failed' ? row.status : null;
}

// ---- Sanitized diagnostics. Never store or log names, signed URLs, tokens or raw provider bodies. ----
// Plain failure codes such as token-expired stay readable; anything that could carry the secret itself does not.
const SENSITIVE = /https?:|access_token|bearer|secret|signature|authorization|fbcdn|graph\.facebook|[A-Za-z0-9_-]{32,}/i;
export function sanitizeCode(value: unknown) {
    const text = value instanceof Error ? value.message : typeof value === 'string' ? value : 'unknown';
    if (SENSITIVE.test(text)) return 'redacted-error';
    return text.replace(/[^\w:.-]+/g, '-').slice(0, 80) || 'unknown';
}
/** The fixed part of a reason, for logs. Free model text and quoted values follow the colon and are dropped. */
export const reasonCode = (reason: string) => sanitizeCode(reason.split(':')[0]);
export function rowDiagnostics(d: RowDecision) {
    return { rowNumber: d.rowNumber, outcome: d.outcome, placement: parseWinnerPrize(d.prize).position, hasTicket: d.row.ticketNumber !== '',
        prizeMatch: d.prizeMatch, reasons: d.reasons.map(reasonCode) };
}
export type AttemptRecord = { postId: string; photoId?: string | null; attempt?: number | null; stage: 'post' | 'photo' | 'pass' | 'row';
    passNumber?: number | null; rowNumber?: number | null; outcome: string; code?: string | null; detail?: Record<string, unknown> };
/** Diagnostics must never stop a winner publishing, so a failed audit write is swallowed. */
export async function recordAttempts(db: D1Database, records: AttemptRecord[]) {
    if (!records.length) return;
    try {
        await db.batch(records.map(r => db.prepare(`INSERT INTO raffle_photo_auto_attempts (post_id, photo_id, attempt, stage, pass_number, row_number, outcome, code, detail_json)
            VALUES (?,?,?,?,?,?,?,?,?)`).bind(r.postId, r.photoId ?? null, r.attempt ?? null, r.stage, r.passNumber ?? null, r.rowNumber ?? null,
            r.outcome, r.code ?? null, JSON.stringify(r.detail ?? {}))));
    } catch { /* Migration 007 not applied yet, or a transient D1 failure. */ }
}

// ---- Durable post queue shared by the webhook, the polling fallback and admin requeues ----
export type QueueSource = 'webhook' | 'poll' | 'admin';
const BACKOFF_MINUTES = [1, 2, 5, 10, 30, 60];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/**
 * Admin requeue, as one atomic batch: the post is queued and its unresolved photos reopened together, or neither happens.
 * A post another run is processing is left alone, so its photos can never be reopened underneath it.
 */
export async function requeuePost(db: D1Database, postId: string) {
    if (!/^\d{1,40}_\d{1,40}$/.test(postId)) throw Error('invalid-post-id');
    const [queued] = await db.batch([
        db.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source) VALUES (?,'admin')
            ON CONFLICT(post_id) DO UPDATE SET source='admin', status='queued', attempts=0, next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            locked_until=NULL, error_code=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE raffle_photo_auto_posts.status IN ('done','ignored','failed','retry')`).bind(postId),
        // Published and duplicate photos stay final. Re-read rows that already exist become duplicates.
        db.prepare(`UPDATE raffle_photo_auto_imports SET status='failed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE post_id=? AND status IN ('rejected','held','ignored','partial')
            AND EXISTS (SELECT 1 FROM raffle_photo_auto_posts p WHERE p.post_id=? AND p.status='queued' AND p.source='admin')`).bind(postId, postId),
    ]);
    return queued.meta.changes === 1;
}

export async function enqueuePost(db: D1Database, postId: string, source: QueueSource, requeue = false) {
    if (!/^\d{1,40}_\d{1,40}$/.test(postId)) throw Error('invalid-post-id');
    const result = await db.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source) VALUES (?,?)
        ON CONFLICT(post_id) DO UPDATE SET source=excluded.source, status='queued', attempts=0, next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        locked_until=NULL, error_code=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE ? AND raffle_photo_auto_posts.status IN ('done','ignored','failed','retry')`).bind(postId, source, requeue ? 1 : 0).run();
    return result.meta.changes === 1;
}

/** Lease-based claim: concurrent webhook and cron runs can never process one post twice at the same time. */
export async function claimPost(db: D1Database, postId: string, now = new Date(), leaseSeconds = 180) {
    const until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const res = await db.prepare(`UPDATE raffle_photo_auto_posts SET status='processing', locked_until=?, attempts=attempts+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE post_id=? AND (status IN ('queued','retry') AND next_attempt_at<=?
        OR status='processing' AND locked_until<?)`).bind(until, postId, now.toISOString(), now.toISOString()).run();
    return res.meta.changes === 1;
}
/**
 * Extends the lease of a post this run still holds (same attempt, still processing) before each long AI read, so the cron cannot
 * reclaim an active extraction however long the reads take. A lease never outlives the run that renews it: Cloudflare ends the
 * invocation, renewals stop and the last lease lapses. False means another run took the post; the caller must stop.
 */
export async function renewLease(db: D1Database, postId: string, attempt: number, now = new Date(), leaseSeconds = 600) {
    const res = await db.prepare(`UPDATE raffle_photo_auto_posts SET locked_until=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE post_id=? AND status='processing' AND attempts=?`).bind(new Date(now.getTime() + leaseSeconds * 1000).toISOString(), postId, attempt).run();
    return res.meta.changes === 1;
}
export async function duePosts(db: D1Database, now = new Date(), limit = 5) {
    const res = await db.prepare(`SELECT post_id AS postId FROM raffle_photo_auto_posts WHERE (status IN ('queued','retry') AND next_attempt_at<=?)
        OR (status='processing' AND locked_until<?) ORDER BY next_attempt_at LIMIT ?`).bind(now.toISOString(), now.toISOString(), limit).all<{ postId: string }>();
    return res.results.map(r => r.postId);
}
export type PublicationSummary = { status: string; inserted: number; duplicate: number; held: number; rejected: number; outsideWindow: number; photos: number };
/** `status` means the queue finished. `publication` records what that run actually did to winners. */
// `attempt` fences a run whose lease expired: once another run has claimed the post, the older run can no longer change its state.
export async function finishPost(db: D1Database, postId: string, status: 'done' | 'ignored', publication: PublicationSummary | undefined, attempt: number) {
    await db.prepare(`UPDATE raffle_photo_auto_posts SET status=?, locked_until=NULL, error_code=NULL, publication_status=?, publication_json=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE post_id=? AND status='processing' AND attempts=?`)
        .bind(status, publication?.status ?? 'none', JSON.stringify(publication ?? {}), postId, attempt).run();
}
// Workers AI refuses every call (4006, in ~0.1 s) once the daily free allocation is used up. Nov 12's post spent its six attempts on refusals
// within two hours and was parked as failed. A refusal therefore gives the attempt back and is retried hourly, and promptly after the
// 00:00 UTC reset, until the post is QUOTA_GIVE_UP_HOURS old. Stored reads are reused, so recovery pays only for reads not yet completed.
export const QUOTA_RETRY_MINUTES = 60, QUOTA_GIVE_UP_HOURS = 30;
export function nextQuotaAttempt(now: Date) {
    const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5);
    return new Date(Math.min(now.getTime() + QUOTA_RETRY_MINUTES * 60000, reset));
}
/** Transient failures retry with backoff; after MAX_ATTEMPTS the post is parked as failed for admin requeue. */
export async function failPost(db: D1Database, postId: string, code: string, attempts: number, now = new Date(), retryAfterSeconds = 0, permanent = false, quota = false) {
    if (quota && !permanent) {
        // attempts-1 keeps the fence (the post is no longer processing, so no run holds this number) and leaves the ordinary budget intact.
        await db.prepare(`UPDATE raffle_photo_auto_posts SET status=CASE WHEN created_at < ? THEN 'failed' ELSE 'retry' END, attempts=attempts-1,
            error_code=?, last_error_code=?, last_error_at=?, locked_until=NULL, next_attempt_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE post_id=? AND status='processing' AND attempts=?`)
            .bind(new Date(now.getTime() - QUOTA_GIVE_UP_HOURS * 3600000).toISOString(), code.slice(0, 120), code.slice(0, 120), now.toISOString(),
                nextQuotaAttempt(now).toISOString(), postId, attempts).run();
        return;
    }
    const delay = Math.max(retryAfterSeconds, BACKOFF_MINUTES[Math.min(attempts, MAX_ATTEMPTS) - 1] * 60);
    await db.prepare(`UPDATE raffle_photo_auto_posts SET status=?, error_code=?, last_error_code=?, last_error_at=?, locked_until=NULL, next_attempt_at=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE post_id=? AND status='processing' AND attempts=?`)
        .bind(permanent || attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', code.slice(0, 120), code.slice(0, 120), now.toISOString(),
            new Date(now.getTime() + delay * 1000).toISOString(), postId, attempts).run();
}
export const validPostId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,40}_\d{1,40}$/.test(v) && v.split('_').every(numericId);
