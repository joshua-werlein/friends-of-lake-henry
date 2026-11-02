import type { APIRoute } from 'astro';
import type { D1Database,R2Bucket } from '@cloudflare/workers-types';
import { json } from '../../../../lib/http';
import { prizeSchedule,validMonth,saveSupplement,reviewSupplement,supplementDraft } from '../../../../lib/server/raffle-prizes';
import { readPosterPrizes } from '../../../../lib/server/raffle-poster-prizes';
type Env={DB?:D1Database;PHOTOS_BUCKET?:R2Bucket;AI?:{run(model:string,input:unknown):Promise<unknown>};RAFFLE_PRIZE_CALENDAR_ENABLED?:string;RAFFLE_POSTER_AI_LICENSE_ACCEPTED?:string};
export const GET:APIRoute=async({locals,url})=>{
    const env=locals.runtime?.env as Env|undefined,month=url.searchParams.get('month');
    if(env?.RAFFLE_PRIZE_CALENDAR_ENABLED!=='true'||!env.DB) return json({ok:false,error:'Prize calendar is not enabled. Manual winner entry and prize editing remain available.'},503);
    if(!validMonth(month)) return json({ok:false,error:'Select a valid raffle month.'},400);
    try { return json({ok:true,month,prizes:await prizeSchedule(env.DB,month,true),aiAvailable:!!env.AI&&env.RAFFLE_POSTER_AI_LICENSE_ACCEPTED==='true',posterUrl:`/api/raffle/poster?month=${month}`}); }
    catch { return json({ok:false,error:'Verify the additive supplemental-prize migration before enabling this feature.'},503); }
};
export const POST:APIRoute=async({locals,request})=>{
    const env=locals.runtime?.env as Env|undefined;
    if(env?.RAFFLE_PRIZE_CALENDAR_ENABLED!=='true'||!env.DB) return json({ok:false,error:'Prize calendar is not enabled.'},503);
    let body;
    try { const text=await request.text();if(text.length>50000) throw Error();body=JSON.parse(text); }
    catch { return json({ok:false,error:'Invalid prize review.'},400); }
    if(!body||!validMonth(body.month)) return json({ok:false,error:'Select a valid month.'},400);
    if(body.action==='extractPoster') {
        if(!env.AI||!env.PHOTOS_BUCKET||env.RAFFLE_POSTER_AI_LICENSE_ACCEPTED!=='true') return json({ok:false,error:'Poster recognition needs the AI binding and owner-confirmed model access/terms. Published events and manual supplements remain available.'},409);
        try { return json({ok:true,...await readPosterPrizes(env.DB,env.PHOTOS_BUCKET,env.AI,body.month)}); }
        catch { return json({ok:false,error:'Poster recognition unavailable. Check the linked R2 image, AI binding, model access and terms. No prizes were published.'},503); }
    }
    try {
        if(body.action==='draft') {
            if(!Array.isArray(body.rows)||body.rows.length<1||body.rows.length>100) return json({ok:false,error:'Provide 1–100 reviewed draft rows.'},400);
            for(const row of body.rows) supplementDraft(row,body.month);
            const results=[];
            for(const row of body.rows) results.push(await saveSupplement(env.DB,body.month,row));
            return json({ok:true,results,published:false});
        }
        if(!['approve','reject','correct'].includes(body.action)||typeof body.id!=='string'||!/^[a-f0-9-]{36}$/.test(body.id)||!Number.isInteger(body.version)||body.approved!==true) return json({ok:false,error:'Explicit review approval and the current row version are required.'},400);
        await reviewSupplement(env.DB,body.id,body.version,body.action,body.row,body.positionConfirmed===true);
        return json({ok:true});
    } catch(error) { return json({ok:false,error:error instanceof Error&&/^(This prize changed|Independently confirm|Review the date)/.test(error.message)?error.message:'A matching prize or position already exists, or review storage is unavailable. Reload and check before retrying.'},409); }
};
