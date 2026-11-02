import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyAndStage } from '../workers/facebook-live/diagnostics.ts';
import { checkVideoDeployment } from '../workers/facebook-live/check-video-deployment.mjs';
const config = JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.video.existing-account.json', import.meta.url)));
const video = '1706736221227932', graphPage = '144051422124740', url = `https://www.facebook.com/61552199315213/videos/${video}/`;
function setup() {
    const manual = JSON.stringify({ latestVideoUrl: url, updatedAt: '2026-11-02T00:02:39.838Z' });
    const data = new Map([['raffle_live', manual]]), writes = [];
    const env = { ...config.vars, FB_PAGE_ACCESS_TOKEN: 'TEST_ONLY', CONFIG: { get: async k => data.get(k) ?? null, put: async (k,v) => { data.set(k,v); writes.push(k); } } };
    const now = new Date('2026-11-02T01:00:00Z');
    const fetcher = async request => {
        const u = new URL(request), fields = u.searchParams.get('fields'), id = u.pathname.split('/').at(-1);
        if (id === graphPage) return Response.json({ id });
        // Only metadata is administrator-observed. Wrapper is a simulated regression harness.
        if (id === 'published_posts') return Response.json({ data: [{ id: `${graphPage}_123`, message: '#LakeHenryRaffle', created_time: '2026-11-02T00:00:00Z',
            attachments: { data: [{ type: 'video_autoplay', target: { id: video, url } }] } }] });
        if (fields === 'id,format') return Response.json({ id, format: [{ width:720, height:1280 }] });
        return Response.json({ id, from:{id:graphPage}, published:true, embeddable:true, live_status:'VOD' });
    };
    return { env, data, writes, manual, now, fetcher };
}
test('private controlled verification stages real-shaped VOD and tests fallback without manual/receipt writes', async () => {
    const s=setup(), result=await verifyAndStage(s.env,video,s);
    assert.equal(result.ok,true);
    assert.equal(result.stage.id,video);
    assert.ok(Object.values(result.checks).every(Boolean));
    assert.deepEqual(s.writes,['raffle_live_automatic','raffle_live_automation_state']);
    assert.equal(s.data.get('raffle_live'),s.manual);
    assert.equal(s.data.has('raffle_live_verification'),false);
});
test('verification refuses enabled flags, unexpected selection, newer stage and Graph failure', async () => {
    const s=setup();
    assert.equal((await verifyAndStage({...s.env,FB_AUTOMATION_ENABLED:'true'},video,s)).status,'verification-precondition-failed');
    assert.equal((await verifyAndStage(s.env,'999',s)).status,'manual-selection-mismatch');
    s.data.set('raffle_live_automatic',JSON.stringify({publishedAt:'2026-11-02T00:59:00Z'}));
    assert.equal((await verifyAndStage(s.env,video,s)).status,'previous-stage-protected');
    assert.deepEqual(s.writes,[]);
    assert.equal((await verifyAndStage(s.env,video,{...s,fetcher:async()=>Response.json({error:{code:190}},{status:400})})).status,'token-expired');
});
test('video-only guard retains strict account, KV, disabled flags and no public endpoint', () => {
    assert.equal(checkVideoDeployment(config,config.account_id),true);
    for (const change of [{account_id:'1'.repeat(32)},{ai:{binding:'AI'}},{main:'photos-entry.ts'},{triggers:{crons:['*/5 * * * *']}},
        {vars:{...config.vars,FB_AUTOMATION_ENABLED:'true'}}]) assert.throws(()=>checkVideoDeployment({...config,...change},config.account_id));
});
