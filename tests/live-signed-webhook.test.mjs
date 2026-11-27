// Release B: Live origin from a Meta-signed live_videos webhook, tied to the EXACT video ID (never by timing).
// Uses the same contract fixture as the Photo Worker (tests/fixtures/live-webhook-events.json, identical in both branches).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveFacts, pruneFacts, FACTS_KEY, MAP_KEY, STORED_FACT_LIMIT } from '../workers/facebook-live/live-events.ts';
import { timingEntry } from '../workers/facebook-live/timing.ts';

const contract = JSON.parse(readFileSync(new URL('./fixtures/live-webhook-events.json', import.meta.url), 'utf8'));

test('contract: the Live Worker re-validates forwarded facts to exactly what the Photo Worker sends, and drops anything else', () => {
    assert.deepEqual(liveFacts(contract.facts), contract.facts);
    const hostile = [{ field: 'live_videos', id: '1; DROP', status: 'LIVE<script>', keys: ['id', 'Bad Key', 42], extra: 'x' },
        { field: 'feed', item: 'photo', verb: 'remove', videoId: 'abc', postId: '999_1' }, { field: 'unknown' }, null, 'string'];
    assert.deepEqual(liveFacts(hostile), [{ field: 'live_videos', keys: ['id'] }, { field: 'feed', keys: [] }]);
    assert.equal(liveFacts(Array.from({ length: 40 }, () => contract.facts[0])).length, 10);
    assert.deepEqual(liveFacts('not-an-array'), []);
});

test('stored facts are bounded to 60 and 48 hours; journal entries keep codes and IDs only', () => {
    const now = Date.parse('2026-11-27T00:05:00Z');
    const old = { ...contract.facts[0], at: now - 49 * 3600_000, ref: 'a'.repeat(12) };
    const many = Array.from({ length: 80 }, (_, i) => ({ ...contract.facts[0], at: now - i, ref: 'b'.repeat(12) }));
    const kept = pruneFacts([old, ...many], now);
    assert.equal(kept.length, STORED_FACT_LIMIT); assert.ok(!kept.includes(old));
    const entry = timingEntry({ stage: 'webhook-live-event', at: now, eventRef: 'abcdef012345', field: 'live_videos', status: 'live_stopped', liveVideoId: '1467167912212118', keys: ['message'], message: 'PRIVATE' });
    assert.deepEqual(entry, { stage: 'webhook-live-event', at: now, status: 'live_stopped', field: 'live_videos', eventRef: 'abcdef012345', liveVideoId: '1467167912212118' });
    assert.equal(typeof FACTS_KEY, 'string'); assert.equal(typeof MAP_KEY, 'string');
});
