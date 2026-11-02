import test from 'node:test';
import assert from 'node:assert/strict';
import { dimensions, presentation, loadPresentation } from '../src/lib/video-presentation.ts';
import { POST } from '../src/pages/api/admin/raffle/presentation.ts';

test('verified real format sizes select portrait; sanitized dimensions only', async () => {
    const raw = { format: [{ width: 130, height: 231 }, { width: 480, height: 853 }, { width: 720, height: 1280, embed_html: '<iframe/>', picture: 'temporary' }] };
    assert.deepEqual(dimensions(raw), { width: 720, height: 1280, source: 'format' });
    for (const id of ['39756815320632328', '1706736221227932']) {
        assert.deepEqual(await loadPresentation({ get: async () => null }, `https://www.facebook.com/61552199315213/videos/${id}/`), { orientation: 'portrait', source: 'format' });
    }
});
test('landscape formats, validated thumbnail fallback, ambiguous sizes and video-scoped override', () => {
    assert.equal(dimensions({ format: [{ width: 1920, height: 1080 }] }).width, 1920);
    assert.equal(dimensions({ media: { image: { width: 1280, height: 720 } } }).source, 'thumbnail');
    for (const value of [{ width: 0, height: 10 }, { width: '720', height: 1280 }, { width: 20000, height: 720 }, { width: 720, height: 720 }]) assert.equal(dimensions({ format: [value] }), null);
    assert.equal(dimensions({ format: [{ width: 720, height: 1280 }, { width: 1280, height: 720 }] }), null);
    const url = 'https://www.facebook.com/61552199315213/videos/123/';
    assert.equal(presentation(url, { videoId: '123', width: 1920, height: 1080 }).orientation, 'landscape');
    assert.equal(presentation(url, { videoId: '123', width: 1920, height: 1080, override: 'portrait' }).orientation, 'portrait');
    assert.equal(presentation(url, { videoId: '456', override: 'landscape' }).source, 'fallback');
});
test('admin saves layout separately without touching URL or other raffle data; rejects mismatched metadata', async () => {
    const writes = [], store = { get: async () => null, put: async (...v) => writes.push(v) };
    const call = body => POST({ request: new Request('http://localhost/api/admin/raffle/presentation', { method: 'POST', body: JSON.stringify(body) }), locals: { runtime: { env: { CONFIG: store } } } });
    const body = { videoUrl: 'https://www.facebook.com/61552199315213/videos/123/', override: 'auto', metadata: { id: '123', format: [{ width: 1920, height: 1080, embed_html: 'ignored' }] } };
    assert.equal((await call(body)).status, 200);
    assert.equal(writes[0][0], 'raffle_video_presentation:123');
    assert.deepEqual(JSON.parse(writes[0][1]), { videoId: '123', override: 'auto', width: 1920, height: 1080, source: 'format' });
    assert.equal((await call({ ...body, metadata: { ...body.metadata, id: '456' } })).status, 400);
    assert.equal(writes.length, 1);
});
