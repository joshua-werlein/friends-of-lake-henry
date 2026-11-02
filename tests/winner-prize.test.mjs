import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { POST } from '../src/pages/api/admin/raffle/winner-prize.ts';
import { GET } from '../src/pages/api/raffle/month.ts';
import { onRequest } from '../src/middleware.ts';
import { cleanPrizeDescription, composeWinnerPrize, parseWinnerPrize, prizeCells } from '../src/lib/winner-prize.ts';
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
        assert.deepEqual(after,{...before,prize:`${row.category}: ${row.description.slice(0,-1)}`}); // trailing period normalized
        assert.equal(parseWinnerPrize(after.prize).position,null);
        assert.equal((await POST(ctx(body))).status,409); // stale edit cannot overwrite the saved value
    }
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_winners').first()).n,2);
    const response=await GET({locals:{runtime:{env:{DB}}},request:new Request('https://example.test/api/raffle/month?month=2026-11')});
    const data=await response.json();
    for(const row of cases) assert.equal(data.winners.find(v=>v.ticketNumber===row.ticket).prize,`${row.category}: ${row.description.slice(0,-1)}`);
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

test('public prize cells hide category prefixes and separate verified placement without changing stored data',()=>{
    assert.deepEqual(prizeCells('Firearm: Auto-Ordnance Thompson'),{place:'—',prize:'Auto-Ordnance Thompson'});
    assert.deepEqual(prizeCells('Gift card: $100 gift certificate'),{place:'—',prize:'$100 gift certificate'});
    assert.deepEqual(prizeCells('2nd place — Gift card: Verified certificate'),{place:'2nd',prize:'Verified certificate'});
    assert.deepEqual(prizeCells(null),{place:'—',prize:'Not recorded'});
});

test('confirmed November 1 placements encode and display as 1st/2nd with clean descriptions',()=>{
    const first=composeWinnerPrize({category:'Firearm',description:'Auto-Ordnance Thompson 1927A-1, .45 ACP.',position:1,positionConfirmed:true,approved:true});
    const second=composeWinnerPrize({category:'Gift card',description:'$100 gift certificate from Safe & Secure Firearms.',position:2,positionConfirmed:true,approved:true});
    assert.equal(first,'1st place — Firearm: Auto-Ordnance Thompson 1927A-1, .45 ACP');
    assert.equal(second,'2nd place — Gift card: $100 gift certificate from Safe & Secure Firearms');
    assert.deepEqual(prizeCells(first),{place:'1st',prize:'Auto-Ordnance Thompson 1927A-1, .45 ACP'});
    assert.deepEqual(prizeCells(second),{place:'2nd',prize:'$100 gift certificate from Safe & Secure Firearms'});
    // Legacy stored values with trailing periods still display cleanly without a data change.
    assert.deepEqual(prizeCells('Firearm: Auto-Ordnance Thompson 1927A-1, .45 ACP.'),{place:'—',prize:'Auto-Ordnance Thompson 1927A-1, .45 ACP'});
});
test('trailing-period cleanup keeps internal punctuation and real abbreviations',()=>{
    assert.equal(cleanPrizeDescription('Ruger 10/22, .22 LR...  '),'Ruger 10/22, .22 LR');
    assert.equal(cleanPrizeDescription('.45 ACP'),'.45 ACP');
    assert.equal(cleanPrizeDescription('Gift card from Smith Bros.'),'Gift card from Smith Bros.');
    assert.equal(cleanPrizeDescription('Made in the U.S.A.'),'Made in the U.S.A.');
    assert.equal(cleanPrizeDescription('Sturm, Ruger & Co.'),'Sturm, Ruger & Co.');
    assert.throws(()=>composeWinnerPrize({category:'',description:'..',position:null,approved:true}));
});
