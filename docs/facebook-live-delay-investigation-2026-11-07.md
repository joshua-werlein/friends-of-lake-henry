# Facebook Live detection delay — November 7, 2026

Investigation only. Only this report was created; no implementation, configuration, credentials, schedules, winner data or email settings were changed. No account migration was started.

**Finding:** current code already requests immediate Graph verification after an eligible signed webhook. The November 6 interval of **86.936 seconds** does not establish a processing delay or broadcast-to-viewer delay. Fresh production KV evidence puts the selected video's Page-post creation time at **6:00:09 PM Central**, only six seconds before its recorded observation time. The early webhook's relationship to that video remains unknown.

## 1. Architecture and timing

References below are repository paths with one-based line numbers.

| Stage | Confirmed behavior |
| --- | --- |
| Webhook | Photo Worker reads a bounded body, verifies HMAC, parses Page hints and requires the active route. Live hints include `live_videos`, `videos`, and eligible feed changes; a signature is authenticity evidence, not proof of a broadcast. Receipt tracking and up to 20 sequential D1 post enqueues precede Live forwarding. Photo AI processing runs afterward through `waitUntil`. `workers/facebook-photos/index.ts:41–93`, `webhook.ts:73` |
| Forwarding | Private `FACEBOOK_LIVE.notify(bodyHash)` RPC passes a deduplication hash, **not a video ID**. Live accepts only during November's drawing window with automation enabled. `workers/facebook-live/video-entry.ts:25` |
| Immediate wake | DO `/event` uses `blockConcurrencyWhile`; it writes a KV webhook heartbeat, pending hash/time, and `setAlarm(received)`. Duplicate hashes in the last 100 are rejected. The next alarm treats an unclaimed event as a webhook and bypasses the slot claim. It does not wait for cron by design. `discovery-object.ts:19`, `coordinator.ts:28–66` |
| Scheduled discovery | Minute cron kicks the singleton `november-2026` DO. Window: **17:50:00–18:30:59 America/Chicago**, November 2026 only. Normal slots: 60 seconds. Burst: **17:59:00 through 18:01:45**, every 15 seconds. Next alarm is armed before network work; missed slots are not replayed. `index.ts:8`, `src/lib/server/raffle-discovery-schedule.ts:4–36`, `coordinator.ts:48` |
| Graph | Sequential identity read, first 25 `published_posts`, then metadata for up to 8 candidates. Same drawing date and post creation inside the window are required. Metadata must match Page/video identity and be published/embeddable; `LIVE`/`LIVE_STOPPED` proves origin, while VOD requires prior same-video Live proof. Multiple plausible candidates fail closed. No hashtag is required on this active Live path. Shared discovery deadline: 25 seconds; optional format read has a separate 2.5-second timeout and is awaited before staging. `livestream.ts:33–105`, `graph.ts:87–138` |
| Retry/guards | Webhook bypasses ordinary next-attempt/backoff, but not paused access, a rate-limit next-attempt gate or active Retry-After. First three transient failures may retry at the next burst slot. Otherwise failures back off to 120 seconds, or longer for Retry-After. Admin disable, expired verification receipt, ambiguity and failed proof prevent publication. `poller.ts:74–118` |
| Selection writes | Selection KV key is written before state KV key. DO maintains strongly consistent copies of these two values for its own checks. Public reads still use KV. `coordinator.ts:72–97`, `poller.ts:123–154` |
| Public resolver | SSR and `/api/raffle/live` share `loadRaffleSelection`: manual record first, then automatic selection/state/verification concurrently. Matching verified state and valid receipt are required; manual overrides retain precedence. No explicit KV cache TTL. API response is `Cache-Control: no-store`. `src/lib/server/raffle-selection.ts:44–97`, `src/pages/api/raffle/live.ts:11`, `src/lib/http.ts:17` |
| Browser/player | Immediate fetch then 15-second intervals; hidden tabs skip checks and refresh on visibility. Ten-second request timeout and overlap guard. Changed URL replaces the iframe; failed requests preserve the current player. SSR iframe is lazy-loaded; dynamically inserted iframe is not. No player-ready/playback measurement or autoplay request. `src/scripts/raffle-live.ts:9–58`, `src/pages/raffle.astro:265`, `src/lib/facebook.ts:46` |

### Production evidence and limits

Read-only Cloudflare GETs succeeded against account `aa86268490e681cccb3a41a62093e2aa` during this investigation:

- Active Live version **`9c28baf5-4f99-4ce7-8326-702972202c2a`**, 100%; deployment resource `964c5500-9a28-4372-8e7d-e0c37307d4b9`, created November 7 at `18:01:53.298405Z`. The supplied identifier is a version ID in Cloudflare's response.
- Actual cron `* * * * *`; automation/probing true; interval variable 60. Live alerts remain enabled/live. Photo alert release was not rechecked; existing `.wrangler/alerts-final-verification.json` records both Workers enabled/live.
- Settings returned no `observability` field. No retained November 6 execution trace was available in the reviewed evidence. Prior investigation documents explicitly report observability off; this is not proof that every possible external log archive is absent.
- Public API returned 200, `no-store`, `automatic` / `verified-discovery`, at Cloudflare location MSP. This single current replay response does not measure historical freshness.
- Existing `.wrangler/alerts-monitor-summary.json` covers November 7 around noon Central, outside discovery hours; successful invocations there do not measure drawing detection. `live-timing` rows in test logs are simulations, not production observations.

## 2. November 6 reconstruction

All local times below are CST (UTC−6); midnight UTC is the next calendar date.

| Central | Evidence and interpretation |
| --- | --- |
| 17:58:48.065 | Earliest signed event, supplied timeline. Payload/video correlation and provider event time unavailable. Being signed does not establish that the selected broadcast was already actionable. |
| 17:59:00 onward | Configured burst boundaries: :00, :15, :30, :45. Configuration describes opportunities, not proof any particular check executed successfully. |
| **18:00:09** | Fresh `raffle_live_automatic.publishedAt = 2026-11-07T00:00:09+0000` for video `2907180069653430`. Code derives this from Page-post `created_time`; it is not independently measured broadcast start or first Graph availability. It is **80.935 seconds after** the early event. |
| **18:00:15.001** | KV `observedAt` and `originObservedAt`, also public `updatedAt`. The poller stamps the check's start time, before Graph requests and writes. Therefore this is not a measured write-completion/display timestamp. Difference from post creation: **6.001 seconds**; difference from earliest event: **86.936 seconds**. |
| 18:00:18.589 | Fresh webhook heartbeat's **latest** DO receipt (`2026-11-07T00:00:18.589Z`). It overwrites prior receipts; it neither reconstructs the first event nor proves which event selected the video. |
| 18:30:00.007 | Last successful verification in stored state, status `unchanged`, failures 0, not paused. Later health cannot explain earlier checks. |

**Best-supported interpretation:** the early hint may have preceded the relevant published video; the selected video's stored creation-to-observation interval was short. Facebook publication/API availability is a stronger lead than assuming the system spent 87 seconds handling an actionable video. This remains an inference. A quarter-minute-aligned observation does **not** establish a cron/alarm trigger: webhook checks can start near the same boundary. Current retry/timing changes were released November 7 and cannot retrospectively diagnose November 6.

## 3. Delay points and the 15–30-second goal

1. **Facebook availability and classification:** no selection is possible until the feed exposes a qualifying attachment and metadata proves Live origin. Empty feed, unpublished/unembeddable metadata, unproven VOD or ambiguity keep the old/manual video. The stored 18:00:09 creation time supports investigating this stage first; exact API visibility is unknown.
2. **Webhook critical path:** D1 queueing precedes notify; a D1 failure prevents forwarding even a valid Live hint. DO heartbeat KV write also precedes alarm creation. Multiple events collapse into one pending hash; only the latest pending event is correlated. Slow existing checks can delay the serialized alarm. These are code-supported risks, not measured historical causes.
3. **Verification/scheduling:** sequential Graph work can consume 25 seconds plus optional 2.5-second format probing and storage time. Alarms are not a latency guarantee. Without a new hint, outside the burst the next healthy opportunity can be nearly 60 seconds away; persistent failures/rate limits take longer. A pre-live hint gets one immediate check, then ordinary slots, with no short event-specific follow-up sequence.
4. **After staging:** independent KV values can be observed at different revisions, making the public resolver fall back until matching state arrives. This cannot explain the webhook-to-`observedAt` interval. No measured write-to-public gap establishes KV as a contributor here. KV defaults to 60-second caching, with visibility sometimes taking **60 seconds or more**, not a hard 60-second upper bound ([Cloudflare KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). Browser polling adds nominally 0–15 seconds after fresh API state, plus request/iframe/player time. Hidden tabs, timer throttling and failures extend that.

**Assessment:** verified selection within 15–30 seconds of an actionable hint is realistic on a healthy, fast Graph path and already supported; it is not guaranteed. The whole viewer-visible path cannot currently promise that target. A signed webhook should remain a wake-up hint followed by all existing Graph checks, never direct publication. Moving Graph calls into the webhook handler would add duplicate/concurrent verification and acknowledgment latency without removing Facebook availability limits. Cloudflare alarms are at-least-once with retries, so durable claims remain necessary ([alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/)).

## 4. Instrumentation gaps

- Photo `receivedAt` starts before signature verification; `queueMs` includes body/HMAC/parsing/receipt/enqueue/hash work, not just D1. `notifyMs` covers the RPC. Failed forwarding lacks `queueMs`.
- DO `firstWebhookAt` starts after forwarding and the initial deduplication read; it is not the photo Worker's receipt time. `wakeLagMs` begins there; coordinator setup before `pollStarted` is outside `pollMs`.
- `graphRequests` and summed `graphMs` include the format probe, but measure fetch response arrival, excluding body consumption/parsing. There is no per-phase duration or candidate-availability history.
- `selectionWriteMs`/`stateWriteMs` include their DO wrapper work; `pollMs` covers the whole poll. `firstSelectedAt` records completion after both writes, a better completion marker than `observedAt`.
- `firstLiveEvidenceAt` is a check-start proxy, and monitor `liveVideoId` also uses the string `ambiguous` on ambiguity; that timeline marker can be set without a uniquely verified video. Early returns/errors can lack `live-timing`.
- Daily DO timeline stores firsts only. It was added after November 6 and cannot backfill history. `LiveEvents.timeline(day)` exists privately, but the current admin API type/route does not expose it; no new diagnostic deployment was made to read it.
- No measurement joins write completion → public resolver response → browser URL change → iframe load → actual playable video. No independently timed broadcast start or Meta-delivery latency is available.

## 5. Ranked smallest safe improvements for later

| Rank | Recommendation | Impact / tradeoff / exact files |
| --- | --- | --- |
| 1 | Capture existing timing and expose the private daily timeline read through the authenticated admin GET. Correct ambiguous evidence accounting and distinguish check start from completion in diagnostics. | Highest diagnostic value, low behavior risk; no guaranteed latency reduction. Use a bounded live tail first; retained logging would require separate reviewed config/preflight changes. Files: `src/pages/api/admin/raffle/live.ts`, `workers/facebook-live/coordinator.ts`, `workers/facebook-live/poller.ts`, `workers/facebook-live/video-entry.ts` if extending timeline fields, `tests/live-detection-timeline.test.mjs`. |
| 2 | Decouple authenticated Live-hint forwarding from photo D1 queue success, retaining photo durable-queue/503 retry semantics and DO deduplication. | Removes an unrelated failure/latency dependency. Low-to-moderate implementation risk: partial success and redelivery must not lose photo work or multiply Graph calls. Files: `workers/facebook-photos/index.ts`, `tests/photo-autopublish.test.mjs`; coordinator tests in `tests/live-detection-timeline.test.mjs`. Existing immediate alarm path stays. |
| 3 | If next-drawing evidence shows early hints followed by empty/pending Graph results outside the burst, add a bounded 15-second follow-up budget after a hint, coalesced with scheduled slots. | Potentially saves most of a 60-second wait outside the burst; little benefit inside it. Moderate scheduling/quota risk. Preserve Retry-After, pause/admin/window/ambiguity guards and all verification checks. Files: `workers/facebook-live/coordinator.ts`, `workers/facebook-live/poller.ts`, `tests/live-detection-timeline.test.mjs`, `tests/discovery-schedule.test.mjs`; `src/lib/server/raffle-discovery-schedule.ts` only if cadence policy is extracted there. |

No TTL reduction, polling-frequency increase, broad burst extension or public DO-read redesign is justified yet. If a measured public freshness gap emerges, investigate it separately. Optional persistent observability would touch `workers/facebook-live/wrangler.video.activation.existing-account.json` and its deployment guards (`check-activation.mjs`, `check-video-deployment.mjs`, `check-deployment.mjs` as applicable), plus the Photo config/guard only if logging is enabled there. Preserve enabled/live email variables on both Workers.

## 6. Next drawing validation

1. Before 17:50 Central, arrange bounded live tails for both Workers and a visible logged-out `/raffle` browser with Network recording. Record version IDs and synchronized UTC/Central clocks. Do not inject webhooks or change production records/settings.
2. Independently record the broadcaster's actual start time and the first visible native Facebook playback. These are different from Page-post `created_time`.
3. Correlate `webhook-live-forwarded` receipt/hash/queue/notify/accepted fields with DO `live-timing` trigger/hash/wake/Graph/poll/write/status. Capture early empty/pending/error checks as well as the successful one. Read the timeline through an existing authorized service-binding environment if available; do not deploy a temporary helper solely for this investigation.
4. Keep ordinary 15-second API polling. Record response receipt, source/reason/selected URL, Cloudflare location, DOM iframe URL change and first actual playback. Iframe `load` alone does not prove playable video. Check manual fallback without altering it.
5. Compare receipt→alarm, alarm→verified writes, writes→first public automatic response, response→iframe, iframe→playback. Only pursue KV changes if completed writes materially precede matching public state. Save sanitized timings; exclude authorization headers, tokens and raw webhook bodies.

## 7. Validation and unresolved questions

Targeted `node --import ./tests/register.mjs --test tests/live-detection-timeline.test.mjs`: **10/10 passed** on local Node 24.22.2. These simulations establish current immediate wake, backoff, verification and split-write behavior; they do not establish November 6 history. No broad suite/build was run. Source was inspected, not downloaded from the deployed bundle; active version/config were checked directly.

Still unknown: early webhook payload and relationship to video `2907180069653430`; actual broadcast start; first Graph visibility/Live status; historical trigger, failures and execution durations; historical KV/browser/player timing; whether an external November 6 log archive exists. The current stored post timestamp is the strongest additional evidence, but does not answer those questions.

Stopped after this report. No fixes implemented.
