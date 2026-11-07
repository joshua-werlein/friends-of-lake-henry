# Unattended Live timing diagnostics

Implemented November 7, 2026. Diagnostics do not change video eligibility, Graph discovery, alarms, backoff, manual overrides or email delivery. No migrations or new bindings are required.

## Retrieve after the drawing

Sign in through `/admin/login`, then open:

`https://friendsoflakehenry.com/api/admin/raffle/live?timeline=2026-11-07`

The existing admin middleware requires the normal server-side admin session. GET is read-only and returns `Cache-Control: no-store`. The date must be November 1–30, 2026. Missing data returns `diagnostics: null`, not invented history. The existing admin GET without the parameter is unchanged.

`timeline` includes the previous first-occurrence summary and `diagnostics` with numeric epoch-millisecond timestamps, a bounded `entries` list, `first` stage markers and an eviction count (`dropped`). Convert timestamps to America/Chicago when reviewing; tonight's 6 PM is November 8 at 00:00 UTC.

## Recorded evidence

- `webhook-received`: receipt time at the Photo Worker, after signature/active-Page hint checks establish eligibility. Only a 12-character body-hash reference is retained. Invalid signatures and inactive routes are excluded.
- `webhook-forward`: forwarding start/finish durations and acceptance. Queue failure and RPC failure have sanitized status codes. Forwarding diagnostics run in background `waitUntil`; receipt diagnostics can survive a later D1 queue failure.
- `do-event`: coordinator receipt and accepted wake request. Existing hash deduplication and alarm behavior are preserved.
- `check-start`: alarm/check-start timestamp and trigger correlation, persisted before Graph work. A start without a result indicates interruption or diagnostic persistence failure.
- `check-result`: status, failure/pending/candidate/verified counts, per-video metadata/origin verification booleans and bounded status enum, Graph HTTP request phases/start/response-arrival times, poll completion, and successful selection/state-write completion timestamps. Empty, pending, failed, skipped/not-due, ambiguous and successful outcomes are recorded. Unhandled poll exceptions are recorded then rethrown as before.
- `public-visible`: first observed automatic resolution in the public API for a selection, captured asynchronously during the drawing window. There is no new KV read/write for diagnostics. Each Pages isolate reports a selection once; the DO deduplicates across viewers/isolates. This requires a real API request; it is not an unattended synthetic probe.

## Bounds and privacy

The existing singleton DO owns exactly 30 possible diagnostic day keys (`timing:v1:2026-11-DD`). Each stores at most 256 recent entries plus one earliest marker for each of the six stages. Graph request lists cap at 11 and video checks at eight per result. Repeated public reports do not write again while their record is retained. The old summary remains separate. No KV diagnostic journal, D1 records, raw webhooks, captions, URLs, tokens, headers, recipient addresses or arbitrary exceptions are persisted. Diagnostic read/modify/write operations serialize through an in-memory promise chain; failures are swallowed without changing detection decisions.

## Interpretation and limits

Use `alarmAt`/`check-start` for starts and `completedAt`, `selectionCompletedAt`, `stateCompletedAt` for completion. Existing public `updatedAt`/selection `observedAt` still represent check start. Graph per-request completion means response arrival, not body parsing; `pollMs` includes the complete verification path. `originVerified` indicates per-video evidence, not selection approval; ambiguity can still block selection.

These records survive without an attached tail. They are best effort: a DO/storage/platform failure, process interruption or failed background RPC can leave gaps. Diagnostics add bounded DO I/O and small RPC overhead, but do not change cadence or retry rules. More than 256 daily records evicts oldest entries, while first-stage markers survive. There is no automatic removal of these fixed November keys.

Public visibility is the server's observation immediately before constructing a successful response, not browser receipt or successful playback. It is not a measure of every Cloudflare location. A page loaded by SSR without API polling produces no public API marker. No Facebook player readiness or actual broadcast start is measured; obtain those independently if needed. Completed checks just after the drawing window are accepted when anchored to an in-window alarm (up to two minutes).

## Validation and rollback

Focused Node 20 suites cover timing persistence/bounds/redaction, Graph result reporting, public reporting, admin authentication, webhook behavior, schedule/retry/selection invariants and photo handling. Run `npm run test:live-timing` for the timing subset. Also validate all four TypeScript checks, both Worker bundles and the Astro build before deployment.

If diagnostics cause errors, restore the previous Live/Photo versions and previous Pages deployment recorded in the release receipt. Preserve `ALERTS_ENABLED=true`, `ALERTS_MODE=live`, existing secrets and schedules. The new fixed diagnostic keys can remain; no data rollback/migration is needed. Do not invoke `testDiscovery`, inject webhooks or alter live raffle data to verify instrumentation.
