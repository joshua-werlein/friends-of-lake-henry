# Facebook raffle video selection — disabled pending approval

The revised policy selects the newest **eligible tagged Page video**. It does not
prove that a video originated as Live or is currently streaming. Ordinary uploaded
videos intentionally tagged by the Page are eligible under this policy too.
Mike must reserve `#LakeHenryRaffle` on video posts for raffle broadcasts/replays.
Photo posts use the same discovery marker but follow the separate review-required
[photo import workflow](../../docs/raffle-photo-imports.md).

## Actual November 1 findings

Graph v26.0 returned Page ownership `144051422124740`, `live_status=VOD`,
`published=true`, `embeddable=true` for both test video `39756815320632328`
and actual 6 PM drawing `1706736221227932`. Facebook displayed LIVE during
viewing of the actual drawing, while the API reported VOD. Both have now ended.
The actual post contained `#LakeHenryRaffle` and attachment type `video_autoplay`.
Sanitized fixtures retain only supplied fields; missing post IDs/times in test
harnesses are explicitly simulated, not claimed as captured responses.

`GET /VIDEO_ID?fields=id,format` also succeeded for both: 130x231, 480x853,
and native 720x1280. Embed HTML and temporary image URLs are discarded.
Page token permissions pages_show_list/pages_read_engagement and published_posts
work. The Live Video API edge is still permission-blocked (#10); it is not used.
An ordinary-upload real negative control has not been supplied. It is no longer
a blocker to establishing Live origin because this policy makes no such claim;
untagged ordinary uploads are regression-tested exclusions. Any tagged ordinary
video is eligible by design, which needs explicit policy approval.

## Selection contract: tagged-page-video-v1

- Required exact, case-sensitive standalone token `#LakeHenryRaffle` (whitespace
  delimited; hashtag suffixes, prefixes and attached punctuation do not match).
- Page post ID prefix must match Graph Page `144051422124740`.
- Only video/video_inline/video_autoplay attachment targets with numeric IDs and
  valid Facebook video URLs are candidates. Photo/album processing is separate.
- GET video metadata requires exact video ID, from.id equal to that Graph Page,
  published=true and embeddable=true. VOD does not disqualify it. Missing/unknown
  live_status is stored as UNKNOWN; neither UNKNOWN nor VOD is labeled LIVE.
- Canonical public URL uses Page `61552199315213`. IDs are an explicit verified
  mapping, not inferred from Meta embed HTML or interchangeable Graph identities.
- Publication must be within the configured season, not future and at most
  **36 hours old**. This supports daily replays without cycling through old months.
  Public selection repeats the age validation; healthy polling cannot keep an old
  drawing eligible forever. Operators can keep any replay manually as long as needed.
- Choose newest post publication time; stable video-ID tie break. Duplicate polls
  renew health without rewriting the staged selection or iframe. Older discoveries
  never replace a newer stage. LIVE/VOD changes do not churn playback.

The Worker writes only `raffle_live_automatic` and `raffle_live_automation_state`.
It never reads, changes or deletes the manual `raffle_live`. Mode and saved manual
URL live together in that manual record; every manual save returns to Manual.
Admin mode changes use existing authentication and same-origin CSRF checks.
Automatic selection additionally needs the Pages deployment flag, explicit admin
Automatic mode, a reviewed receipt and matching successful health <=10 minutes.
Errors, expiry, permission loss, empty scans, stale data or KV failure fall back
to the saved manual URL. Public polling is 15 seconds and unchanged URLs retain
playback. KV propagation is eventually consistent, not instantaneous worldwide.

## Bounds and errors

GET-only Graph v26.0 requests use the Authorization header, fixed Graph host,
no redirects, 512 KiB response cap, 30-second deadline, at most three post pages
of 25 and eight metadata probes. Paging.next URLs are never followed; cursor
requests are reconstructed. No tokens, signed URLs, raw API bodies/errors,
captions or paging URLs are logged. Only sanitized status/counts are logged.
Token/permission/identity/unsupported-contract failures pause until the operator
fixes access and increments FB_ACCESS_REVISION. Rate limits/backoff respect
Retry-After. Empty/error scans preserve the stored stage but cannot select it
while health is unavailable. One Worker and one Cron only; KV is not a lock.

## Deployment status and isolation

Existing account: aa86268490e681cccb3a41a62093e2aa.
Worker: folh-facebook-live-discovery. CONFIG: b70df87ff3db4230a621d4a39ab24ff7.
Previously deployed version f685b083-36e2-42ba-b5d7-b5d1dc465372 has encrypted
FB_PAGE_ACCESS_TOKEN, both flags false, no routes/public URL and empty Cron.
The revised policy is LOCAL ONLY until approved deployment. No credential value
is read or needed in this repository. Generic wrangler.json remains a disabled
new-account template; wrangler.existing-account.json pins this existing account.
The initial check-deployment.mjs remains disabled-only, with account/KV checks.

## Remaining activation steps — explicit approval required

1. Approve the tagged-video policy, including ordinary tagged uploads being eligible
   and the 36-hour recency limit. No additional livestream test is requested.
2. Deploy only the reviewed video Worker with existing-approved config and both
   flags false/Cron empty. Verify existing CONFIG ownership, encrypted secret,
   correct Page IDs/marker and one polling owner. No D1/R2 migration is needed.
3. Run one controlled read-only Graph scan against the real Page using the stored
   Worker secret through the normal authorized Worker test surface. Verify the
   actual post ID/time/attachment URL passes candidate extraction and stages video
   1706736221227932 in a disposable test store first. Existing Explorer results
   prove metadata eligibility, but the missing actual wrapper fields must not be
   invented. The Worker currently has no public HTTP test trigger; add a reviewed
   private test invocation or use the dashboard scheduled-handler test with Cron
   empty, the controlled flags and staging consumer kept off. This still needs
   approval because it calls Meta and can write automation state.
4. Exercise fallback/rollback with real staged data while Pages remains Manual:
   revoke receipt/disable Worker flags, stale health, denied token, empty feed and
   manual-save override. Simulated versions already pass; production rollback
   readiness must be reviewed before receipt creation. Never clear manual data.
5. Create the non-secret CONFIG receipt raffle_live_verification only after review:

```json
{
  "schemaVersion": 3,
  "graphPageId": "144051422124740",
  "publicPageId": "61552199315213",
  "apiVersion": "v26.0",
  "contract": "tagged-page-video-v1",
  "evidence": "tagged-page-video-policy-reviewed",
  "marker": "#LakeHenryRaffle",
  "verifiedVideoId": "1706736221227932",
  "publicPlaybackVerified": true,
  "rollbackTested": true,
  "verifiedAt": "ACTUAL_REVIEW_ISO_UTC_TIMESTAMP",
  "expiresAt": "2026-12-01T06:00:00Z"
}
```

Placeholders are not a usable receipt. Schema 1/2 receipts cannot authorize this
new policy. No receipt is created during development.

6. Prepare a separate reviewed activation manifest derived from existing-approved:
   both flags true; exactly triggers.crons=["*/5 * * * *"]. Run the separate offline
   guard with Node 20 and the TS loader:

```powershell
$env:FB_TARGET_ACCOUNT_ID = 'aa86268490e681cccb3a41a62093e2aa'
$env:FB_ACTIVATION_APPROVAL = 'tagged-page-video-v1'
node --import ./tests/register.mjs workers/facebook-live/check-activation.mjs REVIEWED_CONFIG_PATH REVIEWED_RECEIPT_PATH
```

This does not deploy and does not bypass the initial guard. Do not set approval
variables or deploy activated settings until the administrator explicitly approves.
7. Publish a reviewed **video-only** Pages selection release with
   RAFFLE_AUTOMATIC_SELECTION_ENABLED=false first; no photo-import migration or
   AI binding is required for video. After approval enable that deployment flag,
   keep Manual until a healthy fresh stage exists, then admin explicitly chooses
   Automatic. Confirm /api/raffle/live source, correct iframe/link on mobile and
   desktop. Observe at least two five-minute polls and a manual-save rollback.

Immediate rollback: admin choose Manual or save the desired manual URL; disable
both Worker flags and remove Cron, revoke only the verification receipt if needed.
Keep raffle_live and the selected recording. Restore the previous successful Pages
release if the website consumer fails. Do not rotate secrets or reset KV.

## Seasons and migration

FB_SEASON_START/END are explicit ISO instants, end exclusive; configure the same
values on Worker and Pages. Current season is November 2026; future years update
configuration, never hashtags/code. Invalid/reversed/>366-day windows fail closed.
Review a new receipt each season. Disable Cron after the raffle month.

Coordinate with the migration owner without editing their runbook. Disable old
Cron and flags first; confirm no old polls. Copy reviewed manual configuration,
presentation keys and only still-valid automatic state/receipt if appropriate.
Redeploy disabled with verified new-account CONFIG binding and encrypted Page
secret. Check IDs/season/eligibility and public playback, run rollback checks,
then enable the new Cron only after approval. Never run both account schedules.
No DNS, website migration, account migration or production data changes are
performed by this work.
