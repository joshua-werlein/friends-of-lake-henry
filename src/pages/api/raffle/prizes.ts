import type { APIRoute } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { json } from '../../../lib/http';
import { prizeSchedule, validMonth } from '../../../lib/server/raffle-prizes';
import { parseWinnerPrize } from '../../../lib/winner-prize';

// A completed drawing leaves the upcoming list once every scheduled prize has a published winner.
export function completedDrawingDates(prizes: {drawDate:string;description:string}[], winners: {drawDate:string;prize:string|null}[]) {
    const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    return [...new Set(prizes.map(p=>p.drawDate))].filter(date=>prizes.filter(p=>p.drawDate===date).every(p=>
        winners.some(w=>w.drawDate===date && normalize(parseWinnerPrize(w.prize).description)===normalize(p.description))));
}
export const GET:APIRoute=async({locals,url})=>{
    const env=locals.runtime?.env as {DB?:D1Database;RAFFLE_PRIZE_CALENDAR_ENABLED?:string}|undefined;
    if(env?.RAFFLE_PRIZE_CALENDAR_ENABLED!=='true') return json({ok:true,enabled:false,prizes:[]});
    const month=url.searchParams.get('month');
    if(!env.DB||!validMonth(month)) return json({ok:false,error:'Select a valid raffle month.'},400);
    try {
        const prizes=await prizeSchedule(env.DB,month);
        const winners=await env.DB.prepare('SELECT draw_date AS drawDate,prize FROM raffle_winners WHERE raffle_key=?').bind(month).all<{drawDate:string;prize:string|null}>();
        return json({ok:true,enabled:true,month,prizes,completedDates:completedDrawingDates(prizes,winners.results)});
    }
    catch { return json({ok:false,error:'Prize calendar unavailable.'},503); }
};
