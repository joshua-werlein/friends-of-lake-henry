# Facebook Live discovery Worker — disabled, staging only

Implemented on `codex/facebook-live-worker`. Polling, probes, Cron and public routes remain disabled. The isolated timestamp fix is production commit `f765908` (Pages deployment `485191c1-5399-49c2-b36c-12c3785f5a4a`, November 1 at 4:14 PM Central). Selection changes are prepared separately and have not been published to Pages. See the deployment record below for Worker status.

This is a working candidate collector with a provisional, gated metadata probe.
**Automatic livestream detection has NOT been verified against a real broadcast.**

## Verified access and API blockers

The user verified v26.0 `pages_show_list`, `pages_read_engagement`, and current
`published_posts` with attachments. `live_videos` returns OAuth #10 requiring
Live Video API review. This Worker never calls that edge or bypasses its review.

Official references inspected in the browser:

- [published_posts](https://developers.facebook.com/docs/graph-api/reference/page/published_posts/): documented PagePost list, including New Pages Experience.
- [PagePost](https://developers.facebook.com/docs/graph-api/reference/page-post/): attachments, publication time, message, permalink and status_type. Generic video attachments and captions do not prove Live. The reference also notes a Reels limitation.
- [Get Videos guide](https://developers.facebook.com/documentation/video-api/guides/get-videos) describes Page video reads with a Page token, but the linked [v26 Page Videos reference](https://developers.facebook.com/docs/graph-api/reference/page/videos/) says reading is unavailable. This documentation conflict is an additional reason to require actual supported API verification rather than assume a working video-read contract.
- [Video API reference index](https://developers.facebook.com/documentation/video-api/reference) links the Video read endpoint, but its [linked Graph reference](https://developers.facebook.com/docs/graph-api/reference/video/) displays a removal-after-v3.2 warning. It does not establish a usable current Live field contract. Historical SDK fields are insufficient evidence.

`graph.ts` reads documented published-post fields. Optional video probing requests
`id,from,live_status,published,embeddable` from `GET /v26.0/{video-id}`. These exact
fields/permissions/enum semantics are **provisional**, not verified for this token
and Page. Probing defaults OFF. A positive metadata result still cannot stage
anything without a time-limited real-broadcast verification receipt. Unsupported
fields (#100), object unavailability and permission errors preserve the last stage
and pause calls; do not weaken checks to bypass those errors.

## Identity and classification

- Graph Page ID `144051422124740`: API paths, identity check, post ID prefix, video ownership.
- Public Page ID `61552199315213`: canonical public URL and embed source.
- Output URL: `https://www.facebook.com/61552199315213/videos/{video-id}/`.

This is an explicit mapping supplied by the user, not interchangeable IDs. Before
activation verify an actual returned video permalink and its public playback.

The configured exact caption token `#LakeHenryRaffle` identifies raffle posts.
Put it on its own line; attached punctuation does not match. The token, captions
like “live now,” status_type, thumbnails and attachment types never prove Live.
Only video-shaped attachments with matching numeric target/video URL are candidates.
The video path ignores photos, reels, short/share links, foreign hosts, unrelated posts, foreign Page post
IDs, invalid/future dates and unsupported attachment shapes are ignored.

The provisional metadata verifier requires matching video ID, `from.id` equal to
the Graph Page ID, `published === true`, `embeddable === true`, and exact state
`LIVE` or `LIVE_STOPPED`. `VOD`, missing fields and unknown values are rejected.
Shared external videos cannot pass ownership validation. The real-broadcast test
must establish that these fields can actually distinguish a Live and its replay.

## Isolation, bounds and state

`wrangler.json` is a separate Worker config: separate name/main, no account ID,
all-zero placeholder CONFIG namespace, no routes, workers.dev or preview URL,
empty Cron list and both flags false. No D1/R2/SESSION bindings. Root Pages config
is unchanged. `index.ts` exposes no polling/admin HTTP endpoint; HTTP always 404.

Graph requests are GET-only to the fixed HTTPS v26.0 Graph host, with Authorization
header and redirects refused. Never log raw errors, API bodies, tokens, messages,
paging URLs or credential-bearing URLs. Only sanitized status/counts are logged.
Maximum: 3 post pages, limit 25 (absolute cap 100 returned per page), 8 video probes,
512 KiB per response, 30 seconds total. Cursor requests are rebuilt on the fixed
host; paging.next URLs are never followed. Bounded/ranked scans can miss a broadcast;
a successful empty scan does not prove the Page is offline.

The Worker can write only these two KV keys:

| Key | Content |
| --- | --- |
| `raffle_live_automation_state` | Last/next attempt, status, failure count, pause, access revision and scan counts |
| `raffle_live_automatic` | Verified staged discovery, schema 2 |

The receipt key `raffle_live_verification` is read-only to the Worker. It never
reads, overwrites, clears or deletes **`raffle_live`**. A manual save racing a poll
survives. Empty/unavailable/error responses preserve the previous stage. The deployed website does not read the automatic key. The prepared website consumer reads it only behind a default-off deployment flag and explicit authenticated admin mode.

Schema 2 includes both Page IDs, video/post IDs, API/contract version, canonical
URL, observed time, explicit live/replay evidence and **publishedAt**. Post publication
time is not mislabeled as broadcast start time. Old staged `startedAt` records are
recognized only to preserve ordering. Corrupt staged records are retained. Sequential
runs avoid duplicate writes/older drawings; live-to-replay updates once and replay
never regresses to live from stale metadata.

Persisted due-state enforces a minimum 300-second interval. Failures back off
exponentially with jitter; rate limits honor Retry-After (bounded to one day).
Expired token, permission/identity failure and unsupported contract pause calls.
After resolving actual access/contract problems, increment non-secret
`FB_ACCESS_REVISION` to allow another attempt. Do not clear the manual selection.

KV is eventually consistent, not a lock/CAS: due-state and sequential ordering do
not guarantee globally serialized concurrent writers. Keep one Worker/one Cron,
no alternate trigger. Future public selection needs freshness validation and, if
instant global manual overrides are required, stronger coordination.

The season is configured with `FB_SEASON_START` and `FB_SEASON_END`, explicit ISO instants with offsets, end exclusive. Defaults preserve November 1 midnight CDT to December 1 midnight CST, 2026. Set the SAME dates on the Worker and Pages when changing seasons; `#LakeHenryRaffle` stays unchanged. Invalid/reversed/over-one-year windows fail closed. The real-broadcast receipt must be issued within that season and expire by its end; reverify API access each new season. Old-season discoveries cannot be selected. Remove Cron when the season ends even though the date guard also stops API requests.

## Local validation — no token

Use project-compatible Node 20:

```powershell
npm test
npm run typecheck
npm run typecheck:facebook-worker
npm run build:facebook-worker
npm run build
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config workers/facebook-live/wrangler.json --outdir .wrangler/facebook-live-dry-run
```

The last command builds locally and uploads nothing. Tests inject fetch and use
disposable in-memory services. Page-post fixtures are realistic **simulations**;
metadata and receipts test a proposed contract, not captured real Meta evidence.
A bundled Worker test runs the disabled scheduled handler in workerd and verifies
HTTP 404/no KV writes. No token is requested, retrieved or stored for these checks.

## Existing-account initial deployment (explicitly authorized)

`wrangler.existing-account.json` pins account `aa86268490e681cccb3a41a62093e2aa` and CONFIG `b70df87ff3db4230a621d4a39ab24ff7`. Read-only Wrangler checks confirmed account access and namespace title `folh-config`. The Worker has a distinct name and no D1/R2/SESSION bindings, routes, workers.dev, preview URL or Cron. Disabled execution returns before reading KV or calling Graph.

```powershell
$env:FB_TARGET_ACCOUNT_ID = 'aa86268490e681cccb3a41a62093e2aa'
node workers/facebook-live/check-deployment.mjs existing-approved
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config workers/facebook-live/wrangler.existing-account.json
node node_modules/wrangler/bin/wrangler.js deploy --config workers/facebook-live/wrangler.existing-account.json
```

The guard requires the exact account/namespace pair, Page identities, hashtag, season, interval and disabled flags/Cron/routes. It rejects plaintext token variables and D1/R2. The generic `wrangler.json` remains a migration template with placeholder KV and no account. The default `new-account` guard still rejects the existing account and old namespace. Neither guard proves remote ownership: independently list the target account's namespaces before deployment. Never deploy using an unqualified root config.

After the disabled Worker exists, the owner enters the Page token directly into Cloudflare as an encrypted **Secret**, name `FB_PAGE_ACCESS_TOKEN`. Do not use a plaintext variable, KV, shell argument, committed file or chat message. An owner-operated interactive CLI alternative is:

```powershell
node node_modules/wrangler/bin/wrangler.js secret put FB_PAGE_ACCESS_TOKEN --config workers/facebook-live/wrangler.existing-account.json
```

Do not share terminal output containing credentials. Adding the secret must leave polling, probes and Cron disabled.

## Real-broadcast Graph API Explorer verification — owner action required

Open [Graph API Explorer](https://developers.facebook.com/tools/explorer/) privately. Select the existing app, Graph API **v26.0**, method **GET**, and the existing **Page access token**. Never send a token, token-panel screenshot, generated cURL, complete request URL or `paging.next` here. No publishing or additional permissions are needed for these read probes. If Meta requires more permissions, stop and report the error code.

1. Mike starts a real public **Page Live**, with embedding allowed and the standalone `#LakeHenryRaffle` caption token (own line recommended). A tagged prerecorded upload is a negative control, never a substitute. Keep the website in Manual and save the real video URL using the existing admin control for tonight.
2. Confirm API identity using:

   ```text
   /144051422124740?fields=id,name,link
   ```

   `id` must be `144051422124740`. Confirm its Page link is Friends of Lake Henry and the public Page is `61552199315213`. If the name/link fields error, retry `fields=id` to isolate identity; do not bypass an ID mismatch.
3. During the actual broadcast, discover its tagged Page post with the exact adapter field expansion:

   ```text
   /144051422124740/published_posts?fields=id,message,created_time,permalink_url,attachments{type,target,url,subattachments{type,target,url}}&limit=25
   ```

   Locate the real Live by attachment/video ID and public permalink. Record whether the hashtag and numeric `attachments.data[].target.id` appear, attachment type, post ID prefix and created time. A video attachment alone is only a candidate. Reels/missing posts/unsupported attachment shapes are blockers for this adapter, even when playback works manually.
4. Replace `VIDEO_ID` with that attachment target ID and run these separately to isolate field permissions:

   ```text
   /VIDEO_ID?fields=id
   /VIDEO_ID?fields=id,from,live_status,published,embeddable
   ```

   The second request is a **provisional contract test**, not a claim those fields are supported on v26.0. Our current verifier requires matching video ID, `from.id=144051422124740`, `live_status=LIVE`, and boolean `published=true`, `embeddable=true`. Missing fields, #100, #10, VOD or ambiguous semantics mean STOP; do not create a receipt or enable polling. If one field is rejected, probe it individually only to diagnose and report which field/code failed. Never remove ownership or Live-proof checks merely to get success.
5. After the Live ends, repeat the same metadata request. Verify a replay-specific Live-origin state (`LIVE_STOPPED` for the proposed contract), and compare an ordinary Page-uploaded video, which must not pass. Also check an unrelated/shared video cannot pass Page ownership. Confirm the canonical `https://www.facebook.com/61552199315213/videos/VIDEO_ID/` points to that exact broadcast, and test the embedded player plus direct link on desktop/mobile while logged out. API eligibility does not guarantee browser embedding succeeds.
6. Optional read-only diagnostic if posts omit the video:

   ```text
   /144051422124740/videos?fields=id,description,updated_time&limit=25
   ```

   Meta's [Get Videos guide](https://developers.facebook.com/documentation/video-api/guides/get-videos) describes this read with a Page token and `pages_read_engagement`, but its linked v26 reference says reading is unavailable. Treat this as an optional diagnostic with conflicting documentation, not a guaranteed supported path. A successful list is **not proof of Live origin**. It is not a second production scanner. Do not call the blocked `/live_videos` edge repeatedly.
7. Share only this manually copied whitelist: test time, API version, public post/video IDs, attachment type, created time, ownership ID, the three boolean/state values, live/replay/ordinary-upload comparison, public playback result; for errors share only code/subcode and failed field name. Redact names/captions if unnecessary. Do not share full error objects, trace IDs, paging, image signed URLs or tokens. No simulated fixture is a real-verification receipt.

If the exact contract fails, retain Manual; supported Live evidence or Meta review is still required. This procedure does not grant or bypass API access.

## Activation gates after real verification

1. Review sanitized real responses against current documentation, add sanitized fixtures and rerun regression tests. Adapt the verifier only to a proven supported contract. Confirm CONFIG ownership and encrypted secret exist, and only one Worker is responsible for polling.
2. Store a reviewed non-secret verification record in CONFIG key `raffle_live_verification` only AFTER evidence is verified:

   ```json
   {
     "schemaVersion": 1,
     "graphPageId": "144051422124740",
     "publicPageId": "61552199315213",
     "apiVersion": "v26.0",
     "contract": "video-live-status-v1",
     "verifiedVideoId": "ACTUAL_NUMERIC_VIDEO_ID",
     "verifiedAt": "ACTUAL_VERIFICATION_ISO_UTC_TIMESTAMP",
     "expiresAt": "2026-12-01T06:00:00Z"
   }
   ```

   Revoke only this record to stop staging/automatic selection. Never delete the manual key.
3. Deploy the reviewed Worker with `FB_AUTOMATION_ENABLED=true`, `FB_VIDEO_PROBE_ENABLED=true`, `triggers.crons=["*/5 * * * *"]`; observe sanitized state/logs and the staged broadcast. Increment `FB_ACCESS_REVISION` only after resolving a permission/token/contract pause. The initial-deployment guard intentionally rejects activated configs; activation needs its own evidence/review, not bypassing the initial guard.
4. Publish the reviewed website selection change with `RAFFLE_AUTOMATIC_SELECTION_ENABLED` absent/false first. Verify manual behavior; then explicitly enable that deployment flag with the same season dates. The admin must explicitly choose Automatic. No implicit opt-in from an existing manual record.
5. Verify public `/api/raffle/live` reports source automatic for fresh verified staged data and the iframe/direct link play the correct broadcast. Confirm a manual save returns to Manual, then test fallback/recovery without deleting any live data. Keep an operator ready to use Manual during the first drawing. Do not rush activation to meet a deadline.

## Website selection implementation (prepared; not published)

Authenticated mode control uses existing session middleware and same-origin CSRF enforcement. Missing/unknown mode stays Manual. Both mode and the saved manual URL remain in `raffle_live`; mode changes preserve URL/timestamp/extra fields. Every manual save or clear, including same-value saves, restores Manual. An explicit blank remains a valid saved fallback.

The public API and server-rendered page share a read-only resolver. Default-off deployments read only the manual key. Automatic requires a valid receipt, active season, schema-2 Page/API/contract identity, explicit Live evidence, and a matching successful health check no older than ten minutes. Errors, missing permissions, paused state, stale/corrupt data or extra KV read failures return the saved manual configuration. Verified duplicate polls renew health without changing the video-selection timestamp or iframe. Replays additionally expire after 24 hours. Public refresh stays 15 seconds and retains Watch on Facebook. Unchanged URLs do not reset playback.

KV is eventually consistent: immediate manual override means the same admin operation writes Manual, subject to ordinary KV propagation. It cannot promise instantaneous global consistency. The Worker never writes `raffle_live`, so it cannot overwrite an operator's URL/mode.

## Migration handoff (no migration performed here)

Coordinate with the migration owner; do not edit their runbook or change DNS here.

1. Choose Manual on the old website. Disable old Worker polling/probes and remove its Cron. Verify no pending poll is writing before moving authority. Keep the old manual site operating during preparation.
2. Owner verifies new account and new website CONFIG namespace. Copy required manual config and separately owned website data using the migration process; do not clear old KV/D1/R2. Copy automatic stage/state only as diagnostic state, not proof of freshness. Reverify season/receipt eligibility. A stale receipt/discovery must not become fresh by copying it.
3. Set new account/new namespace in the isolated migration config. Keep all flags/Cron disabled. Run default `new-account` guard, tests and dry run; independently verify namespace ownership. Redeploy this same Worker code to the new account, and enter the encrypted Page secret there separately. Never copy tokens through config exports/chat.
4. Validate new site's Manual workflow, correct CONFIG ownership and API identity. Reconfirm real Live contract and obtain fresh verified state before enabling new Automatic. Reset scheduling state or increment access revision only deliberately after old Cron is confirmed stopped; preserve manual data.
5. Enable ONLY new Cron, then new website gate/admin Automatic after staged playback checks. Never have old and new pollers acting on authoritative state concurrently. Roll back by choosing Manual and stopping new Cron; re-enable old polling only if old account is explicitly authoritative and access/receipt remain valid. Domain migration is a separate owner action.

## Photo/OCR path — deferred until video activation blockers are resolved

Keep one `/published_posts` discovery feed with the same hashtag, and separate typed VIDEO/PHOTO processing. Future PHOTO processing must validate photo/album attachment metadata, deduplicate by Page/post/photo ID and image content revision, and treat non-winner photos as no extraction. OCR of daily or monthly tables produces draft rows (draw date, ticket number, winner name, hometown, optional prize/place), source references and uncertainty flags. Validate dates within the configured season, ticket format, required fields and duplicate/conflicting rows. Monthly tables may span multiple draw dates/prizes. All extracted rows require authenticated admin correction/review and explicit publication through existing winners validation. Never insert into D1 merely because OCR or a hashtag matched. No OCR provider, image download, review UI, production binding or secret has been enabled; manual winner entry remains available.

## Validation and deployment record

November 1 validation on Node 20.19.6: **47 tests passed**, both root/Worker TypeScript checks, Worker esbuild, isolated Wrangler dry run and Astro production build passed. Browser validation of built Pages at `127.0.0.1:8788` used synthetic local KV/D1: Manual → Automatic → same-URL manual save → Manual updated the open public page on its existing 15-second poll. A simulated permission-denied state also made Automatic use its saved manual fallback. Three daily prize winners rendered; the admin layout fit a 390-pixel viewport. Source and deployment guard review found no D1, R2, DNS, root binding or dependency-version changes. Initial disabled Worker deployment succeeded November 1 at 4:35 PM Central from commit `3b12151`: version `a68ff9a2-89dc-4b14-a1b9-83fbc3a4f66a`, existing account. Readback confirmed 100% on that version and no secret yet; the dashboard confirmed CONFIG → folh-config, zero invocations, no public URLs. The deployed Settings page also explicitly confirmed both enable flags false and “No cron triggers configured.” Polling/probes/Cron remain off. Tests use simulated Page posts/metadata and disposable local D1/KV/R2; they are not real Meta integration proof. Node 20 is used. The inherited Astro/Sharp warning is unchanged. No production D1 migration, KV reset, R2, DNS, website migration or secret replacement is required.
