import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {GET,POST} from '../src/pages/api/admin/raffle/winners.ts';
import {GET as publicMonth} from '../src/pages/api/raffle/month.ts';
import {onRequest} from '../src/middleware.ts';

test('editing changes all fields on one ID, preserves printed tickets and rejects stale/duplicate edits',async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB'],d1Persist:false});t.after(()=>mf.dispose());
 const DB=await mf.getD1Database('DB');
 for(const file of ['001_schema.sql','migrations/00x_raffle_poster.sql','004_raffle_photo_autopublish.sql','005_winner_ticket_text.sql']) {
  const sql=(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replace(/--[^\n]*/g,'');
  for(const statement of sql.split(';').filter(s=>s.trim()))await DB.prepare(statement).run();
 }
 const ctx=body=>({locals:{runtime:{env:{DB}}},request:new Request('https://example.test/api/admin/raffle/winners',{method:'POST',body:JSON.stringify(body)})});
 const list=async month=>(await (await GET({locals:{runtime:{env:{DB}}},request:new Request('https://example.test/api/admin/raffle/winners?raffleKey='+month)})).json()).winners;
 for(const [ticketNumber,name] of [['047','Original winner'],['226','Other winner']])assert.equal((await POST(ctx({drawDate:'2026-11-04',ticketNumber,name,town:'',prize:'1st place — Original prize'}))).status,200);
 // Find by identity rather than list order.
 const selected=(await list('2026-11')).find(r=>r.name==='Original winner');
 assert.equal(selected.ticketNumberText,'047');
 const otherBefore=await DB.prepare("SELECT * FROM raffle_winners WHERE winner_name='Other winner'").first();
 const payload={action:'update',id:selected.id,expected:selected,winner:{drawDate:'2026-11-05',ticketNumber:'007',name:'Corrected winner',town:'Blair, WI',prize:'2nd place — Corrected prize'}};
 assert.equal((await POST(ctx(payload))).status,200);
 const saved=(await list('2026-11')).find(r=>r.id===selected.id);
 assert.equal(saved.name,'Corrected winner');assert.equal(saved.drawDate,'2026-11-05');assert.equal(saved.prize,'2nd place — Corrected prize');assert.equal(saved.ticketNumberText,'007');
 assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM raffle_winners').first()).n,2);
 assert.deepEqual(await DB.prepare('SELECT * FROM raffle_winners WHERE id=?').bind(otherBefore.id).first(),otherBefore);
 assert.equal((await POST(ctx(payload))).status,409);
 assert.equal((await POST(ctx({...payload,expected:saved,winner:{...payload.winner,drawDate:'2026-11-04',ticketNumber:'226'}}))).status,409);
 for(const winner of [{...payload.winner,name:''},{...payload.winner,ticketNumber:'1e2'},{...payload.winner,drawDate:'2026-02-30'}])assert.equal((await POST(ctx({...payload,expected:saved,winner}))).status,400);
 // A prize-only concurrent change also invalidates the entire edit.
 await DB.prepare('UPDATE raffle_winners SET prize=? WHERE id=?').bind('Newer prize',selected.id).run();
 assert.equal((await POST(ctx({...payload,expected:saved}))).status,409);
 const latest=(await list('2026-11')).find(r=>r.id===selected.id);
 assert.equal((await POST(ctx({...payload,expected:latest,winner:{...payload.winner,drawDate:'2026-12-01',town:''}}))).status,200);
 assert.equal((await list('2026-11')).length,1);assert.equal((await list('2026-12'))[0].id,selected.id);
 const pub=await (await publicMonth({locals:{runtime:{env:{DB}}},request:new Request('https://example.test/api/raffle/month?month=2026-12')})).json();
 assert.equal(pub.winners[0].ticketNumberText,'007');
});

test('winner editing keeps authentication and cross-origin mutation protections',async()=>{
 const url=new URL('https://example.test/api/admin/raffle/winners');
 for(const [headers,status] of [[{},403],[{Origin:'https://foreign.test'},403],[{Origin:url.origin},401]]) {
  const response=await onRequest({url,locals:{runtime:{env:{SESSION:{get:async()=>null}}}},request:new Request(url,{method:'POST',headers})},()=>{throw Error('unauthorized handler reached')});
  assert.equal(response.status,status);
 }
});
