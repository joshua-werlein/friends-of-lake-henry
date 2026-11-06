import { FACEBOOK_PAGE_VIDEOS_URL, facebookEmbedSrc, parseLiveConfig, RAFFLE_VIDEO_MESSAGE, RAFFLE_NO_VIDEO_MESSAGE } from '../lib/facebook';

const player = document.getElementById('livePlayer');
const fallback = document.getElementById('facebookFallback');
const message = document.getElementById('liveMessage');
const updated = document.getElementById('liveUpdated');
let checking = false;
async function refreshLive() {
    if (document.hidden || checking || !player) return;
    checking = true;
    try {
        const response = await fetch('/api/raffle/live', {
            cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error('Unavailable');
        const config = parseLiveConfig(JSON.stringify(data.config));
        const videoUrl = config.latestVideoUrl ?? '';
        player.dataset.videoLayout = data.presentation?.orientation === 'landscape' ? 'landscape' : 'portrait';
        if (player.dataset.videoUrl !== videoUrl) {
            const src = facebookEmbedSrc(config.latestVideoUrl);
            player.replaceChildren();
            if (src) {
                const frame = document.createElement('div');
                frame.className = 'liveFrame';
                const iframe = document.createElement('iframe');
                iframe.className = 'fbFrame';
                iframe.title = 'Friends of Lake Henry — Facebook video';
                iframe.allow = 'autoplay; encrypted-media; picture-in-picture; web-share';
                iframe.allowFullscreen = true;
                iframe.src = src;
                frame.append(iframe);
                player.append(frame);
            }
            player.dataset.videoUrl = videoUrl;
        }
        if (fallback instanceof HTMLAnchorElement) fallback.href = videoUrl || FACEBOOK_PAGE_VIDEOS_URL;
        if (message) message.textContent = videoUrl ? RAFFLE_VIDEO_MESSAGE : RAFFLE_NO_VIDEO_MESSAGE;
        if (updated) updated.textContent = config.updatedAt
            ? `Video selected: ${new Date(config.updatedAt).toLocaleString('en-US', {
                timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
            })} Central` : '';
    } catch {
        // Preserve the current video and direct link on transient failures.
    } finally { checking = false; }
}

void refreshLive();
window.setInterval(refreshLive, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshLive(); });
