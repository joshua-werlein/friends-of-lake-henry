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
        const prizes=data.prizes.filter((r:any)=>r.drawDate>=today && !(data.completedDates??[]).includes(r.drawDate));
        document.getElementById('prizeCalendarMonth')!.textContent=new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'-15T12:00:00Z'));
        const day=new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});
        const byDate=new Map<string,any[]>();
        for(const row of prizes)byDate.set(row.drawDate,[...(byDate.get(row.drawDate)??[]),row]);
        for(const [drawDate,rows] of byDate){
            const item=document.createElement('li'),date=document.createElement('time'),lines=document.createElement('ul');
            date.dateTime=drawDate;date.textContent=day.format(new Date(drawDate+'T12:00:00Z'));lines.className='prizeLines';
            for(const row of rows){const line=document.createElement('li');line.textContent=`${row.category}: ${row.description}`;lines.append(line);}
            item.append(date,lines);list.append(item);
        }
        if(!prizes.length){const item=document.createElement('li');item.textContent='No upcoming approved prizes for this month.';list.append(item);}
    }catch{/* Keep the last approved display on transient failure. */}
}
window.addEventListener('raffle:month-changed',event=>void load((event as CustomEvent).detail.monthKey));
const select=document.getElementById('monthSelect') as HTMLSelectElement|null;
void load(select?.value??new URL(location.href).searchParams.get('month')??'');
window.setInterval(()=>{if(!document.hidden&&currentMonth)void load(currentMonth);},60000);
