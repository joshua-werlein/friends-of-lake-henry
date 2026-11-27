# Release A: missed-drawing alert only (November 26, 2026)

## Production record

| Item | Value |
|---|---|
| Deployed | 2026-11-27 00:54:08 UTC (6:54 PM CT Nov 26), owner-approved |
| Video Worker version | `61e98186-c418-4664-b798-516091d5b344` at 100% (Wrangler tag `e53af84`) |
| Source | `e53af84` on `task/live-missed-drawing-alert`; annotated Git tag `video-worker-61e98186`; merged into `main` |
| Bindings | Identical to `ced68381`: CONFIG KV `b70df87f…`, `DiscoveryScheduler` DO (coordinator `november-2026`), same 12 vars |
| Secrets | `ALERT_EMAIL_TO`, `ALERT_RESEND_API_KEY`, `FB_PAGE_ACCESS_TOKEN` (unchanged) |
| Triggers | Unchanged ("No non-versioned settings to sync"): `50-59 23 * 11 *`, `0-30 0 * 11,12 *` UTC |
| Verification | Tail during public `/raffle` loads: `LiveEvents.selection` and `DiscoveryScheduler` ran on `61e98186`, all `ok`, 0 exceptions, 0–1 ms CPU; page shows the Nov 26 manual Reel |
| Rollback | `npx wrangler versions deploy ced68381-190a-42dd-b426-511e14d88ea3@100% --name folh-facebook-live-discovery` (source `cf8252e`) |
| First live evaluation | Nov 27 from 6:16 PM CT: expect `missed-drawing-check` log lines, and no email if the drawing is selected |

Branch `task/live-missed-drawing-alert` (worktree `C:\Users\Jwerl\dev\.worktrees\friends-of-lake-henry\live-missed-drawing-alert`),
based on `cf8252e`, the recorded source of production Video Worker `ced68381-190a-42dd-b426-511e14d88ea3`. **Not deployed.**

Live discovery (`livestream.ts`, `poller.ts`, `graph.ts`) is byte-identical to production. The Photo Worker and Pages
are unchanged. The broader discovery change (Release B) stays on `task/live-missed-drawing`, held for the reason below.

## Graph evidence for the November 26 Reel (owner-run, Graph API v27.0)

| Field | Value |
|---|---|
| `from` | `144051422124740` (Friends of Lake Henry) |
| `published` / `embeddable` | `true` / `true` |
| `created_time` | `2026-11-27T00:03:41+0000` (6:03:41 PM CT; the signed webhook arrived 53 s later) |
| `live_status` | omitted |
| `published_posts` | OAuth error 210: Page access token required. So the video read used a non-Page token |

- **Production `cf8252e`:** drops the post because of its `/reel/` link (0 candidates, as observed).
- **Release B:** reads the metadata and rejects it as `not-live-video`, since a non-`/videos/` link has no Live evidence.
- **Both:** the missed-drawing alert fires at 6:16 PM (tested with this exact response).

**Not established:** whether the production Page token on Graph v26.0 returns `live_status` for a Reel-form Live while
it is broadcasting. The owner's read was after the broadcast, on v27.0, with a non-Page token.

## Why discovery is not changed tonight

No supported, verified signal proves Live origin for this Reel:

| Candidate signal | Status |
|---|---|
| `GET /{page}/live_videos` (LiveVideo, `broadcast_start_time`) | Meta documents no read operation; code 10 on Nov 3 |
| Video `live_video`, `is_live_streaming`, `broadcast_id` | Code 100 (unsupported) on Nov 3; undocumented |
| Video `created_time` in the drawing window | Documented, but an ordinary Reel uploaded at 6 PM looks identical. The owner's Nov 3 rule: do not infer Live origin from timing |
| Signed webhook `live_videos` change (`id`, `status`) | Meta's own Live signal. But the Photo Worker forwards only a body hash, and `webhookLiveHint` also fires for ordinary video posts |

Selecting on timing alone could put an ordinary Reel on the raffle page, so it is not done.

## Options for establishing Live origin (owner decision)

1. **Recommended: forward the signed `live_videos` webhook value.** A small Photo Worker change would pass the field
   name, `status` and LiveVideo `id` (all Meta-signed) to `LiveEvents.notify`. The Video Worker would accept a Page-owned,
   embeddable video created in the drawing window only when a signed `live_videos` event with status live arrived within
   minutes of its `created_time`. This needs Photo Worker approval, a verified payload (`id` is the LiveVideo ID, so its
   mapping to the Video ID must be confirmed from a real event), and a separate release.
2. **Observe tomorrow first.** Release B records each video's `live_status` and link form in the timing journal. Deployed
   before a drawing, it shows whether the Page token reports `LIVE` for a Reel-form Live during the broadcast. If it does,
   Release B already selects it with no timing inference.
3. **Policy change: accept timing evidence.** Treat "Page-owned, published, embeddable, created 5:55–6:10 PM, the only
   such video, plus a signed Live hint within 2 minutes" as Live origin. This reverses the Nov 3 rule, and an ordinary Reel
   posted with a hint in that window would be selected.

## What Release A contains

- The `live:missing:<day>` alert from Release B, unchanged:
  - **When:** from 6:16 PM CT on configured season days, evaluated by the cron through 6:30 PM plus one independent
    6:16 PM coordinator alarm.
  - **What clears it:** a manual save today, or an automatic selection first observed Live today at or after 5:30 PM in
    automatic mode.
  - **Once per day:** sent once per day, and not opened while a selection, paused-access or Graph-failure alert is open.
  - **Resolution:** a recovery email on resolution. Rechecks every 5 minutes after 6:30 PM while open, never past
    midnight. Optional `FB_NO_DRAWING_DAYS`.
- Detection checks never plan or resolve `live:missing:*` incidents.
- Ambiguous drawings no longer also count toward the "detection failing repeatedly" streak (one email, not two).
- Season-by-configuration port of the Video Worker part of `f6c73a4` (no migration; coordinator stays `november-2026`).
  `inSeasonDay` rejects impossible dates.

## Verification

- 183/183 tests (`npm test` without the D1 migration file, plus `live-timing-journal` and
  `tests/live-missed-drawing-alert.test.mjs`), run twice; 7/7 migration tests.
- The 12 alert tests cover:
  - Facebook not identifying the video as Live (a Reel with no status, a LIVE Reel dropped by the production link
    rule, an unproven `/videos/` post, a VOD never seen Live);
  - the exact Nov 26 response;
  - delayed indexing;
  - a late webhook recovery;
  - a manual-save recovery;
  - once per day, no-drawing days, the off-season and the 2027 season;
  - an expired token;
  - Resend failures retried with one idempotency key;
  - resource bounds.
- The Video, Photo and Pages typechecks pass, and the bundle builds (87 KiB).
- `wrangler deploy --dry-run` with the production config: bindings identical to `ced68381`.
- Cost per drawing day: 16 extra Durable Object requests, 16 KV reads (no writes) and 1 alarm. No extra Graph calls.

## Deployment (requires approval; outside 5:45–6:35 PM CT)

```powershell
cd C:\Users\Jwerl\dev\.worktrees\friends-of-lake-henry\live-missed-drawing-alert
git add -A; git commit   # then push the branch and tag video-worker-<version-prefix> after upload
npx wrangler versions upload -c workers/facebook-live/wrangler.video.activation.existing-account.json --message "Live: missed-drawing alert (<commit>)"
npx wrangler versions deploy <new-version-id>@100% -c workers/facebook-live/wrangler.video.activation.existing-account.json
npx wrangler deployments status --name folh-facebook-live-discovery
```

Verify:
- the version is at 100% with the same bindings and secrets;
- `wrangler tail` at the next drawing shows `missed-drawing-check` lines from 6:16 PM and no `missed-drawing-check-failed`;
- a drawing that is selected sends no email.

## Rollback

```powershell
npx wrangler versions deploy ced68381-190a-42dd-b426-511e14d88ea3@100% --name folh-facebook-live-discovery
```

The old code would resolve an open `live:missing:*` incident at its next check and send one recovery email, so roll back
when none is open. No KV, D1 or secret changes to undo.
