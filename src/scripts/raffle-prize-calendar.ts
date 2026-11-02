export {};
const section=document.getElementById('prizeCalendar'),list=document.getElementById('publicPrizeList');
let currentMonth='';
async function load(month:string) {
    if(!section||!list||!/^\d{4}-\d{2}$/.test(month))return;
    currentMonth=month;
    try {
        const res=await fetch('/api/raffle/prizes?month='+encodeURIComponent(month),{cache:'no-store'}),data=await res.json();
        if(!res.ok||!data.ok||currentMonth!==month)return;
        section.hidden=!data.enabled;
        list.replaceChildren();
        if(!data.enabled)return;
        const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        const prizes=data.prizes.filter((r:any)=>month<today.slice(0,7)||r.drawDate>=today);
        document.getElementById('prizeCalendarMonth')!.textContent=new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'-15T12:00:00Z'));
        for(const row of prizes){const item=document.createElement('li');const date=document.createElement('time');date.dateTime=row.drawDate;date.textContent=row.drawDate;const text=document.createElement('span');text.textContent=`${row.category}${row.position===null?'':` · verified position ${row.position}`}: ${row.description}`;item.append(date,text);list.append(item);}
        if(!prizes.length){const item=document.createElement('li');item.textContent='No upcoming approved prizes for this month.';list.append(item);}
    }catch{/* Keep the last approved display on transient failure. */}
}
window.addEventListener('raffle:month-changed',event=>void load((event as CustomEvent).detail.monthKey));
const select=document.getElementById('monthSelect') as HTMLSelectElement|null;
void load(select?.value??new URL(location.href).searchParams.get('month')??'');
window.setInterval(()=>{if(!document.hidden&&currentMonth)void load(currentMonth);},60000);
