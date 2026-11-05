import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {runPoll,STATE_KEY,VERIFICATION_KEY} from '../workers/facebook-live/poller.ts';
import {selectRaffleVideo} from '../src/lib/server/raffle-selection.ts';
import {inDiscoveryWindow,discoverySlot,nextDiscoverySlot} from '../src/lib/server/raffle-discovery-schedule.ts';
import {DiscoveryCoordinator} from '../workers/facebook-live/coordinator.ts';
import {discoverLivestreams} from '../workers/facebook-live/livestream.ts';
import {checkActivation} from '../workers/facebook-live/check-activation.mjs';
import {GRAPH_PAGE_ID as graph,PUBLIC_PAGE_ID as page,GRAPH_VERSION as version,LIVE_CONTRACT as contract} from '../workers/facebook-live/graph.ts';
const automaticKey='raffle_live_automatic',manualKey='raffle_live';
const receipt=JSON.stringify({schemaVersion:5,graphPageId:graph,publicPageId:page,apiVersion:version,contract,evidence:'page-video-live-origin-policy-reviewed',verifiedVideoId:'222',publicPlaybackVerified:true,rollbackTested:true,verifiedAt:'2026-11-01T23:00:00Z',expiresAt:'2026-12-01T06:00:00Z'});
const manual=JSON.stringify({latestVideoUrl:`https://www.facebook.com/${page}/videos/111/`,selectionMode:'automatic'});
function setup(){const data=new Map([[VERIFICATION_KEY,receipt],[manualKey,manual]]),reads=[],writes=[];const store={async get(k){reads.push(k);return data.get(k)??null},async put(k,v){writes.push(k);data.set(k,v)}};return {data,reads,writes,store,env:{CONFIG:store,FB_PAGE_ACCESS_TOKEN:'TEST_ONLY',FB_AUTOMATION_ENABLED:'true',FB_VIDEO_PROBE_ENABLED:'true',FB_GRAPH_PAGE_ID:graph,FB_PUBLIC_PAGE_ID:page,FB_RAFFLE_MARKER:'#LakeHenryRaffle',FB_POLL_INTERVAL_SECONDS:'60',FB_ACCESS_REVISION:'1'}};}
function api({id='222',published='2026-11-03T00:00:00Z',failure,ordinary=false,foreign=false,extra=false,start=published,liveStatus='LIVE'}={}){
 const calls=[];return {calls,fetcher:async input=>{const u=new URL(input);calls.push(u.pathname);if(failure)return Response.json({error:{code:failure}},{status:400});
 const part=u.pathname.split('/').at(-1);if(part===graph)return Response.json({id:graph});if(part==='live_videos')return Response.json({data:ordinary?[]:[{id:'777',status:'VOD',broadcast_start_time:start,video:{id}},...(extra?[{id:'778',status:'LIVE',broadcast_start_time:start,video:{id:'444'}}]:[])]});
 if(part==='published_posts')return Response.json({data:[id,...(extra?['444']:[])].map(v=>({id:`${graph}_${v}`,created_time:published,attachments:{data:[{type:'video_inline',target:{id:v,url:`https://www.facebook.com/122332855106073310/videos/${v}/`}}]}}))});
 return Response.json({id:part,from:{id:foreign?'999':graph},published:true,embeddable:true,...(ordinary?{}:{live_status:liveStatus})});
 }};
}
const poll=(s,time,mock=api(),extra={})=>runPoll(s.env,{now:new Date(time),fetcher:mock.fetcher,random:()=>0,...extra});
const selection=(s,time,extra={})=>selectRaffleVideo({manualRaw:s.data.get(manualKey),automaticRaw:s.data.get(automaticKey),stateRaw:s.data.get(STATE_KEY),verificationRaw:s.data.get(VERIFICATION_KEY),enabled:true,now:new Date(time),...extra});
function coordinator(s,time='2026-11-03T00:00:00Z',mock=api()){
 const disk=new Map();let alarm=null,current=Date.parse(time),io=0;const storage={async get(k){io++;return structuredClone(disk.get(k))},async put(k,v){io++;disk.set(k,structuredClone(v))},async getAlarm(){io++;return alarm},async setAlarm(t){io++;alarm=t}};
 const create=()=>new DiscoveryCoordinator(storage,s.env,()=>current,(env,deps)=>runPoll(env,{...deps,random:()=>0}),mock.fetcher);
 return {disk,storage,create,worker:create(),set time(v){current=typeof v==='string'?Date.parse(v):v},get time(){return current},get io(){return io},get due(){return alarm},async fire(){alarm=null;return this.worker.alarm()}};
}
test('confirmed Chicago window includes DST, November 30 and metadata delayed to 6:30; future months do zero I/O',async()=>{
 for(const [time,active] of [['2026-11-01T23:49:59Z',false],['2026-11-01T23:50:00Z',true],['2026-11-02T00:30:59Z',true],['2026-11-02T00:31:00Z',false],['2026-12-01T00:30:00Z',true],['2026-12-01T23:55:00Z',false],['2027-11-02T23:55:00Z',false],['2027-02-03T00:00:00Z',false]]){
 assert.equal(inDiscoveryWindow(new Date(time)),active,time);if(!active){const s=setup(),m=api();assert.equal((await poll(s,time,m)).status,'outside-drawing-window');assert.deepEqual([s.reads.length,s.writes.length,m.calls.length],[0,0,0]);}}
 assert.equal(inDiscoveryWindow(new Date('invalid')),false);
});
test('November 3 known video requires no hashtag, positive Live metadata and Page ownership; ordinary and unrelated videos rejected',async()=>{
 const s=setup(),m=api({id:'28261694626839193',published:'2026-11-04T00:00:52Z',start:'2026-11-03T23:59:46Z'});
 assert.equal((await poll(s,'2026-11-04T00:06:00Z',m)).status,'staged');const stage=JSON.parse(s.data.get(automaticKey));assert.equal(stage.id,'28261694626839193');assert.equal(stage.origin,'page-video-live-status');assert.equal(stage.drawingDate,'2026-11-03');
 for(const args of [{ordinary:true},{foreign:true},{published:'2026-11-02T19:00:00Z'},{published:'2026-11-02T00:00:00Z'}]){const m=api(args);const r=await discoverLivestreams({token:'test',now:new Date('2026-11-03T00:05:00Z'),fetcher:m.fetcher});assert.equal(r.ok,true);assert.equal(r.discoveries.length,0);}
 const multiple=await discoverLivestreams({token:'test',now:new Date('2026-11-03T00:05:00Z'),fetcher:api({extra:true}).fetcher});assert.equal(multiple.reason,'ambiguous-livestream');
});
test('newer daily drawing replaces old replay, duplicates do not rewrite, manual override expires on newer drawing',async()=>{
 const s=setup();assert.equal((await poll(s,'2026-11-03T00:05:00Z')).status,'staged');const stage=s.data.get(automaticKey);
 assert.equal((await poll(s,'2026-11-03T00:06:00Z')).status,'unchanged');assert.equal(s.data.get(automaticKey),stage);assert.equal(s.writes.filter(k=>k===automaticKey).length,1);
 s.data.set(manualKey,JSON.stringify({...JSON.parse(manual),automaticEnabled:true,manualOverrideAt:'2026-11-03T00:06:30Z'}));assert.equal(selection(s,'2026-11-03T00:07:00Z').source,'manual');
 assert.equal((await poll(s,'2026-11-04T00:05:00Z',api({id:'333',published:'2026-11-04T00:00:00Z'}))).status,'staged');assert.equal(selection(s,'2026-11-04T00:05:01Z').source,'automatic');
 assert.equal((await poll(s,'2026-12-02T00:00:00Z',api({id:'444',published:'2026-12-02T00:00:00Z'}))).status,'outside-drawing-window');assert.equal(JSON.parse(s.data.get(automaticKey)).id,'333');
});
test('API failures retain the last verified display and preserve sanitized endpoint/status/time diagnostics; retry at most two minutes',async()=>{
 const s=setup();await poll(s,'2026-11-03T00:05:00Z');const stage=s.data.get(automaticKey);
 for(let n=0;n<4;n++){const time=new Date(Date.parse('2026-11-03T00:06:00Z')+n*120000).toISOString();assert.equal((await poll(s,time,api({failure:2}))).status,'api-failure');const state=JSON.parse(s.data.get(STATE_KEY));assert.ok(state.nextAttemptAt-Date.parse(time)<=120000);assert.equal(state.lastError.phase,'identity');assert.equal(state.lastError.httpStatus,400);assert.equal(state.lastError.at,time);assert.equal(selection(s,time).source,'automatic');}
 assert.equal(s.data.get(automaticKey),stage);assert.equal((await poll(s,'2026-11-03T00:14:00Z')).status,'unchanged');
});
test('permission loss pauses new discovery without replacing video; old tagged receipt cannot authorize new contract',async()=>{
 const s=setup();await poll(s,'2026-11-03T00:05:00Z');assert.equal((await poll(s,'2026-11-03T00:06:00Z',api({failure:10}))).status,'permission-denied');assert.equal((await poll(s,'2026-11-03T00:08:00Z')).status,'access-paused');assert.equal(selection(s,'2026-11-03T00:08:00Z').source,'automatic');
 assert.equal(selection(s,'2026-11-03T00:08:00Z',{verificationRaw:JSON.stringify({...JSON.parse(receipt),schemaVersion:3,contract:'tagged-page-video-v1'})}).reason,'verification-required');
});
test('missed webhook is recovered by polling; final November replay remains displayed in December without automatic replacement',async()=>{
 const s=setup();await poll(s,'2026-12-01T00:20:00Z',api({published:'2026-12-01T00:00:00Z'}));assert.equal(selection(s,'2027-02-01T00:00:00Z').source,'automatic');const before=s.data.get(automaticKey);const m=api();await poll(s,'2027-02-01T00:00:00Z',m);assert.equal(m.calls.length,0);assert.equal(s.data.get(automaticKey),before);
});
test('full day uses 50 serialized polls, one heartbeat each, no off-hours reads; cadences retain quarter-minute drawing burst',async()=>{
 const s=setup(),m=api({published:'2026-11-02T23:50:00Z'}),c=coordinator(s,undefined,m);let checks=0;
 for(let sec=0;sec<86400;sec+=15){c.time=Date.parse('2026-11-03T00:00:00Z')+sec*1000;const off=!inDiscoveryWindow(new Date(c.time)),before=[s.reads.length,s.writes.length,m.calls.length,c.io];if(sec%60===0)await c.worker.kick();if(c.due!==null&&c.due<=c.time){await c.fire();checks++;}if(off)assert.deepEqual([s.reads.length,s.writes.length,m.calls.length,c.io],before);}
 assert.equal(checks,50);assert.equal(s.writes.filter(k=>k===STATE_KEY).length,50);assert.ok(s.reads.length<=102);assert.equal(nextDiscoverySlot(new Date('2026-11-03T00:30:00Z')),null);assert.equal(discoverySlot(new Date('2026-11-02T23:59:22Z')),Date.parse('2026-11-02T23:59:15Z'));
});
test('Durable Object deduplicates webhook event IDs and cron slots across restart; errors do not lose retry state',async()=>{
 const s=setup(),c=coordinator(s);assert.equal(await c.worker.event('a'.repeat(64)),true);assert.equal(await c.worker.event('a'.repeat(64)),false);assert.equal(s.writes.filter(k=>k==='raffle_live_webhook_state').length,1);
 assert.equal((await c.fire()).status,'staged');c.worker=c.create();assert.equal((await c.worker.alarm()).status,'slot-already-claimed');c.time='2026-11-03T00:01:00Z';assert.equal((await c.fire()).status,'unchanged');
 const failed=setup(),m=api({failure:4}),d=coordinator(failed,undefined,m);assert.equal((await d.fire()).status,'rate-limited');failed.data.delete(STATE_KEY);d.worker=d.create();d.time='2026-11-03T00:00:15Z';const calls=m.calls.length;assert.equal((await d.fire()).status,'not-due');assert.equal(m.calls.length,calls);
});
test('held Graph request blocks reentry; closing-window work does not issue more requests or writes',async()=>{
 const s=setup(),m=api();let release,started;const began=new Promise(r=>started=r);const c=coordinator(s,'2026-11-03T00:30:59Z',{fetcher:async(input,init)=>{if(!release){started();await new Promise(r=>release=r)}return m.fetcher(input,init)}});const pending=c.worker.alarm();await began;assert.equal((await c.worker.alarm()).status,'already-running');c.time='2026-11-03T00:31:00Z';release();assert.equal((await pending).status,'storage-or-state-failure');assert.equal(s.writes.length,0);assert.equal(m.calls.length,1);
});
test('admin disable prevents new checks independently of manual fallback',async()=>{const s=setup(),m=api();s.data.set(manualKey,JSON.stringify({...JSON.parse(manual),automaticEnabled:false}));assert.equal((await poll(s,'2026-11-03T00:05:00Z',m)).status,'disabled-by-admin');assert.equal(m.calls.length,0)});
test('deployment preflight keeps exact account, KV, existing DO migration and minute cron',async()=>{const c=JSON.parse(await readFile('workers/facebook-live/wrangler.video.activation.existing-account.json','utf8'));const check=v=>checkActivation(v,JSON.parse(receipt),c.account_id,contract,new Date('2026-11-02T23:55:00Z'));assert.equal(check(c),true);for(const patch of [{triggers:{crons:['*/5 * * * *']}},{durable_objects:undefined},{migrations:[{tag:'wrong',new_classes:['DiscoveryScheduler']}]}])assert.throws(()=>check({...c,...patch}));});
test('actual production Durable Object exports boot with isolated SQLite and KV',async t=>{const b=await build({entryPoints:['workers/facebook-live/video-entry.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});const mf=new Miniflare({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2025-09-15',durableObjects:{DISCOVERY_SCHEDULER:{className:'DiscoveryScheduler',useSQLite:true}},durableObjectsPersist:false,kvNamespaces:['CONFIG'],kvPersist:false,bindings:{FB_AUTOMATION_ENABLED:'false'}});t.after(()=>mf.dispose());const ns=await mf.getDurableObjectNamespace('DISCOVERY_SCHEDULER');assert.equal((await ns.get(ns.idFromName('november-2026')).fetch('https://discovery.internal/kick')).status,204);assert.equal((await mf.dispatchFetch('https://example.test')).status,404);});

test('a fresh webhook accelerates discovery between polling slots without repeating duplicate events',async()=>{
 const s=setup();let response=api();const c=coordinator(s,'2026-11-03T00:00:00Z',{fetcher:(...args)=>response.fetcher(...args)});
 await c.fire();response=api({id:'333',published:'2026-11-03T00:00:03Z'});c.time='2026-11-03T00:00:05Z';
 assert.equal(await c.worker.event('b'.repeat(64)),true);assert.equal(c.due,c.time);assert.equal((await c.fire()).status,'staged');assert.equal(JSON.parse(s.data.get(automaticKey)).id,'333');
 const writes=s.writes.length;assert.equal(await c.worker.event('b'.repeat(64)),false);assert.equal((await c.worker.alarm()).status,'slot-already-claimed');assert.equal(s.writes.length,writes);
});

test('unproven November 3 VOD is held; only a prior same-video Live observation can authorize a replay',async()=>{
 const now=new Date('2026-11-04T00:06:00Z'),mock=api({id:'28261694626839193',published:'2026-11-04T00:00:52Z',liveStatus:'VOD'});
 const result=await discoverLivestreams({token:'test',now,fetcher:mock.fetcher});assert.equal(result.ok,true);assert.equal(result.discoveries.length,0);assert.equal(result.pending[0].reason,'live-origin-unproven');assert.ok(!mock.calls.some(p=>p.endsWith('/live_videos')));
 const s=setup();await poll(s,'2026-11-03T00:05:00Z');const prior=JSON.parse(s.data.get(automaticKey));
 const replay=await discoverLivestreams({token:'test',now:new Date('2026-11-03T00:06:00Z'),fetcher:api({liveStatus:'VOD'}).fetcher,prior});assert.equal(replay.discoveries.length,1);assert.equal(replay.discoveries[0].originObservedAt,prior.originObservedAt);
 const alien=await discoverLivestreams({token:'test',now:new Date('2026-11-03T00:06:00Z'),fetcher:api({id:'444',liveStatus:'VOD'}).fetcher,prior});assert.equal(alien.discoveries.length,0);assert.equal(alien.pending.length,1);
 assert.equal((await poll(s,'2026-11-03T00:06:00Z',api({liveStatus:'VOD'}))).status,'unchanged');
 const fresh=setup();assert.equal((await poll(fresh,'2026-11-04T00:06:00Z',mock)).status,'pending-live-confirmation');assert.equal(fresh.data.has(automaticKey),false);
});

test('the real admin discovery RPC is read-only: it never kicks the scheduler or changes selected KV records',async t=>{
 const bundle=await build({entryPoints:['workers/facebook-live/video-entry.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
 const mf=new Miniflare({workers:[
  {name:'caller',modules:true,compatibilityDate:'2025-09-15',script:`export default {async fetch(r,env){return Response.json(await env.LIVE.testDiscovery())}}`,serviceBindings:{LIVE:{name:'live',entrypoint:'LiveEvents'}}},
  {name:'live',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-09-15',kvNamespaces:['CONFIG'],bindings:{FB_PAGE_ACCESS_TOKEN:'test-only'},outboundService:request=>{const url=new URL(request.url);return Response.json(url.pathname.endsWith('/published_posts')?{data:[]}:{id:graph})}},
 ],kvPersist:false});t.after(()=>mf.dispose());const kv=await mf.getKVNamespace('CONFIG','live');await kv.put(manualKey,manual);await kv.put(automaticKey,'{}');await kv.put(VERIFICATION_KEY,receipt);
 const before=await Promise.all([manualKey,automaticKey,VERIFICATION_KEY,STATE_KEY].map(k=>kv.get(k)));const result=await (await mf.dispatchFetch('https://caller.test/check')).json();
 assert.equal(result.status,'checked');assert.equal(result.selectionChanged,false);assert.deepEqual(await Promise.all([manualKey,automaticKey,VERIFICATION_KEY,STATE_KEY].map(k=>kv.get(k))),before);
});

test('scheduled checks can retain real Live evidence without publishing while policy approval is pending',async()=>{
 const s=setup();s.data.delete(VERIFICATION_KEY);assert.equal((await poll(s,'2026-11-03T00:05:00Z')).status,'verification-required');assert.equal(s.data.has(automaticKey),false);
 assert.equal(JSON.parse(s.data.get(STATE_KEY)).lastLiveObservation.originStatus,'LIVE');
 assert.equal((await poll(s,'2026-11-03T00:06:00Z',api({liveStatus:'VOD'}))).status,'verification-required');assert.equal(s.data.has(automaticKey),false);
 s.data.set(VERIFICATION_KEY,receipt);assert.equal((await poll(s,'2026-11-03T00:07:00Z',api({liveStatus:'VOD'}))).status,'staged');assert.equal(JSON.parse(s.data.get(automaticKey)).originObservedAt,'2026-11-03T00:05:00.000Z');
});

test('sanitized diagnostics remove nested pagination credentials and signed image URLs',async()=>{
 const {sanitizedDiagnostic}=await import('../workers/facebook-live/inspect.ts');const value=sanitizedDiagnostic({data:[{id:'123',attachments:{data:[{target:{id:'456'},paging:{next:'https://graph.facebook.com/next?access_token=sensitive_test_token'}}]}}],url:'https://example.com/?access_token=sensitive_test_token',image:'https://scontent.example.fbcdn.net/photo?sig=sensitive_test_token',paging:{next:'secret'},access_token:'sensitive_test_token'});
 assert.ok(!JSON.stringify(value).includes('sensitive_test_token'));assert.equal(value.url,'[redacted-url]');assert.equal(value.image,'[redacted-url]');assert.equal(value.data[0].attachments.data[0].target.id,'456');
});
