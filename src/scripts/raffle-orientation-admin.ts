export {};
const input = document.getElementById('latestVideoUrl') as HTMLInputElement | null;
const orientation = document.getElementById('videoOrientation') as HTMLSelectElement | null;
const metadataInput = document.getElementById('videoDimensions') as HTMLTextAreaElement | null;
const button = document.getElementById('saveOrientation') as HTMLButtonElement | null;
const status = document.getElementById('orientationStatus');
input?.addEventListener('change', async () => {
    if (!orientation) return;
    if (metadataInput) metadataInput.value = '';
    try {
        const res = await fetch('/api/admin/raffle/presentation?videoUrl=' + encodeURIComponent(input.value), { cache: 'no-store' });
        const data = await res.json();
        orientation.value = res.ok && data.ok ? data.override : 'auto';
    } catch { orientation.value = 'auto'; }
});
button?.addEventListener('click', async () => {
    if (!input || !orientation || !metadataInput || !status) return;
    button.disabled = true;
    try {
        const metadata = metadataInput.value.trim() ? JSON.parse(metadataInput.value) : undefined;
        const res = await fetch('/api/admin/raffle/presentation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoUrl: input.value, override: orientation.value, metadata }) });
        const data = await res.json();
        status.textContent = res.ok && data.ok ? 'Layout saved. Open raffle pages update automatically.' : data.error || 'Unable to save layout.';
        if (res.ok && data.ok) metadataInput.value = '';
    } catch { status.textContent = 'Unable to save. Check the dimension JSON.'; }
    finally { button.disabled = false; }
});
