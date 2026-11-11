import { drawingDate, inDrawingMonth } from '../../src/lib/server/raffle-discovery-schedule';
import { inSeasonDay } from '../../src/lib/server/raffle-season';

export const TIMING_LIMIT = 256;
export const timingDay = (day: string) => inSeasonDay(day);
type Store = { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<unknown> };
export type TimingEntry = { stage: string; at: number; [key: string]: unknown };
type Journal = { version: 1; day: string; entries: TimingEntry[]; dropped: number; first: Record<string, TimingEntry> };
const stages = new Set(['webhook-received', 'webhook-forward', 'do-event', 'check-start', 'check-result', 'public-visible']);
const numeric = ['receivedAt','forwardAt','queueMs','notifyMs','alarmAt','slotAt','wakeLagMs','completedAt','pollMs','graphMs','graphRequests','selectionWriteMs','stateWriteMs','selectionCompletedAt','stateCompletedAt','pending','candidates','verified','failures'];
const code = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,59}$/.test(v);
/** Fixed schema: never persist raw payloads, URLs, errors, headers or credentials. */
export function timingEntry(value: unknown): TimingEntry | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (!stages.has(String(v.stage)) || !Number.isSafeInteger(v.at)) return null;
    // Evidence is kept for any configured season moment (one bounded key per season day); off-season checks are not journaled.
    if(!inDrawingMonth(new Date(Number(v.at))))return null;
    const out: TimingEntry = { stage: String(v.stage), at: Number(v.at) };
    for (const k of numeric) if (Number.isSafeInteger(v[k]) && Number(v[k]) >= 0) out[k] = v[k];
    for (const k of ['accepted','selected','paused']) if (typeof v[k] === 'boolean') out[k] = v[k];
    for (const k of ['status','reason','phase','trigger']) if (code(v[k])) out[k] = v[k];
    if (typeof v.eventRef === 'string' && /^[a-f0-9]{12}$/.test(v.eventRef)) out.eventRef = v.eventRef;
    if (typeof v.videoId === 'string' && /^\d{1,40}$/.test(v.videoId)) out.videoId = v.videoId;
    if (typeof v.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.observedAt) && inDrawingMonth(new Date(v.observedAt))) out.observedAt = v.observedAt;
    if (Array.isArray(v.graph)) out.graph = v.graph.slice(0, 11).map((g: any) => ({
        phase: ['identity','posts','video','format'].includes(g?.phase) ? g.phase : 'unknown',
        startedAt: Number.isSafeInteger(g?.startedAt) ? g.startedAt : 0,
        completedAt: Number.isSafeInteger(g?.completedAt) ? g.completedAt : 0,
        httpStatus: Number.isInteger(g?.httpStatus) && g.httpStatus >= 100 && g.httpStatus <= 599 ? g.httpStatus : 0,
    }));
    if(Array.isArray(v.videos))out.videos=v.videos.slice(0,8).filter((x:any)=>typeof x?.videoId==='string'&&/^\d{1,40}$/.test(x.videoId)).map((x:any)=>({
        videoId:x.videoId,liveStatus:['LIVE','LIVE_STOPPED','VOD'].includes(x.liveStatus)?x.liveStatus:'UNKNOWN',
        published:x.published===true,embeddable:x.embeddable===true,metadataVerified:x.metadataVerified===true,originVerified:x.originVerified===true,
    }));
    return out;
}

/** Serialized best-effort diagnostic writes, separate from selection/scheduling truth.
 * Exactly 30 possible day keys, <=256 recent entries plus six first-stage markers per day.
 */
export class TimingJournal {
    private pending: Promise<unknown> = Promise.resolve();
    constructor(private store: Store) {}
    append(value: unknown): Promise<void> {
        const entry = timingEntry(value);
        if (!entry) return Promise.resolve();
        const day = drawingDate(new Date(entry.at))!;
        this.pending = this.pending.catch(() => {}).then(async () => {
            const key = 'timing:v1:' + day;
            const journal = await this.store.get<Journal>(key) ?? { version: 1, day, entries: [], dropped: 0, first: {} };
            // Public visibility records are first-observation evidence, never one write per viewer/poll.
            if (entry.stage === 'public-visible') {
                const prior=journal.entries.find(e=>e.stage===entry.stage&&e.videoId===entry.videoId&&e.observedAt===entry.observedAt);
                if(prior && prior.at<=entry.at)return;
                if(prior)journal.entries.splice(journal.entries.indexOf(prior),1);
            }
            if(!journal.first[entry.stage] || journal.first[entry.stage].at>entry.at) journal.first[entry.stage]=entry;
            journal.entries.push(entry);
            if (journal.entries.length > TIMING_LIMIT) { journal.entries.shift(); journal.dropped++; }
            await this.store.put(key, journal);
        });
        return this.pending.then(() => {}, () => {});
    }
    async read(day: string) {
        if (!timingDay(day)) return null;
        await this.pending.catch(() => {});
        return await this.store.get<Journal>('timing:v1:' + day) ?? null;
    }
}
