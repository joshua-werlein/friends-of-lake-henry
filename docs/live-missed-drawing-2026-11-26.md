# November 26, 2026: missed Live detection and missing alert

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
