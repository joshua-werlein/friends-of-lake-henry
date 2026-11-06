import type { APIRoute } from 'astro';
import type { KVNamespace } from '@cloudflare/workers-types';
import {json} from '../../../../lib/http';
import {normalizeFacebookVideoUrl,parseLiveConfig,RAFFLE_LIVE_KEY} from '../../../../lib/facebook';
import {loadRaffleSelection,readRecord,selectionMode,STATE_KEY,verificationValid,VERIFICATION_KEY} from '../../../../lib/server/raffle-selection';
import {FACEBOOK_LIVE_CONTRACT} from '../../../../lib/facebook';
import {raffleSeason} from '../../../../lib/server/raffle-season';
import type {SeasonEnv} from '../../../../lib/server/raffle-season';
import {inDiscoveryWindow} from '../../../../lib/server/raffle-discovery-schedule';
type Env=SeasonEnv&{CONFIG?:KVNamespace;RAFFLE_AUTOMATIC_SELECTION_ENABLED?:string;
    FACEBOOK_LIVE?:{testDiscovery():Promise<unknown>}; FACEBOOK_PHOTO_STATUS?:{webhookStatus():Promise<unknown>}};
export const GET:APIRoute=async context=>{
    const env=context.locals.runtime?.env as Env|undefined;
    if(!env?.CONFIG)return json({ok:false,error:'Video settings are unavailable.'},500);
    const now=new Date();const selection=await loadRaffleSelection(env.CONFIG,env.RAFFLE_AUTOMATIC_SELECTION_ENABLED==='true',now,env);
    const [state,webhook,automatic]=await Promise.all([env.CONFIG.get(STATE_KEY),env.CONFIG.get('raffle_live_webhook_state'),env.CONFIG.get('raffle_live_automatic')]);
    let webhookSetup:unknown={configured:false,liveForwarding:false};
    try{webhookSetup=await env.FACEBOOK_PHOTO_STATUS?.webhookStatus()??webhookSetup;}catch{}
    const receipt=await env.CONFIG.get(VERIFICATION_KEY);
    const receiptValid=verificationValid(receipt,now,raffleSeason(env));
    selection.automaticAllowed=env.RAFFLE_AUTOMATIC_SELECTION_ENABLED==='true'&&receiptValid;
    const health=readRecord(state);const automaticEnabled=selection.selectionMode==='automatic';
    const observation=readRecord(JSON.stringify(health?.lastLiveObservation));
    const stage=readRecord(automatic);
    return json({ok:true,config:selection.manualConfig,displayed:selection.config,source:selection.source,reason:selection.reason,
        selectionMode:selection.selectionMode,automaticEnabled,automaticAllowed:selection.automaticAllowed,
        status:!automaticEnabled?'Disabled':health?.lastError||!selection.automaticAllowed?'Error':health?.status==='pending-live-confirmation'?'Waiting':inDiscoveryWindow(now)?'Active':'Waiting',
        lastSuccessfulCheck:health?.lastSuccessAt??health?.lastVerifiedAt??null,lastError:health?.lastError??(!selection.automaticAllowed?{cause:'verification-required'}:null),
        receiptValid, discoveryStatus:health?.status??null, lastLiveObservation:observation?.originObservedAt??null,
        lastObservedLiveVideo:observation?.url??null, lastStagedAt:stage?.contract===FACEBOOK_LIVE_CONTRACT?stage.observedAt:null,
        pendingVideos:health?.pendingVideos??[],lastAutomaticVideo:stage?.url??null,webhook:{...webhookSetup as object,...readRecord(webhook)}});
};
export const POST:APIRoute=async context=>{
    const env=context.locals.runtime?.env as Env|undefined;
    if(!env?.CONFIG)return json({ok:false,error:'Video settings are unavailable.'},500);
    let body:any;try{body=await context.request.json();}catch{return json({ok:false,error:'Invalid JSON body'},400);}
    if(!body||typeof body!=='object'||Array.isArray(body))return json({ok:false,error:'Invalid settings.'},400);
    if(body.action==='testDiscovery'){
        if(!env.FACEBOOK_LIVE)return json({ok:false,error:'Discovery is not connected.'},503);
        try{return json({ok:true,result:await env.FACEBOOK_LIVE.testDiscovery()});}catch{return json({ok:false,error:'Discovery could not be queued. Your current video is unchanged.'},503);}
    }
    const raw=await env.CONFIG.get(RAFFLE_LIVE_KEY);const previous=readRecord(raw)??{latestVideoUrl:null,updatedAt:null};
    if(body.action==='setAutomation'||body.action==='setMode'){
        const enabled=body.action==='setMode'?body.selectionMode==='automatic':body.enabled;
        if(typeof enabled!=='boolean'||(body.action==='setMode'&&!['manual','automatic'].includes(body.selectionMode)))return json({ok:false,error:'Choose enabled or disabled.'},400);
        if(enabled&&env.RAFFLE_AUTOMATIC_SELECTION_ENABLED!=='true')return json({ok:false,error:'Automatic updates are not enabled for this website deployment.'},409);
        await env.CONFIG.put(RAFFLE_LIVE_KEY,JSON.stringify({...previous,automaticEnabled:enabled,selectionMode:enabled?'automatic':'manual'}));
        return json({ok:true,automaticEnabled:enabled,selectionMode:enabled?'automatic':'manual'});
    }
    if(body.action&&!['saveVideo','showVideo','saveFallback'].includes(body.action))return json({ok:false,error:'Unknown action'},400);
    if(!('latestVideoUrl'in body)||(body.latestVideoUrl!==null&&typeof body.latestVideoUrl!=='string'))return json({ok:false,error:'latestVideoUrl must be a string or null'},400);
    const entered=(body.latestVideoUrl??'').trim(),url=entered?normalizeFacebookVideoUrl(entered):null;
    if(entered&&!url)return json({ok:false,error:'Paste the full Facebook video URL. Open short/share links on Facebook and copy the full video URL.'},400);
    const now=new Date().toISOString();const automaticEnabled=selectionMode(raw)==='automatic';
    const config={latestVideoUrl:url,updatedAt:now};
    await env.CONFIG.put(RAFFLE_LIVE_KEY,JSON.stringify({...previous,...config,automaticEnabled,selectionMode:automaticEnabled?'automatic':'manual',
        ...(body.action==='saveFallback'?{}:{manualOverrideAt:now,manualOverrideUrl:url})}));
    return json({ok:true,config,automaticEnabled,selectionMode:automaticEnabled?'automatic':'manual'});
};
