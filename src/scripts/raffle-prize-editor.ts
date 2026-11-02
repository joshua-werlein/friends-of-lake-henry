import { parseWinnerPrize } from '../lib/winner-prize';
const dialog = document.getElementById('winnerPrizeDialog') as HTMLDialogElement | null;
const form = document.getElementById('winnerPrizeForm') as HTMLFormElement | null;
const category = document.getElementById('editPrizeCategory') as HTMLSelectElement | null;
const description = document.getElementById('editPrizeDescription') as HTMLTextAreaElement | null;
const place = document.getElementById('editPrizePosition') as HTMLSelectElement | null;
const confirmPlace = document.getElementById('editPrizePositionConfirmed') as HTMLInputElement | null;
const approve = document.getElementById('editPrizeApproved') as HTMLInputElement | null;
const status = document.getElementById('editPrizeStatus');
let selected: { id: string; prize: string | null } | null = null;
document.getElementById('cancelPrizeEdit')?.addEventListener('click',()=>dialog?.close());
window.addEventListener('raffle:edit-prize', event => {
    if (!dialog || !category || !description || !place || !confirmPlace || !approve || !status) return;
    const row = (event as CustomEvent).detail;
    selected = { id: row.id, prize: row.prize ?? null };
    const parsed = parseWinnerPrize(selected.prize);
    category.value = parsed.category;
    description.value = parsed.description;
    place.value = parsed.position === null ? '' : String(parsed.position);
    confirmPlace.checked = false;
    approve.checked = false;
    document.getElementById('editPrizeWinner')!.textContent = `${row.drawDate} · Ticket ${row.ticketNumber} · ${row.name}, ${row.town}`;
    status.textContent = '';
    dialog.showModal();
});
form?.addEventListener('submit',async event=>{
    event.preventDefault();
    if (!selected || !category || !description || !place || !approve || !confirmPlace || !status) return;
    const button = form.querySelector('button[type=submit]') as HTMLButtonElement;
    button.disabled = true;
    try {
        const response = await fetch('/api/admin/raffle/winner-prize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
            id:selected.id,expectedPrize:selected.prize,category:category.value,description:description.value,
            position:place.value ? Number(place.value) : null,positionConfirmed:confirmPlace.checked,approved:approve.checked,
        })});
        const data = await response.json();
        if (!response.ok || !data.ok) { status.textContent=data.error ?? 'Unable to save.'; return; }
        dialog?.close();
        window.dispatchEvent(new Event('raffle:prize-saved'));
    } catch { status.textContent='Unable to save. Your changes are still here.'; }
    finally { button.disabled=false; }
});
