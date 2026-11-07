# Email alerts and Live detection latency — 2026-11-07

Local, uncommitted, undeployed. Nothing here has touched production D1, KV, R2, secrets, Facebook or Resend.

## 1. Email alerts

### Design (revised after the independent review)
- `src/lib/server/alerts.ts` is the shared engine. It's level-triggered: each evaluation reports the problems that exist now. Each problem has a **stable incident ID**. It is emailed once when it crosses its threshold, and once more as a recovery when it's **confirmed** resolved.
- Every email goes through three steps:
  1. **Plan** (pure). A due email is frozen into an immutable envelope: `Idempotency-Key: folh:<incident>:<firstSeenAt>:<alert|recovery>:<mode>:v<n>` plus the exact subject, text and HTML. It's rendered only from stored fields, and the recovery time is the stored `resolvedAt`.
  2. **Persist**. The incident and its envelope are written **before** any send. If that write fails, nothing is sent.
  3. **Deliver**. The stored envelope is sent verbatim. Every retry reuses the same key and the same bytes. A delivery ledger (the last 12 entries) records each attempt.
- Delivery outcomes:
  - **2xx**: delivered.
  - **Timeout, transport error, 5xx or 409**: *uncertain*, because the email may already have been accepted. Retried with the same envelope after 4, 8, 16, 32, then 60 minutes.
  - **429**: not accepted. Retried, honoring `Retry-After`.
  - **Other 4xx**: not accepted. Retried every 6 hours.
- If the save after a successful send fails, the next run resends the same envelope, and Resend's idempotency deduplicates it.
- **24-hour idempotency window**. A key is reused for at most 23 hours after its first attempt.
  - If any attempt was uncertain, the email is then counted as possibly delivered and is **never** resent, so it can't duplicate.
  - If every attempt was definitely rejected, the email is re-keyed (`v2`) and sent.
  - After 10 attempts, the envelope stops.
- If an incident resolves while its alert is still unconfirmed, the alert counts as possibly delivered and a recovery follows. If the alert was never possibly delivered, the incident closes silently.
- **Dispatch claim (final release fix).** Before every request, a claim is stored: the first-attempt time, a conservative "possibly delivered" flag, and a 5-minute lease.
  - Photo Worker: compare-and-set on the exact stored row, in D1.
  - Live Worker: written inside the serialized Durable Object before `/alerts/claim` returns.
  - If that write fails, or a concurrent run won the claim, nothing is sent.
  - An unknown outcome (lost result save or lost result RPC) is never treated as a failure. The claim keeps its first-attempt deadline and its uncertainty, so the email is retried with the same key inside 23 hours and is never resent or re-keyed after that.
  - Only a confirmed rejection clears that attempt's uncertainty; earlier possibly-accepted attempts stay recorded.
  - The envelope freezes the full provider payload, **including From and To**. A configuration change affects only new emails.
- Storage per Worker:
  - **Photo Worker**: D1, migration 008.
  - **Live Worker**: the existing `DiscoveryScheduler` Durable Object storage. No KV is used.
- Writes happen only on transitions. A healthy system, or one with an already-reported problem, writes nothing.
- **Photo Worker delivery**: inline after the queue drains (`finally`). At most 3 sends per evaluation, 5-second timeout.
- **Live Worker delivery**: the serialized detection alarm only *plans*, using DO storage and no network. The every-minute cron sends the email from the stateless Worker:
  - It claims due envelopes from the DO (`/alerts/claim`), sends them, and reports each result (`/alerts/result`).
  - A result applies only if its key still matches the stored envelope.
  - The cron runs from 17:50 to 19:59 Central in November.
  - A slow or failing Resend therefore can't delay the next detection alarm. There's a regression test for hanging, 500 and slow-but-blocked sends.
- Diagnostics include codes, counts, numeric IDs and timestamps only. URLs, tokens, long opaque strings and free text are redacted. Winner names are never included.
- Every email contains: system, incident ID, first-detected time (Central and ISO), problem, suggested action and diagnostics.

### Switches (Worker vars; both configs ship with alerts off)
| Var | Default | Meaning |
|---|---|---|
| `ALERTS_ENABLED` | `"false"` | Anything but `true`: no evaluation, reads or writes at all |
| `ALERTS_MODE` | `"test"` | `test`: dry run. Logs `alert-test-mode` with subject, no recipients, no Resend call. `live` sends, but only if the key and recipients are set; otherwise it falls back to test |
| `ALERT_EMAIL_FROM` | unset → `Friends of Lake Henry Alerts <alerts@friendsoflakehenry.com>` | Optional |
| `ALERT_WEBHOOK_DELIVERY_ENABLED` | `"false"` (photo Worker only) | Records signed-webhook receipts and enables `photo:webhook-delivery`. Leave off until dry-run evidence supports it |

**Secrets** (set on *both* `folh-facebook-winner-photos` and `folh-facebook-live-discovery`):
- `ALERT_RESEND_API_KEY`
- `ALERT_EMAIL_TO` (comma-separated, maximum 10)

The preflight scripts allow the vars above and still reject the key and recipients as plain vars.

When the mode switches from test to live, any incident that is still open is emailed for real once.

### Alerts and thresholds
| Incident ID | Trigger | Threshold | Recovery email |
|---|---|---|---|
| `photo:graph-auth` | This tick's poll, or any unfinished post (full count, not a sample), fails with `token-expired` / `permission-denied` / `missing-token` | 2 consecutive evaluations | yes |
| `photo:webhook-config` | Automation on, but the active route lacks its app secret or verify token | 1 | yes |
| `photo:webhook-delivery` (off by default) | The last two eligible announcements have **no signed-webhook receipt** 10 minutes after queueing. Receipts are recorded per post, separately from the queue source. Admin requeues and posts queued before tracking began are excluded. Fewer than two samples counts as unknown | 1 | yes, only when the newest eligible post has a receipt. Ageing out of the 7-day sample closes silently |
| `photo:post:<postId>` | Post `failed` (6 attempts or permanent), **or** still pending ≥20 min, **or** ≥3 attempts. Titled "AI extraction" when the error code is AI-related | 1 | yes, only after the post's own row (re-read by primary key) shows it finished. A missing row closes silently |
| `photo:review:<photoId>` | Import `held` / `rejected` / `partial` within 72 h (held and rejected row counts included) | 1 | no. Manual review isn't observable; closes silently |
| `live:access-paused` | Live poller paused itself (token expired, permission denied, identity, contract) | 1 | yes |
| `live:graph-failures` | ≥3 consecutive failed Live checks (about 45 s at the drawing cadence) | 3 | yes, on the next success |
| `live:selection:<day>` | Graph confirmed a Live raffle video today, but it hasn't been staged | 60 s after first confirmation | yes, when staged. A past day's incident closes silently |

Never alerted:
- No livestream that day.
- No announcement posted.
- Only an unproven (pending) VOD.
- Admin-disabled automation.
- `candidates-only` (probing off).

Photo alerts are evaluated only on poll ticks (every 2 minutes from 17:45 to midnight Central, otherwise twice an hour). Each evaluation runs:
- one D1 batch of 3 bounded SELECTs
- an incident load
- primary-key re-reads for active post/review incidents that the bounded discovery read didn't return. Absence from a limited read is treated as unknown, not healthy.

Up to 200 active incidents are loaded, plus every ID named by a current signal. An unloaded incident is never recreated or re-emailed, and `alerts-active-limit` is logged. Live alerts are evaluated only after a check that actually ran, inside the drawing window.

### Migration (additive)
- `migrations/008_ops_alert_incidents.sql` adds two tables and no column changes:
  - `ops_alert_incidents`: one row per incident, holding the full record, including the frozen envelope and ledger, in `record_json`.
  - `ops_webhook_receipts`: per-post signed-webhook receipts, written only when `ALERT_WEBHOOK_DELIVERY_ENABLED=true`.
- 008 was redefined after the review. It has never been applied anywhere.
- Rollback: `migrations/rollback/008_ops_alert_incidents.down.sql`. The preferred rollback is to leave the tables in place, because dropping them loses deduplication history.
- The code tolerates the tables being missing: it logs `alerts-unavailable` and sends nothing.
- Tests cover: applying 008, re-applying it, the CHECK constraint, and rollback preserving unrelated tables.

### Resend setup
- The owner reports: `friendsoflakehenry.com` is verified in Resend, and a dedicated **Sending access** key exists for that domain. I didn't inspect the key or the DNS. Preserve the existing mail and DMARC records.
- Set `ALERT_RESEND_API_KEY` and `ALERT_EMAIL_TO` as secrets on **both** Workers.

## 2. Live detection timing

### Path, as implemented
1. Meta sends the signed webhook to the photo Worker.
2. The photo Worker verifies the HMAC, then does one D1 enqueue per post ID.
3. It calls the `LiveEvents.notify` service binding.
4. The DO handles `/event` under `blockConcurrencyWhile`: KV heartbeat write, DO writes, then `setAlarm(now)`.
5. The alarm fires.
6. The alarm runs the Graph checks (identity, `published_posts`, ≤8 video reads, one format probe), then writes the KV selection and the KV state.
7. Public `/api/raffle/live` reads 4 KV keys (default edge cache 60 s) and requires both the selection and the matching state.
8. The page refreshes every 15 s (`no-store`). This is unchanged.

### November 6 (5:58:48.065 webhook → 6:00:15.001 selection)
- **The roughly 87-second interval remains unexplained.**
- The earlier version of this document said the 6:00:15.001 timestamp (1 ms after a 15-second slot boundary) proved the scheduled alarm made the selection. That was wrong. A webhook-triggered check can finish near a slot boundary, and an earlier check can finish later than it started. The timestamp doesn't establish which trigger ran.
- The existing timeline tests show three *possible* mechanisms. None is established as the historical cause:
  - **(a)** Graph didn't yet list the video, or didn't yet report it `LIVE`.
  - **(b)** A transient failure set a 120 s backoff that suppressed the 15 s burst.
  - **(c)** The 5:58:48 event was a pre-live or feed change.
- Production logs weren't retained (Worker observability is off), so the repository can't distinguish them.
- The 87 s interval also doesn't measure broadcast start to on-page display.

### Implemented
- **Burst retry** (`poller.ts`): when the next slot falls in the 5:59–6:01 15-second cadence, a transient failure retries on the next slot for the first 3 consecutive failures, instead of backing off 120 s.
  - Excluded: rate limits, Retry-After, paused access, and anything outside the burst. These keep the existing backoff.
  - It never exceeds the healthy request rate, and adds no KV operations beyond what a healthy check would do.
  - This mitigates the modeled transient-backoff mechanism (b). In the simulation, a failure at 5:58:00 now leads to selection at 5:59:00 instead of 6:00:00 or 6:00:15, with a regression test. It doesn't address (a) or (c), and it isn't evidence about November 6.
- **Correlated timing:**
  - Photo Worker logs `webhook-live-forwarded` / `webhook-live-forward-failed` with `eventRef` (the first 12 hex characters of the body hash), `receivedAt`, `queueMs` and `notifyMs`.
  - The Live DO logs `live-timing` for every check: `trigger`, `eventRef` / `slotAt`, `wakeLagMs`, `graphRequests`, `graphMs`, `selectionWriteMs`, `stateWriteMs`, `pollMs`, `status`, `liveVideo`, `selected`.
- **What the timing fields measure.** They're correlated stage markers, not exact provider-event or browser-display times:
  - `graphMs` is fetch response arrival, not body parsing.
  - `pollMs` covers the whole check.
  - `firstLiveEvidenceAt` records the start of the check that saw Live.
  - `firstSelectedAt` is recorded after the state write.
- **Per-day timeline** in DO storage, holding the first webhook, first Live evidence and first selection (with trigger, wake lag and Graph time). It costs at most 3 writes per day. Read-only access is `LiveEvents.timeline('2026-11-DD')`, which the Pages binding can already call. No UI was added.

### Proposed, not implemented (evidence needed)
1. **Public KV staleness is probably the largest broadcast-to-display delay.** Selection and state can each be cached up to about 60 s at an edge after the DO writes them. If only the selection is fresh, the page shows the manual or fallback video.
   - Option: `cacheTtl: 30` on those two reads. The minimum dropped from 60 to 30 s on 2026-01-30. Billed read count is unchanged.
   - Not applied: the local Miniflare (Nov 2025) predates that change, and an older runtime rejects values under 60. A rejection would make every request fall back to manual. That needs a preview deployment check first.
   - Stronger option: serve the selection from the DO (strongly consistent) through the service binding.
2. **Enable Worker `observability`** so `live-timing` logs are retained. The preflight scripts currently reject that key, so it needs a reviewed preflight change.
3. **Extend the 15 s cadence through 6:03:59**, only if the timeline shows broadcasts starting after 6:01:45 without a timely webhook. Cost: 8 more checks and 8 more KV writes per drawing day.
4. **Webhook follow-up checks** (a few short re-checks after a webhook that didn't select), only if timelines show cause (c).

## 3. Deployment order (for Sol, after owner approval)
1. Apply **only migration 008** to `folh-db`, after confirming 001–007 are present. Record the existing Worker versions for rollback.
2. Deploy the Live Worker with its **activation** config, outside 17:50–18:31 Central. Alerts stay off. There's no DO class or migration change.
3. Deploy the photo Worker. Alerts stay off, and `ALERT_WEBHOOK_DELIVERY_ENABLED=false`.
4. Set the two secrets on both Workers. Enable **one Worker at a time** with `ALERTS_ENABLED=true`, `ALERTS_MODE=test`, with a live tail attached.
   - Live dry-run messages appear from the cron (`alert-test-mode`).
   - Confirm the `live-timing` cadence is unchanged.
5. With explicit approval for real email, set `ALERTS_MODE=live` on each Worker in turn.

**Rollback:**
- Set alerts disabled, or restore each Worker's previous version.
- Keep migration 008 and its history.
- Rolling back the Live Worker also removes the burst retry and timing logs, but keeps the previous detection behaviour.

## 4. External blocker (owner)
- Sol's production verification failed at the first authenticated Cloudflare read with **HTTP 401, API code 10000**. The Cloudflare session needs the owner to re-authenticate.
- Until then, these stay unverified: production migration history (confirm 001–007 are present and 008 is absent), deployed Worker vars, bindings and schedules, rollback versions, the current verification receipt, and the Pages baseline.
- No credentials were changed during this work.

## 5. Known limits
- A D1 outage can't be alerted through a D1-backed tracker. It's logged only.
- `photo:post` is one email per post. It doesn't re-alert when "not completing" becomes "failed".
- `photo:webhook-delivery` is receipt-based but still unproven against real Meta deliveries. It ships disabled.
- Live emails leave from the cron, so delivery lags detection by up to about a minute. Cron delivery stops at 20:00 Central; anything pending resumes at the next day's window.
- An email that ends *uncertain* (possibly delivered, never confirmed) isn't resent after 23 hours. It's logged, and its recovery still follows.
- Live alerts exist only inside the drawing window. A Live token that expires overnight is reported at the first 17:50 check.
