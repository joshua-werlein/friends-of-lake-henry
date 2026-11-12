import { FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_PAGE_ID } from './facebook';
import { BONUS, parseWinnerPrize, placementLabel, type WinnerPosition } from './winner-prize';

// Mistral Small 3.1 (Apache-2.0) needs no click-through license on Workers AI and scored 120/120 fields on the
// November 2025 winner table (2026-11-02). Llama 3.2 Vision stays supported but requires the account owner's
// one-time Meta license acceptance (Workers AI error 5016 until then).
export const PHOTO_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const LLAMA_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
export const MAX_IMPORT_ROWS = 100;
export type PhotoCandidate = { photoId: string; postId: string | null; sourceUrl: string; publishedAt: string | null };
export type CellStatus = 'readable' | 'blank' | 'uncertain';
export type DraftWinner = { drawDate: string; position: WinnerPosition; ticketNumber: string; name: string; town: string; notes: string; prize?: string;
    townStatus?: CellStatus; ticketStatus?: CellStatus; cellText?: string;
    /** Set only when the approved calendar dated a self-labelled bonus cell: the date of the row the extraction placed it on. */
    readDate?: string;
    /** A bonus label the extraction attached to this cell although the cell's own text does not contain it (dropped from prize). */
    strayLabel?: string };
export const WARNING_CODES = ['clipped', 'ambiguous-layout', 'uncertain-association', 'missing-heading', 'illegible', 'blank-cell', 'other'] as const;
export type StructuredWarning = { scope: 'image' | 'row' | 'cell'; code: typeof WARNING_CODES[number]; drawDate?: string; ticketNumber?: string; name?: string;
    field?: 'drawDate' | 'ticketNumber' | 'name' | 'town' | 'prize'; message?: string };
// Plain strings remain valid: older captures and models that ignore the requested warning shape still parse.
export type ExtractionWarning = string | StructuredWarning;
export type Extraction = { containsWinners: boolean; rows: DraftWinner[]; warnings: ExtractionWarning[] };
export type PhotoCapture = { photoId: string; sourceUrl: string; bytes: Uint8Array; mime: string;
    sha256: string; width: number; height: number; extraction: Extraction; model: string };
export type PhotoService = { discover(source?: string): Promise<PhotoCandidate[]>;
    extract(photoId: string, monthHint: string): Promise<PhotoCapture> };
export function photoUrl(id: string) { return `https://www.facebook.com/photo/?fbid=${id}`; }
export function numericId(value: unknown): value is string { return typeof value === 'string' && /^\d{1,40}$/.test(value); }
export function monthValid(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value); }
export function parsePhotoSource(raw: unknown): { kind: 'post' | 'photo'; id: string } | null {
    if (typeof raw !== 'string' || raw.length > 2000) return null;
    if (numericId(raw.trim())) return { kind: 'photo', id: raw.trim() };
    try {
        const url = new URL(raw.trim());
        if (url.protocol !== 'https:' || url.port || url.username || url.password
            || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase())) return null;
        if (/^\/photo(?:\.php|\/)?$/.test(url.pathname) && numericId(url.searchParams.get('fbid'))) return { kind: 'photo', id: url.searchParams.get('fbid')! };
        const photo = url.pathname.match(/^\/(?:[^/]+\/)?photos\/(?:[^/]+\/)?(\d+)\/?$/);
        if (photo && numericId(photo[1])) return { kind: 'photo', id: photo[1] };
        const post = url.pathname.match(/^\/(\d+)\/posts\/(\d+)\/?$/);
        if (post && [FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_PAGE_ID].includes(post[1])) return { kind: 'post', id: `${FACEBOOK_GRAPH_PAGE_ID}_${post[2]}` };
        if (url.pathname === '/permalink.php' && [FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_PAGE_ID].includes(url.searchParams.get('id') ?? '')
            && numericId(url.searchParams.get('story_fbid'))) return { kind: 'post', id: `${FACEBOOK_GRAPH_PAGE_ID}_${url.searchParams.get('story_fbid')}` };
    } catch { /* Untrusted URL: never resolve short links or fetch arbitrary input. */ }
    return null;
}
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
/** Preserve missing/uncertain fields for correction; never turn a model response into published data. */
export function draftRows(value: unknown): DraftWinner[] {
    if (!Array.isArray(value) || value.length > MAX_IMPORT_ROWS) throw Error('Invalid or oversized row list.');
    return value.map(v => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid row.');
        return { drawDate: text(v.drawDate, 30), position: [1, 2, 3].includes(v.position) ? v.position : typeof v.position === 'string' && v.position.trim().toLowerCase() === 'bonus' ? BONUS : null,
            ticketNumber: typeof v.ticketNumber === 'number' ? String(v.ticketNumber) : text(v.ticketNumber, 30),
            name: text(v.name, 200), town: text(v.town, 200), notes: text(v.notes, 500), prize: text(v.prize, 250),
            ...(['readable', 'blank', 'uncertain'].includes(v.townStatus) ? { townStatus: v.townStatus } : {}),
            ...(['readable', 'blank', 'uncertain'].includes(v.ticketStatus) ? { ticketStatus: v.ticketStatus } : {}),
            ...(typeof v.cellText === 'string' ? { cellText: text(v.cellText, 300) } : {}) };
    });
}
function draftWarning(v: unknown): ExtractionWarning {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return text(v, 500);
    const w = v as Record<string, unknown>;
    // An unknown scope or code cannot be trusted as row-specific, so it stays free text and is handled image-wide.
    if (!['image', 'row', 'cell'].includes(w.scope as string) || !WARNING_CODES.includes(w.code as never)) return text(w.message, 500) || 'unrecognized warning';
    return { scope: w.scope as StructuredWarning['scope'], code: w.code as StructuredWarning['code'], drawDate: text(w.drawDate, 30),
        ticketNumber: typeof w.ticketNumber === 'number' ? String(w.ticketNumber) : text(w.ticketNumber, 30), name: text(w.name, 200),
        ...(['drawDate', 'ticketNumber', 'name', 'town', 'prize'].includes(w.field as string) ? { field: w.field as StructuredWarning['field'] } : {}),
        message: text(w.message, 500) };
}
export function parseExtraction(response: unknown): Extraction {
    if (!response || typeof response !== 'object' || !('response' in response)) throw Error('invalid-extraction');
    // Llama returns JSON text; chat models on Workers AI (e.g. Mistral Small 3.1) return it already parsed.
    // Both take the same size bound and the same strict validation below.
    const body = response.response;
    const raw = typeof body === 'string' ? body : body && typeof body === 'object' ? JSON.stringify(body) : null;
    if (raw === null || raw.length > 120000) throw Error('invalid-extraction');
    let value;
    try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { throw Error('invalid-extraction'); }
    // One remark per cell is possible on a full month table (a real read of a 56-cell table returned 34, 31 of them "prize is missing"
    // on cells that inherit their column heading), so the bound follows the row bound instead of rejecting a complete read.
    if (!value || typeof value.containsWinners !== 'boolean' || !Array.isArray(value.warnings) || value.warnings.length > MAX_IMPORT_ROWS * 2) throw Error('invalid-extraction');
    const rows = draftRows(value.rows);
    if (!value.containsWinners && rows.length) throw Error('invalid-extraction');
    return { containsWinners: value.containsWinners, rows, warnings: value.warnings.map(draftWarning) };
}
export function approvalRows(value: unknown, month: string): DraftWinner[] {
    if (!monthValid(month)) throw Error('Select the correct raffle month.');
    const rows = draftRows(value);
    if (!rows.length) throw Error('Select at least one reviewed row.');
    const tickets = new Set<string>(), slots = new Set<string>();
    for (const row of rows) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.drawDate) || row.drawDate.slice(0, 7) !== month
            || !Number.isFinite(Date.parse(`${row.drawDate}T00:00:00Z`))
            || new Date(`${row.drawDate}T00:00:00Z`).toISOString().slice(0, 10) !== row.drawDate) throw Error('Every draw date must be valid and in the selected month.');
        if (!/^\d+$/.test(row.ticketNumber) || !Number.isSafeInteger(Number(row.ticketNumber)) || Number(row.ticketNumber) <= 0) throw Error('Every ticket must be a positive whole number.');
        if (row.name.length < 2 || row.town.length < 2) throw Error('Every winner needs a name and hometown.');
        const ticket = `${row.drawDate}:${Number(row.ticketNumber)}`;
        const slot = `${row.drawDate}:${row.position}`;
        if (tickets.has(ticket) || (row.position !== null && slots.has(slot))) throw Error('Duplicate ticket/date or prize position in these rows.');
        tickets.add(ticket); slots.add(slot);
    }
    return rows;
}
export function positionPrize(position: WinnerPosition): string | null {
    return placementLabel(position);
}
export async function hashBytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export type ExistingWinner = { id: string; drawDate: string | null; ticketNumber: number | null;
    name: string | null; town: string | null; prize?: string | null; prizeSlotId?: string | null };
export type Comparison = { status: 'complete' | 'incomplete' | 'missing' | 'conflicting';
    existingId: string | null; missingFields: string[]; conflicts: string[]; issues: string[] };
const normalized = (v: string | null) => (v ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const positiveTicket = (v: unknown) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
export function compareWinner(row: DraftWinner, existing: ExistingWinner[]): Comparison {
    const date = row.drawDate, ticket = positiveTicket(row.ticketNumber), name = normalized(row.name);
    const matches = existing.filter(v => {
        if (date && v.drawDate?.trim() && v.drawDate !== date) return false;
        const sameTicket = ticket !== null && ticket === positiveTicket(v.ticketNumber);
        const sameName = !!name && name === normalized(v.name);
        return sameTicket || sameName || (v.drawDate === date && !positiveTicket(v.ticketNumber) && !normalized(v.name));
    });
    // A ticket-free read is verified only when the row itself says the ticket cell was visibly blank.
    const ticketFree = !row.ticketNumber && row.ticketStatus === 'blank';
    const issues = [row.notes, ...(!row.drawDate || (!ticket && !ticketFree) || !row.name || (!row.town && row.townStatus !== 'blank') ? ['Missing or uncertain extracted fields.'] : [])].filter(Boolean);
    if (matches.length > 1) return { status: 'conflicting', existingId: null, missingFields: [], conflicts: ['Several existing winners could match.'], issues };
    if (!matches.length) return { status: 'missing', existingId: null, missingFields: [], conflicts: [], issues };
    const found = matches[0], missingFields: string[] = [], conflicts: string[] = [];
    for (const field of ['drawDate', 'ticketNumber', 'name', 'town'] as const) {
        const old = field === 'ticketNumber' ? positiveTicket(found[field]) : field === 'town' ? normalized(found.town).replace(/[\s,]+/g, '') : normalized(found[field]);
        const next = field === 'ticketNumber' ? ticket : field === 'town' ? normalized(row.town).replace(/[\s,]+/g, '') : normalized(row[field]);
        if (field === 'town' && !old && !next && row.townStatus === 'blank') continue;
        // An announcement that prints no ticket says nothing about a stored one. The caller compares prize slots before calling this a duplicate.
        if (field === 'ticketNumber' && ticketFree) continue;
        if (!old) missingFields.push(field);
        else if (!next || old !== next) conflicts.push(field);
    }
    if (row.position !== null && found.prize) {
        const position = parseWinnerPrize(found.prize).position;
        if (position !== null && position !== row.position) conflicts.push('position');
    }
    return { status: conflicts.length ? 'conflicting' : missingFields.length ? 'incomplete' : 'complete',
        existingId: found.id, missingFields, conflicts, issues };
}
