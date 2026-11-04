# Facebook raffle automation: production follow-up after token rotation

Date: November 3, 2026 (America/Chicago). This report supersedes the Live API prerequisite and token status in the earlier repair report.

## Verified production results

Both existing Workers successfully used their encrypted replacement Page token to read Page `144051422124740`, Page posts and video `28261694626839193`. Token introspection returned app `1700219394854878`, type PAGE, valid=true, expires_at=0 and scopes pages_show_list, pages_read_engagement, pages_manage_metadata, public_profile. Their non-secret SHA-256 fingerprints match, confirming they hold the same current credential. No token value, Authorization header or token-bearing pagination URL was returned or logged.

The pre-rotation token fingerprint/value is unavailable to this investigation, so **distinctness from the exposed old value and revocation of that old value cannot be independently certified**. Cloudflare version history confirms both secret replacements; the new token's scope/expiry metadata differs from the earlier snapshot. Treat the previously exposed credential as compromised until Meta confirms it is invalid or that specific credential is revoked. Do not remove the entire app/Page grant as a shortcut, because it may invalidate the replacement too. Do not paste either token into chat.

A bounded project scan inspected 823 source/config/log text files (excluding dependencies, binaries and build/runtime caches) and found zero EAA-prefixed token-like values. Worker deployment settings contain FB_PAGE_ACCESS_TOKEN only as an encrypted secret, never a plaintext variable. This is a scoped scan, not a claim that every external chat, browser history entry or inaccessible log has been searched.

## Discovery policy now uses the working endpoints

Production discovery no longer calls `/live_videos`. It uses:

1. `GET /144051422124740?fields=id`.
2. `GET /144051422124740/published_posts` with bounded video attachments, publication time and a limit of 25.
3. `GET /VIDEO_ID?fields=id,from,live_status,published,embeddable` for each eligible candidate (at most eight).

No hashtag/title is required. Page identity, exact video ID, published=true and embeddable=true remain mandatory. Candidates must be posted on the current November 2026 drawing date between 17:50 and 18:30 inclusive, America/Chicago. No automatic Facebook/KV work happens outside that confirmed schedule. Only the explicit administrator diagnostic may make read-only Facebook calls outside the polling window.

**The owner's confirmed rule is to hold ambiguous VOD, not infer Live origin from timing.** A video with `live_status=LIVE` or `LIVE_STOPPED` supplies positive status evidence. A subsequent VOD may reuse only an authentic stored observation for the same video, same publication time, correct Page/API/contract and drawing window. A naked VOD or missing/unknown status remains pending. Multiple plausible candidates are also held. Observations may be recorded by real scheduled checks before policy activation, but that does not publish a video or create a verification receipt.

Contract: `page-video-live-origin-v3`; schema-5 policy receipt evidence: `page-video-live-origin-policy-reviewed`. Older tagged-video and Live-edge receipts are incompatible and cannot authorize it. **No replacement receipt or automatic-mode setting was written during this work.** A new receipt must reflect reviewed real Live-origin evidence, actual playback and rollback checks; simulated LIVE test data is insufficient evidence for a production verification claim.

The read-only production check found November 3 post `144051422124740_28261694626839193`, published `2026-11-04T00:00:52+0000`, and verified its video owner, availability and embedding. Meta returned only VOD. The exact new policy returned:

- ok=true; one candidate; zero auto-eligible discoveries.
- pending video `28261694626839193`: `live-origin-unproven`.

Extra probes for `live_video`, `is_live_streaming` and `broadcast_id` on that video returned HTTP 400 / code 100 (unsupported). Metadata introspection exposed no additional live/broadcast field names. These are actual tested limitations, not reasons to create another app or require the restricted Live Video API.

## Scheduling, retries and diagnostics

The minute cron, original DiscoveryScheduler SQLite namespace/migration and 17:59–18:01 quarter-minute burst remain. The discovery window is 17:50–18:30 inclusive, November 1–30, 2026 only. Generic backoff stays capped at two minutes; Retry-After and rate limits are respected. `FB_ACCESS_REVISION=rotated-metadata-v3` releases stale permission-paused coordinator state on the next real drawing window. Manual selection, fallback and the previous working replay remain preserved.

The admin Test discovery control is now **read-only**, including during a drawing window: it neither contacts the coordinator nor writes KV/selection/receipt. It reports actual candidates and pending Live-origin confirmation. Pending scheduled candidates are also exposed in the admin status. Automatic and Manual sections remain separate; saving a fallback preserves a displayed explicit manual override and automation enablement. New drawing dates can supersede a manual override when authorized verification succeeds.

## Winner-photo automation

The photo Worker now prefers its **own replacement encrypted token**, independently of the video discovery service. The private read binding remains only as a fallback when its own token is absent.

Real production verification using that own token re-read the official November 3 post, fetched photo metadata, downloaded the actual image (35,010 bytes, JPEG, 1036x231) and reproduced SHA-256 `8fe16e93009ddb2a19ef43c6cc64670f3be0bd0945331e24e2f0ae444c706ef9`. Its existing D1 post is done, attempts=1, error_code=null. A real scheduled invocation of photo Worker version `0336abab-582c-444c-afd4-594d2dff68da` logged `poll`, queued=0, outcome=ok after rotation; it did not reinsert winners.

The public November winners remain six rows. November 3: Nate Berg (392), 1st, Tikka T3X Hunter 7MM Rem Mag; Kerry & Jeff Jacobson (047), 2nd, $100 gift certificate from Safe & Secure Firearms. First sorts above second. Earlier winners are preserved.

## Webhook setup is not complete

The existing public callback remains `https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook`.

- Receiver code validates the raw-body Meta HMAC-SHA256 signature and Page identity, deduplicates, and forwards video hints to the separate Live service. Every candidate is re-read from Graph before any selection.
- The replacement token has pages_manage_metadata and `GET /144051422124740/subscribed_apps?fields=id,subscribed_fields` now succeeds, but returns an empty list. The app is not subscribed to this Page by the evidence available.
- The Worker still lacks `FB_APP_SECRET` and `FB_WEBHOOK_VERIFY_TOKEN`. `webhookStatus` reports configured=false, liveForwarding=true.
- No actual signed Meta Page event has been received and processed successfully. Local signed tests and a reachable callback do not prove that.

Required owner actions on the **existing app**, without creating another app or adding the Live Video API use case:

1. Store the app's actual App Secret as encrypted `FB_APP_SECRET` on folh-facebook-winner-photos. Choose/store a separate random `FB_WEBHOOK_VERIFY_TOKEN` there. Do not paste secrets into chat or source.
2. In the app's Page Webhooks configuration, enter the callback above and matching verify token; complete the GET challenge and subscribe to Page `feed`.
3. If the dashboard does not expose Webhooks, the app-level Graph configuration route is `/1700219394854878/subscriptions`, using an **app access token**, not the Page token. Configure object=page, callback_url=the existing callback, fields=feed and verify_token=the stored token. This requires the missing app secret/app-admin access; an app-level subscription is separate from subscribing the app to this Page.
4. With the existing Page token and pages_manage_metadata, subscribe the existing app through `POST /144051422124740/subscribed_apps` with subscribed_fields=feed, preserving any subscriptions found at that time. Re-read the list and confirm this app and feed are present.
5. Send a real official Page event and verify actual signature acceptance, durable handoff, Graph re-verification and the resulting pending/verified classification. An ambiguous VOD must remain pending even after a successful webhook.

These are configuration prerequisites, not a claim that the app-level subscription was created or delivery tested. App-secret entry and any Meta permission/administrative interaction remain the owner's boundary.

## Release, Git and go/no-go

All 72 regressions passed, including actual-image evidence, independent photo-token/fallback transports, signed event forwarding, bad signatures, deduplication, fail-closed VOD, replay provenance, no restricted Live API requests, read-only admin RPC and KV immutability. All four TypeScript projects and all three production builds passed. Selection, automatic stage and receipt hashes matched before/after real diagnostics.

Repair source is on codex/raffle-automation-repair, based on the current main (`e33cf53` when fetched). A commit/merge-ready record and final deployment versions are appended after release. Main must not be described as containing the repair until merged.

**NO-GO for guaranteed fully unattended November 4 video publishing.** The supported production transport works, but the observed November 3 metadata is VOD-only, actual positive Live-origin evidence has not been seen with this token/policy, the new policy receipt is absent and automatic mode remains disabled/manual. The code is ready to capture real Live metadata during the next drawing window and hold uncertain videos. Working photo polling is proven; webhooks are not operational. Use manual confirmation if the next video also exposes insufficient Live-origin evidence.

### Final release evidence

Live Worker: 5b19737a-8831-4d49-9f04-4dbc81dfc5aa. Photo Worker: dee53170-2db3-4cd8-9cd9-9f345939e0b9. Pages: 99ab9977-8255-438a-81f1-407e1b4eb6d9. Original account/resources and newly rotated secrets are preserved. The final private admin Test discovery RPC returned checked, selectionChanged=false, and the actual November 3 VOD pending for manual Live-origin confirmation. The production token fingerprint was unchanged after deployment. Public APIs still show the correct replay and six winners, with Nate 1st, the Jacobsons 2nd and 047 preserved.

App-level subscription inspection with the Page token returned HTTP 400 / Meta code 104. It cannot establish or configure app-level subscriptions with this token; the missing App Secret/app-token configuration remains the owner step. Page-level subscription inspection separately succeeded with an empty list.

Diagnostics now recursively remove paging objects at every depth and redact credential-bearing/signed URLs, including nested attachment paging. A dedicated regression verifies this.

No production raffle selection, automatic stage, policy receipt, winner or queue record was mutated by this follow-up's diagnostic checks. Before/after/final hashes match for all three selection/receipt records. No automatic activation or real Meta event success has been claimed.
