import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { runPoll, STATE_KEY, VERIFICATION_KEY } from '../workers/facebook-live/poller.ts';
import { selectRaffleVideo } from '../src/lib/server/raffle-selection.ts';
import { inDiscoveryWindow, discoverySlot, nextDiscoverySlot } from '../src/lib/server/raffle-discovery-schedule.ts';
import { DiscoveryCoordinator } from '../workers/facebook-live/coordinator.ts';
import { checkActivation } from '../workers/facebook-live/check-activation.mjs';
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
        FB_GRAPH_PAGE_ID:graph,FB_PUBLIC_PAGE_ID:page,FB_RAFFLE_MARKER:'#LakeHenryRaffle',FB_POLL_INTERVAL_SECONDS:'60',FB_ACCESS_REVISION:'1'};
    return {data,reads,writes,store,env};
}
function api({id='222',published='2026-11-02T23:00:00Z',failure,liveStatus='LIVE',empty=false}={}) {
    const calls=[];
    const fetcher=async input=>{
        const url=new URL(input);calls.push(url.pathname);
        if(failure)return Response.json({error:{code:failure}},{status:400});
        const part=url.pathname.split('/').at(-1);
        if(part===graph)return Response.json({id:graph});
        if(part==='published_posts')return Response.json({data:empty?[]:[{id:`${graph}_333`,message:'#LakeHenryRaffle drawing',created_time:published,
            attachments:{data:[{type:'video_inline',target:{id,url:`https://www.facebook.com/${page}/videos/${id}/`}}]}}]});
        if(url.searchParams.get('fields')==='id,format')return Response.json({id,format:[{width:720,height:1280}]});
        return Response.json({id,from:{id:graph},published:true,embeddable:true,live_status:liveStatus});
    };
    return {fetcher,calls};
}
const selection=(s,time,extra={})=>selectRaffleVideo({manualRaw:s.data.get(manualKey),automaticRaw:s.data.get(automaticKey),
    stateRaw:s.data.get(STATE_KEY),verificationRaw:s.data.get(VERIFICATION_KEY),enabled:true,now:new Date(time),...extra});
const poll=(s,time,mock=api(),extra={})=>runPoll(s.env,{now:new Date(time),fetcher:mock.fetcher,random:()=>0,...extra});
function coordinator(s, time='2026-11-02T23:50:00Z', mock=api()) {
    const disk=new Map(); let alarm=null, current=Date.parse(time), io=0;
    const storage={async get(key){io++;return structuredClone(disk.get(key));},async put(key,value){io++;disk.set(key,structuredClone(value));},
        async getAlarm(){io++;return alarm;},async setAlarm(time){io++;alarm=time;}};
    const create=()=>new DiscoveryCoordinator(storage,s.env,()=>current,(env,deps)=>runPoll(env,{...deps,random:()=>0}),mock.fetcher);
    return {storage,disk,create,worker:create(),set time(value){current=typeof value==='string'?Date.parse(value):value;},get time(){return current;},
        get io(){return io;},get due(){return alarm;},async fire(){alarm=null;return this.worker.alarm();}};
}

test('Chicago 5:50 through 6:10 inclusive handles UTC date boundaries, DST and unconfirmed months',()=>{
    for(const [time,active]of [
        ['2026-10-31T23:55:00Z',false],['2026-11-01T06:30:00Z',false],['2026-11-01T07:30:00Z',false],
        ['2026-11-01T22:55:00Z',false],['2026-11-01T23:49:59Z',false],['2026-11-01T23:50:00Z',true],
        ['2026-11-02T00:00:00Z',true],['2026-11-02T00:10:00Z',true],['2026-11-02T00:10:59Z',true],['2026-11-02T00:11:00Z',false],
        ['2026-12-01T00:10:00Z',true],['2026-12-01T00:11:00Z',false],['2026-12-01T23:55:00Z',false],['2027-11-02T23:55:00Z',false]]) {
        assert.equal(inDiscoveryWindow(new Date(time)),active,time);
    }
    assert.equal(inDiscoveryWindow(new Date('invalid')),false);
});

test('outside the window every invocation returns before all KV and Facebook I/O',async()=>{
    for(const time of ['2026-11-02T12:00:00Z','2026-11-02T23:49:59Z','2026-11-03T00:11:00Z','2026-12-02T00:00:00Z','2027-11-02T23:55:00Z']) {
        const s=setup(),mock=api();assert.equal((await poll(s,time,mock)).status,'outside-drawing-window');
        assert.equal(s.reads.length,0);assert.equal(s.writes.length,0);assert.equal(mock.calls.length,0);
    }
});

test('full UTC day: 1440 cron ticks, 30 serialized discovery cycles, one heartbeat each, no off-hours I/O',async()=>{
    const s=setup(),mock=api(),c=coordinator(s,undefined,mock);let checks=0;const groups=[0,0,0];
    for(let seconds=0;seconds<86400;seconds+=15) {
        c.time=Date.parse('2026-11-03T00:00:00Z')+seconds*1000;
        const off=!inDiscoveryWindow(new Date(c.time)),before=[s.reads.length,s.writes.length,mock.calls.length,c.io];
        if(seconds%60===0)await c.worker.kick();
        if(c.due!==null&&c.due<=c.time){
            assert.ok(['staged','unchanged'].includes((await c.fire()).status));checks++;
            const utc=new Date(c.time),hour=utc.getUTCHours(),minute=utc.getUTCMinutes();
            groups[hour===23&&minute<59?0:hour===23||minute<2?1:2]++;
        }
        if(off)assert.deepEqual([s.reads.length,s.writes.length,mock.calls.length,c.io],before);
    }
    assert.equal(checks,30);assert.equal(s.writes.filter(k=>k===STATE_KEY).length,30);
    assert.deepEqual(groups,[9,12,9]);
    assert.equal(s.reads.length,32);assert.equal(s.writes.filter(k=>k===automaticKey).length,1);
    assert.equal(mock.calls.filter(path=>path.endsWith('/published_posts')).length,30);
    assert.equal(s.data.get(manualKey),manual);
    console.log('Measured daily schedule: 1440 cron ticks, 30 discovery cycles, 30 state writes, 32 KV reads (cold coordinator), 1 initial stage write.');
});

test('unchanged healthy videos write one heartbeat; one-minute jitter tolerance does not permit an immediate duplicate',async()=>{
    const s=setup();assert.equal((await poll(s,'2026-11-02T23:55:03Z')).status,'staged');
    const staged=s.data.get(automaticKey),start=s.writes.length;
    assert.equal((await poll(s,'2026-11-02T23:56:01Z')).status,'unchanged');
    assert.deepEqual(s.writes.slice(start),[STATE_KEY]);assert.equal(s.data.get(automaticKey),staged);
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).lastVerifiedAt,'2026-11-02T23:56:01.000Z');
    const next=s.writes.length;assert.equal((await poll(s,'2026-11-02T23:56:02Z')).status,'not-due');assert.equal(s.writes.length,next);
});

test('failed checks write one error/backoff, honor retry timing, pause permission failures, and recover',async()=>{
    const s=setup();await poll(s,'2026-11-02T23:55:00Z');const stage=s.data.get(automaticKey),start=s.writes.length;
    assert.equal((await poll(s,'2026-11-02T23:56:00Z',api({failure:4}))).status,'rate-limited');
    assert.deepEqual(s.writes.slice(start),[STATE_KEY]);assert.equal(s.data.get(automaticKey),stage);
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).nextAttemptAt,Date.parse('2026-11-02T23:58:00Z'));
    assert.equal((await poll(s,'2026-11-02T23:57:59Z')).status,'not-due');
    assert.equal((await poll(s,'2026-11-02T23:58:00Z')).status,'unchanged');
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).failures,0);
    assert.equal((await poll(s,'2026-11-02T23:59:00Z',api({failure:190}))).status,'token-expired');
    assert.equal((await poll(s,'2026-11-03T00:00:00Z')).status,'access-paused');assert.equal(s.data.get(manualKey),manual);
});

test('delayed availability at 6:10 is discovered; replay survives UTC/local midnight; next day replaces it',async()=>{
    const s=setup();
    assert.equal((await poll(s,'2026-11-02T23:55:00Z',api({empty:true}))).status,'no-eligible-video');
    assert.equal(selection(s,'2026-11-03T00:00:00Z').source,'manual');
    const late=api({published:'2026-11-03T00:09:00Z'});
    assert.equal((await poll(s,'2026-11-03T00:10:00Z',late)).status,'staged');
    const before=[s.reads.length,s.writes.length,late.calls.length];
    assert.equal((await poll(s,'2026-11-03T00:11:00Z',late)).status,'outside-drawing-window');
    assert.deepEqual([s.reads.length,s.writes.length,late.calls.length],before);
    for(const time of ['2026-11-03T00:21:00Z','2026-11-03T05:59:59Z','2026-11-03T06:00:00Z','2026-11-03T23:49:59Z'])assert.equal(selection(s,time).source,'automatic',time);
    assert.equal(selection(s,'2026-11-03T23:55:00Z').reason,'detection-unavailable');
    assert.equal((await poll(s,'2026-11-03T23:55:00Z',late)).status,'unchanged');
    assert.equal(selection(s,'2026-11-03T23:55:01Z').source,'automatic');
    assert.equal((await poll(s,'2026-11-04T00:02:00Z',api({id:'444',published:'2026-11-04T00:01:00Z'}))).status,'staged');
    assert.match(selection(s,'2026-11-04T00:02:01Z').config.latestVideoUrl,/444/);
    assert.equal(s.data.get(manualKey),manual);
});

test('videos first available after cutoff are missed until next window; empty checks never clear selection',async()=>{
    const s=setup();await poll(s,'2026-11-02T23:55:00Z');const stage=s.data.get(automaticKey);
    assert.equal((await poll(s,'2026-11-03T00:10:00Z',api({empty:true}))).status,'no-eligible-video');
    assert.equal(s.data.get(automaticKey),stage);
    const late=api({id:'555',published:'2026-11-03T00:11:00Z'});
    assert.equal((await poll(s,'2026-11-03T00:11:00Z',late)).status,'outside-drawing-window');assert.equal(late.calls.length,0);
    assert.equal(selection(s,'2026-11-03T00:30:00Z').source,'manual');
    assert.equal((await poll(s,'2026-11-03T23:55:00Z',late)).status,'staged');
    assert.match(selection(s,'2026-11-03T23:55:01Z').config.latestVideoUrl,/555/);
});

test('successful early-window verification remains replayable overnight even if later ticks were missed',async()=>{
    const s=setup();await poll(s,'2026-11-02T23:55:00Z');
    assert.equal(selection(s,'2026-11-03T00:30:00Z').source,'automatic');
    assert.equal(selection(s,'2026-11-03T06:00:00Z').source,'automatic');
});

test('backoff crossing cutoff does not trigger off-hours checks and recovers at the next daily window',async()=>{
    const s=setup();await poll(s,'2026-11-03T00:08:00Z');
    assert.equal((await poll(s,'2026-11-03T00:09:00Z',api({failure:4}))).status,'rate-limited');
    assert.equal((await poll(s,'2026-11-03T00:10:00Z')).status,'not-due');
    const before=[s.reads.length,s.writes.length],late=api({id:'666',published:'2026-11-03T00:10:00Z'});
    assert.equal((await poll(s,'2026-11-03T00:11:00Z',late)).status,'outside-drawing-window');
    assert.deepEqual([s.reads.length,s.writes.length],before);assert.equal(late.calls.length,0);
    assert.equal(selection(s,'2026-11-03T06:00:00Z').source,'manual');
    assert.equal((await poll(s,'2026-11-03T23:55:00Z',late)).status,'staged');
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).failures,0);
    assert.match(selection(s,'2026-11-03T23:55:01Z').config.latestVideoUrl,/666/);
});

test('off-hours replay never bypasses receipt, manual mode, identity, failure or wrong-day checks',async()=>{
    const s=setup();await poll(s,'2026-11-03T00:10:00Z');const now='2026-11-03T02:30:00Z',state=JSON.parse(s.data.get(STATE_KEY));
    for(const patch of [{paused:true},{failures:1},{lastVerifiedVideoId:'999'},{lastVerifiedAt:'2026-11-02T23:49:00Z'},
        {lastAttemptAt:Date.parse('2026-11-02T23:49:00Z')}]) {
        assert.equal(selection(s,now,{stateRaw:JSON.stringify({...state,...patch})}).source,'manual');
    }
    assert.equal(selection(s,now,{verificationRaw:null}).source,'manual');
    assert.equal(selection(s,now,{manualRaw:JSON.stringify({...JSON.parse(manual),selectionMode:'manual'})}).source,'manual');
    assert.equal(selection(s,'2026-11-04T06:00:00Z').source,'manual');
});

test('an interrupted check does not publish a heartbeat; failed storage or closing provider failure retains fallback',async()=>{
    const s=setup();await poll(s,'2026-11-02T23:55:00Z');const old=s.data.get(STATE_KEY);s.writes.length=0;
    let release,started;const began=new Promise(resolve=>started=resolve);
    const held=runPoll(s.env,{now:new Date('2026-11-03T00:10:00Z'),fetcher:()=>{started();return new Promise(resolve=>release=resolve);}});
    await began;assert.deepEqual(s.writes,[]);assert.equal(s.data.get(STATE_KEY),old);
    release(Response.json({error:{code:4}},{status:400}));await held;assert.deepEqual(s.writes,[STATE_KEY]);
    assert.equal(selection(s,'2026-11-03T00:30:00Z').source,'manual');
    const clean=setup();await poll(clean,'2026-11-03T00:00:00Z');const before=clean.data.get(STATE_KEY);
    clean.env.CONFIG={get:clean.store.get,async put(){throw Error('simulated storage failure')}};
    assert.equal((await poll(clean,'2026-11-03T00:01:00Z')).status,'storage-or-state-failure');assert.equal(clean.data.get(STATE_KEY),before);
});

test('deployment guards require one-minute cron and interval, rejecting the former five-minute config',async()=>{
    const config=JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.video.activation.existing-account.json',import.meta.url),'utf8'));
    const check=value=>checkActivation(value,JSON.parse(receipt),config.account_id,'tagged-page-video-v1',new Date('2026-11-02T23:55:00Z'));
    assert.equal(check(config),true);
    assert.throws(()=>check({...config,triggers:{crons:['*/5 * * * *']}}));
    assert.throws(()=>check({...config,vars:{...config.vars,FB_POLL_INTERVAL_SECONDS:'300'}}));
    assert.throws(()=>check({...config,durable_objects:undefined}));
    assert.throws(()=>check({...config,migrations:[{tag:'wrong',new_classes:['DiscoveryScheduler']}]}));
});

test('all cadence transitions are aligned, including each burst quarter and final 6:10 minute',()=>{
    const expected=[['23:49:59',null],['23:50:37','23:50:00'],['23:58:59','23:58:00'],['23:59:00','23:59:00'],['23:59:14','23:59:00'],
        ['23:59:15','23:59:15'],['23:59:30','23:59:30'],['23:59:59','23:59:45']];
    for(const [actual,slot] of expected)assert.equal(discoverySlot(new Date('2026-11-02T'+actual+'Z')),slot===null?null:Date.parse('2026-11-02T'+slot+'Z'));
    for(const [actual,next] of [['2026-11-02T23:58:00Z','2026-11-02T23:59:00Z'],['2026-11-02T23:59:45Z','2026-11-03T00:00:00Z'],
        ['2026-11-03T00:01:45Z','2026-11-03T00:02:00Z'],['2026-11-03T00:02:00Z','2026-11-03T00:03:00Z'],['2026-11-03T00:10:00Z',null]]) {
        assert.equal(nextDiscoverySlot(new Date(actual)),next===null?null:Date.parse(next));
    }
});

test('duplicate cron, delayed invocations and retried/restarted alarms never repeat a claimed slot',async()=>{
    const s=setup(),mock=api(),c=coordinator(s,'2026-11-02T23:59:22Z',mock);
    await Promise.all([c.worker.kick(),c.worker.kick()]);assert.equal((await c.fire()).status,'staged');
    assert.equal(JSON.parse(s.data.get(STATE_KEY)).lastAttemptAt,c.time);
    assert.equal(c.due,Date.parse('2026-11-02T23:59:30Z'));
    const before=s.writes.length;
    c.worker=c.create();assert.equal((await c.worker.alarm()).status,'slot-already-claimed');assert.equal(s.writes.length,before);
    c.time='2026-11-03T00:00:37Z';assert.equal((await c.fire()).status,'unchanged');
    assert.equal(s.writes.length,before+1);assert.equal(c.due,Date.parse('2026-11-03T00:00:45Z'));
    c.time='2026-11-03T00:11:01Z';const outside=[c.io,s.reads.length,s.writes.length,mock.calls.length];
    assert.equal((await c.worker.alarm()).status,'outside-drawing-window');await c.worker.kick();
    assert.deepEqual([c.io,s.reads.length,s.writes.length,mock.calls.length],outside);
});

test('held Facebook request blocks reentrant discovery; slow checks skip missed quarters without catch-up',async()=>{
    const s=setup(),mock=api();let release,started,active=0,max=0;
    const began=new Promise(resolve=>started=resolve);
    const fetcher=async input=>{active++;max=Math.max(max,active);try {if(!release){started();await new Promise(resolve=>release=resolve);}return await mock.fetcher(input);}finally{active--;}};
    const c=coordinator(s,'2026-11-02T23:59:00Z',{fetcher}),pending=c.worker.alarm();
    await began;c.time='2026-11-02T23:59:31Z';await c.worker.kick();assert.equal((await c.worker.alarm()).status,'already-running');
    assert.equal(s.writes.length,0);release();await pending;assert.equal(max,1);
    assert.equal((await c.fire()).status,'unchanged');assert.equal(s.writes.filter(k=>k===STATE_KEY).length,2);
    assert.equal(c.due,Date.parse('2026-11-02T23:59:45Z'));
});

test('durable claim survives interruption before discovery and the next slot recovers',async()=>{
    const s=setup(),c=coordinator(s,'2026-11-02T23:59:00Z');
    const interrupted=new DiscoveryCoordinator(c.storage,s.env,()=>c.time,async()=>{throw Error('simulated runtime interruption');});
    await assert.rejects(interrupted.alarm());assert.equal(s.writes.length,0);
    c.worker=c.create();assert.equal((await c.worker.alarm()).status,'slot-already-claimed');
    c.time='2026-11-02T23:59:15Z';assert.equal((await c.fire()).status,'staged');assert.deepEqual(s.writes,[automaticKey,STATE_KEY]);
});

test('burst backoff survives restart and stale KV; final KV failure cannot forget retry state',async()=>{
    const s=setup(),failed=api({failure:4}),c=coordinator(s,'2026-11-02T23:59:00Z',failed);
    assert.equal((await c.fire()).status,'rate-limited');const calls=failed.calls.length;
    // Simulate eventual-consistency reads returning an older, empty state.
    s.data.delete(STATE_KEY);c.worker=c.create();c.time='2026-11-02T23:59:15Z';
    assert.equal((await c.fire()).status,'not-due');assert.equal(failed.calls.length,calls);
    c.time='2026-11-03T00:01:00Z';assert.equal((await c.fire()).status,'rate-limited');
    const s2=setup(),c2=coordinator(s2,'2026-11-02T23:59:00Z',failed);
    s2.env.CONFIG={get:s2.store.get,async put(){throw Error('KV unavailable');}};
    assert.equal((await c2.fire()).status,'storage-or-state-failure');c2.worker=c2.create();c2.time='2026-11-02T23:59:15Z';
    const before=failed.calls.length;assert.equal((await c2.fire()).status,'not-due');assert.equal(failed.calls.length,before);
});

test('a final check crossing 6:11 cannot initiate another Facebook request or a KV write',async()=>{
    const s=setup(),mock=api();let release,started;
    const began=new Promise(resolve=>started=resolve);
    const fetcher=async (input,init)=>{if(!release){started();await new Promise(resolve=>release=resolve);}return mock.fetcher(input,init);};
    const c=coordinator(s,'2026-11-03T00:10:59Z',{fetcher}),pending=c.worker.alarm();
    await began;const writes=s.writes.length;c.time='2026-11-03T00:11:00Z';release();
    assert.equal((await pending).status,'storage-or-state-failure');
    assert.equal(mock.calls.length,1);assert.equal(s.writes.length,writes);
});

test('production Durable Object export boots under workerd with isolated SQLite storage and KV',async t=>{
    const bundle=await build({entryPoints:[new URL('../workers/facebook-live/video-entry.ts',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],
        bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
    const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-09-15',
        durableObjects:{DISCOVERY_SCHEDULER:{className:'DiscoveryScheduler',useSQLite:true}},durableObjectsPersist:false,
        kvNamespaces:['CONFIG'],kvPersist:false,bindings:{FB_AUTOMATION_ENABLED:'false'}});
    t.after(()=>mf.dispose());
    const kv=await mf.getKVNamespace('CONFIG');await kv.put(manualKey,manual);
    const ns=await mf.getDurableObjectNamespace('DISCOVERY_SCHEDULER');
    const stub=ns.get(ns.idFromName('november-2026'));
    const responses=await Promise.all([stub.fetch('https://discovery.internal/kick'),stub.fetch('https://discovery.internal/kick')]);
    assert.deepEqual(responses.map(r=>r.status),[204,204]);
    assert.equal(await kv.get(manualKey),manual);assert.equal(await kv.get(STATE_KEY),null);
    assert.equal((await mf.dispatchFetch('https://example.test/')).status,404);
});
