import test from 'node:test';
import assert from 'node:assert/strict';
import { runPoll, STATE_KEY, VERIFICATION_KEY } from '../workers/facebook-live/poller.ts';
import { selectRaffleVideo } from '../src/lib/server/raffle-selection.ts';
import { inDiscoveryWindow } from '../src/lib/server/raffle-discovery-schedule.ts';
import { GRAPH_PAGE_ID as graph, PUBLIC_PAGE_ID as page, GRAPH_VERSION as version, LIVE_CONTRACT as contract } from '../workers/facebook-live/graph.ts';
const automaticKey='raffle_live_automatic', manualKey='raffle_live';
const receipt=JSON.stringify({schemaVersion:3,graphPageId:graph,publicPageId:page,apiVersion:version,contract,
    evidence:'tagged-page-video-policy-reviewed',marker:'#LakeHenryRaffle',verifiedVideoId:'222',publicPlaybackVerified:true,
    rollbackTested:true,verifiedAt:'2026-11-01T23:00:00Z',expiresAt:'2026-12-01T06:00:00Z'});
const manual=JSON.stringify({latestVideoUrl:`https://www.facebook.com/${page}/videos/111/`,updatedAt:'2026-11-01T23:00:00Z',selectionMode:'automatic'});
function setup() {
    const data=new Map([[VERIFICATION_KEY,receipt],[manualKey,manual]]),reads=[],writes=[];
    const store={async get(key){reads.push(key);return data.get(key)??null;},async put(key,value){writes.push(key);data.set(key,value);}};
    const env={CONFIG:store,FB_PAGE_ACCESS_TOKEN:'TEST_ONLY',FB_AUTOMATION_ENABLED:'true',FB_VIDEO_PROBE_ENABLED:'true',
        FB_GRAPH_PAGE_ID:graph,FB_PUBLIC_PAGE_ID:page,FB_RAFFLE_MARKER:'#LakeHenryRaffle',FB_POLL_INTERVAL_SECONDS:'300',FB_ACCESS_REVISION:'1'};
    return {data,reads,writes,store,env};
}
function api({id='222',published='2026-11-02T23:00:00Z',failure,liveStatus='LIVE'}={}) {
    const calls=[];
    const fetcher=async input=>{
        const url=new URL(input);calls.push(url.pathname);
        if(failure)return Response.json({error:{code:failure}},{status:400});
        const part=url.pathname.split('/').at(-1);
        if(part===graph)return Response.json({id:graph});
        if(part==='published_posts')return Response.json({data:[{id:`${graph}_333`,message:'#LakeHenryRaffle drawing',created_time:published,
            attachments:{data:[{type:'video_inline',target:{id,url:`https://www.facebook.com/${page}/videos/${id}/`}}]}}]});
        if(url.searchParams.get('fields')==='id,format')return Response.json({id,format:[{width:720,height:1280}]});
        return Response.json({id,from:{id:graph},published:true,embeddable:true,live_status:liveStatus});
    };
    return {fetcher,calls};
}
const selection=(s,time,extra={})=>selectRaffleVideo({manualRaw:s.data.get(manualKey),automaticRaw:s.data.get(automaticKey),
    stateRaw:s.data.get(STATE_KEY),verificationRaw:s.data.get(VERIFICATION_KEY),enabled:true,now:new Date(time),...extra});
const poll=(s,time,mock=api(),extra={})=>runPoll(s.env,{now:new Date(time),fetcher:mock.fetcher,random:()=>0,...extra});

test('confirmed Chicago window is half-open, handles UTC midnight/DST, and does not extrapolate months',()=>{
    for(const [time,active]of [
        ['2026-10-31T23:30:00Z',false],['2026-11-01T06:30:00Z',false],['2026-11-01T07:30:00Z',false],
        ['2026-11-01T22:30:00Z',false],['2026-11-01T23:29:59Z',false],['2026-11-01T23:30:00Z',true],
        ['2026-11-02T00:00:00Z',true],['2026-11-02T01:25:00Z',true],['2026-11-02T01:29:59Z',true],['2026-11-02T01:30:00Z',false],
        ['2026-12-01T01:25:00Z',true],['2026-12-01T01:30:00Z',false],['2026-12-01T23:30:00Z',false],['2027-11-02T23:30:00Z',false]]) {
        assert.equal(inDiscoveryWindow(new Date(time)),active,time);
    }
    assert.equal(inDiscoveryWindow(new Date('invalid')),false);
});
test('outside the window every invocation returns before all KV and Facebook I/O',async()=>{
    for(const time of ['2026-11-02T12:00:00Z','2026-11-02T23:29:59Z','2026-11-03T01:30:00Z','2026-12-02T00:00:00Z','2027-11-02T23:30:00Z']) {
        const s=setup(),mock=api();assert.equal((await poll(s,time,mock)).status,'outside-drawing-window');
        assert.equal(s.reads.length,0);assert.equal(s.writes.length,0);assert.equal(mock.calls.length,0);
    }
});
test('a full UTC day has 288 cron ticks but only 24 checks and 24 normal state writes',async()=>{
    const s=setup(),mock=api({published:'2026-11-02T23:00:00Z'});let checks=0;
    for(let minute=0;minute<1440;minute+=5) {
        const time=new Date(Date.parse('2026-11-03T00:00:00Z')+minute*60000).toISOString();
        if((await poll(s,time,mock)).status!=='outside-drawing-window')checks++;
    }
    assert.equal(checks,24);assert.equal(s.writes.filter(k=>k===STATE_KEY).length,24);
    assert.equal(s.reads.length,72);assert.equal(s.writes.filter(k=>k===automaticKey).length,1);
    assert.equal(s.data.get(manualKey),manual);
    console.log('Measured daily schedule: 288 cron ticks, 24 discovery cycles, 24 state writes, 72 KV reads, 1 initial stage write.');
});
test('unchanged healthy videos write exactly one heartbeat and retain selection timestamp; early cron tolerance is preserved',async()=>{
    const s=setup();assert.equal((await poll(s,'2026-11-02T23:30:03Z')).status,'staged');
    const staged=s.data.get(automaticKey),start=s.writes.length;
    assert.equal((await poll(s,'2026-11-02T23:35:01Z')).status,'unchanged');
    assert.deepEqual(s.writes.slice(start),[STATE_KEY]);assert.equal(s.data.get(automaticKey),staged);
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).lastVerifiedAt,'2026-11-02T23:35:01.000Z');
    const next=s.writes.length;assert.equal((await poll(s,'2026-11-02T23:36:00Z')).status,'not-due');assert.equal(s.writes.length,next);
});
test('failed checks persist one error/backoff, honor retry timing, pause permission failures, and recover',async()=>{
    const s=setup();await poll(s,'2026-11-02T23:30:00Z');const stage=s.data.get(automaticKey),start=s.writes.length;
    assert.equal((await poll(s,'2026-11-02T23:35:00Z',api({failure:4}))).status,'rate-limited');
    assert.deepEqual(s.writes.slice(start),[STATE_KEY]);assert.equal(s.data.get(automaticKey),stage);
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).nextAttemptAt,Date.parse('2026-11-02T23:45:00Z'));
    assert.equal((await poll(s,'2026-11-02T23:44:59Z')).status,'not-due');
    assert.equal((await poll(s,'2026-11-02T23:45:00Z')).status,'unchanged');
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).failures,0);
    assert.equal((await poll(s,'2026-11-02T23:50:00Z',api({failure:190}))).status,'token-expired');
    assert.equal((await poll(s,'2026-11-02T23:55:00Z')).status,'access-paused');assert.equal(s.data.get(manualKey),manual);
});
test('late broadcasts are selected at 7:25, replay survives overnight, and next window requires fresh health',async()=>{
    const s=setup(),late=api({published:'2026-11-03T01:20:00Z'});
    assert.equal((await poll(s,'2026-11-03T01:25:00Z',late)).status,'staged');
    const count=s.writes.length;assert.equal((await poll(s,'2026-11-03T01:30:00Z',late)).status,'outside-drawing-window');assert.equal(s.writes.length,count);
    for(const time of ['2026-11-03T01:40:00Z','2026-11-03T06:00:00Z','2026-11-03T23:29:59Z'])assert.equal(selection(s,time).source,'automatic',time);
    assert.equal(selection(s,'2026-11-03T23:30:00Z').reason,'detection-unavailable');
    assert.equal((await poll(s,'2026-11-03T23:30:00Z',late)).status,'unchanged');
    assert.equal(selection(s,'2026-11-03T23:30:01Z').source,'automatic');
});
test('off-hours replay never bypasses receipt, mode, identity, failure or closing-health checks',async()=>{
    const s=setup();await poll(s,'2026-11-03T01:25:00Z');const now='2026-11-03T02:30:00Z',state=JSON.parse(s.data.get(STATE_KEY));
    for(const patch of [{paused:true},{failures:1},{lastVerifiedVideoId:'999'},{lastVerifiedAt:'2026-11-03T01:10:00Z'},
        {lastAttemptAt:Date.parse('2026-11-03T01:10:00Z')}]) {
        assert.equal(selection(s,now,{stateRaw:JSON.stringify({...state,...patch})}).source,'manual');
    }
    assert.equal(selection(s,now,{verificationRaw:null}).source,'manual');
    assert.equal(selection(s,now,{manualRaw:JSON.stringify({...JSON.parse(manual),selectionMode:'manual'})}).source,'manual');
    const noon=setup();await poll(noon,'2026-11-02T23:30:00Z');assert.equal(selection(noon,now).source,'manual');
});
test('an interrupted in-flight check does not publish a checking heartbeat; failed final storage preserves previous state',async()=>{
    const s=setup();await poll(s,'2026-11-03T00:00:00Z');const old=s.data.get(STATE_KEY);s.writes.length=0;
    let release,started;const began=new Promise(resolve=>started=resolve);
    const held=runPoll(s.env,{now:new Date('2026-11-03T01:25:00Z'),fetcher:()=>{started();return new Promise(resolve=>release=resolve);}});
    await began;assert.deepEqual(s.writes,[]);assert.equal(s.data.get(STATE_KEY),old);
    assert.equal(selection(s,'2026-11-03T01:40:00Z').source,'manual');
    release(Response.json({error:{code:4}},{status:400}));await held;assert.deepEqual(s.writes,[STATE_KEY]);
    const clean=setup();await poll(clean,'2026-11-03T00:00:00Z');const before=clean.data.get(STATE_KEY);
    clean.env.CONFIG={get:clean.store.get,async put(){throw Error('simulated storage failure')}};
    assert.equal((await poll(clean,'2026-11-03T00:05:00Z')).status,'storage-or-state-failure');assert.equal(clean.data.get(STATE_KEY),before);
});
