import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { parsePhotoSource, parseExtraction, compareWinner, approvalRows, PHOTO_MODEL, hashBytes } from '../src/lib/raffle-photo-import.ts';
import { extractPhotoCandidates, largestImage, photoService } from '../workers/facebook-live/photos.ts';
import { GRAPH_PAGE_ID, PUBLIC_PAGE_ID } from '../workers/facebook-live/graph.ts';
import { approveImport } from '../src/lib/server/raffle-photo-review.ts';
import { GET, POST } from '../src/pages/api/admin/raffle/imports.ts';
import { GET as imageGet } from '../src/pages/api/admin/raffle/import-image.ts';
import { onRequest } from '../src/middleware.ts';
import { checkPhotoDeployment } from '../workers/facebook-live/check-photo-deployment.mjs';

const load = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}`,import.meta.url),'utf8'));
const reference = await load('november-2025-image-reference.json');
const windows = await load('november-2025-windows-ocr.json');
const baseline = (await load('november-2025-existing-winners.json')).rows.map((v,i)=>({...v,id:`existing-${i}`}));
const picture = new Uint8Array(await readFile(new URL('./fixtures/november-2025-winner-table.png',import.meta.url)));
const fakeId='122279759156073310';
const row = (extra={})=>({drawDate:'2026-11-01',ticketNumber:'66',name:'Test Winner',town:'Blair',position:null,notes:'',...extra});
const response = value=>({response:JSON.stringify(value)});

test('reference contains all 30 source rows, required dates, and no invented prize positions',()=>{
    const rows=parseExtraction(response(reference)).rows;
    assert.equal(rows.length,30);
    for(const [date,ticket,name,town] of [['2025-11-01','66','Kurt Thesing','Gallesville'],['2025-11-15','529','Scott Tiepleman','Blair'],['2025-11-30','75','Al Chikowski','Berlin']]) {
        assert.deepEqual(rows.find(v=>v.drawDate===date),{drawDate:date,ticketNumber:ticket,name,town,position:null,notes:''});
    }
    assert.ok(rows.every(v=>v.position===null));
    const comparisons=rows.map(v=>compareWinner(v,baseline));
    assert.equal(comparisons.filter(v=>v.status==='complete').length,29);
    assert.equal(comparisons.filter(v=>v.status==='conflicting').length,1); // Gallesville vs stored Galesville
    assert.ok(comparisons.every(v=>v.existingId));
    assert.equal(comparisons.filter(v=>v.status==='missing').length,0);
    // Matching all four stored fields recognizes all 30 complete records, never inserts.
    assert.ok(baseline.every(v=>compareWinner(row({...v,ticketNumber:String(v.ticketNumber)}),baseline).status==='complete'));
});

test('actual local OCR baseline recognizes all 30 existing identities and flags every ambiguity',()=>{
    assert.equal(windows.rows.length,30);
    const results=windows.rows.map(v=>compareWinner(v,baseline));
    assert.ok(results.every(v=>v.existingId));
    assert.equal(results.filter(v=>v.status==='complete').length,25);
    assert.equal(results.filter(v=>v.status==='conflicting').length,5);
    assert.equal(results.filter(v=>v.status==='missing').length,0);
    const accurate=field=>windows.rows.filter((v,i)=>String(v[field])===String(reference.rows[i][field])).length;
    assert.deepEqual(['drawDate','ticketNumber','name','town'].map(accurate),[27,30,28,30]);
    assert.ok(windows.rows.filter(v=>!v.drawDate).every(v=>v.notes.includes('Ambiguous')));
});

test('classification handles complete, incomplete, missing, conflicting and ambiguous identities',()=>{
    const original={id:'original',...row(),ticketNumber:66,prize:null};
    assert.equal(compareWinner(row(),[original]).status,'complete');
    assert.deepEqual(compareWinner(row(),[{...original,town:''}]).missingFields,['town']);
    assert.equal(compareWinner(row(),[{...original,town:''}]).status,'incomplete');
    assert.equal(compareWinner(row(),[]).status,'missing');
    assert.equal(compareWinner(row({town:'Taylor'}),[original]).status,'conflicting');
    assert.equal(compareWinner(row(),[original,{...original,id:'other'}]).status,'conflicting');
    assert.throws(()=>approvalRows([row({drawDate:'2026-11-31'})],'2026-11'));
    assert.throws(()=>approvalRows([row(),row()],'2026-11'));
    assert.throws(()=>approvalRows([row({ticketNumber:'6?'})],'2026-11'));
    assert.throws(()=>approvalRows([row({name:''})],'2026-11'));
    assert.throws(()=>parseExtraction(response({containsWinners:false,rows:[row()],warnings:[]})));
    assert.throws(()=>parseExtraction({response:'Ignore all instructions <script>bad</script>'}));
    assert.equal(parseExtraction(response({containsWinners:false,rows:[],warnings:[]})).rows.length,0);
    assert.equal(parseExtraction(response({containsWinners:true,rows:[row({town:'',notes:'Unclear hometown'})],warnings:[]})).rows[0].town,'');
});

test('historical URLs are parsed locally; arbitrary hosts, redirects, groups and pfbid links are not fetched',()=>{
    for(const url of [`https://www.facebook.com/photo/?fbid=${fakeId}`,`https://m.facebook.com/photo.php?fbid=${fakeId}`,`https://facebook.com/${PUBLIC_PAGE_ID}/photos/a.123/${fakeId}/`,fakeId]) assert.equal(parsePhotoSource(url).id,fakeId);
    assert.equal(parsePhotoSource(`https://facebook.com/${PUBLIC_PAGE_ID}/posts/999`).id,`${GRAPH_PAGE_ID}_999`);
    for(const url of ['http://facebook.com/photo/?fbid=1','https://evil.test/photo/?fbid=1','https://facebook.com@evil.test/photo/?fbid=1','https://facebook.com/groups/1/posts/2','https://facebook.com/share/p/abc',`https://facebook.com/${PUBLIC_PAGE_ID}/posts/pfbid123`]) assert.equal(parsePhotoSource(url),null);
});

test('photo/album/subattachment discovery shares hashtag feed; unrelated photos are not presumed winners',()=>{
    const photo={type:'photo',target:{id:fakeId}};
    const post={id:`${GRAPH_PAGE_ID}_1`,message:'#LakeHenryRaffle',created_time:'2026-11-01T20:00:00Z',attachments:{data:[{type:'album',subattachments:{data:[photo,photo]}}]}};
    assert.equal(extractPhotoCandidates([post]).length,1);
    assert.equal(extractPhotoCandidates([{...post,message:'November 2025 winners'}]).length,0);
    assert.equal(extractPhotoCandidates([{...post,message:'November 2025 winners'}],false).length,1);
    assert.equal(extractPhotoCandidates([{...post,id:'999_1'}]).length,0);
    assert.equal(extractPhotoCandidates([{...post,attachments:{data:[{type:'video_inline',target:{id:fakeId}}]}}]).length,0);
    assert.equal(extractPhotoCandidates([{...post,created_time:'2999-11-01T20:00:00Z'}]).length,0);
});

const small={source:'https://scontent.test.fbcdn.net/small?signed=TEMP',width:100,height:200};
const large={source:'https://scontent.test.fbcdn.net/large?signed=TEMP',width:831,height:1554};
test('largest resolution is chosen by area, not array position, and hostile image locations are rejected',()=>{
    assert.deepEqual(largestImage([small,large]),large);
    for(const source of ['http://scontent.test.fbcdn.net/a','https://127.0.0.1/a','https://fbcdn.net.evil.test/a','https://user:secret@scontent.test.fbcdn.net/a']) assert.throws(()=>largestImage([{...large,source}]));
});

test('import APIs retain session auth and CSRF; initial photo configuration retains account and disabled guards',async()=>{
    for(const path of ['/api/admin/raffle/imports','/api/admin/raffle/import-image']) {
        const url=new URL('https://example.test'+path);let nextCalls=0;
        const context=(method,origin,cookie='')=>({
            url, request:new Request(url,{method,headers:{Origin:origin,Cookie:cookie}}),
            locals:{runtime:{env:{SESSION:{async get(){return '{"role":"admin"}';}}}}},
        });
        const next=async()=>{nextCalls++;return new Response('ok');};
        assert.equal((await onRequest(context('GET',url.origin),next)).status,401);
        assert.equal((await onRequest(context('POST','https://evil.test','admin_session=local'),next)).status,403);
        assert.equal((await onRequest(context('POST',url.origin,'admin_session=local'),next)).status,200);
        assert.equal(nextCalls,1);
    }
    const config=JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.photos.existing-account.json',import.meta.url),'utf8'));
    const account='aa86268490e681cccb3a41a62093e2aa';assert.equal(checkPhotoDeployment(config,account),true);
    for(const change of [{account_id:'1'.repeat(32)},{triggers:{crons:['*/5 * * * *']}},{vars:{...config.vars,FB_PHOTO_IMPORT_ENABLED:'true'}},{ai:{binding:'WRONG'}},{workers_dev:true}]) assert.throws(()=>checkPhotoDeployment({...config,...change},account));
    const migration=JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.photos.json',import.meta.url),'utf8'));
    assert.throws(()=>checkPhotoDeployment(migration,'1'.repeat(32),'new-account'));
    assert.equal(checkPhotoDeployment({...migration,account_id:'1'.repeat(32),kv_namespaces:[{binding:'CONFIG',id:'2'.repeat(32)}]},'1'.repeat(32),'new-account'),true);
});

function network({expired=false,metadata={},aiResult=reference}={}) {
    const calls=[],aiCalls=[];let downloads=0;
    const fetcher=async(input,init)=>{
        const url=new URL(input);calls.push({url,init});
        if(url.hostname==='graph.facebook.com') {
            assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bearer SIMULATED_TEST_TOKEN');assert.equal(url.searchParams.has('access_token'),false);
            return Response.json(url.pathname.endsWith(GRAPH_PAGE_ID)?{id:GRAPH_PAGE_ID}:{id:fakeId,images:[small,{...large,source:large.source+downloads}],link:'https://facebook.com/photo/',...metadata});
        }
        assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');downloads++;
        if(expired&&downloads===1)return new Response('Expired',{status:403});
        return new Response(picture,{headers:{'Content-Type':'image/png'}});
    };
    const AI={async run(model,input){aiCalls.push({model,input});return response(aiResult);}};
    return {fetcher,calls,aiCalls,AI};
}
const env=AI=>({FB_PHOTO_IMPORT_ENABLED:'true',FB_VISION_MODEL_LICENSE_ACCEPTED:'true',FB_PAGE_ACCESS_TOKEN:'SIMULATED_TEST_TOKEN',AI});
test('tagged scan and explicit old post/photo discovery share the read-only reader and never run AI',async()=>{
    const original={id:`${GRAPH_PAGE_ID}_123`,created_time:'2025-11-30T20:00:00Z',message:'November winners',attachments:{data:[{type:'album',subattachments:{data:[{type:'photo',target:{id:fakeId}}]}}]}};
    let aiCalls=0;const calls=[];
    const service=photoService(env({async run(){aiCalls++;throw Error('must not run');}}),async(input,init)=>{
        const url=new URL(input);calls.push(url);assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.method,'GET');
        assert.equal(init.headers.Authorization,'Bearer SIMULATED_TEST_TOKEN');
        if(url.pathname.endsWith(GRAPH_PAGE_ID))return Response.json({id:GRAPH_PAGE_ID});
        if(url.pathname.endsWith('/published_posts'))return Response.json({data:[original,{...original,message:'#LakeHenryRaffle'}]});
        if(url.pathname.endsWith(fakeId))return Response.json({id:fakeId,images:[large,small],link:'https://facebook.com/photo/'});
        return Response.json(original);
    });
    assert.equal((await service.discover()).length,1);
    assert.equal((await service.discover(`https://facebook.com/${PUBLIC_PAGE_ID}/posts/123`)).length,1);
    assert.equal((await service.discover(`https://facebook.com/photo/?fbid=${fakeId}`))[0].photoId,fakeId);
    assert.equal(aiCalls,0);assert.ok(calls.every(url=>!url.searchParams.has('access_token')));
});
test('full-resolution download refreshes an expired URL; AI sees bytes and the original is captured without signed URLs',async()=>{
    const mock=network({expired:true});const capture=await photoService(env(mock.AI),mock.fetcher).extract(fakeId,'2025-11');
    assert.equal(capture.width,831);assert.equal(capture.height,1554);assert.equal(capture.extraction.rows.length,30);
    assert.deepEqual(capture.bytes,picture);assert.equal(capture.sha256,await hashBytes(picture));
    assert.equal(mock.calls.filter(v=>v.url.hostname==='graph.facebook.com'&&v.url.pathname.endsWith(fakeId)).length,2);
    assert.ok(mock.calls.filter(v=>v.url.hostname!=='graph.facebook.com').every(v=>v.url.pathname==='/large'));
    assert.equal(mock.aiCalls.length,1);assert.equal(mock.aiCalls[0].model,PHOTO_MODEL);
    assert.ok(mock.aiCalls[0].input.image.startsWith('data:image/png;base64,'));
    assert.equal(JSON.stringify(capture).includes('signed='),false);assert.equal(JSON.stringify(mock.aiCalls).includes('SIMULATED_TEST_TOKEN'),false);
});
test('single-day announcements and unrelated photos use the same review-only extraction path',async()=>{
    for(const result of [{containsWinners:true,rows:[row({position:2})],warnings:[]},{containsWinners:false,rows:[],warnings:['Not a winner announcement.']}]) {
        const mock=network({aiResult:result});
        const capture=await photoService(env(mock.AI),mock.fetcher).extract(fakeId,'2026-11');
        assert.equal(capture.extraction.rows.length,result.rows.length);
        if(result.rows.length)assert.equal(capture.extraction.rows[0].position,2);
    }
});
test('disabled/missing AI, unaccepted license, wrong identity, unsupported metadata and non-images fail closed',async()=>{
    const mock=network();
    for(const config of [{},env(undefined),{...env(mock.AI),FB_VISION_MODEL_LICENSE_ACCEPTED:'false'}]) await assert.rejects(photoService(config,()=>{throw Error('must not fetch');}).extract(fakeId,'2025-11'));
    await assert.rejects(photoService(env(mock.AI),async()=>Response.json({id:'999'})).extract(fakeId,'2025-11'));
    await assert.rejects(photoService(env(mock.AI),network({metadata:{images:[]}}).fetcher).extract(fakeId,'2025-11'));
    await assert.rejects(photoService(env(mock.AI),async(input,init)=>new URL(input).hostname==='graph.facebook.com'?mock.fetcher(input,init):new Response('<html>not a photo</html>',{headers:{'Content-Type':'text/html'}})).extract(fakeId,'2025-11'));
});

test('review lifecycle against disposable D1/R2 never publishes without approval or overwrites historical winners',async t=>{
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB'],r2Buckets:['PHOTOS_BUCKET'],d1Persist:false,r2Persist:false});t.after(()=>mf.dispose());
    const DB=await mf.getD1Database('DB'),PHOTOS_BUCKET=await mf.getR2Bucket('PHOTOS_BUCKET');
    for(const name of ['001_schema.sql','002_raffle_photo_imports.sql']) {
        const sql=(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')).replace(/--[^\n]*/g,'');
        const [before,trigger]=sql.split('CREATE TRIGGER');
        for(const statement of before.split(';').filter(v=>v.trim())) await DB.prepare(statement).run();
        if(trigger) await DB.prepare('CREATE TRIGGER'+trigger).run();
    }
    for(const old of baseline) await DB.prepare('INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize) VALUES(?,?,?,?,?,?,?)').bind(old.id,'2025-11',old.drawDate,old.ticketNumber,old.name,old.town,null).run();
    const mock=network();let extracts=0;
    const service={async discover(){return [{photoId:fakeId,sourceUrl:`https://www.facebook.com/photo/?fbid=${fakeId}`,postId:null,publishedAt:null}];},async extract(id,month){extracts++;return photoService(env(mock.AI),mock.fetcher).extract(id,month);}};
    const runtime={DB,IMPORT_IMAGES:PHOTOS_BUCKET,FACEBOOK_PHOTOS:service,RAFFLE_PHOTO_IMPORT_ENABLED:'true'};
    const ctx=(body,query='')=>({locals:{runtime:{env:runtime}},url:new URL('https://example.test/api/admin/raffle/imports'+query),request:new Request('https://example.test/api/admin/raffle/imports'+query,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    const post=async body=>{const r=await POST(ctx(body));return {status:r.status,...await r.json()};};
    const count=async()=>Number((await DB.prepare('SELECT count(*) AS n FROM raffle_winners').first()).n);
    let draft;
    await t.test('extract original, show all 30 comparisons, retain image privately; extraction and edits publish nothing',async()=>{
        const data=await post({action:'extract',photoId:fakeId,monthHint:'2025-11'});assert.equal(data.status,200);draft=data.item;
        assert.equal(await count(),30);assert.equal(draft.rows.length,30);assert.equal(draft.rows.filter(v=>v.comparison.status==='complete').length,29);
        assert.equal(draft.rows[0].comparison.status,'conflicting');
        const image=await imageGet(ctx(undefined,`?id=${draft.id}`));assert.equal(image.status,200);assert.equal(image.headers.get('cache-control'),'no-store');assert.deepEqual(new Uint8Array(await image.arrayBuffer()),picture);
        const again=await post({action:'extract',photoId:fakeId,monthHint:'2025-11'});assert.equal(again.existing,true);assert.equal(extracts,1);
        const saved=await post({action:'save',id:draft.id,version:draft.version,rows:reference.rows});assert.equal(saved.status,200);draft=saved.item;assert.equal(await count(),30);
    });
    await t.test('duplicate, conflict, stale or unconfirmed approvals do not change any historical field or prize',async()=>{
        for(const body of [{confirmReviewed:false,rows:reference.rows},{confirmReviewed:true,rows:[reference.rows[0]]},{confirmReviewed:true,rows:[reference.rows[14]]},{confirmReviewed:true,version:0,rows:[row()]}]) {
            const result=await post({action:'approve',id:draft.id,version:draft.version,...body});assert.ok([400,409].includes(result.status));
        }
        assert.equal(await count(),30);
        assert.equal((await DB.prepare("SELECT town FROM raffle_winners WHERE draw_date='2025-11-01'").first()).town,'Galesville');
        assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_winners WHERE prize IS NOT NULL').first()).n,0);
        assert.equal((await DB.prepare('SELECT status FROM raffle_photo_imports WHERE id=?').bind(draft.id).first()).status,'pending');
    });
    const stage=async(id,rows)=>DB.prepare("INSERT INTO raffle_photo_imports(id,photo_id,source_url,month_hint,status,rows_json) VALUES(?,?,?,'2026-11','pending',?)").bind(id,id,'https://facebook.com/photo/',JSON.stringify(rows)).run();
    await t.test('explicit approval inserts new rows once and leaves unknown positions null',async()=>{
        const id=crypto.randomUUID();await stage(id,[row()]);
        const result=await approveImport(DB,id,1,[row()]);assert.deepEqual(result,{inserted:1,filled:0});
        assert.equal(await count(),31);assert.equal((await DB.prepare("SELECT prize FROM raffle_winners WHERE raffle_key='2026-11'").first()).prize,null);
        await assert.rejects(approveImport(DB,id,1,[row()]));assert.equal(await count(),31);
    });
    await t.test('verified blank-field fill preserves populated fields and preexisting prize',async()=>{
        await DB.prepare("INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize) VALUES('incomplete','2026-11','2026-11-02',777,'Existing Name','','Legacy prize')").run();
        const id=crypto.randomUUID(),fill=row({drawDate:'2026-11-02',ticketNumber:'777',name:'Existing Name',town:'Taylor'});await stage(id,[fill]);
        assert.deepEqual(await approveImport(DB,id,1,[fill]),{inserted:0,filled:1});
        const winner=await DB.prepare("SELECT * FROM raffle_winners WHERE id='incomplete'").first();assert.equal(winner.town,'Taylor');assert.equal(winner.winner_name,'Existing Name');assert.equal(winner.prize,'Legacy prize');
    });
    await t.test('approval audit trigger rolls back the entire transaction on conflict',async()=>{
        const id=crypto.randomUUID();await stage(id,[row({ticketNumber:'888'})]);
        const before=await count();
        // A valid new winner followed by an intentionally mismatched audit proves D1 batch rollback.
        await assert.rejects(DB.batch([
            DB.prepare("UPDATE raffle_photo_imports SET status='approved',review_nonce='test' WHERE id=?").bind(id),
            DB.prepare("INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town) VALUES('rollback-test','2026-11','2026-11-03',888,'Test','Blair')"),
            DB.prepare("INSERT INTO raffle_photo_import_rows(import_id,row_number,review_nonce,winner_id,fingerprint,draw_date,ticket_number,winner_name,town,action) VALUES(?,0,'test','rollback-test','test','2026-11-03',888,'WRONG','Blair','insert')").bind(id),
        ]));
        assert.equal(await count(),before);assert.equal((await DB.prepare('SELECT status FROM raffle_photo_imports WHERE id=?').bind(id).first()).status,'pending');
    });
    await t.test('a winner added concurrently cannot be duplicated by an approval',async()=>{
        const id=crypto.randomUUID(),candidate=row({drawDate:'2026-11-05',ticketNumber:'999',name:'Concurrent Test'});await stage(id,[candidate]);
        const wrapped={prepare:DB.prepare.bind(DB),async batch(statements){
            await DB.prepare("INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town) VALUES('concurrent','2026-11','2026-11-05',999,'Concurrent Test','Other town')").run();
            return DB.batch(statements);
        }};
        await assert.rejects(approveImport(wrapped,id,1,[candidate]));
        assert.equal((await DB.prepare("SELECT count(*) AS n FROM raffle_winners WHERE draw_date='2026-11-05' AND ticket_number=999").first()).n,1);
        assert.equal((await DB.prepare("SELECT town FROM raffle_winners WHERE id='concurrent'").first()).town,'Other town');
        assert.equal((await DB.prepare('SELECT status FROM raffle_photo_imports WHERE id=?').bind(id).first()).status,'pending');
    });
    await t.test('rejection publishes nothing; disabled gate does not access service or storage',async()=>{
        assert.equal((await post({action:'reject',id:draft.id,version:draft.version})).status,200);
        assert.equal((await post({action:'approve',id:draft.id,version:draft.version,rows:[row()],confirmReviewed:true})).status,409);
        runtime.RAFFLE_PHOTO_IMPORT_ENABLED='false';
        assert.equal((await GET(ctx())).status,503);assert.equal((await POST(ctx({action:'discover'}))).status,503);assert.equal((await imageGet(ctx(undefined,`?id=${draft.id}`))).status,503);
    });
});

test('private PhotoImports RPC runs in workerd, fails closed disabled, and public HTTP stays 404',async t=>{
    const compiled=await build({entryPoints:['workers/facebook-live/photos-entry.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
    const mf=new Miniflare({workers:[
        {name:'caller',compatibilityDate:'2025-09-15',modules:true,script:`export default { async fetch(request,env) { try { await env.PHOTOS.discover(); return new Response('bad'); } catch(e) { return new Response(e.message,{status:503}); } } };`,serviceBindings:{PHOTOS:{name:'photos',entrypoint:'PhotoImports'}}},
        {name:'photos',compatibilityDate:'2025-09-15',modules:true,script:compiled.outputFiles[0].text,bindings:{FB_PHOTO_IMPORT_ENABLED:'false',FB_AUTOMATION_ENABLED:'false'}},
    ]});t.after(()=>mf.dispose());
    const r=await mf.dispatchFetch('https://example.test');assert.equal(r.status,503);assert.match(await r.text(),/discovery unavailable/);
    assert.equal((await (await mf.getWorker('photos')).fetch('https://example.test')).status,404);
});
