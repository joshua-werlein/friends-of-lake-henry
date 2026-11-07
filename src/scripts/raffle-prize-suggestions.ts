export {};
const date=document.getElementById('wDate') as HTMLInputElement|null;
const choice=document.getElementById('scheduledPrizeSuggestion') as HTMLSelectElement|null;
const description=document.getElementById('wPrize') as HTMLInputElement|null;
const help=document.getElementById('scheduledPrizeHelp');
let options:any[]=[];
async function refresh() {
    if(!date?.value||!choice||!help)return;
    const requested=date.value;
    try {
        const res=await fetch('/api/raffle/prizes?month='+requested.slice(0,7),{cache:'no-store'}),data=await res.json();
        if(!res.ok||!data.ok||date.value!==requested)return;
        options=(data.prizes??[]).filter((p:any)=>p.drawDate===requested);
        choice.replaceChildren(new Option('Choose a verified prize suggestion (optional)',''));
        for(let i=0;i<options.length;i++)choice.add(new Option(`${options[i].category}: ${options[i].description}`,String(i)));
        help.textContent=options.length?`${options.length} approved date-matched prize(s). Choose only after verifying the winner/prize association. Placement stays unchanged.`:'No approved prize suggestions. Manual prize entry remains available; leave numeric placement unknown unless verified.';
    }catch{help.textContent='Prize suggestions unavailable. Manual entry remains available.';}
}
choice?.addEventListener('change',()=>{
    if(!description||choice.value==='')return;
    const row=options[Number(choice.value)];
    if(row)description.value=(row.category==='Main prize'||row.category==='Bonus drawing'?'':row.category+': ')+row.description;
    // Date/position are deliberately untouched; a date match is not proof of placement.
});
date?.addEventListener('change',()=>void refresh());
document.getElementById('raffleMonth')?.addEventListener('change',()=>queueMicrotask(()=>void refresh()));
window.addEventListener('raffle:winner-saved',()=>{if(choice)choice.value='';});
window.addEventListener('load',()=>void refresh());
void refresh();
