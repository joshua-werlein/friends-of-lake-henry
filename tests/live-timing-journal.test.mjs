import test from 'node:test';
import assert from 'node:assert/strict';
import { TimingJournal, TIMING_LIMIT, timingEntry } from '../workers/facebook-live/timing.ts';
import { DiscoveryCoordinator } from '../workers/facebook-live/coordinator.ts';
import { GET } from '../src/pages/api/admin/raffle/live.ts';
import { onRequest } from '../src/middleware.ts';
import { discoverLivestreams } from '../workers/facebook-live/livestream.ts';
import { GRAPH_PAGE_ID, PUBLIC_PAGE_ID } from '../workers/facebook-live/graph.ts';
import { GET as publicLive } from '../src/pages/api/raffle/live.ts';
import { FACEBOOK_API_VERSION, FACEBOOK_LIVE_CONTRACT } from '../src/lib/facebook.ts';
const at=Date.parse('2026-11-08T00:00:00Z'), day='2026-11-07';
function storage(){const values=new Map();return {values,async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async getAlarm(){return null;},async setAlarm(){}};}

test('journal bounds concurrent writes, keeps first markers, rejects off-season and strips sensitive fields',async()=>{
 const s=storage(),j=new TimingJournal(s);
 await Promise.all(Array.from({length:TIMING_LIMIT+9},(_,i)=>j.append({stage:'check-result',at:at+i,status:'no-eligible-video',token:'secret',url:'https://secret',body:'private'})));
 const result=await j.read(day);assert.equal(result.entries.length,TIMING_LIMIT);assert.equal(result.dropped,9);
 assert.equal(result.first['check-result'].at,at);assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private'));
 assert.equal(timingEntry({stage:'check-result',at:Date.parse('2026-12-02T00:00:00Z')}),null);
 assert.equal(await j.read('2026-11-31'),null);
});
test('journal failures are best effort; public observations deduplicate',async()=>{
 const j=new TimingJournal({async get(){throw Error('offline');},async put(){throw Error('offline');}});
 await j.append({stage:'check-start',at});
 const s=storage(),good=new TimingJournal(s),entry={stage:'public-visible',at,videoId:'123',observedAt:'2026-11-08T00:00:00.000Z'};
 await Promise.all([good.append(entry),good.append(entry)]);assert.equal((await good.read(day)).entries.length,1);
});
test('coordinator stores starts and completion/results for empty, pending, failed and successful checks without KV diagnostics',async()=>{
 for(const status of ['no-eligible-video','pending-live-confirmation','api-failure','staged','not-due']){
  const s=storage();let clock=at;const kv=[];
  const c=new DiscoveryCoordinator(s,{FB_AUTOMATION_ENABLED:'true',CONFIG:{async get(){return null;},async put(k){kv.push(k);}}},()=>clock,
   async(env,options)=>{clock+=5;await options.fetcher('https://graph.facebook.com/v24.0/123?fields=id');clock+=7;await env.CONFIG.put('raffle_live_automatic','{}');clock+=3;await env.CONFIG.put('raffle_live_automation_state','{}');
    return {status,monitor:{failures:status==='api-failure'?1:0,paused:false,pending:status==='pending-live-confirmation'?1:0,verified:status==='staged'?1:0,selected:status==='staged',liveVideoId:status==='staged'?'123':undefined}};},
   async()=>{clock+=11;return Response.json({id:'123'});});
  await c.alarm();const timeline=await c.timeline(day),entries=timeline.diagnostics.entries;
  assert.deepEqual(entries.map(e=>e.stage),['check-start','check-result']);const last=entries.at(-1);
  assert.equal(last.status,status);assert.equal(last.alarmAt,at);assert.ok(last.completedAt>last.alarmAt);
  assert.ok(last.selectionCompletedAt>at);assert.ok(last.stateCompletedAt>=last.selectionCompletedAt);
  assert.equal(last.graph[0].phase,'identity');assert.equal(last.graph[0].httpStatus,200);
  assert.deepEqual(kv,['raffle_live_automatic','raffle_live_automation_state']);
 }
});
test('timeline retrieval validates date, uses service binding only and stays behind admin middleware',async()=>{
 const url='https://test/api/admin/raffle/live?timeline='+day;
 let calls=0;const context={request:new Request(url),url:new URL(url),locals:{runtime:{env:{FACEBOOK_LIVE:{async timeline(d){calls++;assert.equal(d,day);return {timeline:{day,diagnostics:null}};}}}}}};
 const denied=await onRequest(context,()=>GET(context));assert.equal(denied.status,401);assert.equal(calls,0);
 context.request=new Request(url,{headers:{cookie:'admin_session=test-only'}});
 context.locals.runtime.env.SESSION={async get(){return JSON.stringify({role:'admin'});}};
 const result=await onRequest(context,()=>GET(context));assert.equal(result.status,200);assert.equal((await result.json()).timeline.day,day);assert.equal(calls,1);
 const invalid={...context,request:new Request('https://test/api/admin/raffle/live?timeline=2026-11-31')};assert.equal((await GET(invalid)).status,400);assert.equal(calls,1);
});
test('actual Graph verification reports pending, rejected metadata and verified origin without raw content',async()=>{
 for(const [live_status,embeddable]of [['LIVE',true],['VOD',true],['LIVE',false]]){
  const result=await discoverLivestreams({token:'test-only',now:new Date(at),fetcher:async input=>{
   const u=new URL(input),path=u.pathname.split('/').at(-1);
   if(path===GRAPH_PAGE_ID)return Response.json({id:GRAPH_PAGE_ID});
   if(path==='published_posts')return Response.json({data:[{id:GRAPH_PAGE_ID+'_321',created_time:new Date(at-1000).toISOString(),attachments:{data:[{type:'video',target:{id:'123',url:`https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/123/`}}]}}]});
   return Response.json({id:'123',from:{id:GRAPH_PAGE_ID},published:true,embeddable,live_status,token:'do-not-save'});
  }});
  assert.equal(result.ok,true);assert.equal(result.checks.length,1);
  assert.equal(result.checks[0].originVerified,live_status==='LIVE'&&embeddable);
  assert.equal(result.pending.length,live_status==='VOD'?1:0);
  assert.ok(!JSON.stringify(result.checks).includes('do-not-save'));
 }
});
test('public API captures first successful automatic resolution asynchronously with no additional KV writes',async()=>{
 const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
 try{
  const observedAt=new Date(at-1000).toISOString(),url=`https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/777/`;
  const stage={schemaVersion:2,graphPageId:GRAPH_PAGE_ID,publicPageId:PUBLIC_PAGE_ID,apiVersion:FACEBOOK_API_VERSION,contract:FACEBOOK_LIVE_CONTRACT,
   id:'777',videoId:'777',postId:GRAPH_PAGE_ID+'_888',url,publishedAt:observedAt,observedAt,origin:'page-video-live-status',originStatus:'LIVE',originObservedAt:observedAt,drawingDate:day,status:'video',liveStatus:'LIVE'};
  const receipt={schemaVersion:5,graphPageId:GRAPH_PAGE_ID,publicPageId:PUBLIC_PAGE_ID,apiVersion:FACEBOOK_API_VERSION,contract:FACEBOOK_LIVE_CONTRACT,
   evidence:'page-video-live-origin-policy-reviewed',publicPlaybackVerified:true,rollbackTested:true,verifiedVideoId:'777',verifiedAt:'2026-11-01T23:00:00Z',expiresAt:'2026-12-01T06:00:00Z'};
  const values=new Map(Object.entries({raffle_live:{latestVideoUrl:null,automaticEnabled:true},raffle_live_automatic:stage,
   raffle_live_automation_state:{version:1,lastVerifiedVideoId:'777',lastVerifiedAt:observedAt,lastLiveObservation:{...stage,id:undefined,source:'format'}},raffle_live_verification:receipt}).map(([k,v])=>[k,JSON.stringify(v)]));
  const calls=[],jobs=[];const context={locals:{runtime:{env:{CONFIG:{async get(k){return values.get(k)??null;},async put(){throw Error('No KV diagnostic writes');}},RAFFLE_AUTOMATIC_SELECTION_ENABLED:'true',FACEBOOK_LIVE:{async recordDiagnostic(v){calls.push(v);}}},ctx:{waitUntil(p){jobs.push(p);}}}}};
  for(let i=0;i<2;i++){const r=await publicLive(context);assert.equal(r.status,200);assert.equal((await r.json()).source,'automatic');}
  await Promise.all(jobs);assert.equal(calls.length,1);assert.deepEqual(calls[0],{stage:'public-visible',at,videoId:'777',observedAt,reason:'kv'});
 }finally{globalThis.Date=RealDate;}
});
