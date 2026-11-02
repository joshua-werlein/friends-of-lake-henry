export const prizeCategories = ['Firearm', 'Gift card', 'Cash', 'Other'] as const;
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
    return { place: parsed.position === null ? '—' : `${parsed.position}${parsed.position===1?'st':parsed.position===2?'nd':'rd'}`,
        prize: cleanPrizeDescription(parsed.description) || 'Not recorded' };
}
export function parseWinnerPrize(value: string | null) {
    let text = value ?? '';
    const match = text.match(/^([123])(?:st|nd|rd) place(?:\s*[—–-]\s*|$)/);
    const position = match ? Number(match[1]) : null;
    if (match) text = text.slice(match[0].length);
    const category = prizeCategories.find(v => text.startsWith(v + ':')) ?? '';
    return { position, category, description: category ? text.slice(category.length + 1).trim() : text };
}
export function composeWinnerPrize(input: { category?: unknown; description?: unknown; position?: unknown; approved?: unknown; positionConfirmed?: unknown }) {
    if (input.approved !== true) throw Error('Review and approve the prize before saving.');
    if (typeof input.category !== 'string' || !['', ...prizeCategories].includes(input.category)) throw Error('Select a valid prize category.');
    if (typeof input.description !== 'string' || input.description.trim().length < 2 || input.description.length > 250) throw Error('Enter a prize description (2–250 characters).');
    if (input.position !== null && (typeof input.position !== 'number' || ![1, 2, 3].includes(input.position))) throw Error('Select a verified place or leave it unknown.');
    if (input.position !== null && input.positionConfirmed !== true) throw Error('Confirm the numeric place from a verified source, or leave it unknown.');
    const description = cleanPrizeDescription(input.description);
    if (description.length < 2) throw Error('Enter a prize description (2–250 characters).');
    const prize = (input.position === null ? '' : `${input.position}${Number(input.position) === 1 ? 'st' : Number(input.position) === 2 ? 'nd' : 'rd'} place — `)
        + (input.category ? input.category + ': ' : '') + description;
    if (prize.length > 250) throw Error('The complete prize description must be at most 250 characters.');
    return prize;
}
