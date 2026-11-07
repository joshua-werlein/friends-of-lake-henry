// Pure helpers for the winner-photo Worker (no Workers globals), shared with tests.
import { GRAPH_PAGE_ID, PUBLIC_PAGE_ID } from '../facebook-live/graph';

export function inSeason(env: { FB_SEASON_START?: string; FB_SEASON_END?: string }, now: Date) {
    const start = Date.parse(env.FB_SEASON_START ?? ''), end = Date.parse(env.FB_SEASON_END ?? '');
    return Number.isFinite(start) && Number.isFinite(end) && now.getTime() >= start && now.getTime() < end;
}
/** Automatic photo imports require the raffle hashtag as a standalone caption token. */
export function qualifies(message: unknown, marker = '#LakeHenryRaffle') {
    if (typeof message !== 'string') return false;
    return message.split(/\s+/).some(word => word.replace(/[.,!?:;]+$/, '').toLowerCase() === marker.toLowerCase());
}
function chicagoClock(now: Date) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
    return { month: get('month'), h: get('hour'), m: get('minute') };
}
/** Graph backup discovery: every tick from 17:55 to 18:15 Central, November only. Webhooks cover everything else. */
export function pollDue(now: Date) {
    const { month, h, m } = chicagoClock(now), minute = h * 60 + m;
    return month === 11 && minute >= 17 * 60 + 55 && minute <= 18 * 60 + 15;
}
/** Alert evaluations: every tick from 17:45 to midnight Central; otherwise twice an hour. */
export function alertsDue(now: Date) {
    const { h, m } = chicagoClock(now);
    return h > 17 || (h === 17 && m >= 45) || m % 30 < 2;
}

function hexBytes(hex: string) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
    return new Uint8Array(hex.match(/../g)!.map(b => parseInt(b, 16)));
}
export async function validSignature(secret: string, header: string | null, body: ArrayBuffer) {
    const sig = header?.startsWith('sha256=') ? hexBytes(header.slice(7)) : null;
    if (!sig || !secret) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, sig, body); // Constant-time comparison.
}
export async function sameSecret(a: string, b: string) {
    const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
    const p = new Uint8Array(x), q = new Uint8Array(y);
    let diff = 0;
    for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
    return diff === 0;
}
/** Post IDs named by Page feed changes. The payload is only a hint: every post is re-read from Graph before use. */
export function webhookPostIds(payload: unknown): string[] {
    const ids = new Set<string>();
    if (!payload || typeof payload !== 'object' || (payload as any).object !== 'page' || !Array.isArray((payload as any).entry)) return [];
    for (const entry of (payload as any).entry.slice(0, 50)) {
        if (![GRAPH_PAGE_ID, PUBLIC_PAGE_ID].includes(String(entry?.id)) || !Array.isArray(entry.changes)) continue;
        for (const change of entry.changes.slice(0, 50)) {
            const v = change?.value;
            if (change?.field !== 'feed' || !v || !['add', 'edited'].includes(v.verb) || !['photo', 'status', 'post'].includes(v.item)) continue;
            const m = typeof v.post_id === 'string' ? v.post_id.match(/^(\d{1,40})_(\d{1,40})$/) : null;
            if (m && [GRAPH_PAGE_ID, PUBLIC_PAGE_ID].includes(m[1])) ids.add(`${GRAPH_PAGE_ID}_${m[2]}`);
        }
    }
    return [...ids].slice(0, 20);
}

/** Signed hints only; every selected video is subsequently fetched through the Page Live edge. */
export function webhookLiveHint(payload:unknown):boolean {
    const p=payload as any;
    return p?.object==='page' && Array.isArray(p.entry) && p.entry.slice(0,50).some((e:any)=>
        [GRAPH_PAGE_ID,PUBLIC_PAGE_ID].includes(String(e?.id)) && Array.isArray(e.changes) && e.changes.slice(0,50).some((c:any)=>
            c?.field==='live_videos' || c?.field==='videos' || (c?.field==='feed' && ['video','status','post'].includes(c?.value?.item) && ['add','edited'].includes(c?.value?.verb))));
}
