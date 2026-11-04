import type { D1Database } from '@cloudflare/workers-types';
/** Keep numeric ticket identity while recovering the exact printed label from immutable import evidence. */
export async function winnerTicketLabels<T extends {id:unknown;ticketNumber:unknown}>(db:D1Database,rows:T[]):Promise<(T&{ticketNumberText:string})[]> {
    const labels=new Map<string,string>();
    try {
        const result=await db.prepare(`SELECT a.winner_id AS id,json_extract(a.row_json,'$.ticketNumber') AS label,w.ticket_number AS ticket
            FROM raffle_photo_auto_rows a JOIN raffle_winners w ON w.id=a.winner_id
            WHERE a.outcome='inserted' AND CAST(json_extract(a.row_json,'$.ticketNumber') AS INTEGER)=w.ticket_number`).all<any>();
        for(const r of result.results) if(typeof r.label==='string' && /^\d{1,9}$/.test(r.label)) labels.set(r.id,r.label);
    } catch { /* Older deployments without the additive photo audit tables retain normal numeric labels. */ }
    return rows.map(row=>({...row,ticketNumberText:labels.get(String(row.id))??String(row.ticketNumber??'')}));
}
