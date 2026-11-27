// Signed Live/video webhook facts forwarded by the Photo Worker (Release B). They are evidence only, never a selection:
// a video still needs Page ownership, availability, the time rule and either Graph Live status or an exact ID
// correlation with a signed live_videos event. Everything is re-validated here; nothing from the payload is trusted.
import { GRAPH_PAGE_ID } from './graph';

export type LiveFact = { field: 'live_videos' | 'videos' | 'feed'; id?: string; videoId?: string; postId?: string;
    status?: string; item?: string; verb?: string; keys: string[] };
/** A fact as stored by the coordinator: when the signed webhook reached it, and the body-hash reference. */
export type StoredFact = LiveFact & { at: number; ref: string };
/** LiveVideo ID -> Video ID, learned from a read-only Graph LiveVideo lookup (or why it is unknown). */
export type LiveMapping = { videoId?: string; status?: string; reason?: string; at: number };
export type LiveSignals = { facts: StoredFact[]; mappings: Record<string, LiveMapping> };

export const FACTS_KEY = 'live-events', MAP_KEY = 'live-video-map';
export const FACT_LIMIT = 10, STORED_FACT_LIMIT = 60, FACT_RETENTION_MS = 48 * 3600_000, MAP_RETENTION_MS = 7 * 86400_000;
/** Signed live_videos statuses that prove a broadcast happened. Meta does not document the enum; others are logged only. */
export const LIVE_EVENT_STATUSES = new Set(['live', 'live_now', 'live_stopped']);

const num = (x: unknown) => typeof x === 'string' && /^\d{1,40}$/.test(x) ? x : undefined;
const code = (x: unknown) => typeof x === 'string' && /^[a-z_]{1,40}$/.test(x) ? x : undefined;
/** Re-validates forwarded facts (same contract as workers/facebook-photos/webhook.ts webhookLiveEvents). */
export function liveFacts(value: unknown): LiveFact[] {
    if (!Array.isArray(value)) return [];
    const out: LiveFact[] = [];
    for (const v of value.slice(0, FACT_LIMIT)) {
        if (!v || typeof v !== 'object' || !['live_videos', 'videos', 'feed'].includes((v as any).field)) continue;
        const f = v as Record<string, unknown>;
        const keys = Array.isArray(f.keys) ? f.keys.filter((k): k is string => typeof k === 'string' && /^[a-z_]{1,40}$/.test(k)).slice(0, 20) : [];
        const postId = typeof f.postId === 'string' && new RegExp(`^${GRAPH_PAGE_ID}_\\d{1,40}$`).test(f.postId) ? f.postId : undefined;
        const item = ['video', 'status', 'post'].includes(String(f.item)) ? String(f.item) : undefined;
        const verb = ['add', 'edited'].includes(String(f.verb)) ? String(f.verb) : undefined;
        const fact = { field: f.field as LiveFact['field'], id: num(f.id), videoId: num(f.videoId), postId, status: code(f.status), item, verb, keys };
        out.push(Object.fromEntries(Object.entries(fact).filter(([, x]) => x !== undefined)) as LiveFact);
    }
    return out;
}
export function pruneFacts(facts: StoredFact[], now: number): StoredFact[] {
    return facts.filter(f => f.at <= now && now - f.at <= FACT_RETENTION_MS).slice(-STORED_FACT_LIMIT);
}
export function pruneMappings(map: Record<string, LiveMapping>, now: number): Record<string, LiveMapping> {
    return Object.fromEntries(Object.entries(map).filter(([k, m]) => /^\d{1,40}$/.test(k) && now - m.at <= MAP_RETENTION_MS).slice(-50));
}
/** Log/journal-safe one-line summary (codes and public numeric IDs). */
export function factSummary(facts: LiveFact[]): string {
    return facts.map(f => [f.field, f.item ?? '', f.verb ?? '', f.status ?? '', f.id ?? '', f.videoId ?? '', f.keys.join('+')].join(':')).join(';').slice(0, 900);
}
