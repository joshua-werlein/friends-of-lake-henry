# November 26, 2026: missed Live detection and missing alert

> **Status 2026-11-27.** Release A (alert) shipped as Video `61e98186`, and Release B is now live as Video `ce1b7724` and
> Photo `18adc1b9` (see "Production record" below). The "Release B: signed Live webhook correlation" section below supersedes the earlier plan where
> they differ.

Branch `task/live-missed-drawing` (worktree `C:\Users\Jwerl\dev\.worktrees\friends-of-lake-henry\live-missed-drawing`),
based on `cf8252e`, the recorded source of production Video Worker `ced68381-190a-42dd-b426-511e14d88ea3`.
**Not deployed.** Photo Worker, winner processing and Pages are unchanged.

## What happened (Central Time)

| Time | Event | Evidence |
|---|---|---|
| 5:50 PM onward | Backup polls every minute (15 s from 5:59 to 6:01), all successful | `raffle_live_automation_state`: `failures: 0`, not paused |
| 6:04:34 PM | Signed Live webhook accepted by the coordinator | `raffle_live_webhook_state` |
| 6:08 PM | Winner photo post queued by webhook and processed by 6:10 PM | `raffle_photo_auto_posts` |
| 6:10:38 PM | Admin saved `https://www.facebook.com/reel/1467167912212118` manually | `raffle_live.manualOverrideAt` |
| 6:11–6:15 PM | Every poll: `no-eligible-video`, `candidates: 0` of 25 posts | KV state, read twice |
| — | No alert was raised | Live alert code (below) |

## Root cause (confirmed from code and data; the post's raw attachment was not read)

Today's Live was published as a **Reel**. Live discovery accepted a Page-post video attachment only when its link
normalized to exactly `https://www.facebook.com/61552199315213/videos/<id>/`. `normalizeFacebookVideoUrl` maps
`/reel/<id>` to `https://www.facebook.com/reel/<id>`, so the attachment was dropped before any Graph metadata check
(`graph.ts` `extractCandidates`; the code comment states Reels are deliberately not treated as Live). Both the webhook
check and every backup poll therefore saw zero candidates. The hashtag played no part: Live discovery passes an
empty marker. The token, permissions, webhook delivery and cron were all working.

The one assumption: that the post's attachment link used the same `/reel/` form as the URL the admin copied from
Facebook. Confirming it would take one Graph read of today's post, which was not made.

## Why there was no alert (confirmed)

`liveSignals` alerted only after Graph had confirmed a Live origin ("an unscheduled or absent stream never alerts").
A successful poll that finds no candidate is healthy by that definition, so no incident was created. Nothing was
suppressed, deduplicated or lost in email delivery, and nothing watched the outcome "a drawing day passed with no video".

## Graph API verification (official Meta docs, read 2026-11-26)

| Requirement | Finding | Decision |
|---|---|---|
| `GET /{page-id}/live_videos` | The reference states reading is not supported. A real call returned code 10 on Nov 3 (`raffle-automation-repair-2026-11-03.md`) | **Not called.** A guessed request stays forbidden |
| `LiveVideo.broadcast_start_time` | The LiveVideo reference page returned 404; the field cannot be verified, and it is reachable only through the edge above | Not used |
| `GET /{page-id}/videos`, `/video_reels` | Reading is not supported (`video_reels` has a conflicting guide, and returns no Live status) | Not used |
| Video node `created_time` | Documented. Production read it on Nov 3 (video 23:59:46 UTC, before its post at 00:00:52 UTC) | Used as the broadcast time |
| Video `live_status`, `from`, `published`, `embeddable` | Not in the current Video reference, but production reads them successfully every day | Unchanged |
| Webhook video ID | `feed` changes with `item: video` carry `video_id`; `live_videos` changes carry only the LiveVideo `id` and `status` | Not used: the Photo Worker forwards only a body hash, and changing it was out of scope |

Token scopes (Nov 3 introspection): `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `public_profile`.

## Changes (Video Worker only)

1. **Live candidate extractor** (`livestream.ts` `extractLiveCandidates`). Any Page-post attachment whose type is a
   video type and whose target ID is numeric qualifies, whatever the link (`/videos/`, `/reel/`, `/watch`, share links).
   The selection record always uses the canonical `/videos/<id>/` URL that the deployed resolver requires. The shared
   `extractCandidates` is untouched (it is used by the photo-read and sync paths).
2. **Safeguards preserved.** Ownership (`from.id`), identity, `published` and `embeddable` are still required, as is
   Live evidence (`LIVE`/`LIVE_STOPPED`, or a VOD with a prior same-video observation). Two plausible videos are still
   held as ambiguous. A non-`/videos/` link with no Live status (an ordinary Reel or share) is rejected as
   `not-live-video`, never left pending, so it can never make the drawing ambiguous.
3. **Broadcast time.** In the backup window, a post that fails the time rule (announced earlier, or dated before the
   broadcast) qualifies when the video's own `created_time` meets the same rule. A Live running since the afternoon
   that is still LIVE does not qualify. Yesterday's selected video is never re-probed. At most 3 such reads per check
   (8 metadata reads total, as before).
4. **Rejection reasons.** Codes and counts only (`no-video-attachment`, `stale-post`, `outside-time-window`,
   `not-page-owned`, `unpublished`, `not-embeddable`, `not-live-video`, `live-origin-unproven`, `previous-drawing`, ...),
   recorded in `raffle_live_automation_state.rejections`, the timing journal (with per-video `reason` and `form`) and the
   `live-timing` log line. No token, URL or post text is stored.
5. **Missed-drawing alert** `live:missing:<day>`, independent of detection outcomes:
   - **When:** on every configured season day, from 6:16 PM Central, after the final 6:15 PM backup slot.
   - **Who evaluates:** the cron each minute until 6:30 PM, plus one 6:16 PM coordinator alarm, so it does not depend
     on the cron alone.
   - **What counts as handled:** a manual save today (any URL form), or an automatic selection whose first Live
     observation is today at or after 5:30 PM, while the page is in automatic mode.
   - **Once per day:** one alert per day (stable ID). It is held back from opening while today's
     "confirmed but not shown", paused-access or Graph-failure alert is open, so one problem sends one email.
   - **Resolution:** a recovery email when a selection appears. The coordinator rechecks every 5 minutes after
     6:30 PM while the incident is open, never past midnight. An earlier day's incident resolves quietly.
   - **Opt-out days:** optional `FB_NO_DRAWING_DAYS="YYYY-MM-DD,..."`.
   - **Isolation:** detection checks no longer plan or resolve `live:missing:*` records.
6. **Duplicate alert fix.** An ambiguous drawing no longer also counts toward the "detection failing repeatedly" streak.
   Its "confirmed but not shown" alert already covers it.
7. **Seasons by configuration.** The Video Worker part of `f6c73a4` was ported: season days, windows and the coordinator
   name come from `FB_SEASON_START`/`FB_SEASON_END`. No migration and no D1; the 2026 coordinator stays `november-2026`.
   `inSeasonDay` now rejects impossible dates such as `2026-11-31`. That was a bug carried in from `f6c73a4`, and the
   existing timeline test caught it.

## Tests

`tests/live-missed-drawing.test.mjs` (15 tests) drives the real cron handler, coordinator, poller and resolver:

- the Nov 26 Reel replay (old extractor 0 candidates, new one selected, by polling alone, with no hashtag);
- watch, share and unknown link forms;
- ownership, embedding and Live-status rejections;
- broadcast time versus an unrelated afternoon Live;
- the previous drawing is not re-probed;
- unrelated uploads and two simultaneous Lives (one email);
- delayed indexing (visible at 6:12 PM, and after 6:15 PM);
- a missing webhook;
- recovery by a late webhook and by a manual Reel save;
- once per day, quiet past-day resolution, no-drawing days, alerts off and the off-season;
- the 2027 season;
- an expired token;
- Resend failures retried with one idempotency key;
- rejection codes with no secrets or post text;
- resource bounds.

Results: 186/186 for `npm test` (excluding the D1 migration file) plus `live-timing-journal` and the new file, run
twice; 7/7 for `raffle-winner-migration` with its untracked SQL fixture copied in temporarily. The Video, Photo and
Pages typechecks pass, the Video bundle builds, and `wrangler deploy --dry-run` with the production config shows
bindings identical to `ced68381`.

Expectations changed in existing tests: one `live-year-round` case now uses an ordinary Reel with no Live status (a
LIVE Reel is now selected by design), and the 6:15 PM email test steps through the new 6:16 PM alarm (no Graph call,
no email) before the 6:31 PM delivery.

## Resource use

- **Graph:** unchanged at 3 calls per check in the normal case (identity, posts, one video). Up to 3 extra video reads
  per check only when the last 36 hours contain other video posts. `created_time` is one more field on an existing read.
- **KV:** no new writes. The missed-drawing evaluation reads `raffle_live` once (16 reads per drawing day, plus at most
  70 more on an unresolved day).
- **Durable Object:** 15 extra internal requests and 1 alarm per drawing day.

## Deployment (requires approval; run from the worktree after committing)

```powershell
cd C:\Users\Jwerl\dev\.worktrees\friends-of-lake-henry\live-missed-drawing
npm run typecheck:facebook-worker; npm test
npx wrangler versions upload -c workers/facebook-live/wrangler.video.activation.existing-account.json --message "Live: any link form, created_time eligibility, missed-drawing alert (<commit>)"
npx wrangler versions deploy <new-version-id>@100% -c workers/facebook-live/wrangler.video.activation.existing-account.json
npx wrangler deployments status --name folh-facebook-live-discovery
```

Deploy outside 5:45–6:35 PM Central. Afterwards, check:
- the next drawing's Admin > Raffle timeline: `check-result` entries carry `rejections`;
- `raffle_live_automation_state.rejections`;
- no `missed-drawing-check-failed` in `wrangler tail`.

## Rollback

```powershell
npx wrangler versions deploy ced68381-190a-42dd-b426-511e14d88ea3@100% --name folh-facebook-live-discovery
```

The old code ignores the new `rejections` fields. It would treat an open `live:missing:*` incident as one of its own
and resolve it at its next check, sending one recovery email if the alert had gone out. So roll back when no missed
incident is open, or accept that email. There are no KV, D1 or secret changes to undo.

## Not addressed

- **Unconfirmed Graph behavior:** whether Graph reports `live_status=LIVE` for a Live published as a Reel, and what
  `created_time` holds for a Live scheduled in advance. If either differs, the missed-drawing alert still fires at
  6:16 PM.
- **Webhook-carried video IDs:** would need a Photo Worker change (out of scope).
- **Ambiguity ordering (pre-existing):** when a second Live is posted a minute after the first, the first poll stages
  the only one visible; later polls hold as ambiguous and the earlier selection remains.

## Release B: signed Live webhook correlation (deployed 2026-11-27)

### Production record

| Item | Video Worker | Photo Worker |
|---|---|---|
| Version (100%) | `ce1b7724-2924-4f84-a754-fe5a34d70657` (deployed 01:45:53 UTC) | `18adc1b9-6bd3-4b46-a7f2-a92bb530a378` (deployed 01:47:27 UTC) |
| Source and tag | `a09e4ca`, `video-worker-ce1b7724`; merged into `main` | `23202e5` on base `photo-worker-40eba822`, `photo-worker-18adc1b9`; ported onto `main` (identical hunks) |
| Bindings and secrets | Identical to `61e98186` (3 secrets, DO, KV, 11 vars) | Identical to `40eba822` (5 secrets, D1, AI, Images, 2 service bindings, 10 vars) |
| Triggers | Unchanged | Unchanged (`*/2 * * * *`) |
| Production check | Tail during `/raffle` loads: 4 `LiveEvents.selection` and 4 DO requests on `ce1b7724`, all `ok`, 0 exceptions | Unsigned POST rejected with 403 (`webhook-bad-signature`); two cron ticks `ok`, 0 exceptions, 4–5 ms CPU; D1 unchanged (92 winners, 46 posts, 0 pending, 0 open incidents) |
| Rollback (independent) | `npx wrangler versions deploy 61e98186-c418-4664-b798-516091d5b344@100% --name folh-facebook-live-discovery` | `npx wrangler versions deploy 40eba822-d6df-42d7-85ea-54ab8249ae68@100% --name folh-facebook-winner-photos` |

**Webhook app (corrected 2026-11-27).** Production webhooks come from **FOHL Sync `2349506929155471`**, not
`1700219394854878`; the old app was deleted on Nov 5 (`fohl-sync-migration.md`). The production `FB_*` secret names hold
FOHL Sync's values with `FB_CREDENTIAL_SET` unset, so the code's "legacy" credential path is FOHL Sync. The owner
verified `feed` and `live_videos` on FOHL Sync at both the Page and app levels (v27.0, callback
`https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook`).

**Follow-up:** the admin-only diagnostic `workers/facebook-live/inspect.ts:37` still queries app-level subscriptions for
`1700219394854878` when `FB_CREDENTIAL_SET` is unset, so it should use FOHL Sync. Detection, selection and alerts do not
use it.

**First real evidence** comes at the next Live: watch for `webhook-live-events` (Photo) and `live-event-facts` (Video)
log lines, the `webhook-live-event` timing entries, and whether `originCorrelation` is `event-video-id` or
`live-video-lookup`.

### Original design (as built)

The owner's Graph v27 read of Reel `1467167912212118` found it Page-owned, published and embeddable, created
`2026-11-27T00:03:41Z`, with `live_status` omitted. That proves no Live origin, so discovery here rejects it
(`not-live-video`). Release B adds Live origin from Meta's own signed webhook, tied to the **exact video ID**.

### Photo Worker (branch `task/photo-live-event-forwarding`, base `photo-worker-40eba822` = `476637c`)

- `webhookLiveEvents(payload)` extracts sanitized facts from the signed payload. Kept: `field` (`live_videos`, `videos`,
  `feed`), numeric `id` / `video_id` / `post_id`, lowercase `status` / `item` / `verb`, and payload key **names**. Dropped:
  message, name, link and every other value. At most 10 facts.
- They are passed as `LiveEvents.notify(id, events)`; an older Live Worker ignores the extra argument. The log line
  `webhook-live-events` (facts summary) records Meta's real payload shape.
- Sanitizer errors never change the response. Photo queueing, AI extraction, winner logic and deduplication are untouched.
- Tests: 251/251 (247 existing + 4 new in `tests/photo-live-events.test.mjs`). Bindings and vars are identical to
  production `40eba822`.

### Video Worker (this branch)

- `notify` re-validates the facts (`live-events.ts`), and the Durable Object stores them (48 hours, at most 60), plus a
  `webhook-live-event` journal entry and a `live-event-facts` log line. The bare-id body is still accepted.
- **Origin rule:** a signed `live_videos` event with status `live`, `live_now` or `live_stopped` proves Live origin only
  when its `id` **equals** the candidate video ID, or a read-only `GET /{live-video-id}?fields=id,status,video` returns
  `video.id` equal to it. That means at most 2 lookups per check, with a 3 s timeout, cached for 7 days (only final
  outcomes are cached; timeouts are retried). Failures never pause or fail detection. **Timing never ties an event to a
  video.** Ownership, published, embeddable, the time rule and ambiguity are all still required.
- A signed `feed` video fact adds that exact video as a candidate before `published_posts` indexes it. It still needs Live
  origin (Graph `LIVE`/`LIVE_STOPPED` or a correlated event).
- Records carry `originEvidence` (`graph-live-status` or `signed-live-webhook`), `originCorrelation`
  (`event-video-id` or `live-video-lookup`) and `originEventRef`. `origin` keeps the value the deployed resolver requires.
- Tests: 215/215 (all suites, including the migration test).
  - New `tests/live-signed-webhook.test.mjs`, plus Release B cases in `tests/live-missed-drawing.test.mjs`: the Nov 26
    replay with today's exact metadata; the lookup path; a different video, unsupported (100), permission (10),
    scheduled status or feed-only facts all leave nothing selected and the alert fires; final lookups are not retried
    and transient ones are; an ordinary Reel next to a correlated Live; two correlated Lives are ambiguous; delayed
    indexing through a feed fact; the bare-id body; redelivery.
  - A cross-Worker run of the real new Photo `fetch` and the real new coordinator over the shared contract fixture: a
    signed `live_videos` event selects today's Reel response, and a feed-only change selects nothing.

### Prerequisites and unknowns

- **Webhook subscription.** The Page subscription is recorded as `feed` only, so Meta likely sends no `live_videos`
  changes today. Adding `live_videos` to the app's Page subscription (`POST /144051422124740/subscribed_apps`, keeping
  `feed`) is a Meta configuration change for the owner. Until then Release B adds only the feed-fact candidate path and
  diagnostics.
- **Unverified:** whether a `live_videos` event's `id` is the Video ID or a LiveVideo ID, and whether
  `GET /{live-video-id}?fields=video` is readable with the Page token. Meta's reference lists the read but its field page
  is unavailable. Either way an unmatched event selects nothing, and the `webhook-live-events` / `live-event-facts` logs
  plus the timing journal will show the real IDs after the first Live.

### Deployment (requires approval; outside 5:45–6:35 PM CT)

1. Video first (accepts the new body, old Photo still works). Run from this worktree:
   `npx wrangler versions upload -c workers/facebook-live/wrangler.video.activation.existing-account.json`, then
   `versions deploy <id>@100%`.
2. Photo second, from the Photo worktree, with `-c workers/facebook-photos/wrangler.json` (same commands).
   Verify the `webhook-live-events` log on the next signed webhook.

Rollback, in either order: Photo `40eba822-d6df-42d7-85ea-54ab8249ae68`, Video `61e98186-c418-4664-b798-516091d5b344`
(Release A). Both are compatible with each other and with the new versions. Stored facts and mappings are ignored by
the older code.
