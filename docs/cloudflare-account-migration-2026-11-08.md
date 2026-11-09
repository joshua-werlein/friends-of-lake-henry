# Cloudflare account migration — Phase 1 (staged 2026-11-07)

Move Friends of Lake Henry from the **personal Cloudflare account** (`aa86268490e681cccb3a41a62093e2aa`, SOURCE)
to the **nonprofit Cloudflare account** (`ffe1aa6f4a533743f8f1b624f43c6d3d`, DESTINATION).
Phase 1 created and filled destination resources only. Nothing in SOURCE was modified, and no traffic,
DNS, Facebook webhook, cron, or email was switched.

## Inventory and mapping

| Resource | SOURCE (production) | DESTINATION (staged) |
|---|---|---|
| Pages project | `friends-of-lake-henry` (GitHub, `main`; domains `friendsoflakehenry.com`, `friends-of-lake-henry.pages.dev`) | `friends-of-lake-henry` id `532b6a24-6dbd-4ea2-86ae-66ce2e5ec62e`, **Direct Upload**, `friends-of-lake-henry-d16.pages.dev` |
| D1 `folh-db` | `527df871-e876-4924-81d0-5d0572b4dd7b` | `ecde3f50-a040-415b-ae61-06045302c37e` (ENAM) |
| KV `folh-config` (binding `CONFIG`) | `b70df87ff3db4230a621d4a39ab24ff7` | `c4ea8ffeb28a419abc8dafc250a0b6ba` |
| KV `folh-session` (binding `SESSION`) | `d7ea3cc7deef422789bfa015a3c1a6db` | `4d6784e6b44d4353a7f8b54f76e5a4e1` (empty by design) |
| R2 `folh-photos` (binding `PHOTOS_BUCKET`) | 28 objects, 16,606,134 bytes, private, ENAM | **not created: R2 not enabled on the account** |
| Worker `folh-facebook-live-discovery` | cron `* * * * *`, automation/probe/alerts on | version `a134d4df-1133-436a-af28-47615b481d69`, no cron, no workers.dev, flags off, no secrets |
| Durable Object `DiscoveryScheduler` (SQLite) | namespace `2e316a104a5843c4a3a914090c174ff9` | namespace `9435462e26fc43658e15bfb550db2150`, empty |
| Worker `folh-facebook-winner-photos` | cron `*/2 * * * *`, workers.dev on, autopublish/poll/alerts on | version `1ca3d573-ec83-4986-837d-0669ec525de2`, no cron, no workers.dev, flags off, no secrets |
| Zone `friendsoflakehenry.com` | `521cd66466d2270d975476d8d08b967f`, active, full setup | not moved |

Inactive configs: `workers/facebook-live/wrangler.nonprofit.staged.json`,
`workers/facebook-photos/wrangler.nonprofit.staged.json`. Staging Pages bindings (production and preview):
`DB`, `CONFIG`, `SESSION`, `FACEBOOK_LIVE → LiveEvents`, `FACEBOOK_PHOTO_STATUS → PhotoDiagnostics`, plain vars
`FB_SEASON_START/END`, `RAFFLE_AUTOMATIC_SELECTION_ENABLED=true`, `RAFFLE_PRIZE_CALENDAR_ENABLED=true`, compat
`2025-09-15` + `nodejs_compat`, `disable_nodejs_process_v2`. No `PHOTOS_BUCKET` until R2 exists.

Existing-state note: SOURCE Pages **preview** deployments are bound to production D1/KV/R2. This was not changed.

## Secrets (names only; values cannot be read from Cloudflare and must be re-entered)

- Pages: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `RESEND_API_KEY`, `FROM_EMAIL`, `TO_EMAIL`, `TURNSTILE_SECRET`, `PUBLIC_TURNSTILE_KEY`
- Live Worker: `FB_PAGE_ACCESS_TOKEN`, `ALERT_RESEND_API_KEY`, `ALERT_EMAIL_TO`
- Photo Worker: `FB_PAGE_ACCESS_TOKEN`, `FB_APP_SECRET`, `FB_WEBHOOK_VERIFY_TOKEN`, `ALERT_RESEND_API_KEY`, `ALERT_EMAIL_TO`

Turnstile: add the destination hostname(s) to the widget, or create a widget in the destination account and use its keys.

## Phase 1 data results

- **D1**: `wrangler d1 export` of SOURCE (132,408 bytes, 276 INSERTs) imported into DESTINATION. Schema hash
  `fd5608f3e9739906` matches (30 objects). All 15 tables match by row count and SHA-256 of ordered rows:
  d1_migrations 8, donors 72, events 34, ops_alert_incidents 4, ops_webhook_receipts 0, photos 21, raffle_months 1,
  raffle_photo_auto_attempts 21, raffle_photo_auto_imports 7, raffle_photo_auto_posts 10, raffle_photo_auto_rows 46,
  raffle_prize_review_log 0, raffle_prize_supplements 0, raffle_winner_corrections 2, raffle_winners 46.
  `sqlite_sequence` matches (donors 74, raffle_photo_auto_attempts 21, raffle_winner_corrections 2, d1_migrations 8).
- **KV CONFIG**: all 7 keys copied; value SHA-256, metadata and expiration match.
  **KV SESSION**: not copied (admin sessions and login rate limits are short-lived). Admins sign in again after cutover.
- **R2**: read-only backup of all 28 objects to a private local folder (not in Git) with manifest. Sizes total
  16,606,134 bytes (equals bucket usage) and every MD5 equals its ETag. All 24 D1 references (21 `photos.r2_key`,
  3 `events.poster_key`) exist; 4 objects are unreferenced and will be copied anyway.
- **Durable Object**: not migrated, see below.

## Durable Object state

Cloudflare has no export/import for Durable Object storage, and `DiscoveryScheduler` has no dump route. Its keys:

| Key | Purpose | Impact of starting empty |
|---|---|---|
| `cache:*` | Write-through cache of CONFIG KV | None: rebuilt from KV |
| `events`, `pending-event`, `pending-event-at`, `claimed-slot`, `claimed-event` | Per-drawing webhook/Live claim state | None if cutover is outside 17:45–18:45 Central |
| `timeline:<day>`, timing journal | Drawing timing diagnostics | History is lost from the new account. It stays readable in SOURCE while SOURCE is kept. |
| `alerts:incidents`, `alerts:monitor` | Live alert deduplication | A condition that is still open may send **one** repeat email after cutover |

Live **selection** is in CONFIG KV (copied). Photo alert incidents are in D1 (copied).
To preserve timelines/alert dedupe exactly, a read-only export method on the SOURCE Durable Object (service binding only)
and a matching import in DESTINATION would be needed. That is a production code deploy and needs separate approval.

## What changes before cutover

- D1: winners (Nov 8 drawing), photo queue/imports/attempts/rows, alert incidents, webhook receipts, and any admin
  edits to donors, events, photos, prizes and corrections.
- R2: new photo submissions and posters.
- KV CONFIG: `raffle_live*` and `raffle_video_presentation:*` change during each drawing.
- KV SESSION and Durable Object: not carried over (above).

## Cutover runbook

Schedule it **outside 17:45–18:45 Central** and tell admins not to make changes during it.

Prerequisites (can be done beforehand):
1. Enable R2 in DESTINATION (billing activation), create `folh-photos` (location ENAM), upload the 28 objects from
   the backup and verify by MD5/size. Add the `PHOTOS_BUCKET` binding to the staging Pages project (production and
   preview) and redeploy. Recheck `/api/photos/<key>` and event posters.
2. Enter all secrets above in DESTINATION. Verify staging admin login and an admin read, without editing production data.
3. Decide the domain path (see "Domain and DNS"). Export DNS records from the SOURCE dashboard
   (DNS → Records → Export). The wrangler login cannot read DNS.

Cutover:
1. **Stop SOURCE automation**: redeploy the SOURCE Photo Worker with crons `[]` and photo/alert flags `false`, and
   the SOURCE Live Worker with `wrangler.video.existing-account.json` (crons `[]`, flags off). Record the previous
   version IDs (Live `1b6719db-22fc-4aeb-9b04-9d511c7a183f`, Photo `660df4f7-16f4-496a-bac1-6f234c3e136a` at the
   time of writing).
2. **Final D1 sync**: export SOURCE, drop every table in DESTINATION (keep the database and its ID), import, and
   compare hashes for every table and `sqlite_sequence`. All must match.
3. **Final KV sync**: re-copy CONFIG and delete DESTINATION keys that are not in SOURCE; verify hashes.
4. **Final R2 sync**: copy objects that are new or have a different ETag; verify the count, bytes and MD5s; recheck D1 references.
5. **Activate DESTINATION Workers**: Live first with the activation settings (cron `* * * * *`, automation, probe,
   alerts live), then Photo (cron `*/2 * * * *`, `workers_dev: true`, all flags as in `wrangler.json`). Use the
   destination account and resource IDs.
6. **Facebook webhook**: change the callback to
   `https://folh-facebook-winner-photos.friendsoflakehenryblair.workers.dev/facebook/webhook` and re-verify the subscription.
7. **Domain**: move `friendsoflakehenry.com` to the DESTINATION Pages project (below).
8. Verify: public pages, winners, photos, admin login, the contact form (Turnstile and Resend), one cron tick each in
   both Workers, and no cron running in SOURCE.

## Domain and DNS

The zone is in SOURCE. A Pages custom **apex** domain needs the zone in the same account as the project, so the zone
has to be added to DESTINATION. That gives it new nameservers to set at the registrar. Before that:
- Recreate every DNS record from the export, including mail (MX/SPF/DKIM/DMARC) records and the Resend
  domain-verification records.
- Recreate zone settings now active on production: email obfuscation, bot/AI-crawler protection (`/cdn-cgi/content`)
  and any other zone settings.
- Check where the domain is registered. If it uses Cloudflare Registrar, follow Cloudflare's account-transfer process.
This is the step with possible downtime. Lower DNS TTLs a day ahead if the records allow it.

## Git deployments

The destination project is Direct Upload, and Cloudflare cannot convert a Direct Upload project to Git integration.
For automatic deploys from GitHub, either (a) delete this staging project at cutover and create a Git-connected one
(after authorizing the Cloudflare GitHub app for the nonprofit account), or (b) keep Direct Upload and deploy from CI.
The SOURCE project's GitHub connection stays as it is until the domain has moved.

## Rollback

SOURCE resources stay intact. Keep them for at least 7 days.
1. Redeploy the SOURCE Workers at their recorded versions (crons and flags back on). Point the Facebook webhook back to
   `https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook`.
2. Point the domain back to the SOURCE Pages project (restore the previous nameservers, or the DNS records/custom domain).
3. Disable DESTINATION crons and flags.
4. Reverse-sync anything written in DESTINATION after cutover (winners, photo imports, R2 uploads, admin edits) into
   SOURCE using the same export, compare and import steps.
