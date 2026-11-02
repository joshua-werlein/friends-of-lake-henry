import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { POST } from '../src/pages/api/admin/raffle/winner-prize.ts';
import { GET } from '../src/pages/api/raffle/month.ts';
import { onRequest } from '../src/middleware.ts';
import { composeWinnerPrize, parseWinnerPrize } from '../src/lib/winner-prize.ts';
const cases = [
    { id:'2026-11-2026-11-01-360', ticket:360, name:'Tim Hartley', town:'La Crosse', category:'Firearm', description:'Auto-Ordnance Thompson 1927A-1, .45 ACP.' },
    { id:'2026-11-2026-11-01-894', ticket:894, name:'Troy Zigler', town:'Cashton', category:'Gift card', description:'$100 gift certificate from Safe & Secure Firearms.' },
];
test('editing existing prizes preserves every identity field and publishes descriptions without numeric placement', async t => {
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB'],d1Persist:false});t.after(()=>mf.dispose());
    const DB=await mf.getD1Database('DB');
    for (const file of ['../migrations/001_schema.sql','../migrations/migrations/00x_raffle_poster.sql']) {
        const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/--[^\n]*/g,'');
        for (const statement of sql.split(';').filter(v=>v.trim())) await DB.prepare(statement).run();
    }
    const ctx=body=>({locals:{runtime:{env:{DB}}},request:new Request('https://example.test/api/admin/raffle/winner-prize',{method:'POST',body:JSON.stringify(body)})});
    for(const row of cases) {
        await DB.prepare('INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town) VALUES(?,?,?,?,?,?)').bind(row.id,'2026-11','2026-11-01',row.ticket,row.name,row.town).run();
        const before=await DB.prepare('SELECT * FROM raffle_winners WHERE id=?').bind(row.id).first();
        const body={id:row.id,expectedPrize:null,category:row.category,description:row.description,position:null,approved:true};
        assert.equal((await POST(ctx(body))).status,200);
        const after=await DB.prepare('SELECT * FROM raffle_winners WHERE id=?').bind(row.id).first();
        assert.deepEqual(after,{...before,prize:`${row.category}: ${row.description}`});
        assert.equal(parseWinnerPrize(after.prize).position,null);
        assert.equal((await POST(ctx(body))).status,409); // stale edit cannot overwrite the saved value
    }
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_winners').first()).n,2);
    const response=await GET({locals:{runtime:{env:{DB}}},request:new Request('https://example.test/api/raffle/month?month=2026-11')});
    const data=await response.json();
    for(const row of cases) assert.equal(data.winners.find(v=>v.ticketNumber===row.ticket).prize,`${row.category}: ${row.description}`);
});
test('prize edits require approval and independent confirmation for any numeric position',()=>{
    const body={category:'Firearm',description:'Verified description',position:null,approved:true};
    assert.throws(()=>composeWinnerPrize({...body,approved:false}));
    assert.throws(()=>composeWinnerPrize({...body,position:1}));
    assert.throws(()=>composeWinnerPrize({...body,position:true,positionConfirmed:true}));
    assert.equal(composeWinnerPrize({...body,position:2,positionConfirmed:true}),'2nd place — Firearm: Verified description');
    assert.equal(parseWinnerPrize('3rd place - Legacy prize').position,3);
    assert.equal(parseWinnerPrize('Historical prize').description,'Historical prize');
});
test('middleware rejects unauthenticated and cross-origin prize edits before handler access',async()=>{
    const base={url:new URL('https://example.test/api/admin/raffle/winner-prize'),locals:{runtime:{env:{SESSION:{get:async()=>null}}}}};
    for(const [headers,status] of [[{},403],[{Origin:'https://foreign.test'},403],[{Origin:'https://example.test'},401]]) {
        const response=await onRequest({...base,request:new Request(base.url,{method:'POST',headers})},()=>{throw Error('must not run')});
        assert.equal(response.status,status);
    }
});
