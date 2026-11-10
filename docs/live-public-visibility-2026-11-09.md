# Live video public-visibility delay — 2026-11-09

## What happened

| Day | Worker staged (state write done) | First public API response with the new video | Delay |
|---|---|---|---|
| Nov 7 | 6:00:47.3 PM | 6:00:48.5 PM | 1.2 s |
| Nov 8 | 6:00:31.6 PM | 6:01:06.6 PM | 35.1 s |
| Nov 9 | 6:00:28.2 PM | none before the manual override at 6:01:31.7 PM | > 63.5 s |

Source: the DO diagnostic timeline (`/api/admin/raffle/live?timeline=2026-11-0D`), stages `check-result` and `public-visible`.
On every day the Worker verified and staged the video 1–3 s after its trigger. At 5:55:22 PM on Nov 9 the public
API served Nov 8's video as `source: automatic`, so no same-day manual override existed before the administrator's.

## Root cause

The public resolver (`loadRaffleSelection`) read `raffle_live_automatic` and `raffle_live_automation_state` from
Workers KV. KV is eventually consistent: edge locations cache values (60 s by default, and Cloudflare documents
propagation as sometimes longer). A selection is shown only when **both** keys are fresh and match. Viewers polling
every 15 s keep the edge cache warm with the previous drawing's values, so the delay varies from about 1 s to
over a minute, depending on when each key's cached copy was refreshed. Selection precedence and browser polling
were not the cause (polling adds at most 15 s; no blocking override existed).

Shortening the KV cache TTL (minimum 30 s) would only lower the upper bound and would not fix the
mismatched-pair fallback, so it was not used.

## Fix

- The Live coordinator (Durable Object) already keeps strongly consistent copies of both keys (`cache:*`), written by
  the same code that writes KV. New read-only route `GET /selection` → `LiveEvents.selection()` RPC returns both
  values from one DO storage read.
- Pages (`/api/raffle/live`, `/raffle` SSR, admin GET) use that snapshot (originally 5:50-8 PM; see the update below).
  Both values or neither; any RPC failure, missing copy, malformed reply or 1.5 s timeout falls back to KV.
  The manual record and verification receipt still come from KV, and the resolver's checks are unchanged.
- The browser polls every 5 s from 5:58:00 to 6:05:59 PM Central (server hint `refreshMs`, clamped 5–60 s), otherwise 15 s.
- `public-visible` timeline entries now carry `reason: durable-object | kv` showing which path served the video.

Expected public delay after staging: under 1 s at the server, plus up to 5 s for the browser poll.

## Limits

- Every public Live API request and `/raffle` page load in the window makes one DO request (a single DO in one
  location). That is fine for the raffle's traffic. Outside the window, reads use KV only.
- A manual override still reaches the public page through KV, with the same delay as before.
- No measurement covers iframe load or Facebook player start, and none covers viewers who load the page without
  the API poll running (for example, with JavaScript disabled).

## Update (commit 15de231): backup window 5:50-6:15 PM, off-schedule webhooks, no 8 PM limit

- Scheduled backup discovery now runs 5:50:00-6:15:59 PM Central (35 checks a day). The Live Crons fire only on November
  evenings, 23:50-01:59 UTC (5:50-7:59 PM Central): discovery until 6:15 PM, existing alert delivery until 8 PM. That's
  130 invocations a day instead of 1,440.
- A signed Live webhook at any time on a November day now runs one check (previously eight window gates dropped it).
  There's no follow-on polling outside the window. Outside the window a candidate must be a same-day video published in
  the last 2 hours; inside it the rules are unchanged.
- The coordinator snapshot is read on any November day, not only 5:50-8 PM. `activeUntil` is 2 minutes after a signed
  hint or a new selection, plus 5:58-6:05 PM. While active, Pages reuse a snapshot for at most 2 s and browsers poll every
  5 s. Otherwise it's 15 s and 15 s.
- Remaining limits: an off-schedule Live needs a webhook after the video is published (Facebook sent one every night
  Nov 7-9, about 10 s after publication). If none arrives, nothing detects it until the next hint or the next backup
  window. Live alerts raised by an off-schedule check are emailed by the evening cron (5:50-8 PM), not immediately.
