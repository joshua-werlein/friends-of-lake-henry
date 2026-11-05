/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { graphReader, GRAPH_PAGE_ID, numericId } from './graph';
import type { Env } from './poller';
import { pageAccessToken } from './credentials';
const postFields='id,message,created_time,attachments{type,target,url,subattachments{type,target,url,subattachments{type,target,url}}}';
/** Private read-only Page photo transport. Independent of discovery flags, alarms and video API calls. */
export class FacebookPhotoReads extends WorkerEntrypoint<Env> {
    async read(path: string, params: Record<string,string>) {
        const token = pageAccessToken(this.env);
        if (!token) throw Error('missing-token');
        const pageFeed=path===`${GRAPH_PAGE_ID}/published_posts`;
        if (!(pageFeed || numericId(path) || new RegExp(`^${GRAPH_PAGE_ID}_\\d{1,40}$`).test(path))
            || ![postFields,'id,images,link'].includes(params.fields)
            || Object.keys(params).some(k=>!['fields','limit'].includes(k))
            || (params.limit!==undefined && params.limit!=='10')) throw Error('invalid-photo-read');
        const body=await graphReader(token,new Date(),fetch,AbortSignal.timeout(25000))(path,params);
        delete body.paging;
        return body;
    }
}
