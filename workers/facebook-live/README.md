# November 2026 discovery stabilization

This directory tracks the live-only implementation already deployed separately as
`folh-facebook-live-discovery`. Photo importing and AI bindings are excluded.

The temporary `* * * * *` cron wakes one private SQLite-backed Durable Object
(`DISCOVERY_SCHEDULER`, singleton name `november-2026`) only in November 2026,
17:50 through 18:10 inclusive in `America/Chicago`. Its durable alarms select
minute slots at 17:50–17:58 and 18:02–18:10, and quarter-minute slots at
17:59–18:01 (:00, :15, :30, :45). There are 30 slots daily (9 + 12 + 9).
The entire 18:10 minute is eligible; 18:11 exits.
The timezone gate precedes every KV/Meta operation, handles UTC midnight and DST,
and never activates an unconfirmed future season. Completed checks persist one
final heartbeat, including unchanged results and provider failures. Interrupted
checks leave the previous health timestamp unchanged.

Expected normal daily usage: 30 state writes and 30 receipt reads, plus two initial
KV reads to bootstrap the coordinator's strongly consistent state/selection cache,
and selection writes
when a candidate changes. Off-hours: zero KV/Meta operations. Public page requests,
administrator activity and retries are separate. Public polling remains 15 seconds.
The Worker never writes the saved manual video. Durable Object storage operations
are separate from Workers KV. Normal operation needs about 21 cron-to-object calls
and 30 alarms daily, plus small durable claims/cache/alarm writes. SQLite Durable
Objects are available on Workers Free; this does not require a paid plan, but
account-wide quotas still apply. References:
[alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Only alarms may run discovery; Cloudflare guarantees one alarm handler at a time
per object. Each slot is durably claimed before discovery, so a retried alarm or
restart cannot repeat it. A slow check skips passed slots rather than overlapping
or catching up. Cron kicks can rearm a lost alarm but never contact Facebook.
Backoff remains based on the 60-second base interval, including during the burst;
Retry-After is never shortened. A crash after a claim can lose that check by design;
the next alarm/cron recovers. Exact wall-clock delivery is not guaranteed.
The coordinator keeps final retry/pause state in SQLite before the public KV
heartbeat so stale KV or a failed KV write cannot erase backoff. Only its own
state/selection are cached; verification receipts remain checked on every poll.
Out-of-band edits to these coordinator-owned keys are not a supported control;
use existing manual selection or the access revision for recovery.

Pages must be released first. Its resolver retains matching successful
verification from the last scheduled window overnight, preserving receipt, identity, failure,
pause, season and 36-hour video-age checks. The next drawing window requires fresh
health. Failed closing checks fall back to manual. A broadcast first available
after the last 18:10 check needs manual selection or discovery in the next confirmed
window. Backoff near closing, a delayed cron arriving at 18:11, or Facebook feed
latency can also cause an evening's discovery to be missed. Empty responses never
clear the saved video. A successful verification earlier in the window remains
usable off-hours if subsequent ticks were missed, but an explicitly failed final
check retains the existing manual fallback. The 36-hour video-age and season/receipt
expiry limits remain; this does not authorize playback beyond their expiration.

This is a temporary schedule until Facebook webhook integration is implemented
and verified. The 30 checks are discovery cycles, not individual HTTP requests:
each cycle can read Page identity, posts and video metadata.

## Deployment after explicit approval only

1. Recheck current releases for intervening changes. Inspected November 2 baseline:
   Pages commit `6fd0092546363d3f46d077a01b9c522f70aea198`, Worker version
   `de963a6c-0500-4795-9c99-fc94443778eb`.
2. Run `npm test`, `npm run typecheck`, `npm run typecheck:pages-api`,
   `npm run typecheck:facebook-worker`, `npm run build`, and
   `npm run build:facebook-worker` using the established Node 20 release environment.
3. Release the approved site commit through the existing Cloudflare Pages Git
   workflow on production branch `main`. Confirm its new resolver is live before
   publishing the Worker. Feature-branch pushes can create previews with production
   bindings; do not push casually.
4. Verify account `aa86268490e681cccb3a41a62093e2aa`, CONFIG namespace
   `b70df87ff3db4230a621d4a39ab24ff7`, existing encrypted token, current policy
   receipt, and sole cron ownership. Do not recreate bindings or secrets.
5. Run the existing offline activation checker with an independently read,
   non-secret receipt, the active configuration, and the existing account/policy
   assertions. It neither deploys nor writes a receipt:
   `node --import ./tests/register.mjs workers/facebook-live/check-activation.mjs workers/facebook-live/wrangler.video.activation.existing-account.json <receipt-path>`.
6. Publish with the existing Wrangler installation:
   `wrangler deploy --config workers/facebook-live/wrangler.video.activation.existing-account.json`.
   Use this active profile, not the similarly named disabled verification profile.
   Keep both existing flags true and the existing CONFIG binding. Add only
   `DISCOVERY_SCHEDULER` and class migration `discovery-scheduler-v1` using
   `new_sqlite_classes: ["DiscoveryScheduler"]`. This provisions a new isolated
   coordinator namespace; it is not a D1 migration and does not migrate raffle data.
   Change the sole cron from
   `*/5 * * * *` to `* * * * *` and the polling interval from 300 to 60 seconds.
   Other variables, bindings, the encrypted token, manual video and data stay intact.
   Do not run staging diagnostics or upload a replacement token.
7. Observe an in-window check and an off-hours cron: one final heartbeat versus
   `outside-drawing-window` with no KV/Meta operations. Verify saved manual video
   and winners are unchanged. Check replay more than ten minutes after closing
   and recovery next window without manufacturing production KV values.

Rollback needs to account for the new Durable Object class. Do not assume a
dashboard version rollback across its creation migration is supported. For safe
containment publish this reviewed Worker with both automation/probe flags false,
retaining the class, binding, migration history and cron. Alarm and cron handlers
then exit without discovery; the saved manual video is untouched. Verify manual
fallback before rolling back Pages. Reinstating the previous single-minute code
requires retaining an inert exported DiscoveryScheduler class so old alarms cannot
run alongside the restored direct polling handler. Do not delete the namespace,
reverse its creation migration, or reset D1/KV data as a rollback shortcut.
