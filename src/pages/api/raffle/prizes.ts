import type { APIRoute } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { json } from '../../../lib/http';
import { prizeSchedule, validMonth } from '../../../lib/server/raffle-prizes';
export const GET:APIRoute=async({locals,url})=>{
    const env=locals.runtime?.env as {DB?:D1Database;RAFFLE_PRIZE_CALENDAR_ENABLED?:string}|undefined;
    if(env?.RAFFLE_PRIZE_CALENDAR_ENABLED!=='true') return json({ok:true,enabled:false,prizes:[]});
    const month=url.searchParams.get('month');
    if(!env.DB||!validMonth(month)) return json({ok:false,error:'Select a valid raffle month.'},400);
    try { return json({ok:true,enabled:true,month,prizes:await prizeSchedule(env.DB,month)}); }
    catch { return json({ok:false,error:'Prize calendar unavailable.'},503); }
};
