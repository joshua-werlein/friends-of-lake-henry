# November 2026 discovery stabilization

This directory tracks the live-only implementation already deployed separately as
`folh-facebook-live-discovery`. Photo importing and AI bindings are excluded.

The unchanged `*/5 * * * *` cron does actual discovery only in November 2026,
17:30 inclusive to 19:30 exclusive in `America/Chicago`. The last check is 19:25.
The timezone gate precedes every KV/Meta operation, handles UTC midnight and DST,
and never activates an unconfirmed future season. Completed checks persist one
final heartbeat, including unchanged results and provider failures. Interrupted
checks leave the previous health timestamp unchanged.

Expected normal daily usage: 24 state writes and 72 KV reads, plus selection writes
when a candidate changes. Off-hours: zero KV/Meta operations. Public page requests,
administrator activity and retries are separate. Public polling remains 15 seconds.
The Worker never writes the saved manual video.

Pages must be released first. Its resolver retains matching healthy closing
verification from 19:20 or 19:25 overnight, preserving receipt, identity, failure,
pause, season and 36-hour video-age checks. The next drawing window requires fresh
health. Failed closing checks fall back to manual. A broadcast first posted after
19:25 needs manual selection or discovery in the next confirmed window.

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
   Keep both existing flags true, the single cron unchanged, and only CONFIG bound.
   Do not run staging diagnostics or upload a replacement token.
7. Observe an in-window check and an off-hours cron: one final heartbeat versus
   `outside-drawing-window` with no KV/Meta operations. Verify saved manual video
   and winners are unchanged. Check replay more than ten minutes after closing
   and recovery next window without manufacturing production KV values.

Rollback: restore the previous Worker version first, then the previous Pages
deployment if needed. Reversing that order would reintroduce ten-minute replay
expiration while checks are stopped. No migration, reset, binding change, KV
cleanup or data rollback is required.
