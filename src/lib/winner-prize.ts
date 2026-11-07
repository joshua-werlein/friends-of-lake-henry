export const prizeCategories = ['Firearm', 'Gift card', 'Cash', 'Other'] as const;
// 1st and 2nd are the current scheduled places, 3rd survives on historical records, and Bonus is a separate
// drawing rather than a numbered place. null means the place is unknown or unconfirmed.
export const BONUS = 'Bonus' as const;
export type WinnerPosition = 1 | 2 | 3 | typeof BONUS | null;
export const validPosition = (v: unknown): v is Exclude<WinnerPosition, null> => v === 1 || v === 2 || v === 3 || v === BONUS;
export function placementShort(position: WinnerPosition) {
    return position === null ? '—' : position === BONUS ? BONUS : `${position}${position === 1 ? 'st' : position === 2 ? 'nd' : 'rd'}`;
}
/** The stored prefix: `1st place`, `2nd place`, `3rd place` or `Bonus`. */
export function placementLabel(position: WinnerPosition) {
    return position === null ? null : position === BONUS ? BONUS : placementShort(position) + ' place';
}
// Same-day display order. Every winner query uses this so Bonus never sorts as an unknown place.
export const WINNER_PLACEMENT_ORDER_SQL = `CASE WHEN prize LIKE '1st place%' THEN 1 WHEN prize LIKE '2nd place%' THEN 2 WHEN prize LIKE '3rd place%' THEN 3
    WHEN prize='Bonus' OR prize LIKE 'Bonus —%' OR prize LIKE 'Bonus –%' OR prize LIKE 'Bonus -%' THEN 4 ELSE 5 END`;
export const TICKET_NOT_PUBLISHED = 'Not published';
// A missing ticket is never shown as 0 or null. Real labels, including leading zeros such as 047, pass through unchanged.
export const ticketLabel = (value: unknown) => { const label = String(value ?? '').trim(); return !label || /^0+$/.test(label) ? TICKET_NOT_PUBLISHED : label; };
const slug = (v: string) => v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** Stable identity for a winner with no published ticket, from the approved calendar slot. Manual entry and the importer must agree, and adding a ticket later keeps it. */
export function ticketlessWinnerId(drawDate: string, prizeSlotId: string) {
    return `${drawDate.slice(0, 7)}-${drawDate}-slot-${slug(prizeSlotId).slice(0, 110)}`.replace(/[^\w-]/g, '');
}
// Trailing sentence periods are dropped; internal punctuation (".45 ACP", "1927A-1,") and
// abbreviations whose period is part of the word ("Inc.", "U.S.") are kept.
const keptAbbreviation = /(?:^|[\s(])(?:Inc|Co|Corp|Ltd|Jr|Sr|St|Mfg|Bros|No|[A-Za-z](?:\.[A-Za-z])+)\.$/;
export function cleanPrizeDescription(value: string) {
    let text = value.trim();
    while (text.endsWith('.') && !keptAbbreviation.test(text)) text = text.slice(0, -1).trimEnd();
    return text;
}
export function prizeCells(value: string | null) {
    const parsed = parseWinnerPrize(value);
    return { place: placementShort(parsed.position), prize: cleanPrizeDescription(parsed.description) || 'Not recorded' };
}
export function parseWinnerPrize(value: string | null) {
    let text = value ?? '';
    // Bonus needs the separator: a historical description such as "Bonus knife" is not a placement.
    const match = text.match(/^(?:([123])(?:st|nd|rd) place|(Bonus))(?:\s*[—–-]\s*|$)/);
    const position: WinnerPosition = !match ? null : match[2] ? BONUS : Number(match[1]) as 1 | 2 | 3;
    if (match) text = text.slice(match[0].length);
    const category = prizeCategories.find(v => text.startsWith(v + ':')) ?? '';
    return { position, category, description: category ? text.slice(category.length + 1).trim() : text };
}
/** `Bonus — description` is the canonical form the Bonus-slot uniqueness index relies on. Other stored text is left as entered. */
export function canonicalWinnerPrize(value: string | null) {
    if (value === null) return null;
    const parsed = parseWinnerPrize(value);
    if (parsed.position !== BONUS) return value;
    const description = cleanPrizeDescription(parsed.description);
    return description ? `${BONUS} — ${description}` : BONUS;
}
export function composeWinnerPrize(input: { category?: unknown; description?: unknown; position?: unknown; approved?: unknown; positionConfirmed?: unknown }) {
    if (input.approved !== true) throw Error('Review and approve the prize before saving.');
    if (typeof input.category !== 'string' || !['', ...prizeCategories].includes(input.category)) throw Error('Select a valid prize category.');
    if (typeof input.description !== 'string' || input.description.trim().length < 2 || input.description.length > 250) throw Error('Enter a prize description (2–250 characters).');
    if (input.position !== null && !validPosition(input.position)) throw Error('Select a verified place or leave it unknown.');
    if (input.position !== null && input.positionConfirmed !== true) throw Error('Confirm the place from a verified source, or leave it unknown.');
    const description = cleanPrizeDescription(input.description);
    if (description.length < 2) throw Error('Enter a prize description (2–250 characters).');
    const label = placementLabel(input.position as WinnerPosition);
    const prize = (label === null ? '' : `${label} — `) + (input.category && input.position !== BONUS ? input.category + ': ' : '') + description;
    if (prize.length > 250) throw Error('The complete prize description must be at most 250 characters.');
    return prize;
}
