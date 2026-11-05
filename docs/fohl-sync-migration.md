# FOHL Sync migration

The migration starts from `codex/facebook-reliability-audit` at `4b05a2d1f692b279495a3c5527eb8db427f4b356`. The owner reports that FOHL Sync (`2349506929155471`) is published. The existing app (`1700219394854878`) continues serving the current integration. The official Graph Page ID is `144051422124740`.

## Isolated endpoint

- Worker `folh-sync-webhook-test` in the existing Cloudflare account. Initial version `10faba01-3c85-4be3-a9e5-0b0a46521c51`.
- Callback `https://folh-sync-webhook-test.jjwerlein.workers.dev/facebook/webhook`.
- The callback verifies the challenge and raw-body HMAC using the existing helpers. Sanitized log markers report the app, whether the payload names the official Page, and the photo and Live routing decisions. There are no storage bindings, cron triggers, or production service bindings.
- The private `SyncDiagnostics` service binding uses fixed Graph reads. It verifies the Page token's issuing app, type, validity, granted scopes and Page identity. It checks both subscriptions, reads Page posts, downloads a known winner photo, and reads the known November 4 video's ownership and Live metadata. It returns a summary with no tokens, message text or image URLs. A VOD response proves metadata access only.

## Owner credential and Meta setup

1. Open Cloudflare **Workers & Pages → folh-sync-webhook-test → Settings → Variables and Secrets**. Add all three entries as **Secret** and save them on this Worker.

   | Secret | Value to enter privately |
   | --- | --- |
   | `FB_APP_SECRET` | The App Secret from FOHL Sync app `2349506929155471`. |
   | `FB_PAGE_ACCESS_TOKEN` | A Page access token issued by FOHL Sync for Page `144051422124740`, with the four granted scopes. In Graph API Explorer select FOHL Sync, authorize those scopes and select the Friends of Lake Henry Page token. |
   | `FB_WEBHOOK_VERIFY_TOKEN` | A new random value generated and stored in your password manager. Use the same value in the Meta callback setup. |

2. Open [FOHL Sync Webhooks](https://developers.facebook.com/apps/2349506929155471/webhooks/). Select **Page**, enter the isolated callback URL and verify token, then verify and save. Subscribe the app to `feed`. Use v26.0 if Meta offers it and record the selected version.
3. In Graph API Explorer with **FOHL Sync** selected and the new Page token active, send `POST /144051422124740/subscribed_apps` with `subscribed_fields=feed`. If FOHL Sync already has other Page-level fields, retain them in that request. This installs the new app's subscription on the Page. Keep the old app installed.
4. Report which steps succeeded, along with any error code or status. Enter credentials only in Meta and Cloudflare. Keep access tokens, App Secrets and verify tokens out of chat, source, command arguments and screenshots.

## Verification after setup

Run the authenticated local RPC client using the account's Wrangler login. Pass a Wrangler module path as the optional argument when the installed client cannot establish the remote binding. The cached Wrangler 4.156.0 client established the binding and returned `stage: credentials` before secrets were entered.

```powershell
node workers/fohl-sync/probe.mjs .wrangler/npm-validation-cache/_npx/2fea031b5bd76b2e/node_modules/wrangler/wrangler-dist/cli.js
```

Verify `appFeed` and `pageFeed`, the official Page identity, photo download and video metadata. The app subscription must point to the isolated callback. A failure includes a stage name so the credential or subscription can be corrected in the relevant dashboard.

Start a sanitized Cloudflare tail before the owner sends the Meta Page `feed` dashboard sample. Retain only timestamp, HTTP status and allowlisted log markers. Never print request URLs with query strings, headers or bodies. The sample should receive HTTP 200 and a `fohl-sync-signed-received` marker. A fictional sample is expected to have `officialPage=false`.

Keep the tail running for a genuine official Page event from normal Page activity. Confirm HTTP 200, `officialPage=true`, and the corresponding routing classification. Use an actual eligible photo event to prove a nonzero photo route count and an actual video event to prove the Live route flag. This Worker observes routing decisions. A later approved production check must verify D1 processing and the Live coordinator separately.

## Cutover and rollback after explicit approval

The cutover candidate selects credentials with `FB_CREDENTIAL_SET`. Unset or `legacy` selects the existing credentials. `fohl-sync` selects the new Page token for photo polling and Live Graph reads. Each webhook path validates with its own App Secret and verify token. Both paths can complete the handshake. A valid delivery on the inactive path is acknowledged after classification, before any enqueue or Live forwarding. Existing D1 post deduplication remains in the active path.

1. Require a genuine signed event from the official Page at the isolated callback. Record the available routing evidence. Recheck production versions and bindings, cron schedules, Durable Object namespace, raffle KV and manual video against the saved baseline.
2. After approval, the owner adds `FOHL_SYNC_PAGE_ACCESS_TOKEN` on both production Workers and adds `FOHL_SYNC_APP_SECRET` and `FOHL_SYNC_WEBHOOK_VERIFY_TOKEN` on `folh-facebook-winner-photos`. Use encrypted Cloudflare secrets and the values already tested on the isolated Worker. Preserve all existing `FB_*` credentials. Verify the new bindings by name before selecting them.
3. Deploy the reviewed code with legacy selected. Use `workers/facebook-live/wrangler.video.activation.existing-account.json` for the existing minute cron and `workers/facebook-photos/wrangler.json` for the existing two-minute cron. Verify the deployed resource bindings and schedules. The new production callback is `https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook/fohl-sync`. Move only the new app's callback there. Verify handshake and signed delivery with processing still set to legacy.
4. Set `FB_CREDENTIAL_SET=fohl-sync` on Live, verify official Page reads, then set the same value on the photo Worker. On the photo Worker, this selects both the new token and active callback together. Verify photo polling, an eligible event's Graph read and D1 outcome, and preservation of winners, manual video and schedules. Retain the saved automatic Live disable and existing activation gates. Confirm genuine Live-origin evidence and activation checks under separate approval before enabling automatic selection.
5. To roll back, select `legacy` on the photo Worker first and then on Live. Return the new app's callback to the isolated endpoint. If a code rollback is needed, the pre-cutover production versions were `b7d652d5-7da2-4e14-9941-332cf9ad1510` for photos and `5b19737a-8831-4d49-9f04-4dbc81dfc5aa` for Live. Recheck the original callback, Graph access, schedule and queue health. Preserve D1 and KV records written by normal activity during the window. Retain the old app, Workers and credentials for rollback.

## Checks completed before credential handoff

80 local tests passed, including challenge echo, valid raw-body HMAC, cross-app signature rejection and routing on only the selected production path. The saved Live discovery fix uses the correct Worker `fetch` receiver and its workerd regression passes. The winner-image fixes keep exact ticket labels, require matching prize evidence, and hold a row when either extraction pass flags uncertainty. The November 3 and 4 fixtures passed. The photo integration fixture now derives its drawing date from the source post so the test can cross Central midnight. Five TypeScript checks, both production Worker builds, the Astro build and Worker deployment dry runs passed. The production snapshot matched for winners, Live selection, verification KV, Worker settings and schedules.

## Isolated verification result

The private probe passed for app `2349506929155471` and Page `144051422124740`. It verified the Page token and four granted scopes, both `feed` subscriptions, five published posts, the winner-photo download and metadata for the published, embeddable Page video. Meta reported `VOD` for that video.

The Meta dashboard sample arrived on November 4 at 11:58:54.737 PM Central (`2026-11-05T05:58:54.737Z`). Worker version `91245be4-6dd2-4cf1-b867-5ea45ee739b0` returned HTTP 200 with zero exceptions and logged `fohl-sync-signed-received` for the new app. `officialPage=false`, `photoRouteCandidates=0`, and `liveRouteCandidate=false` describe the fictional sample.

The owner's temporary text-only post produced a genuine signed Page `feed` delivery on November 5 at **12:07:34.431 AM Central** (`2026-11-05T06:07:34.431Z`). Isolated Worker version `687a37e6-835d-4980-ac69-ff8d6880ae4b` accepted the raw-body HMAC, logged `officialPage=true` for app `2349506929155471`, and returned HTTP 200 with zero exceptions. The sanitized feed record identified post `144051422124740_122333532062073310`, `item=status`, `verb=add`.

The initial feed classifiers reported one post to check for photos and one Live hint. Status posts can link to either kind of media, so these flags request a Graph lookup. The private Graph read matched the exact post ID and found zero photo candidates and zero video candidates. The isolated Worker has no production enqueue or forwarding bindings.

At **12:08:23.006 AM Central**, Meta sent `status/edited` for the same post. The signature passed, the callback returned HTTP 200, and the Worker reported zero exceptions. The owner confirmed deletion, and the follow-up Graph lookup could no longer read the post. The monitor closed at approximately **12:11:58 AM Central** with two signed deliveries and no explicit removal event. The publication event satisfies the genuine-delivery gate.

The post-test production comparison matched the pre-test winner and video responses, raffle selection and verification KV, both Worker settings and schedules, and the sampled D1 photo queue and import audit records. The latest release checks passed all 80 tests, five TypeScript checks, both production Worker builds, the Astro build, and all three Worker deployment dry runs. The two recorded rollback versions were confirmed active at 100%, and the legacy encrypted binding names were verified.

**GO for a staged production rollout after explicit owner approval and entry of the new encrypted production bindings.** The owner also needs to move the new app's callback to the production FOHL Sync path during staging. The text-only test establishes delivery and classification, while an eligible photo and genuine Live-origin event remain separate verification steps. Retain the manual video and the saved automatic Live disable during migration.

## Production staging on November 5

The owner approved the staged migration. Automatic photo imports now require the standalone `#LakeHenryRaffle` caption tag. The Graph read applies this gate for webhook and scheduled photo discovery. Explicit administrator imports still accept untagged posts. Live discovery still uses Page ownership and Live-origin metadata without a hashtag gate.

All 80 tests passed, including the real November 3 and 4 image fixtures, untagged administrator import, webhook routing and Live transport regressions. Five TypeScript checks, the Astro and two production Worker builds, the photo deployment preflight, and both production Wrangler dry runs passed.

| Worker | Legacy-active staged version | Rollback version | Cron |
| --- | --- | --- | --- |
| `folh-facebook-live-discovery` | `fee83650-87a5-40ba-961a-ad712f4e6ece` | `5b19737a-8831-4d49-9f04-4dbc81dfc5aa` | `* * * * *` |
| `folh-facebook-winner-photos` | `d50cb960-0e5f-4977-8842-780f655a0d29` | `b7d652d5-7da2-4e14-9941-332cf9ad1510` | `*/2 * * * *` |

The public winner and Live responses, three selection and verification KV records, both schedules, and operational Worker bindings matched the baseline. The photo settings hash changed because Cloudflare's deployment annotation changed from `secret` to `version_upload`. A field comparison excluding annotations matched. Private read diagnostics confirmed Live discovery could read 25 posts and the photo Worker could fetch and match the November 3 post and image. Its existing D1 queue record remained `done` with one attempt. The public selection and manual video were preserved. Both production Workers are still using legacy credentials. The next gate is entry and verification of the four new encrypted production bindings before moving the Meta callback.

## Cloudflare usage and polling decision

Cloudflare GraphQL reported the following for the complete UTC day on November 4. These are aggregate resource metrics, including website and administrative traffic.

| Resource | Reads | Writes |
| --- | ---: | ---: |
| Raffle `CONFIG` KV namespace | 959 operations | 9 operations |
| Account-wide KV | 1,009 operations | 18 operations |
| `folh-db` D1 | 32,805 rows across 3,010 read queries | 34 rows across 14 write queries |

On a normal 24-hour in-season day, the current photo cron schedules 720 queue checks. Evaluating the current time gate across that day yields 223 scheduled Graph feed reads. An empty sweep makes no D1 mutation. Webhook and polling overlap shares a post ID, a conditional insert, and a lease-based claim. Duplicate attempts can still cost a query, but cannot run a second concurrent extraction for the same post. The photo Worker has no KV binding.

Keep the current photo cron until a genuine tagged winner post reaches the production webhook, completes extraction, and publishes verified rows. After that gate, the proposed configuration disables the scheduled feed read and replaces the two-minute cron with a five-minute queue-only sweep on the same Worker. On a normal in-season day that changes the scheduled Graph feed reads from 223 to 0 and scheduled D1 due-queue queries from 720 to 288. The proposed sweep preserves retry, expired lease recovery, and administrator imports, with up to five minutes between sweeps. Compare billed D1 rows after rollout because query counts and billed rows differ.

The Live minute cron checks the approved November drawing window before contacting the Durable Object. Outside the window it makes no Graph or KV calls. In the simulated full-day active schedule the coordinator ran 50 serialized checks, with at most 102 KV reads and 50 heartbeat writes before event-driven activity. With automatic selection disabled, the poll exits after reading the manual selection setting and makes no Graph reads or heartbeat writes. The current in-window webhook path can write a separate KV receipt per unique accepted hint. The Durable Object deduplicates event IDs and claims slots before discovery. Retain the existing window and alarm coordination during cutover.

The measured day was below the published free-tier daily KV and D1 allowances. Continue monitoring shared account totals after migration and after any polling change. [KV analytics](https://developers.cloudflare.com/kv/observability/metrics-analytics/) · [KV limits](https://developers.cloudflare.com/kv/platform/limits/) · [D1 analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## Production secret verification gate

The owner reported saving and deploying the new secrets. Cloudflare's secret list, Worker settings, and active-version binding metadata showed the legacy encrypted credentials only. Active versions were `f4bf7c5c-02ad-4ddc-ab0e-ada3a85266f2` on photos and `7f2c6035-0df8-41d9-bc98-3d16bd961f86` on Live. The new production route returned HTTP 503 for an unsigned POST, consistent with its new signing secret being absent. Both Workers still selected legacy and retained their existing schedules. Resolve the missing bindings on the exact production Workers before moving the Meta callback.

## Direct switch using existing names

The owner chose to reuse the existing `FB_*` binding names. This supersedes the separate-secret cutover procedure above. Keep `FB_CREDENTIAL_SET` unset. The active photo callback is `https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook`.

Private production diagnostics verified that both Workers already have valid Page tokens issued by FOHL Sync (`2349506929155471`) under `FB_PAGE_ACCESS_TOKEN`, with the four required scopes and successful Page identity reads. Current versions at the check were `f17f598c-8703-4184-bdb0-78bb8195e507` on photos and `7f2c6035-0df8-41d9-bc98-3d16bd961f86` on Live. Both crons matched. The isolated probe confirmed the app callback was still isolated.

Confirm the photo Worker's existing `FB_APP_SECRET` and `FB_WEBHOOK_VERIFY_TOKEN` hold the FOHL Sync values. In the FOHL Sync dashboard, set the production callback above with the matching rotated verification token and keep Page `feed` subscribed. Verify the handshake and send the signed dashboard sample during a sanitized production tail. Check HTTP 200 and the accepted-signature marker on the active route. Then observe genuine eligible photo processing and polling before considering the polling change. Keep automatic Live selection disabled.

For rollback, return the new app's callback to the isolated endpoint and use the legacy-active staged Worker versions listed above as code rollback targets. The direct switch overwrote active `FB_*` credentials. We have not tested whether rollback makes the old secret values available or whether those values still match valid Meta credentials after rotation. A working legacy rollback requires independent verification of the old Page token, app signing secret, callback verification token, and Page subscription. If any fails, a code rollback alone is insufficient. Keep both Meta apps, the isolated Worker and the existing storage resources until the observation period and separate cleanup approval.

The owner sent the FOHL Sync dashboard sample on November 5. At 12:57:25.214 AM Central (`2026-11-05T06:57:25.214Z`), production photo Worker version `4e1a34ab-e8fd-467d-9880-8ca5d9ee62dc` accepted the HMAC on `POST /facebook/webhook` and returned HTTP 200 with zero exceptions. The sanitized logs reported `activeRoute=true`, `posts=0`, `queued=0`, and `liveHint=false`. The sample confirms the direct production callback and signing credentials. Production publication from a genuine tagged winner-photo event remains the gate for changing the polling schedule.

## November 5 release verification

Both production Workers reported a valid PAGE token issued by FOHL Sync, all four required scopes, and successful official Page identity reads. Live discovery examined 25 posts and left selection unchanged. The photo Worker read the known November 3 image and its existing D1 record. The production tail observed the two-minute photo cron and a successful feed poll with zero queued posts. The tail through approximately 1:02 AM Central contained no bad-signature marker. A bad signature alone would not identify the sender app.

| Worker | Active deployment ID | Active version ID | SHA-256 of matching local and deployed bundle |
| --- | --- | --- | --- |
| Live discovery | `ffdfc9dd-480c-4f9c-83cd-d2c3d9da373c` | `7f2c6035-0df8-41d9-bc98-3d16bd961f86` | `097a3a00feba2f6cda6a895a4671edbd5425c90cf4d0521731a638118b3b251f` |
| Winner photos | `c808e524-9b72-4ea0-a43e-1b39b9eb80d8` | `4e1a34ab-e8fd-467d-9880-8ca5d9ee62dc` | `df2f84b467be987945c62b53f57dc8eb939259c628485f7cec98d8976cf7e157` |

All 80 tests, five TypeScript checks, both Worker builds, the Astro build and Wrangler dry runs for both production Workers passed. Cloudflare script content matched the Wrangler artifacts byte for byte. Public website health, winner and Live responses, the three selection and verification KV records, both cron schedules, operational bindings including the D1 and Durable Object IDs, and the sampled D1 queue and import records passed comparison to the saved baseline. Automatic Live selection is disabled. Scheduled operation estimates and the measured pre-optimization baseline remain in the usage section above.

Both production Graph checks of `/144051422124740/subscribed_apps` returned only FOHL Sync `feed`. This is the view available through the FOHL Sync token. The old app's own dashboard subscription has not been independently checked since the direct switch, and there is no confirmed legacy Page subscription to remove. Retained inventory includes app `1700219394854878`, prior Worker versions with legacy binding names, the inactive `/facebook/webhook/fohl-sync` route and unused `FOHL_SYNC_*` selector code, and `folh-sync-webhook-test` with its isolated credentials. The original `/facebook/webhook` path and current production `FB_*` bindings serve FOHL Sync and are required. Cleanup remains gated on verified genuine production photo publishing, Live routing, and separate deletion approval.

### Obsolete integration cleanup checkpoint

The signed production test and both deployed Page-token checks confirm FOHL Sync is active. Meta's FOHL Sync dashboard shows Page `feed` subscribed at v27.0 on the original production `/facebook/webhook` path. Meta's All Apps view did not list app `1700219394854878` for the current administrator. This and the Page subscription query do not establish whether Meta archived or permanently removed the old app, or whether an owner can still see its app-level subscriptions.

The owner confirmed deletion of old Meta app `1700219394854878` and isolated Cloudflare Worker `folh-sync-webhook-test`. A separate old subscription removal was not observed. Genuine production photo publishing and Live routing remain unverified. Production still uses its original `FB_*` names for FOHL Sync. The unused alternate callback and migration selectors are retained in the verified release bundle. The overwritten legacy secrets are unavailable as a dependable rollback.
