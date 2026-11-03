export {};
const dialog = document.getElementById('winnerDetailsDialog') as HTMLDialogElement | null;
const form = document.getElementById('winnerDetailsForm') as HTMLFormElement | null;
const field = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const date = field('editWinnerDate'), ticket = field('editWinnerTicket'), name = field('editWinnerName'), town = field('editWinnerTown');
const status = document.getElementById('editWinnerStatus');
let selected: { id: string; drawDate: string; ticketNumber: number; name: string; town: string } | null = null;
document.getElementById('cancelWinnerEdit')?.addEventListener('click', () => dialog?.close());
window.addEventListener('raffle:edit-winner', event => {
    if (!dialog || !date || !ticket || !name || !town || !status) return;
    const row = (event as CustomEvent).detail;
    selected = { id: row.id, drawDate: row.drawDate, ticketNumber: row.ticketNumber, name: row.name, town: row.town };
    date.value = row.drawDate; ticket.value = String(row.ticketNumber); name.value = row.name; town.value = row.town;
    status.textContent = '';
    dialog.showModal();
});
form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!selected || !date || !ticket || !name || !town || !status) return;
    const button = form.querySelector('button[type=submit]') as HTMLButtonElement;
    button.disabled = true;
    try {
        // `expected` lets the server refuse to overwrite a concurrent edit.
        const response = await fetch('/api/admin/raffle/winners', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ action: 'update', id: selected.id, expected: selected,
                winner: { drawDate: date.value, ticketNumber: ticket.value, name: name.value, town: town.value } }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) { status.textContent = data.error ?? 'Unable to save.'; return; }
        dialog?.close();
        window.dispatchEvent(new Event('raffle:winner-edited'));
    } catch { status.textContent = 'Unable to save. Your changes are still here.'; }
    finally { button.disabled = false; }
});
