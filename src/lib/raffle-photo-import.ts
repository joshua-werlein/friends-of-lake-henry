import { FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_PAGE_ID } from './facebook';

// Mistral Small 3.1 (Apache-2.0) needs no click-through license on Workers AI and scored 120/120 fields on the
// November 2025 winner table (2026-11-02). Llama 3.2 Vision stays supported but requires the account owner's
// one-time Meta license acceptance (Workers AI error 5016 until then).
export const PHOTO_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const LLAMA_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
export const MAX_IMPORT_ROWS = 100;
export type PhotoCandidate = { photoId: string; postId: string | null; sourceUrl: string; publishedAt: string | null };
export type DraftWinner = { drawDate: string; position: number | null; ticketNumber: string; name: string; town: string; notes: string; prize?: string;
    townStatus?: 'readable' | 'blank' | 'uncertain' };
export type Extraction = { containsWinners: boolean; rows: DraftWinner[]; warnings: string[] };
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
        return { drawDate: text(v.drawDate, 30), position: [1, 2, 3].includes(v.position) ? v.position : null,
            ticketNumber: typeof v.ticketNumber === 'number' ? String(v.ticketNumber) : text(v.ticketNumber, 30),
            name: text(v.name, 200), town: text(v.town, 200), notes: text(v.notes, 500), prize: text(v.prize, 250),
            ...(['readable', 'blank', 'uncertain'].includes(v.townStatus) ? { townStatus: v.townStatus } : {}) };
    });
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
    if (!value || typeof value.containsWinners !== 'boolean' || !Array.isArray(value.warnings) || value.warnings.length > 30) throw Error('invalid-extraction');
    const rows = draftRows(value.rows);
    if (!value.containsWinners && rows.length) throw Error('invalid-extraction');
    return { containsWinners: value.containsWinners, rows, warnings: value.warnings.map((v: unknown) => text(v, 500)) };
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
export function positionPrize(position: number | null): string | null {
    return position === null ? null : `${position}${position === 1 ? 'st' : position === 2 ? 'nd' : 'rd'} place`;
}
export async function hashBytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export type ExistingWinner = { id: string; drawDate: string | null; ticketNumber: number | null;
    name: string | null; town: string | null; prize?: string | null };
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
    const issues = [row.notes, ...(!row.drawDate || !ticket || !row.name || (!row.town && row.townStatus !== 'blank') ? ['Missing or uncertain extracted fields.'] : [])].filter(Boolean);
    if (matches.length > 1) return { status: 'conflicting', existingId: null, missingFields: [], conflicts: ['Several existing winners could match.'], issues };
    if (!matches.length) return { status: 'missing', existingId: null, missingFields: [], conflicts: [], issues };
    const found = matches[0], missingFields: string[] = [], conflicts: string[] = [];
    for (const field of ['drawDate', 'ticketNumber', 'name', 'town'] as const) {
        const old = field === 'ticketNumber' ? positiveTicket(found[field]) : field === 'town' ? normalized(found.town).replace(/[\s,]+/g, '') : normalized(found[field]);
        const next = field === 'ticketNumber' ? ticket : field === 'town' ? normalized(row.town).replace(/[\s,]+/g, '') : normalized(row[field]);
        if (field === 'town' && !old && !next && row.townStatus === 'blank') continue;
        if (!old) missingFields.push(field);
        else if (!next || old !== next) conflicts.push(field);
    }
    if (row.position !== null && found.prize) {
        const position = found.prize.match(/^([123])(?:st|nd|rd) place\b/i);
        if (position && Number(position[1]) !== row.position) conflicts.push('position');
    }
    return { status: conflicts.length ? 'conflicting' : missingFields.length ? 'incomplete' : 'complete',
        existingId: found.id, missingFields, conflicts, issues };
}
