import { FACEBOOK_PAGE_VIDEOS_URL, facebookEmbedSrc, parseLiveConfig } from '../lib/facebook';

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
        if (message) message.textContent = data.source === 'automatic'
            ? 'Automatically selected verified drawing. If the player is unavailable, watch directly on Facebook.'
            : data.selectionMode === 'automatic'
                ? 'Using the saved manual selection while automatic detection is unavailable. You can also watch directly on Facebook.'
                : videoUrl ? 'Latest selected drawing. If the player is unavailable, watch directly on Facebook.'
                    : 'No broadcast selected yet. This page checks for updates automatically.';
        if (updated) updated.textContent = config.updatedAt
            ? `Video selected: ${new Date(config.updatedAt).toLocaleString('en-US', {
                timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
            })} Central` : '';
    } catch {
        // Preserve the current video and direct link on transient failures.
        if (message) message.textContent = 'Unable to check for a newer drawing. Retrying automatically; you can still watch on Facebook.';
    } finally { checking = false; }
}

void refreshLive();
window.setInterval(refreshLive, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshLive(); });
