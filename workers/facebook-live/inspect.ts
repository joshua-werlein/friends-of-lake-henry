import { graphReader, GRAPH_PAGE_ID } from './graph';
import { discoverLivestreams } from './livestream';
import type { Env } from './poller';

/** Strip pagination at every depth; Graph can embed credentials in nested attachment paging URLs. */
export function sanitizedDiagnostic(value:unknown):unknown {
    if(Array.isArray(value))return value.slice(0,100).map(sanitizedDiagnostic);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['paging','access_token','appsecret_proof','authorization','message','description'].includes(key.toLowerCase())).map(([key,item])=>[key,sanitizedDiagnostic(item)]));
    if(typeof value==='string'&&/^https?:/.test(value)) {
        try{const url=new URL(value);if(url.username||url.password||url.hostname.endsWith('.fbcdn.net')||[...url.searchParams.keys()].some(key=>/token|signature|proof|secret/i.test(key)))return '[redacted-url]';}catch{return '[invalid-url]';}
    }
    return value;
}

/** Account-only diagnostics: Graph reads only, no selection, receipt, queue or KV writes. */
export async function inspectGraph(env: Pick<Env, 'FB_PAGE_ACCESS_TOKEN'>) {
    const token=env.FB_PAGE_ACCESS_TOKEN??'';
    const get=graphReader(token,new Date(),fetch,AbortSignal.timeout(25000));
    const out:Record<string,unknown>={at:new Date().toISOString()};
    for(const [phase,path,fields] of [
        ['identity',GRAPH_PAGE_ID,'id'],
        ['posts',`${GRAPH_PAGE_ID}/published_posts`,'id,message,created_time,attachments{type,target,url}'],
        ['known-video','28261694626839193','id,from,live_status,published,embeddable,created_time'],
        ['subscription',`${GRAPH_PAGE_ID}/subscribed_apps`,'id,subscribed_fields'],
    ]) {
        try {
            const body=await get(path,{fields,limit:'10'});
            if(Array.isArray(body.data))body.data=body.data.map((p:any)=>{const {message,...safe}=p;return safe});
            delete body.paging;out[phase]={ok:true,body};
        }catch(e){out[phase]={ok:false,reason:(e as any).reason??'runtime-failure',detail:(e as any).detail??{}}}
    }
    try {
        const body=await get('debug_token',{input_token:token});const d=body.data as any;
        out.tokenAccess={appId:d?.app_id,type:d?.type,isValid:d?.is_valid,expiresAt:d?.expires_at,dataAccessExpiresAt:d?.data_access_expires_at,scopes:d?.scopes};
    }catch(e){out.tokenAccess={ok:false,reason:(e as any).reason??'unavailable'}}
    try {
        const subscriptions=await get('1700219394854878/subscriptions',{});
        out.appSubscriptions={readable:true,subscriptions:Array.isArray(subscriptions.data)?subscriptions.data.map((v:any)=>({object:v.object,active:v.active,fields:v.fields})):[]};
    } catch(e) {out.appSubscriptions={readable:false,reason:(e as any).reason??'unavailable',detail:(e as any).detail??{}};}
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    out.tokenFingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    out.livestreamPolicy=await discoverLivestreams({token});
    return sanitizedDiagnostic(out);
}

/** Probe only the known public video, reporting allowlisted values/field names rather than raw metadata. */
export async function inspectOriginMetadata(env:Pick<Env,'FB_PAGE_ACCESS_TOKEN'>) {
    const get=graphReader(env.FB_PAGE_ACCESS_TOKEN??'',new Date(),fetch,AbortSignal.timeout(25000));
    const result:Record<string,unknown>={at:new Date().toISOString()};
    for(const field of ['live_video','is_live_streaming','broadcast_id']) {
        try{const body=await get('28261694626839193',{fields:'id,'+field});result[field]={supported:true,present:body[field]!==undefined};}
        catch(e){result[field]={supported:false,reason:(e as any).reason??'unavailable',detail:(e as any).detail??{}}}
    }
    try{const body=await get('28261694626839193',{fields:'id',metadata:'1'});result.liveFieldNames=(body.metadata as any)?.fields?.map((v:any)=>v.name).filter((v:unknown)=>typeof v==='string'&&/live|broadcast/.test(v))??[];}catch{result.liveFieldNames=null}
    return result;
}
