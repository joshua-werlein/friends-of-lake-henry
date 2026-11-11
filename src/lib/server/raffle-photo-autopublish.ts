import type { D1Database } from '@cloudflare/workers-types';
import { compareWinner, numericId, type DraftWinner, type Extraction, type ExtractionWarning, type ExistingWinner, type StructuredWarning } from '../raffle-photo-import';
import { BONUS, parseWinnerPrize, cleanPrizeDescription, placementLabel, ticketlessWinnerId, type WinnerPosition } from '../winner-prize';
import { calendarPosition, prizeSchedule, type ScheduledPrize } from './raffle-prizes';

// Unattended publication of Facebook winner photos. A row is published only when every extraction pass agrees
// on it, every field validates, it is dated for the announcement's own drawing window and it neither duplicates
// nor contradicts an existing winner. Anything else is recorded with a reason and never guessed or overwritten.
// held = the evidence is ambiguous, so a person should review it. rejected = it contradicts stored data.

export type RowOutcome = 'insert' | 'duplicate' | 'held' | 'rejected' | 'outside-window';
export type RowDecision = { rowNumber: number; outcome: RowOutcome; reasons: string[]; row: DraftWinner;
    winnerId: string | null; prize: string | null; prizeSlotId?: string | null; prizeMatch: 'scheduled' | 'unmatched' | 'none' };
export type PhotoDecision = { status: 'published' | 'partial' | 'duplicate' | 'held' | 'rejected' | 'ignored';
    reasons: string[]; rows: RowDecision[] };

const WINDOW_DAYS = 2; // An announcement may report today's or the previous two days' drawings.
const MAX_AUTO_ROWS = 12; // Bound the eligible rows even when the Page posts a cumulative table.
const fold = (v: string) => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();
const same = (a: string | null | undefined, b: string | null | undefined) => fold(a ?? '') === fold(b ?? '');
export const chicagoDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const realDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T12:00:00Z'))
    && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
export const winnerId = (date: string, ticket: number) => `${date.slice(0, 7)}-${date}-${ticket}`.replace(/[^\w-]/g, ''); // Same as manual entry.

function identifyPrize(text: string | undefined, drawDate: string, schedule: ScheduledPrize[]) {
    const visible = fold(text ?? '');
    if (visible.length < 3) return null;
    const eligible = schedule.filter(p => p.status === 'approved' && p.drawDate === drawDate);
    const categories: Record<string, string> = { 'gift card': 'Gift card', firearm: 'Firearm',
        bonus: 'Bonus drawing', 'bonus prize': 'Bonus drawing', 'bonus drawing': 'Bonus drawing', '2nd drawing': 'Bonus drawing' };
    const category = Object.hasOwn(categories, visible) ? categories[visible] : null;
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
        if (phrase.length) return phrase.length === 1 ? phrase[0] : null;
    }
    // Strong token overlap ("Savage 110 30-06" vs "Savage 110 High Country 30-06"), unique to one scheduled prize.
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
type RowWarning = { row: DraftWinner; reason: string | null; blankField?: 'ticketNumber' | 'town' };
function classifyWarnings(passes: Extraction[]) {
    const imageWide: string[] = [], rowWarnings: RowWarning[] = [];
    for (const pass of passes) for (const warning of pass.warnings) {
        const text = warningText(warning).trim();
        if (typeof warning === 'string' && (!text || NO_WARNING.test(text))) continue;
        if (typeof warning !== 'string') {
            const matches = pass.rows.filter(r => (!!warning.drawDate || !!warning.ticketNumber || !!warning.name)
                && (!warning.drawDate || r.drawDate === warning.drawDate)
                && (!warning.ticketNumber || Number(r.ticketNumber) === Number(warning.ticketNumber))
                && (!warning.name || same(r.name, warning.name)));
            if (warning.scope === 'image' || IMAGE_WIDE_CODES.has(warning.code) || matches.length !== 1) { imageWide.push(text); continue; }
            const blankField = warning.code === 'blank-cell' && (warning.field === 'ticketNumber' || warning.field === 'town') ? warning.field : undefined;
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
function outvotedLayoutWarning(passes: Extraction[], announcementDate: string) {
    const imageWide = (p: Extraction) => classifyWarnings([p]).imageWide.length > 0;
    const flagged = passes.filter(imageWide);
    if (flagged.length !== 1 || flagged.length === passes.length || !flagged[0].warnings.some(OUTVOTABLE)
        || imageWide({ ...flagged[0], warnings: flagged[0].warnings.filter(w => !OUTVOTABLE(w)) })) return false;
    const current = (p: Extraction) => p.rows.filter(r => publishable(r, announcementDate));
    const read = (p: Extraction) => JSON.stringify(current(p).map(r => ROW_FIELDS.map(f => r[f] ?? null)));
    return passes.every(p => current(p).length > 0 && read(p) === read(passes[0]));
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
 * Real captures show both passes can agree on a false blank (ticket 894 read as blank) and can take a hometown from the next cell.
 * Each pass therefore copies the raw cell, and the parsed fields must be consistent with it. A ticket-free row must supply it.
 */
function cellTextProblems(row: DraftWinner) {
    const cell = (row.cellText ?? '').trim(), words = ` ${fold(cell)} `;
    if (!cell) return row.ticketNumber === '' ? ['a winner without a ticket needs the raw cell text to confirm it'] : [];
    const problems: string[] = [];
    // A leading number is a ticket; a label such as "2nd Drawing" is not.
    if (row.ticketNumber === '' && /^\W{0,3}\d+(?:\s*[-–—:#]|\s+[A-Za-z])/.test(cell)) problems.push('cell text shows a ticket number that was not extracted');
    if (row.ticketNumber !== '' && !new RegExp(`(?:^|\\D)${row.ticketNumber.replace(/\D/g, '') || 'x'}(?:\\D|$)`).test(cell)) problems.push('ticket number is not in the cell text');
    if (fold(row.name) && !words.includes(` ${fold(row.name)} `)) problems.push('name is not in the cell text');
    // Spacing around commas differs between reads (Auburn,WA), so hometowns compare without separators.
    if (row.town && !fold(cell).replace(/ /g, '').includes(fold(row.town).replace(/ /g, ''))) problems.push('hometown is not in the cell text');
    if (!row.town && row.townStatus === 'blank' && /,/.test(cell.slice(cell.indexOf(row.name) + row.name.length))) problems.push('cell text shows a hometown that was not extracted');
    return problems;
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
    const { imageWide, rowWarnings } = classifyWarnings(passes);
    if (imageWide.length && !outvotedLayoutWarning(passes, announcementDate)) return { status: 'rejected', reasons: ['image has unresolved extraction warnings; review required', ...imageWide], rows: [] };
    if (passes.every(p => !p.rows.length)) return { status: 'rejected', reasons: ['announcement contains no readable winner rows'], rows: [] };
    const groups = reconcileRows(passes);
    const agreed = groups.filter(g => passes.every((_, i) => g.members[i]));
    // Rows that barely overlap mean the passes read the table differently; no row association can be trusted.
    if (agreed.length * 2 < Math.max(...passes.map(p => p.rows.length))) return { status: 'rejected', reasons: ['extraction passes could not be reliably matched row to row; review required'], rows: [] };
    const anchor = (g: RowGroup) => g.members.find(Boolean)!;
    // Rows stored before slots existed, or by older code, resolve from their description.
    const storedSlot = (w: ExistingWinner) => w.prizeSlotId ?? identifyPrize(parseWinnerPrize(w.prize ?? null).description, w.drawDate ?? '', schedule)?.id ?? null;
    const currentRows = groups.filter(g => !rowProblems(anchor(g), announcementDate).outside).length;
    if (currentRows > MAX_AUTO_ROWS) return { status: 'rejected', reasons: [`${currentRows} rows exceeds the ${MAX_AUTO_ROWS}-row drawing window limit; review required`], rows: [] };

    const rows: RowDecision[] = groups.map((group, i) => {
        const row = anchor(group);
        const { reasons, outside } = rowProblems(row, announcementDate);
        reasons.push(...group.issues);
        const seen = group.members.filter(Boolean).length;
        if (seen < passes.length) reasons.push(`row was read by only ${seen} of ${passes.length} extraction passes`);
        for (const o of group.members) {
            if (!o || o === row) continue;
            const differs: string[] = (['drawDate', 'name', 'town'] as const).filter(f => !same(row[f], o[f]));
            if (Number(row.ticketNumber) !== Number(o.ticketNumber)) differs.push('ticketNumber');
            if (row.ticketNumber !== o.ticketNumber && Number(row.ticketNumber) === Number(o.ticketNumber)) reasons.push('extraction passes disagree on printed ticket label');
            if (!row.town && row.townStatus !== o.townStatus) reasons.push('extraction passes disagree on whether hometown is visibly blank');
            if (!row.ticketNumber && row.ticketStatus !== o.ticketStatus) reasons.push('extraction passes disagree on whether the ticket is visibly blank');
            if (o.notes || o.townStatus === 'uncertain' || o.ticketStatus === 'uncertain') reasons.push('another extraction pass flagged uncertainty');
            if (row.position !== o.position) differs.push('position');
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
            else if (w.blankField === 'town' ? group.members.some(m => m && (m.town !== '' || m.townStatus !== 'blank'))
                : group.members.some(m => m && (m.ticketNumber !== '' || m.ticketStatus !== 'blank'))) reasons.push('a warning reports a blank cell that the extraction passes do not confirm');
        }
        // A row older than this announcement's window can never publish, so reading it imperfectly is not a hold.
        return { rowNumber: i + 1, outcome: outside ? 'outside-window' : reasons.length ? 'held' : 'insert', reasons, row,
            winnerId: null, prize: null, prizeMatch: 'none' as const };
    });

    // Conflicts inside the image itself hold every involved row rather than picking one.
    const clusters = new Map<string, RowDecision[]>();
    for (const d of rows) {
        if (!realDate(d.row.drawDate) || d.outcome === 'outside-window') continue;
        const keys = [...(d.row.ticketNumber ? [`t:${d.row.drawDate}:${Number(d.row.ticketNumber)}`] : []),
            ...(d.row.position !== null && d.row.position !== BONUS ? [`p:${d.row.drawDate}:${d.row.position}`] : [])];
        for (const k of keys) clusters.set(k, [...(clusters.get(k) ?? []), d]);
    }
    for (const [k, list] of clusters) if (list.length > 1) for (const d of list) {
        d.outcome = 'held'; d.reasons.push(k.startsWith('t:') ? 'ticket appears twice for this date in the image' : 'place appears twice for this date in the image');
    }

    for (const d of rows) {
        if (d.outcome === 'held') continue;
        const cmp = compareWinner(d.row, existing);
        const prize = identifyPrize(d.row.prize, d.row.drawDate, schedule);
        const scheduledPosition = prize ? calendarPosition(prize, schedule) : null;
        if (cmp.status === 'complete') {
            const record = existing.find(w => w.id === cmp.existingId);
            const recordSlot = record ? storedSlot(record) : null;
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
        if (d.outcome === 'outside-window') { d.reasons.push('draw date is older than this announcement window'); continue; }
        if (cmp.status !== 'missing') {
            d.outcome = cmp.status === 'incomplete' ? 'held' : 'rejected';
            d.reasons.push(cmp.status !== 'incomplete' ? 'conflicts with existing winner (' + cmp.conflicts.join(', ') + ')'
                : cmp.missingFields.includes('ticketNumber') ? 'the announcement shows a ticket the stored winner lacks; add it in admin'
                : 'existing winner record is incomplete; correct it in admin');
            continue;
        }
        if (!prize) {
            d.outcome = 'held';
            d.prizeMatch = fold(d.row.prize ?? '').length < 3 ? 'none' : 'unmatched';
            d.reasons.push('prize or column header must identify exactly one approved scheduled prize; review required');
            continue;
        }
        d.prizeMatch = 'scheduled';
        const position = d.row.position ?? scheduledPosition;
        if (position === null || (scheduledPosition !== null && position !== scheduledPosition)) {
            d.outcome = 'held';
            d.reasons.push('place is missing or conflicts with the approved drawing schedule; review required');
            continue;
        }
        const ticketFree = d.row.ticketNumber === '';
        // A blank ticket needs a slot the calendar proves: main prize, gift card or a bonus drawing. A legacy numbered supplement does not qualify.
        if (ticketFree && !(scheduledPosition === 1 || scheduledPosition === 2 || scheduledPosition === BONUS)) {
            d.outcome = 'held';
            d.reasons.push('a winner without a ticket needs one approved main, gift card or bonus prize on the calendar');
            continue;
        }
        // The slot is the identity. Numbered places also stay exclusive for stored rows with no matching description; several bonus drawings may coexist.
        const holder = existing.find(w => w.drawDate === d.row.drawDate && (storedSlot(w) === prize.id
            || (position !== BONUS && parseWinnerPrize(w.prize ?? null).position === position)));
        if (holder) { d.outcome = 'rejected'; d.reasons.push(`${placementLabel(position)} for ${d.row.drawDate} already belongs to another winner`); continue; }
        d.prize = composePrize(position, prize.description);
        d.prizeSlotId = prize.id;
        d.winnerId = ticketFree ? ticketlessWinnerId(d.row.drawDate, prize.id) : winnerId(d.row.drawDate, Number(d.row.ticketNumber));
        if (options.removedWinnerIds?.has(d.winnerId)) {
            d.outcome = 'held'; d.reasons.push('this photo already published this winner and an administrator removed it; not republished');
            continue;
        }
        d.reasons.push(`all ${passes.length} extraction passes agree`, `prize matches approved calendar entry ${prize.id}`,
            `${placementLabel(position)} from ${d.row.position === null ? 'the approved calendar' : 'the printed label and approved calendar'}`,
            ...(ticketFree ? ['every extraction pass confirms no ticket number is printed'] : []));
    }

    const placements = new Map<string, RowDecision[]>();
    for (const d of rows.filter(d => d.outcome === 'insert')) {
        const key = d.prizeSlotId ?? `${d.row.drawDate}:${parseWinnerPrize(d.prize).position}`;
        placements.set(key, [...(placements.get(key) ?? []), d]);
    }
    for (const list of placements.values()) if (list.length > 1) for (const d of list) {
        d.outcome = 'held'; d.reasons = ['multiple new winners match the same scheduled prize'];
    }

    const count = (o: RowOutcome) => rows.filter(d => d.outcome === o).length;
    const inserted = count('insert'), held = count('held'), rejected = count('rejected');
    const status = inserted && (held || rejected) ? 'partial' : inserted ? 'published' : rejected ? 'rejected' : held ? 'held'
        : count('duplicate') ? 'duplicate' : 'ignored';
    return { status, reasons: status === 'ignored' ? ['no rows for the current drawing window'] : [], rows };
}

export async function loadContext(db: D1Database, months: string[]) {
    const existing: ExistingWinner[] = [], schedule: ScheduledPrize[] = [];
    for (const month of [...new Set(months)]) {
        const res = await db.prepare(`SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId
            FROM raffle_winners WHERE raffle_key=?`).bind(month).all<ExistingWinner>();
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
        } else {
            const outcome = d.outcome === 'insert' ? 'held' : d.outcome;
            const reasons = d.outcome === 'insert' ? ['dry run: verified but not published (FB_PHOTO_AUTOPUBLISH is off)', ...d.reasons] : d.reasons;
            statements.push(db.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
                VALUES (?,?,?,?,?,?,?) ON CONFLICT(photo_id, row_number) DO UPDATE SET outcome=excluded.outcome, winner_id=excluded.winner_id, prize=excluded.prize, reasons_json=excluded.reasons_json, row_json=excluded.row_json`)
                .bind(photo.photoId, number, outcome, d.winnerId, d.prize, JSON.stringify(reasons), row));
        }
    }
    const dryRun = !publish && decision.rows.some(d => d.outcome === 'insert');
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
/** Transient failures retry with backoff; after MAX_ATTEMPTS the post is parked as failed for admin requeue. */
export async function failPost(db: D1Database, postId: string, code: string, attempts: number, now = new Date(), retryAfterSeconds = 0, permanent = false) {
    const delay = Math.max(retryAfterSeconds, BACKOFF_MINUTES[Math.min(attempts, MAX_ATTEMPTS) - 1] * 60);
    await db.prepare(`UPDATE raffle_photo_auto_posts SET status=?, error_code=?, last_error_code=?, last_error_at=?, locked_until=NULL, next_attempt_at=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE post_id=? AND status='processing' AND attempts=?`)
        .bind(permanent || attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', code.slice(0, 120), code.slice(0, 120), now.toISOString(),
            new Date(now.getTime() + delay * 1000).toISOString(), postId, attempts).run();
}
export const validPostId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,40}_\d{1,40}$/.test(v) && v.split('_').every(numericId);
