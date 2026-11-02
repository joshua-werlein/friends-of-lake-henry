import type { D1Database } from '@cloudflare/workers-types';
import { chicagoDatetimeLocalToUtcIso } from '../datetime';
export type ScheduledPrize = { id:string; drawDate:string; category:string; position:number|null; description:string;
    source:'event'|'supplement'; status:'approved'|'draft'|'rejected'; eventId?:string; notes:string; version?:number };
export const validMonth = (v:unknown):v is string => typeof v==='string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(v);
export function validDrawDate(v:unknown,month:string):v is string {
    return typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v.slice(0,7)===month
        && Number.isFinite(Date.parse(v+'T12:00:00Z')) && new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
}
const localDate = (iso:string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso
    : new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
export async function prizeSchedule(db:D1Database,month:string,includeDrafts=false):Promise<ScheduledPrize[]> {
    if(!validMonth(month)) throw Error('Select a valid raffle month.');
    const [year,m]=month.split('-').map(Number), next=new Date(Date.UTC(year,m,1,12)).toISOString().slice(0,7);
    const start=chicagoDatetimeLocalToUtcIso(month+'-01T00:00'), end=chicagoDatetimeLocalToUtcIso(next+'-01T00:00');
    const events=await db.prepare(`SELECT id,title,date_start,summary FROM events WHERE status='published' AND lower(kind)='raffle' AND is_tbd=0
        AND ((date_start>=? AND date_start<?) OR (length(date_start)=10 AND substr(date_start,1,7)=?)) ORDER BY date_start LIMIT 500`).bind(start,end,month).all<any>();
    const main:ScheduledPrize[]=[];
    for(const e of events.results) {
        if(!Number.isFinite(Date.parse(e.date_start))) continue;
        const date=localDate(e.date_start);
        if(!validDrawDate(date,month)) continue;
        main.push({id:'event:'+e.id,eventId:e.id,drawDate:date,category:'Main prize',position:null,
            description:String(e.title).replace(/^Day\s+\d+\s*[-—:]\s*/i,'').trim(),source:'event',status:'approved',notes:String(e.summary??'')});
    }
    const supplement=await db.prepare(`SELECT id,draw_date AS drawDate,category,position,description,notes,status,version FROM raffle_prize_supplements
        WHERE raffle_key=? ${includeDrafts?'':"AND status='approved'"} ORDER BY draw_date,category,position`).bind(month).all<any>();
    return [...main,...supplement.results.map(v=>({...v,source:'supplement' as const}))]
        .sort((a,b)=>a.drawDate.localeCompare(b.drawDate)||a.category.localeCompare(b.category)||(a.position??99)-(b.position??99));
}
export function suggestPrizes(prizes:ScheduledPrize[],drawDate:string,position:number|null=null) {
    const options=prizes.filter(p=>p.status==='approved' && p.drawDate===drawDate && (position===null || p.position===null || p.position===position));
    return { status:options.length===0?'unavailable':options.length===1?'review-suggestion':'selection-required',options,
        position:null, requiresApproval:true }; // A date match never establishes a winner's placement.
}
export function supplementDraft(value:unknown,month:string) {
    if(!value || typeof value!=='object') throw Error('Invalid supplemental prize.');
    const v=value as Record<string,unknown>;
    if(!validDrawDate(v.drawDate,month) || typeof v.category!=='string' || !['Firearm','Gift card','Cash','Other'].includes(v.category)
        || (v.position!==null && (typeof v.position!=='number'||![1,2,3].includes(v.position)))
        || typeof v.description!=='string' || v.description.trim().length<2 || v.description.length>250) throw Error('Review the date, category, description and optional verified position.');
    return {drawDate:v.drawDate,category:v.category,position:v.position as number|null,description:v.description.trim(),notes:typeof v.notes==='string'?v.notes.trim().slice(0,500):''};
}
export async function saveSupplement(db:D1Database,month:string,value:unknown,source?:{key:string;hash:string}) {
    const row=supplementDraft(value,month), id=crypto.randomUUID();
    // Never copy or overwrite a published main event prize.
    const key=(v:string)=>v.normalize('NFKC').trim().toLowerCase();
    const match=(await prizeSchedule(db,month,true)).find(p=>p.drawDate===row.drawDate && p.status!=='rejected' && key(p.description)===key(row.description));
    if(match) return {id:match.id,duplicate:true};
    await db.batch([
        db.prepare(`INSERT INTO raffle_prize_supplements(id,raffle_key,draw_date,category,position,description,notes,source_poster_key,source_hash) VALUES(?,?,?,?,?,?,?,?,?)`)
            .bind(id,month,row.drawDate,row.category,row.position,row.description,row.notes,source?.key??null,source?.hash??null),
        db.prepare(`INSERT INTO raffle_prize_review_log(id,prize_id,action,after_json) VALUES(?,?,?,?)`).bind(crypto.randomUUID(),id,'draft',JSON.stringify(row)),
    ]);
    return {id,duplicate:false};
}
export async function reviewSupplement(db:D1Database,id:string,version:number,action:'approve'|'reject'|'correct',value:unknown,positionConfirmed:boolean) {
    const current=await db.prepare('SELECT * FROM raffle_prize_supplements WHERE id=?').bind(id).first<any>();
    if(!current || current.version!==version) throw Error('This prize changed. Reload before reviewing.');
    const row=action==='reject'?{drawDate:current.draw_date,category:current.category,position:current.position,description:current.description,notes:current.notes}:supplementDraft(value,current.raffle_key);
    if(action!=='reject' && row.position!==null && !positionConfirmed) throw Error('Independently confirm the numeric position or leave it unknown.');
    const status=action==='reject'?'rejected':action==='approve'||current.status==='approved'?'approved':'draft';
    // SQLite D1 batch is atomic; log insertion is conditional on the successful version update.
    const results=await db.batch([
        db.prepare(`UPDATE raffle_prize_supplements SET draw_date=?,category=?,position=?,description=?,notes=?,status=?,version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`)
            .bind(row.drawDate,row.category,row.position,row.description,row.notes,status,id,version),
        db.prepare(`INSERT INTO raffle_prize_review_log(id,prize_id,action,before_json,after_json)
            SELECT ?,?,?,?,? WHERE changes()=1`)
            .bind(crypto.randomUUID(),id,action,JSON.stringify(current),JSON.stringify({...row,status})),
    ]);
    if(results[0].meta.changes!==1) throw Error('This prize changed. Reload before reviewing.');
}
