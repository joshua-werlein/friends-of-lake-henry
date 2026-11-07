# Final email/Live release review — November 7, 2026

**NO-GO under the owner's all-gates-pass condition. Stopped before migration, commit, push, or deployment.** No implementation changes were made in this review.

## Four-fix verification

1. **Not fully corrected: delivery safety.** Envelopes are now saved before sending; message content, recovery timestamp, and key remain stable on ordinary retries. However, the first-attempt timestamp and potentially-accepted state are only saved **after** sending. `prepareDelivery` (`src/lib/server/alerts.ts:211`) leaves a first send with `firstAttemptAt=null` and `uncertain=false`; `deliverDue` sends at line 252, and the result save follows at line 258. If sending succeeds but that save is lost, the durable record still says no attempt occurred. A Node 20 mock probe confirmed: successful acceptance, failed result save, next evaluation 25 hours later => **two actual simulated deliveries**. The same omission exists in `claimLiveDeliveries`: claims return the envelope without durably recording a started/possibly accepted attempt. A lost result RPC leaves no expiry anchor. Resend retains deduplication keys for 24 hours: [provider documentation](https://resend.com/changelog/idempotency-keys).

   Required correction: persist a dispatch/claim marker, first-attempt timestamp, and conservative possibly-accepted state before handing an envelope to the network in both delivery paths. A confirmed rejection may clear that attempt's uncertainty, while earlier uncertain attempts must remain recorded. A lost result must retain its original expiry deadline and must never be re-keyed as definitely rejected. Add failed-result-save / lost-result-RPC tests followed by an evaluation beyond 24 hours.

   Also, the stored envelope freezes subject/text/HTML but **not From/To**. `resendBody` at line 109 reconstructs these from the current configuration on every retry. A sender/recipient configuration change can therefore produce a different payload for the same key. Freeze the complete provider payload or explicitly retire pending envelopes before such changes.

2. **Corrected for the reviewed newest-queue case.** Active post incidents missing from the newest 20 results are reread by primary key; failed posts remain signalled. Missing rows retire silently. Current signal IDs are loaded explicitly beyond the 200-active-incident sample, preventing those IDs being recreated because of the limit. Relevant regression tests passed.

3. **Corrected, default off.** Signed-webhook receipts live in a separate table, independent of queue source. Recording is gated by both alerts and the webhook-delivery switch; source/queue ownership is preserved. The heuristic requires two distinct eligible announcements after tracking begins, a ten-minute grace, and no receipt. Admin requeues/backfills are excluded; unknown/expired samples do not claim healthy recovery. The photo config sets `ALERT_WEBHOOK_DELIVERY_ENABLED=false`; leave it false. The Live Worker does not implement this photo-specific heuristic.

4. **Corrected for slow Resend isolation.** The serialized Live alarm only plans and stores alerts. Stateless cron sends and reports results through the DO. No Resend fetch occurs inside the alarm. The isolated slow/hanging-send tests passed once the Node 20 test-harness issue below was accounted for. Ordinary DO storage work remains on the alarm path; email network time does not.

## Validation and scope

- Used cached **Node v20.20.2**, without changing the machine's active Node installation.
- Initial targeted Node 20 run: 82 tests, **77 passed, 0 assertions failed, 5 cancelled**, exit 1. Cancellation begins in the hanging-send test: `Promise resolution is still pending but the event loop has already resolved`. Its mock waits on `AbortSignal.timeout`, whose timer does not keep Node 20 alive.
- Supplemental diagnostic: an ignored preload holds the event loop and clears it with a root `after` hook. With that test-only preload, **26/26 alert tests passed**, including the five cancelled tests. No implementation or tracked test file was edited. The ordinary Node 20 test command still needs a deterministic hanging-mock fix; this review does not claim the unmodified suite is green.
- Additional Node 20 Facebook/photo suites: **31/31 passed**. The remaining 56 tests in the first targeted run passed, covering the schedule, timeline, November 6 corrections, prize display, and video presentation.
- Four TypeScript checks, two Worker bundles, and Astro build passed under Node 20. Photo and disabled-video offline deployment guards passed. `git diff --check` passed. Production activation preflight could not run against a freshly read production receipt because authentication failed.
- No winner/placement/prize-display implementation or data change appears in this diff. The 15-second burst window and public polling are unchanged; the proposed 30-second KV cache TTL remains unimplemented. No Grayz'n Buffalo or other repository was modified.
- November 6's roughly 87-second interval remains unexplained; the revised implementation document now states that correctly.

## Migration 008 and production preflight

The revised SQL adds only:

- `ops_alert_incidents`: primary key `incident_id`, system/status/first-seen metadata, JSON record storage, and a `(system,status,first_seen_at)` index. Status is constrained to open/recovering/resolved.
- `ops_webhook_receipts`: primary key `post_id` and first receipt timestamp; the tracking-start sentinel is separate from numeric post IDs.

There are no alterations, foreign keys, or writes to existing raffle tables. Local D1 tests passed apply/reapply/CHECK/rollback checks and preserved existing photo data. Production must still be checked for the **new** `record_json` definition: `CREATE TABLE IF NOT EXISTS` would not upgrade the earlier draft schema if someone had already applied it. Confirm 001–007 and absence of 008 in production migration history before using the normal tracked migration mechanism to apply **only 008**. No production schema or history was changed in this review.

The first authenticated Cloudflare read (`GET` Live Worker settings) returned **HTTP 401, API code 10000**. Therefore the current production schema/migration history, actual Worker vars/bindings/schedules, deployed versions and rollback versions, current verification receipt, and current Pages deployment ID remain **unverified**. Existing local logs are historical evidence and were not substituted for current production state. The Cloudflare session needs reauthentication before these release gates can pass. No secret values were printed; no Resend key was requested, read, or stored.

The reviewed local Live activation configuration remains `workers/facebook-live/wrangler.video.activation.existing-account.json`: `video-entry.ts`, `DiscoveryScheduler` binding, existing `discovery-scheduler-v1` SQLite DO migration, minute cron, automation/probing true, access revision `rotated-metadata-v3`. Photo remains its separate Worker with two-minute cron, photo automation/autopublish/polling true, two extraction passes, existing AI/D1 and read/notify bindings. Both source configs retain `ALERTS_ENABLED=false`, `ALERTS_MODE=test`. Current production parity and rollback IDs could not be confirmed.

Read-only public checks succeeded: `/raffle`, `/api/raffle/month?month=2026-11`, and `/api/raffle/live` all returned HTTP 200. The Live API reported automatic selection with reason `verified-discovery`. Public November 6 rows remain Troy Lindberg / 288, Lyle Schlomer / 838, and Kent Johnson / 681. Kent's stored prize retains its Bonus prefix, which unchanged `prizeCells` maps to the public **3rd** label. Display regressions passed; no fresh browser screenshot was taken. These public checks do not independently verify either Worker's cron or webhook health.

## Release and Git status

- New commit SHA: **none**. New Worker deployments/versions: **none**.
- Migration 008: **not applied by this review**; its pre-existing production status is unverified due to 401.
- No Worker, Pages, secret, cron, or production data mutation occurred. No real email was sent. No Pages deploy was triggered by this review because nothing was pushed.
- Local `main`, `origin/main`, and a fresh `git ls-remote` agree at `3f4356d15fc9f7cc69c9ce3f2623f5dca7a4beb2`.
- The working tree remains dirty with Claude's unreleased source and documentation, the previous independent review, and this new report. It was intentionally not committed after the gate failed. Ignored local verification scripts/logs live in `.wrangler/final-review-*`.

After corrections and restored authentication, the authorized order remains: verify current schema/history/configs/receipt/rollback versions and Pages baseline; apply only tracked 008; commit and push reviewed files with the established Pages-skip protection; deploy Live activation config then Photo; verify versions, schedules, bindings, forwarding/publication flags, public board and unchanged Pages baseline. Keep alerts disabled and webhook heuristic off. Deploy only outside **17:50–18:31 America/Chicago**. Record actual deployment and rollback IDs then; do not reuse old log IDs.

## Secure email configuration — prepared only

Do this separately after the release blockers are fixed. Nothing in this section was executed.

For **each** production Worker, `folh-facebook-live-discovery` and `folh-facebook-winner-photos`:

1. In Cloudflare **Workers & Pages**, select the exact Worker, then **Settings → Variables and Secrets → Add**.
2. Select **Secret**, name `ALERT_RESEND_API_KEY`, and paste the dedicated domain-restricted sending-only key **directly into Cloudflare**. Do not paste it into chat, a shell command, or any repository file.
3. Add another **Secret**, `ALERT_EMAIL_TO`, containing the approved recipient address(es), comma-separated, maximum ten valid addresses.
4. Leave `ALERT_EMAIL_FROM` unset if the verified sender is `Friends of Lake Henry Alerts <alerts@friendsoflakehenry.com>`. Only add a plain variable with a different verified sender if required.
5. Check `ALERTS_ENABLED=false` and `ALERTS_MODE=test` before saving/deploying the settings. Keep the photo webhook-delivery switch false. Cloudflare's Deploy action creates a production settings deployment; schedule it outside the protected window and record its version.

The owner reports the domain and dedicated key are ready; Forge activation requires no additional binding in this implementation. Cloudflare hides stored secret values: [secure configuration instructions](https://developers.cloudflare.com/workers/configuration/secrets/).

Separate dry-run activation procedure, after the fixes and production release pass:

1. Attach `wrangler tail` to one Worker before an eligible evaluation, then set only that Worker's `ALERTS_ENABLED=true`, keeping `ALERTS_MODE=test` and webhook heuristic false. Preserve all existing automation flags and bindings.
2. Inspect `alert-test-mode` keys/subjects and incident transitions. Photo evaluates on eligible poll ticks; Live detection plans during the drawing window and cron delivers dry-run logs until 20:00 Central. No incident means no test message; use mocked tests for forced scenarios rather than breaking production automation.
3. Verify Live timing/cadence and photo publication, then repeat on the other Worker. Set alerts false again if ending the dry run. Keep deployed vars and source configuration consistent to prevent a later deploy from resetting the chosen state.
4. **Test mode logs only; it does not send even a test email through Resend and does not require the key.** A real mailbox delivery test requires additional approval and a controlled live-mode procedure. Do not switch `ALERTS_MODE=live` without that approval.

Stopped after review and verification. No security upgrades, Astro migration, polling cleanup, or account migration was started.
