import type { APIRoute } from 'astro';
import type { D1Database,R2Bucket } from '@cloudflare/workers-types';
import { json } from '../../../../lib/http';
import { prizeSchedule,validMonth,saveSupplement,reviewSupplement,supplementDraft,approveDrafts,monthCalendar,recurringPrizes,saveRecurring,reviewRecurring,recurringDraft,setCalendarStatus } from '../../../../lib/server/raffle-prizes';
import { readPosterPrizes } from '../../../../lib/server/raffle-poster-prizes';
type Env={DB?:D1Database;PHOTOS_BUCKET?:R2Bucket;AI?:{run(model:string,input:unknown):Promise<unknown>};RAFFLE_PRIZE_CALENDAR_ENABLED?:string;RAFFLE_POSTER_AI_LICENSE_ACCEPTED?:string};
export const GET:APIRoute=async({locals,url})=>{
    const env=locals.runtime?.env as Env|undefined,month=url.searchParams.get('month');
    if(env?.RAFFLE_PRIZE_CALENDAR_ENABLED!=='true'||!env.DB) return json({ok:false,error:'Prize calendar is not enabled. Manual winner entry and prize editing remain available.'},503);
    if(!validMonth(month)) return json({ok:false,error:'Select a valid raffle month.'},400);
    try { return json({ok:true,month,calendar:await monthCalendar(env.DB,month),recurring:await recurringPrizes(env.DB,month),prizes:await prizeSchedule(env.DB,month,true),aiAvailable:!!env.AI&&env.RAFFLE_POSTER_AI_LICENSE_ACCEPTED==='true',posterUrl:`/api/raffle/poster?month=${month}`}); }
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
        // Recurring prizes (every drawing day) are drafts until reviewed, like supplements.
        if(body.action==='recurringDraft') {
            if(!Array.isArray(body.rows)||body.rows.length<1||body.rows.length>10) return json({ok:false,error:'Provide 1–10 reviewed recurring prizes.'},400);
            for(const row of body.rows) recurringDraft(row);
            const results=[];
            for(const row of body.rows) results.push(await saveRecurring(env.DB,body.month,row));
            return json({ok:true,results,published:false});
        }
        if(body.action==='reviewRecurring') {
            if(!['approve','reject','correct'].includes(body.review)||typeof body.id!=='string'||!/^[a-z0-9-]{8,60}$/.test(body.id)||!Number.isInteger(body.version)||body.approved!==true) return json({ok:false,error:'Explicit review approval and the current row version are required.'},400);
            await reviewRecurring(env.DB,body.id,body.version,body.review,body.row,body.positionConfirmed===true);
            return json({ok:true});
        }
        // The calendar becomes authoritative for winner validation and photo publication only after this explicit approval.
        if(body.action==='approveCalendar'||body.action==='reopenCalendar') {
            if(body.approved!==true) return json({ok:false,error:'Explicit review approval is required.'},400);
            const heading=typeof body.mainPrizeHeading==='string'||body.mainPrizeHeading===null?body.mainPrizeHeading:undefined;
            return json({ok:true,calendar:await setCalendarStatus(env.DB,body.month,body.action==='approveCalendar'?'approved':'draft',heading)});
        }
        if(body.action==='approveDrafts') {
            if(body.approved!==true) return json({ok:false,error:'Explicit review approval and the current row version are required.'},400);
            return json({ok:true,approved:await approveDrafts(env.DB,body.month,body.items)});
        }
        if(!['approve','reject','correct'].includes(body.action)||typeof body.id!=='string'||!/^[a-f0-9-]{36}$/.test(body.id)||!Number.isInteger(body.version)||body.approved!==true) return json({ok:false,error:'Explicit review approval and the current row version are required.'},400);
        await reviewSupplement(env.DB,body.id,body.version,body.action,body.row,body.positionConfirmed===true);
        return json({ok:true});
    } catch(error) { return json({ok:false,error:error instanceof Error&&/^(This prize changed|Independently confirm|Review the date|Review the category|Publish the month)/.test(error.message)?error.message:'A matching prize or position already exists, or review storage is unavailable. Reload and check before retrying.'},409); }
};
