> Current production status after token rotation: [follow-up report](facebook-automation-production-2026-11-03.md).

# November 3 raffle automation repair

Work began November 3, 2026, Central time. Branch: `codex/raffle-automation-repair`.
Production account remains `aa86268490e681cccb3a41a62093e2aa`.

## Confirmed production findings

- Downloaded both deployed Worker modules and compared their executable code to commit `e33cf53`: both equivalent before repair.
- Video Worker `folh-facebook-live-discovery`: minute cron enabled, existing SQLite `DiscoveryScheduler` namespace `2e316a104a5843c4a3a914090c174ff9`, original `discovery-scheduler-v1` migration, CONFIG `b70df87ff3db4230a621d4a39ab24ff7`.
- Historical video state: four `api-failure` outcomes, last attempt `2026-11-04T00:08:00.002Z`, next attempt `00:24:16.002Z`. The old drawing window ended at 00:11Z. Exponential backoff demonstrably prevented recovery before cutoff.
- The historical state discarded HTTP status, endpoint and underlying error. Exact cause of those four API errors is **not established**. Do not label it token expiry: the video Worker's token successfully read the Page, actual November 3 video and full legacy discovery during this investigation. No retained November 3 per-request error evidence was available from the settings inspected. Live tails show only subsequent invocations.
- Actual video `28261694626839193`: owner `144051422124740`, published and embeddable, `live_status=VOD`, creation `2026-11-03T23:59:46+0000`; its Page post was published `2026-11-04T00:00:52+0000`. Legacy discovery found it with 720x1280 dimensions. This proves Page video availability, **not** Live-origin verification.
- Real `/{page-id}/live_videos` request: HTTP 400, Meta code 10, permission denied. The response did not identify a specific missing permission in the allowlisted diagnostic. The full Live-edge contract therefore remains unvalidated against real accessible data.
- Real `/{page-id}/subscribed_apps` request: HTTP 403, Meta code 200; error specifically names `pages_manage_metadata`.
- Photo Worker `folh-facebook-winner-photos`: two-minute cron and all three automation flags were enabled. Its token returned HTTP 401, code 190, subcode 463 (expired) on every tested endpoint. A real scheduled tail logged `poll-failed / token-expired`. November 3's post had never reached D1.
- Photo receiver had neither `FB_APP_SECRET` nor `FB_WEBHOOK_VERIFY_TOKEN` deployed. No signed delivery was proven. A GET handshake alone would not prove signed delivery or successful processing.

## Winner recovery: actual production evidence

The official post is `144051422124740_122333284658073310`; photo `122333284628073310`, published `2026-11-04T00:06:41+0000`.

The deployed repair introduced a private, read-only `FacebookPhotoReads` service entrypoint using the Live Worker's still-working encrypted Page token. It is independent of video discovery flags, alarms, receipts and Live-edge calls. The separate photo Worker retains its D1, AI, cron, controls and queue. No credential was copied into source, printed or returned. Its expired secret was preserved, but is no longer used while the binding is configured. The two pipelines still share token availability and host availability; a healthy new Page token should eventually be installed independently in each Worker to remove that operational dependency.

A real scheduled poll on repaired version `fa52470f-53e7-4ba1-a0ae-2b0f6a13e876` queued the actual post and ran Mistral twice. Both passes agreed on all six visible rows. It inserted only the two new November 3 winners; three older hometown differences were held, and the fourth older row was a duplicate. November 1–2 records remained unchanged.

| Ticket label | Winner | Hometown | Verified prize |
|---|---|---|---|
| 392 | Nate Berg | Brainerd, MN | Tikka T3X Hunter 7MM Rem Mag |
| 047 | Kerry & Jeff Jacobson | Monona, WI | $100 gift certificate from Safe & Secure Firearms |

The real image was downloaded and visually checked. Fixture SHA-256: `8fe16e93009ddb2a19ef43c6cc64670f3be0bd0945331e24e2f0ae444c706ef9`. Captured production AI responses and image are in `tests/fixtures/facebook-winners-2026-11-03.*`.

Prize categories are printed in the image, without numeric places. The main description was independently checked against published event `2026-11-03-day-3-tikka-t3x-hunter-7mm-rem-mag` (00:00Z November 4 = 6 PM November 3 Central). The gift certificate is the verified poster's daily scheduled prize. Two guarded, null-only updates supplied those descriptions without assigning places or editing prior winners. D1 reported two rows written. Resulting bookmark: `0000265f-00000006-00005119-a145c9b465922d6e503a6eba1734b44a`.

Numeric D1 identity remains ticket 47; exact printed label `047` is recovered from the immutable successful extraction audit for public display. Manual ticket edits cannot inherit a mismatched audit label.

## New Live selection policy

Contract: `page-livestream-drawing-v2`. The former tagged-video receipt cannot authorize it. No replacement production receipt has been fabricated or written.

- Fetch the Page's Live Video edge, then Page posts and video metadata. Require explicit Live-edge membership, an associated video ID, Page ownership, publication, embedding and a broadcast start time inside the November drawing window.
- No hashtag, title or caption is required. An ordinary upload is excluded even if its metadata reports VOD.
- Only November 1–30, 2026, America/Chicago; discovery 17:50 through 18:30 inclusive. Cron is still every minute, with the existing 15-second 17:59–18:01 burst. Off-window cron invocations perform no Facebook or KV operations.
- Only the current drawing date is eligible for replacement. Prior-day broadcasts and future months are excluded. A verified final November replay can remain displayed later, without making any new automatic selection.
- Multiple qualifying broadcasts are ambiguous: hold the current replay/manual fallback. A single unrelated Page livestream inside the drawing window cannot reliably be distinguished from a raffle by timing and ownership alone. This is a remaining semantic ambiguity, not proof of raffle content. The operator must review this policy before authorizing a new receipt and can explicitly show a manual video for that date.
- Generic API backoff is capped at two minutes, with a final-window recovery attempt where possible. Explicit provider Retry-After and rate-limit backoff are respected. Access failures pause until access is repaired and `FB_ACCESS_REVISION` changes.
- The Durable Object serializes event and poll work, claims slots/events durably, and deduplicates signed event body hashes. Fresh signed events can accelerate a check between polling slots. Facebook remains authoritative; payload content cannot publish a video.
- Failures retain the last verified replay. Sanitized state records cause, phase, HTTP status, numeric Meta code/subcode and actual timestamp; credentials, signed URLs and raw Graph errors are excluded.

## Shared webhook and independent controls

The existing photo receiver still checks Meta HMAC-SHA256 over the raw body and Page identity. Signed `feed` video/status/post hints and `videos` / `live_videos` hints can be forwarded through a private `LiveEvents` binding. They never directly select a video. Photo work is durably queued independently; a failed video handoff requests Meta redelivery while permitting already-queued photo processing.

These field handlers are defensive adapters, **not evidence that Meta currently offers/delivers each field to this app**. Actual subscription access and signed delivery remain unverified.

`/admin/raffle` now separates Automatic Facebook Live and Manual Video. Automatic enablement is an independent saved setting. Showing a manual video overrides that drawing date; a verified later drawing date can resume automatically. Saving a fallback does not disable automation. Orientation and sanitized dimensions remain under Advanced settings. Status shows last success, signed event evidence, last automatic video and actionable errors. Winner-photo review remains at `/admin/raffle/photo-imports`.

Public video refresh remains 15 seconds. Manual-only public selection avoids loading the three unused automatic KV records. Scheduled polling uses one completed heartbeat per check; no off-hours automation I/O.

## Required Meta actions before unattended Live GO

Use the **same existing Meta app** that owns the Page token: **1700219394854878** ([app dashboard](https://developers.facebook.com/apps/1700219394854878/)). A real token introspection returned type PAGE, is_valid=true, expires_at=0, scopes pages_show_list/pages_read_engagement/public_profile. Thus the working token does not currently include pages_manage_metadata. Do not create a second webhook receiver or duplicate app subscription.

1. In Meta's app dashboard, identify the app's Live Video API use case/product access and review the app's current token permissions and Page access. The confirmed Live-edge denial is code 10, but the exact missing Live API grant/product approval is not identifiable from the available permission response. Do not assume `pages_read_engagement` alone solves it, or that a publishing permission is automatically necessary for reads.
2. In Graph API Explorer, using that app and an appropriate Page access token, get `v26.0/144051422124740/live_videos?fields=id,status,broadcast_start_time,video{id}&limit=25`. Resolve the actual Meta access/app-review requirement shown by that app. Verify the edge returns the known November 3 broadcast and its associated video `28261694626839193`; adjust the parser only against real evidence if the field shape differs. The implementation's exact field shape is not yet production-validated because access is denied.
3. Obtain `pages_manage_metadata` for the relevant app/Page. Confirm `GET v26.0/144051422124740/subscribed_apps?fields=id,subscribed_fields` succeeds. Preserve existing subscriptions and add the Page `feed` subscription to the existing app if missing. Check the app dashboard for any supported dedicated video/Live fields; do not assume a field exists merely because a handler accepts it.
4. Install the app's actual App Secret as `FB_APP_SECRET` and a newly chosen verify token as `FB_WEBHOOK_VERIFY_TOKEN` on **folh-facebook-winner-photos**, using Cloudflare's encrypted Worker secrets UI. Do not paste them into chat, code or URLs. Configure the callback as `https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook`, using the same verify token. Complete Meta's handshake.
5. Deliver a real signed official Page event. Confirm its receipt, private handoff, successful Graph re-verification and selection in production. A local synthetic HMAC test or dashboard handshake is insufficient. Also verify the website's public embed plays the resulting video.
6. After real Live-edge evidence, negative controls and rollback are reviewed, create a genuine schema-4 policy/playback/rollback receipt under `raffle_live_verification`. Required fields are enforced by `verificationValid`; it must name `page-livestream-drawing-v2`, evidence `page-live-edge-policy-reviewed`, the actual verified video, Page IDs/API version, true playback/rollback checks, real verification time and an expiry no later than `2026-12-01T06:00:00Z`. Do not recycle the old receipt or insert placeholders.
7. Increment `FB_ACCESS_REVISION` on the existing video Worker after access repair to release a permission pause. Enable automatic updates in the admin page and verify a new real selection without saving a manual video.

Official reference pages were attempted during the investigation but returned HTTP 429 from Meta to the browsing tool. Accordingly, this report bases actual access claims on production Graph responses, not cached third-party documentation:
- https://developers.facebook.com/docs/graph-api/reference/page/live_videos/
- https://developers.facebook.com/docs/graph-api/webhooks/reference/page/
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages/

## Validation and deployment record

The test suite covers actual-image evidence, independent AI agreement/category matching, expired photo-token recovery through the private transport, signed video handoff, invalid signatures, duplicate deliveries, ordinary uploads, ownership, ambiguity, November-only gates, retries, missed-event polling, manual overrides, retained replays, DO serialization/restarts, public winner reads and existing authentication/CSRF.

The old schedule/resolver tests that asserted expired health must hide the last valid replay, unlimited backoff, or a 6:10 cutoff were replaced with regressions for the requested behavior. No test result is evidence of a real Meta webhook delivery.

Final deployment versions and public verification results are appended below after release.

### Final released versions and evidence

- Live Worker: `56c9e39d-7129-4c87-907f-b45e71217ce5`.
- Photo Worker: `db9996d7-98a9-4b3f-b06b-74fdd992d72f`.
- Production Pages: `9b4bb09b-c2bb-45a8-b8c8-3cc4fce650ab` ([deployment](https://9b4bb09b.friends-of-lake-henry.pages.dev)).
- Final production binding inspection confirms the original account, D1/KV/R2, DO namespace and migration; existing secret names remain. Only private service bindings were added.
- Wrangler 4.50 Pages ignored the account environment variable in favor of `node_modules/.cache/wrangler/pages.json`. The first lookup stopped with Project Not Found in a different cached account; nothing was deployed there. The local cache was backed up and pinned to the verified production account before successful upload. Pages does not support account_id in its wrangler config; no unsupported property remains.
- November 3, 6:54 PM Central production verification: /api/raffle/live HTTP 200, source Manual, video 28261694626839193, portrait; /api/raffle/month HTTP 200, six winners, both new prizes and ticketNumberText=047; /raffle contains the same rows and neutral winner wording. Donors/events/photos all HTTP 200. Browser inspection confirmed the actual embedded replay loads and the six winner rows display.
- Production screenshot: `.wrangler/automation-repair/production-winners.jpg`.
- Authenticated production admin verification was attempted with the locally available credentials during both release checks; sign-in was not accepted. Neither sign-in was accepted; no further attempts or credential changes. Admin sections and scripts were verified with dummy credentials in the disposable local workerd preview. A real administrator should confirm the deployed status screen in their own session.
- Automatic approval review rejected a production authenticated testDiscovery POST because it can change state. It was not invoked. A safer account-private **read-only** run of the exact new discovery policy was completed instead: permission-denied, phase live-videos, HTTP 400, code 10, at 2026-11-04T00:51:29.595Z.
- Final local regression suite: **67/67**; all four TypeScript checks, both Worker builds, Astro production build, photo preflight and exact-resource repair preflight passed. Existing broader authentication, prizes, donors/events/photos and winner editing regressions remain covered. Workerd tests require sandbox loopback permission; sandbox-only EACCES was resolved by running those tests with that access.
- Source is on local branch `codex/raffle-automation-repair`, uncommitted. No Git push or merge to main was performed. **Commit and merge/push this repair before another Git-driven main deployment**, or that deployment can replace the directly published repair. The sibling photo-autopublish worktree was the verified baseline used during investigation.

**November 4 at 6 PM Central: NO-GO for fully unattended Live selection.** The strict policy cannot verify Live origin with this app's current access, the new receipt is intentionally absent, webhook secrets/subscription and real signed processing are unverified, and production selection remains Manual. Winner-photo **scheduled recovery is proven** on the real November 3 image; its webhook remains unconfigured. Use a manual video for November 4 unless every Meta verification step above is completed and a real automatic selection is observed beforehand.

The final Pages release also separates the saved fallback URL from the currently displayed manual override URL. A regression proves saving a fallback preserves the active manual override and automatic enablement. Final public verification repeated successfully after this release.

### Owner-confirmed November 3 placements

The owner subsequently explicitly confirmed the firearm winner is 1st and the gift-card winners are 2nd. Updated only those two production rows: Nate Berg (392) is `1st place`; Kerry & Jeff Jacobson (047) are `2nd place`. The public API was checked after the update and returns Nate first, followed by the Jacobsons, with `047` preserved. Existing SSR and API queries already sort 1st/2nd/3rd within each date, so no code deployment was needed. This confirmation supersedes the earlier decision to leave these two places unknown based on the image alone.
