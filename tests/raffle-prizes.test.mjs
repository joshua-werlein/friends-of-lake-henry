import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { prizeSchedule,saveSupplement,reviewSupplement,suggestPrizes,approveDrafts } from '../src/lib/server/raffle-prizes.ts';
import { readPosterPrizes } from '../src/lib/server/raffle-poster-prizes.ts';
import { POST } from '../src/pages/api/admin/raffle/prizes.ts';
import { GET } from '../src/pages/api/raffle/prizes.ts';
const fixture=JSON.parse(await readFile(new URL('./fixtures/november-2026-published-raffle-events.json',import.meta.url)));
async function setup(t) {
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB'],r2Buckets:['PHOTOS_BUCKET'],d1Persist:false,r2Persist:false});t.after(()=>mf.dispose());
    const DB=await mf.getD1Database('DB'),PHOTOS_BUCKET=await mf.getR2Bucket('PHOTOS_BUCKET');
    for(const name of ['001_schema.sql','migrations/00x_raffle_poster.sql','003_raffle_prize_supplements.sql']) {
        const sql=(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).replace(/--[^\n]*/g,'');
        for(const statement of sql.split(';').filter(v=>v.trim()))await DB.prepare(statement).run();
    }
    for(const e of fixture.events)await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id,e.title,e.kind,e.status,e.date_start,e.summary).run();
    const env={DB,PHOTOS_BUCKET,RAFFLE_PRIZE_CALENDAR_ENABLED:'true'};
    const ctx=body=>({locals:{runtime:{env}},url:new URL('https://example.test/api/raffle/prizes?month=2026-11'),request:new Request('https://example.test/api/admin/raffle/prizes',{method:'POST',body:JSON.stringify(body)})});
    return {DB,PHOTOS_BUCKET,env,ctx};
}
test('30 real published event prizes match Central drawing dates; no event copying or prize placements',async t=>{
    const {DB}=await setup(t),rows=await prizeSchedule(DB,'2026-11');
    const main=rows.filter(v=>v.category==='Main prize'),bonus=rows.filter(v=>v.category==='Bonus drawing');
    assert.equal(main.length,30);assert.equal(main[0].drawDate,'2026-11-01');assert.equal(main.at(-1).drawDate,'2026-11-30');
    assert.equal(new Set(main.map(v=>v.drawDate)).size,30); // one main prize per Central drawing date
    assert.ok(rows.every(v=>['event','daily'].includes(v.source)&&v.position===null)); // daily = poster's $100 Safe & Secure certificate
    // Bonus drawings come from published summaries, read-only, never from supplements.
    assert.equal(bonus.length,13);
    assert.deepEqual(bonus.find(v=>v.drawDate==='2026-11-26'),{...bonus.find(v=>v.drawDate==='2026-11-26'),description:'Gun Safe',eventId:main.find(v=>v.drawDate==='2026-11-26').eventId});
    assert.equal(rows.find(v=>v.drawDate==='2026-11-15'&&v.category==='Bonus drawing').description,'Black Stone 28" Griddle'); // id says 11-05; date_start wins
    assert.match(rows[0].description,/Thompson/);
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_prize_supplements').first()).n,0);
    await DB.prepare("INSERT INTO events(id,title,kind,status,date_start) VALUES('future','Future November prize','Raffle','published','2027-12-01T00:00:00Z')").run();
    assert.equal((await prizeSchedule(DB,'2027-11'))[0].drawDate,'2027-11-30');
});
test('supplements remain private until approved, deduplicate and never alter events/winners',async t=>{
    const {DB,ctx}=await setup(t),before=(await DB.prepare('SELECT * FROM events ORDER BY id').all()).results;
    const value={drawDate:'2026-11-01',category:'Gift card',position:null,description:'Verified supplemental gift certificate',notes:''};
    const saved=await saveSupplement(DB,'2026-11',value);
    const base=(await prizeSchedule(DB,'2026-11')).length;assert.equal(base,73); // 30 main + 13 bonus + 30 daily poster prizes; drafts stay private
    assert.equal((await saveSupplement(DB,'2026-11',value)).duplicate,true);
    assert.equal((await saveSupplement(DB,'2026-11',{...value,category:'Other',description:'gun safe'})).duplicate,false); // different date
    assert.equal((await saveSupplement(DB,'2026-11',{...value,drawDate:'2026-11-26',category:'Other',description:' GUN SAFE '})).duplicate,true); // already a published bonus
    assert.equal((await POST(ctx({action:'approve',month:'2026-11',id:saved.id,version:1,row:value,approved:false}))).status,400);
    await reviewSupplement(DB,saved.id,1,'approve',value,false);
    const approved=await prizeSchedule(DB,'2026-11');assert.equal(approved.length,base+1);
    const suggestion=suggestPrizes(approved,'2026-11-01');assert.equal(suggestion.status,'selection-required');assert.equal(suggestion.position,null);assert.equal(suggestion.requiresApproval,true);
    await assert.rejects(reviewSupplement(DB,saved.id,1,'correct',{...value,description:'Stale overwrite'},false));
    await assert.rejects(reviewSupplement(DB,saved.id,2,'correct',{...value,position:1},false));
    await reviewSupplement(DB,saved.id,2,'correct',{...value,description:'Reviewed corrected certificate'},false);
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_prize_review_log').first()).n,4); // 2 drafts + approve + correct
    await reviewSupplement(DB,saved.id,3,'reject',value,false);
    assert.equal((await prizeSchedule(DB,'2026-11')).length,base);
    assert.deepEqual((await DB.prepare('SELECT * FROM events ORDER BY id').all()).results,before); // rows only; meta.last_row_id is connection state
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_winners').first()).n,0);
});
test('existing R2 poster extraction excludes event main prizes, forces unknown placement and never writes',async t=>{
    const {DB,PHOTOS_BUCKET,ctx}=await setup(t),key='raffle/2026-11/existing-poster.png';
    await PHOTOS_BUCKET.put(key,new Uint8Array([137,80,78,71,13,10,26,10]));
    await DB.prepare('INSERT INTO raffle_months(month_key,title,poster_key) VALUES(?,?,?)').bind('2026-11','Existing poster',key).run();
    const main=(await prizeSchedule(DB,'2026-11'))[0];let prompt;
    const AI={run:async(_model,input)=>{prompt=JSON.stringify(input);return {response:JSON.stringify({rows:[
        {drawDate:'2026-11-01',category:'Firearm',description:main.description,position:1},
        {drawDate:'2026-11-01',category:'Gift card',description:'Visible certificate',position:2},
        {drawDate:'',category:'Other',description:'Uncertain bonus',notes:'Date needs review'},
    ],warnings:['Review all extracted information.']})};}};
    const result=await readPosterPrizes(DB,PHOTOS_BUCKET,AI,'2026-11');
    assert.equal(result.proposals.length,2);assert.ok(result.proposals.every(v=>v.position===null&&v.needsReview));assert.equal(result.proposals[1].dateValid,false);
    assert.match(prompt,/Do NOT duplicate/);assert.match(prompt,/data:image\/png;base64/);
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_prize_supplements').first()).n,0);
    assert.equal((await POST(ctx({action:'extractPoster',month:'2026-11'}))).status,409);
});
test('calendar deployment gate avoids all D1 reads until explicitly enabled',async()=>{
    const res=await GET({locals:{runtime:{env:{DB:{prepare(){throw Error('must not query')}}}}},url:new URL('https://example.test/api/raffle/prizes?month=2026-11')});
    assert.deepEqual(await res.json(),{ok:true,enabled:false,prizes:[]});
});
test('bulk approval publishes only reviewed, unchanged, placement-free drafts; descriptions lose trailing periods',async t=>{
    const {DB,ctx}=await setup(t);
    const dates=['2026-11-02','2026-11-03','2026-11-04'];
    const ids=[];for(const drawDate of dates) ids.push((await saveSupplement(DB,'2026-11',{drawDate,category:'Gift card',position:null,description:'$100 gift certificate.',notes:''})).id);
    const stored=await DB.prepare('SELECT description FROM raffle_prize_supplements').all();
    assert.ok(stored.results.every(r=>r.description==='$100 gift certificate'));
    const base=(await prizeSchedule(DB,'2026-11')).length;
    const items=ids.map(id=>({id,version:1}));
    assert.equal((await POST(ctx({action:'approveDrafts',month:'2026-11',items}))).status,400); // explicit approval required
    await assert.rejects(approveDrafts(DB,'2026-11',[{id:ids[0],version:7}])); // stale version
    await assert.rejects(approveDrafts(DB,'2026-12',items)); // wrong month
    const res=await POST(ctx({action:'approveDrafts',month:'2026-11',items,approved:true}));
    assert.equal(res.status,200);assert.equal((await res.json()).approved,3);
    assert.equal((await prizeSchedule(DB,'2026-11')).length,base+3);
    assert.equal((await POST(ctx({action:'approveDrafts',month:'2026-11',items,approved:true}))).status,409); // already approved
    const positioned=await saveSupplement(DB,'2026-11',{drawDate:'2026-11-05',category:'Other',position:3,description:'Positioned prize',notes:''});
    await assert.rejects(approveDrafts(DB,'2026-11',[{id:positioned.id,version:1}])); // numeric place needs individual confirmation
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM raffle_prize_supplements WHERE status='approved'").first()).n,3);
});
test('prize review endpoints require an admin session and same-origin requests',async()=>{
    const { onRequest }=await import('../src/middleware.ts');
    for(const path of ['/api/admin/raffle/prizes','/api/admin/raffle/prizes?month=2026-11']) {
        const url=new URL('https://example.test'+path),locals={runtime:{env:{SESSION:{get:async()=>null}}}};
        for(const [method,headers,status] of [['POST',{},403],['POST',{Origin:'https://foreign.test'},403],['POST',{Origin:'https://example.test'},401],['GET',{},401]]) {
            const response=await onRequest({url,locals,request:new Request(url,{method,headers,body:method==='POST'?'{}':undefined})},()=>{throw Error('must not run')});
            assert.equal(response.status,status,`${method} ${path}`);
        }
    }
});
