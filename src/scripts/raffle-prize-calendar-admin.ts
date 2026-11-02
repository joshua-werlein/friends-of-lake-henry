export {};
const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const month=get<HTMLInputElement>('prizeMonth'),status=get('calendarStatus');
let rows:any[]=[];
const node=(tag:string,text?:string)=>{const el=document.createElement(tag);if(text)el.textContent=text;return el;};
async function api(body?:unknown) {
    const res=await fetch('/api/admin/raffle/prizes'+(body?'':'?month='+encodeURIComponent(month.value)),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
    const data=await res.json();if(!res.ok||!data.ok)throw Error(data.error??'Calendar unavailable.');return data;
}
async function run(action:()=>Promise<void>) { try{await action();}catch(error){status.textContent=error instanceof Error?error.message:'Unable to complete review.';} }
function card(row:any,proposal=false) {
    const box=node('section');box.className='prizeReviewCard';
    box.append(node('h3',`${row.drawDate||'Date needs review'} · ${row.category} · ${row.status??'AI proposal; unapproved'}`));
    if(row.source==='event') {
        box.append(node('p',row.description));
        const link=node('a','Edit original event') as HTMLAnchorElement;link.href='/admin/events/'+encodeURIComponent(row.eventId);box.append(link);
        if(row.notes)box.append(node('p','Event notes (review before adding supplemental prizes): '+row.notes));return box;
    }
    const field=(label:string,input:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)=>{const wrap=node('label',label);input.className='input';wrap.append(input);box.append(wrap);return input;};
    const date=field('Draw date',document.createElement('input')) as HTMLInputElement;date.type='date';date.value=row.drawDate;
    const category=field('Category',document.createElement('select')) as HTMLSelectElement;for(const v of ['Firearm','Gift card','Cash','Other'])category.add(new Option(v,v));category.value=row.category;
    const description=field('Prize description',document.createElement('textarea')) as HTMLTextAreaElement;description.maxLength=250;description.value=row.description;
    const position=field('Independently verified position',document.createElement('select')) as HTMLSelectElement;
    position.add(new Option('Unknown / not confirmed',''));for(const v of [1,2,3])position.add(new Option(String(v),String(v)));position.value=row.position===null?'':String(row.position);
    const notes=field('Review notes',document.createElement('textarea')) as HTMLTextAreaElement;notes.maxLength=500;notes.value=row.notes??'';
    const approved=document.createElement('input');approved.type='checkbox';const label=node('label','I reviewed this description and independently verified any numeric position.');label.prepend(approved);box.append(label);
    const value=()=>({drawDate:date.value,category:category.value,position:position.value?Number(position.value):null,description:description.value,notes:notes.value});
    const button=(text:string,action:string)=>{const b=node('button',text) as HTMLButtonElement;b.type='button';b.className='btn';b.addEventListener('click',()=>run(async()=>{
        if(action!=='draft'&&!approved.checked)throw Error('Confirm your review before approving, rejecting or correcting this prize.');
        b.disabled=true;
        try{await api(action==='draft'?{action,month:month.value,rows:[value()]}:{action,month:month.value,id:row.id,version:row.version,row:value(),approved:true,positionConfirmed:approved.checked});await load();if(proposal)box.remove();status.textContent=action==='draft'?'Private draft saved; approval is still required.':'Review saved.';}finally{b.disabled=false;}
    }));box.append(b);};
    if(proposal)button('Save as private draft','draft');else{button(row.status==='approved'?'Save reviewed correction':'Save draft correction','correct');if(row.status==='draft')button('Approve prize','approve');if(row.status!=='rejected')button('Reject prize','reject');}
    return box;
}
async function load() {
    const data=await api();rows=data.prizes;get('calendarRows').replaceChildren(...rows.map(v=>card(v)));
    get<HTMLImageElement>('calendarPoster').src=data.posterUrl;get<HTMLAnchorElement>('calendarPosterLink').href=data.posterUrl;
    get<HTMLButtonElement>('recognizePoster').disabled=!data.aiAvailable;
    get('posterAiStatus').textContent=data.aiAvailable?'Recognition proposes private rows only.':'AI binding and owner-confirmed model access/terms are needed for optional poster recognition. Events and manual drafts remain available.';
    status.textContent=`${rows.filter(r=>r.source==='event').length} published event prizes · ${rows.filter(r=>r.source==='supplement').length} supplemental rows. No event records were copied.`;
}
month.value=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).format(new Date()).slice(0,7);
get('loadPrizeMonth').addEventListener('click',()=>run(load));month.addEventListener('change',()=>run(load));
get('supplementForm').addEventListener('submit',event=>{event.preventDefault();void run(async()=>{
    const dates=get<HTMLInputElement>('allEventDates').checked?[...new Set(rows.filter(r=>r.source==='event').map(r=>r.drawDate))]:get<HTMLTextAreaElement>('supplementDates').value.split(/[\s,]+/).filter(Boolean);
    await api({action:'draft',month:month.value,rows:dates.map(drawDate=>({drawDate,category:get<HTMLSelectElement>('supplementCategory').value,description:get<HTMLTextAreaElement>('supplementDescription').value,position:null,notes:''}))});
    await load();status.textContent='Private supplemental drafts saved. Review and approve each before publication.';
});});
get('recognizePoster').addEventListener('click',()=>run(async()=>{
    const button=get<HTMLButtonElement>('recognizePoster');button.disabled=true;
    try{const data=await api({action:'extractPoster',month:month.value});get('posterProposals').replaceChildren(...data.proposals.map((v:any)=>card(v,true)));status.textContent=`${data.proposals.length} unapproved proposals. ${data.warnings.join(' ')}`;}finally{button.disabled=false;}
}));
get<HTMLImageElement>('calendarPoster').addEventListener('error',()=>{get('calendarPoster').hidden=true;});
void run(load);
