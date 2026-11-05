# Facebook integration audit — November 4, 2026 (America/Chicago)

Baseline: `origin/main` at merged PR #3, `f2d224b`. Work is isolated on `codex/facebook-reliability-audit`. Production reads, temporary sanitized log tails, and isolated Workers AI inference only. No deployment, subscription edit, secret replacement, activation, queue reprocessing, winner mutation, or policy-receipt write was performed.

## 1. Verified working

- Existing photo Worker has `FB_APP_SECRET`, `FB_WEBHOOK_VERIFY_TOKEN`, and `FB_PAGE_ACCESS_TOKEN` as encrypted `secret_text` bindings. Their values were not retrieved or printed. Its private status confirms webhook configuration and `FACEBOOK_LIVE` binding presence.
- Page-token diagnostics return app `1700219394854878`, type PAGE, valid, and granted `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `public_profile`. `business_management` is absent from this deployed token, despite being requested in the app UI. Page identity, published posts, video metadata, and Page subscription reads succeed without it.
- `GET /144051422124740/subscribed_apps?fields=id,subscribed_fields` returns this app subscribed to `feed`.
- The authenticated Meta dashboard's direct [Webhooks URL](https://developers.facebook.com/apps/1700219394854878/webhooks/) opens successfully despite no sidebar menu. Select **Page**, not User. The Page callback is `https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook`; `feed` is Subscribed at **v26.0**. This independently verifies the app-level subscription through the UI.
- Callback without a verification query returns 403; unsigned POST returns 403 and logs `webhook-bad-signature`. Code and isolated workerd tests verify successful GET challenge echo and raw-body HMAC-SHA256 acceptance, rejection, durable queue-before-acknowledgment, redelivery deduplication, and video hint forwarding. These tests do not prove a valid production App Secret until Meta's signed test succeeds.
- Photo fallback polling still runs on `*/2 * * * *`, logged `poll`, queued=0, outcome=ok during audit. Both actual November 3–4 posts came from `poll`, status done, attempts=1, error_code=null. There are four queue records, all poll-sourced; none were webhook-sourced at the initial read. Queue source is first-insert provenance, so this alone cannot exclude a later webhook for an existing post.
- Live cron remains `* * * * *`; original DiscoveryScheduler namespace, KV, D1, services and secrets are unchanged. Manual video is November 4 video `2008286453186547`, automaticEnabled=false. Corrected published winners and the existing admin editing release remain intact.

## 2. Broken or unconfigured

### Scheduled Live transport

The coordinator stores the Workers global `fetch` as a class property and invokes it through `this.fetcher(...)`. In workerd this produces `TypeError: Illegal invocation: function called with incorrect this reference`. Direct diagnostics use a bare fetch function and succeed, explaining the discrepancy. The retained production automation state reports identity-phase `transport-error`, five failures, last attempt at November 4 6:00 PM Central. This is consistent with the reproduced defect, not evidence of token expiry. Later scheduled calls were disabled by the saved administrator setting.

Prepared fix: wrap the default fetch in an arrow function. A new workerd regression exercises the actual coordinator's default transport, event → alarm → three mocked Graph reads → stored positive Live observation. It verifies manual fallback preservation, no automatic stage and no fabricated receipt when the current receipt is absent. See [Cloudflare's explanation of illegal invocation](https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors).

### Winner extraction

The old prompt requested prize text "printed next to" a winner but did not explicitly inherit column headers. Both passes used the same Mistral model, identical prompt and temperature 0; they were repeated reads, not independent evidence against a shared systematic mistake. November 4 warnings recognized Firearm/Gift Card columns but rows omitted those headings. Warnings were not publication gates. The validator required hometown while allowing null prize/place. This rejected Jim and published incomplete Rob. The source images were already the largest Graph variants; no download-size defect was found.

Prepared fixes: two differently instructed table reads, explicit header inheritance and row/date association, full city/state transcription, exact ticket-string agreement, and explicit `townStatus` to distinguish a fully visible blank cell from uncertain/cropped text. At least two reads are required. A genuinely blank hometown is accepted only when both reads confirm it; uncertainty/notes remain held. A new row must match exactly one approved scheduled prize for its date. Missing, unmatched or ambiguous prize evidence and unresolved image warnings are held. No calendar or conflicting calendar entries also hold the row. Existing winners are never overwritten. Numeric places still require printed numeric labels; no category/order-to-place mapping was silently introduced.

## 3. Blocked by Meta / evidence limits

- The actual Page Webhooks screen explicitly states that **unpublished apps receive dashboard tests only**, and production data is not delivered even for app admins, developers or testers. The app is Unpublished. This is a specific observed delivery blocker, not an inference from missing business verification.
- The Publish screen has a disabled final Publish button and lists unfinished Business verification, App Review and publishing tasks. The `pages_manage_metadata` Requirements tooltip lists Business Verification, App Review, a successful API test call and data handling questions for the selected request flow. The app has recorded calls and Ready for testing, which is not review approval or publishing.
- `business_management` is marked Required for use case in the selected Manage Pages interface. That explains why its Remove action is unavailable. No application code calls Business Manager endpoints; successful deployed Page operations prove it is not their technical prerequisite. The dashboard bundle and backend endpoint requirements are separate. No alternate own-Page publishing exemption was verified; no use case or permission was removed.
- The Access verification panel describes Tech Providers accessing **other businesses'** assets. This integration is for the organization's own Page; do not claim Tech Provider access verification is required solely because that panel appears. Likewise, comparisons with other apps do not establish the requirements for this app/use-case configuration. No new portfolio, app, business permission or Live Video API feature was added.
- The official [Access Levels documentation](https://developers.facebook.com/docs/graph-api/overview/access-levels/) says role-only users need Standard Access, but explicitly limits that document to apps created using an App Type. This app uses the newer use-case dashboard. The current [Publish documentation](https://developers.facebook.com/documentation/development/release) also generally exempts role-only use from review and verification, while the app-specific Page Webhooks banner still forbids real deliveries while Unpublished. Therefore existing administrator permissions are demonstrably sufficient for the tested reads/subscription, but cannot bypass this observed webhook delivery gate. The selected request flow lists verification/review requirements; that is not proof that every own-Page integration must obtain Advanced Access or attach a business portfolio. The remaining ambiguity is the minimum publishing path for this specific use-case app, not the validity of its already-working Page token.
- The Page token cannot inspect app-level `/{app-id}/subscriptions`: actual HTTP 400 / Meta code 104. That requires an app credential, not an extra Page permission. An app access token may read/configure the existing app subscription, but doing so does not bypass the unpublished delivery restriction.
- Initial 150-second sanitized tail: no accepted signed receipt or Live `notify` call. KV `raffle_live_webhook_state` was absent. Only this audit's unsigned POST was observed and rejected. Live tail is prospective, not a complete historical delivery archive. Subsequent owner-test observation is recorded below.
- Meta's public documentation URLs returned 429 through web fetch; Access Levels and Publish documentation were subsequently read successfully in the browser. App-specific access/publishing conclusions above are based on the actual authenticated dashboard and production Graph responses. No unsupported API endpoint for remotely triggering a Meta sample has been assumed.

## 4. Requires owner action in Meta

1. The signed **Page → feed → Test v26.0** sample passed. See the timestamp and sanitized Worker result below. The fictional post `44444444_444444444` and Test Page `1067280970047460` are outside the official Page allowlist.
2. Resolve the existing app's publishing checklist. Current evidence points to the selected use case's verification/review flow; obtain Meta's explicit own-Page/Standard Access publishing path or complete the requirements shown for this app. Do not create another app, attach a portfolio, request Advanced Access or add Live Video API permissions based only on assumptions. No additional action is needed to grant the deployed token `business_management` for the working reads.
3. After publishing is permitted and approved, observe a real official Page event during an agreed monitor window. Do not publish a test Facebook post without approval. Winner-photo events require Page ownership and a Graph re-read before processing. Existing final imports dedupe instead of re-running. A video/status event may wake discovery but is not itself proof of Live origin.

### Graph and Cloudflare commands (reference only; not executed to change settings)

Read-only Graph API Explorer requests, using the appropriate token privately:

```text
GET v26.0/1700219394854878/subscriptions
    Credential: app access token for this app (not the Page token).
GET v26.0/144051422124740/subscribed_apps?fields=id,subscribed_fields
    Credential: existing Page token with pages_manage_metadata.
```

If a subscription were missing, the existing API supports `POST /1700219394854878/subscriptions` with object=page, fields=feed, callback_url=the existing callback and verify_token=the existing verification token, authenticated with the app credential. Page installation uses `POST /144051422124740/subscribed_apps` with subscribed_fields=feed and the Page token. Both subscriptions were observed present, so **do not repeat either write now**. Do not put any token/secret in chat, source, logged URLs or command history. Use Meta's dashboard sample to test authentic delivery; locally signing a POST is only a receiver test.

Secrets already exist. Only if replacement becomes necessary and is approved, enter values at Wrangler's interactive prompts:

```powershell
node node_modules/wrangler/bin/wrangler.js secret put FB_APP_SECRET --config workers/facebook-photos/wrangler.json
node node_modules/wrangler/bin/wrangler.js secret put FB_WEBHOOK_VERIFY_TOKEN --config workers/facebook-photos/wrangler.json
```

Do not rotate these merely to investigate. A configured binding proves presence, not that its value matches Meta's current secret/token. A real dashboard handshake/signature test resolves that distinction without revealing values.

## 5. Real-image before and after

Fixtures are public Page announcement images, verified against immutable production SHA-256 audits:

- November 3: photo `122333284628073310`, 1036×231, SHA-256 `8fe16e93009ddb2a19ef43c6cc64670f3be0bd0945331e24e2f0ae444c706ef9`.
- November 4: photo `122333482004073310`, 1030×249, SHA-256 `e4c9943181cbc03bd3f41d1bbbecdce58bd0bb5ba5593445a898af7fb30f37ee`.

The stored before passes are in each fixture's `.json`; actual new Workers AI responses are in `.table-vision.json`. No mocked extraction is presented as an actual model read. An initial trial recovered headings but omitted state abbreviations and speculated about truncation; those failed trial outputs remain in the ignored audit directory. A revised prompt was then run twice on each complete original image. The four final responses agree on six November 3 rows and eight November 4 rows, full hometowns, headings, `047`, and blank Jim hometown, with warnings=[] and all positions=null. This small sample is useful regression evidence, not a general accuracy guarantee.

| Image / ticket | Stored before (both passes) | Actual final reads + isolated decision |
|---|---|---|
| Nov 3 / 392 | Nate Berg; Brainerd, MN; Firearm; null place | Same visible fields; uniquely matches Tikka T3X Hunter 7MM Rem Mag; eligible in empty isolated context |
| Nov 3 / 047 | Kerry & Jeff Jacobson; Monona, WI; Gift Card; null place | Exact `047` and full town retained; uniquely matches $100 gift certificate from Safe & Secure Firearms |
| Nov 4 / 226 | Jim Wilber; blank town; blank prize; null place → rejected for town | townStatus=blank in both; Firearm → Henry Big Boy All Weather 44 Mag; eligible with blank town |
| Nov 4 / 362 | Rob Stanton; Dakota, MN; blank prize; null place → inserted with null prize | Gift Card → $100 gift certificate from Safe & Secure Firearms; eligible with complete prize |

The old November 3 passes also warned Possible truncation of table, and the November 4 passes warned about columns/date association. The stricter decision now holds such warnings rather than ignoring them. New reads must resolve the warning, or an administrator reviews the image. Published numeric places remain the owner's prior corrections; new reads do not infer 1st/2nd from headings. Historical town differences still conflict rather than changing existing winners.

## 6. Priority order and Live activation

1. Determine the minimum publishing requirements for the existing app and its own Page. Confirm which review or verification steps Meta actually requires before pursuing them. Preserve app/subscription identity and v26.0 field version.
2. After publication is approved and complete, monitor a genuine official Page event. Verify signature acceptance, the Graph read, D1 queue provenance, and the processing outcome for an eligible photo post.
3. Review and approve release of the prepared Worker fixes for Live detection and image reading. These code changes use the existing storage, bindings, and schedules.
4. During the discovery window, verify a genuine video event's forwarding and coordinator alarm.
5. Obtain real positive Live metadata in the November drawing window. `LIVE`/`LIVE_STOPPED`, or a stored same-video observation with strict provenance, are required. November 3 and 4 videos currently expose VOD only. Immediate webhook Graph verification is possible only when the event is delivered during the window and the Page post/video is discoverable then; actual live-time availability of `published_posts` has not been demonstrated. A webhook payload alone never authorizes selection.
6. Current `automaticEnabled=false` stops `runPoll` before Graph reads, including observation capture. Do not silently enable it. A deliberate observation-only mode or owner-approved probe session is needed to collect evidence without staging/publishing; the local transport regression demonstrates the mechanism with no valid receipt, not a production Live observation.
7. Only after real evidence, reviewed playback/rollback checks and owner approval may a schema-5 `page-video-live-origin-v3` policy receipt and activation be considered. The current schema-3 tagged-video receipt is incompatible and remains untouched. Keep ambiguous VOD pending and preserve manual selection/fallback.

## Local validation

The checkpoint passed 78/78 regressions, four TypeScript checks, both Worker builds, and the Astro production build. The first Astro run hit Windows `EPERM` while creating a directory under `dist`. The standalone rerun passed without source changes. The production comparison matched the saved November 4 snapshot for winner and Live responses, both Worker schedules and settings, and the three Live selection and verification KV records. Automatic Live selection remains disabled.

## Owner dashboard test observation

The owner sent the Page → feed → Test v26.0 sample. The first monitoring window had ended before the owner's later reply; no delivery claim is made for that first send. After refreshing the existing Cloudflare OAuth session and reconnecting a sanitized tail, the owner repeated the send.

At **November 4, 2026 10:43:52.941 PM Central** (`2026-11-05T04:43:52.941Z`), photo Worker version `b7d652d5-7da2-4e14-9941-332cf9ad1510` received **POST /facebook/webhook**, returned **HTTP 200**, outcome=ok, exceptionCount=0, and logged `webhook-received`, posts=0, queued=0. That log occurs only after raw-body HMAC verification and JSON parsing succeed. This proves authentic Meta dashboard sample delivery and that the deployed App Secret matches Meta's signing secret. No secret was revealed or replaced.

The sample uses a fictional Test Page/post, so its exclusion by the official Page allowlist is expected. It creates no queue work and no Live hint. This does **not** prove production official-Page event delivery, D1 photo processing, or signed-event forwarding into the Live coordinator. Those remain separate tests after the Unpublished restriction is resolved. The current saved automatic setting remains disabled; no Live-origin policy was relaxed or receipt created.

The test's sanitized record is saved under ignored `.wrangler/automation-repair/meta-signed-test-2026-11-04.json`. A dashboard screenshot was saved as `meta-feed-test-result.png`; the dashboard has no retained HTTP result, so the Worker log is the actual success evidence. Production public winner/live responses, selected-video KV values, Worker settings and schedules were rechecked against the preserved November 4 release snapshot after the send.
