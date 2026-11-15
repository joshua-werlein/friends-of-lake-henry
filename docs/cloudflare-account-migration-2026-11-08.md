# Cloudflare account migration (staged 2026-11-07, production re-verified 2026-11-15)

Move Friends of Lake Henry from the **personal Cloudflare account** (`aa86268490e681cccb3a41a62093e2aa`, SOURCE)
to the **nonprofit Cloudflare account** (`ffe1aa6f4a533743f8f1b624f43c6d3d`, DESTINATION).
Phase 1 created and filled destination resources only. Nothing in SOURCE was modified, and no traffic,
DNS, Facebook webhook, cron, or email was switched.

## Status on 2026-11-15

**Decision: no cutover before the season ends. The domain move waits until after November 30, 2026.**
The Cloudflare Registrar move (below) cannot be undone quickly and needs the destination to accept it, so it is not
done between nightly drawings.

Pages and Worker evidence is from the November 15 production investigation. Destination staging, DNS, and the
schema inventory below reflect the November 14 checkpoint.

| Item | SOURCE (production) | DESTINATION (staging) |
|---|---|---|
| Pages | `3a16b88e-5ff4-447b-b982-5da9e8ba6b1a` from `482d85107a83d8205dec7bae1f6ba77cc04d26b8`; hosted Node **22.23.5**. Production selector `main`; both automatic production and preview builds disabled | Direct Upload staging (Nov 8 build); pages 200, `/api/photos/file` **500** (no R2) |
| D1 schema | migrations 001–008, 17 tables, **009 not applied** | same; **009 not applied** |
| D1 data | 60 winners through 2026-11-13 | 46 winners through 2026-11-07 (stale by design; final sync replaces it) |
| R2 `folh-photos` | 28 objects, 16.6 MB, ENAM (unchanged since Nov 8) | **R2 not enabled** (API code 10042) |
| Live Worker | `ced68381-190a-42dd-b426-511e14d88ea3` at 100%; successful discovery on Nov 14 | `a134d4df`, no cron, flags off |
| Photo Worker | `3d4928c9-4fe6-46a8-8989-6c2ece78458d` at 100%, built from `893d371`; Nov 13 fallback poll processed a winner photo | `1ca3d573`, no cron, flags off |
| Secrets | Pages 7, Live 3, Photo 5 (names below) | **none** |
| `FOHL_SYNC_*` credentials | not set (legacy credentials in use) | not set |
| Domain | Cloudflare Registrar, `clientTransferProhibited`, DNSSEC off, expires 2027-12-12, NS `angelina`/`sam` | not added |

The [SOURCE Pages rollback](https://dash.cloudflare.com/aa86268490e681cccb3a41a62093e2aa/pages/view/friends-of-lake-henry/995a1755-4d19-4d31-af4e-a3227b2d9130) is `995a1755-4d19-4d31-af4e-a3227b2d9130`, built from `cf8252e` under Node 20.20.0. Keep it as an emergency artifact in SOURCE. The Node release retained the Pages build settings and production bindings, and the standalone Worker versions, binding inventories, and cron settings matched the production records.

Cloudflare analytics recorded 79 successful Live cron invocations and 1,445 successful Photo cron invocations, with zero cron errors in the 48-hour investigation window. The Live Worker verified the November 14 broadcast at 6:15 p.m. Central with zero consecutive failures and no pending videos or backoff. Photo ran all ten cron ticks in that night's polling window. D1 has no active Photo jobs or November 14 winner rows, and the one webhook item for that window was ignored. The records do not establish whether Facebook offered a qualifying winner photo. Reconcile that drawing and review the [November 13 rejected rows and older failed job](raffle-photo-ai-usage-2026-11-12.md#production-follow-up-2026-11-15) before the final sync.

Public DNS seen from outside: proxied A/AAAA on the apex, a `google-site-verification` TXT, no MX, no CAA, no DS,
nothing at `www`, `_dmarc`, `resend._domainkey` or `send`. The full record set (including non-public settings) must still
be exported from the SOURCE dashboard; the wrangler login cannot read DNS records.

The Nov 8 local R2 backup folder is no longer on the workstation. R2 will be copied directly from SOURCE (read-only)
once DESTINATION R2 is enabled. The 24 D1-referenced keys can be read with wrangler; listing the 4 unreferenced
objects needs the dashboard object list or an R2 S3 API token (the wrangler OAuth token is refused by the list API).

### Release sources and dependency maintenance

- The Pages source is `482d851` on `codex/pages-node-22-security`. It is a direct child of `cf8252e` with only four Node version and documentation edits. The November 15 GitHub `main` check found `608a792`, which includes the integrated Photo Worker changes, the season/calendar work (`f6c73a4`), and migration 009.
- `main` code **requires migration 009** (Pages and the integrated Photo Worker). Until 009 is applied in production,
  every push to `main` must carry `[CF-Pages-Skip]` on its head commit, and no Worker is deployed from `main`.
- Production Photo Worker source: branch `fix/photo-ai-usage` (pushed) and tag `photo-worker-3d4928c9` → `893d371`.
  Rollback Photo version `13311c6d` was built from the `../folh-hotfix` worktree lineage (believed `6c65cec`; unconfirmed).
- Kept until migration and rollback verification are complete: branches `codex/pages-node-22-security`, `fix/photo-ai-usage`,
  `hotfix/photo-nov11-column-association`, `integrate/photo-ai-usage-main`, `codex/raffle-stabilization`,
  `backup/bad-prod-fix`, and all worktrees.
- Local backups: `C:\Users\Jwerl\dev\folh-all-refs-2026-11-14.bundle` (verified) and
  `C:\Users\Jwerl\dev\folh-backups-2026-11-14\` (13 ignored `.sql` files with SHA-256 manifests).
- Not yet identified: the commit that built Live version `ced68381`.

The November 15 audit of the Pages lockfile found **23 package findings** (1 critical, 21 high, 1 low). The production-declared audit shows two high entries (`@astrojs/sitemap` and its Zod dependency) for one Zod issue, with no public validation path identified. Zod's fix starts at `4.6.6`. A sitemap-only upgrade needs an Astro 5 build and XML parity check. The Astro AVIF finding requires untrusted input to reach Sharp optimization. The deployed R2 photo routes serve stored bytes, and no public path to that optimizer was identified.

Before cutover, pin and test a Wrangler v4 release **at least `4.59.1`** for Direct Upload. This is the [CLI command-injection fix floor](https://github.com/advisories/GHSA-36p8-mvp6-cv38), and the audit can still report inherited findings above that floor. If passing `--commit-hash`, use the verified full Git SHA. Use the patched CLI outside the application lockfile. Schedule the broader [Astro and Cloudflare adapter upgrade](astro-7-upgrade-assessment.md) after the account cutover stabilizes. The newer adapter removes Pages support and requires a separate move to Workers and changes to how binding access works.

### Migration 009 sequence

Migration 009 is additive (old code ignores the new columns). It also records November 2026's calendar as
`approved` with heading `Firearm`, which is the approval the integrated Photo Worker checks before any AI read.

1. Cut over first with the code that runs in production today: Pages from `482d851` built with Node 22.23.5, Photo Worker from `893d371`,
   Live Worker from the `ced68381` source commit. No schema change during the move.
2. After cutover is stable: apply 009 to DESTINATION D1 (the only production database by then), verify
   `raffle_months.calendar_status = 'approved'` for `2026-11` (or the current season's month), then deploy Pages and
   the Photo Worker from `main`.
3. Treat any proposal to run 009 before the cutover as a separate change to the plan. The reviewed cutover uses schema 001–008 in both accounts.

## Inventory and mapping

| Resource | SOURCE (production) | DESTINATION (staged) |
|---|---|---|
| Pages project | `friends-of-lake-henry` (GitHub, selector `main`, automatic production and preview builds off; domains `friendsoflakehenry.com`, `friends-of-lake-henry.pages.dev`) | `friends-of-lake-henry` id `532b6a24-6dbd-4ea2-86ae-66ce2e5ec62e`, **Direct Upload**, `friends-of-lake-henry-d16.pages.dev` |
| D1 `folh-db` | `527df871-e876-4924-81d0-5d0572b4dd7b` | `ecde3f50-a040-415b-ae61-06045302c37e` (ENAM) |
| KV `folh-config` (binding `CONFIG`) | `b70df87ff3db4230a621d4a39ab24ff7` | `c4ea8ffeb28a419abc8dafc250a0b6ba` |
| KV `folh-session` (binding `SESSION`) | `d7ea3cc7deef422789bfa015a3c1a6db` | `4d6784e6b44d4353a7f8b54f76e5a4e1` (empty by design) |
| R2 `folh-photos` (binding `PHOTOS_BUCKET`) | 28 objects, 16,606,134 bytes, private, ENAM | **not created: R2 not enabled on the account** |
| Worker `folh-facebook-live-discovery` | UTC crons `50-59 23 * 11 *` and `0-30 0 * 11,12 *`; `FB_AUTOMATION_ENABLED=true`, `FB_VIDEO_PROBE_ENABLED=true`, `ALERTS_ENABLED=true`, `ALERTS_MODE=live`; workers.dev off | version `a134d4df-1133-436a-af28-47615b481d69`, no cron, no workers.dev, flags off, no secrets |
| Durable Object `DiscoveryScheduler` (SQLite) | namespace `2e316a104a5843c4a3a914090c174ff9` | namespace `9435462e26fc43658e15bfb550db2150`, empty |
| Worker `folh-facebook-winner-photos` | UTC cron `*/2 * * * *`; workers.dev on; `FB_PHOTO_AUTOMATION_ENABLED=true`, `FB_PHOTO_AUTOPUBLISH=true`, `FB_PHOTO_POLL_ENABLED=true`, `ALERTS_ENABLED=true`, `ALERTS_MODE=live`, `ALERT_WEBHOOK_DELIVERY_ENABLED=false` | version `1ca3d573-ec83-4986-837d-0669ec525de2`, no cron, no workers.dev, flags off, no secrets |
| Zone `friendsoflakehenry.com` | `521cd66466d2270d975476d8d08b967f`, active, full setup | not added |

`workers/fohl-sync` (`folh-sync-webhook-test`) is a probe and is not deployed in either account.

Inactive configs: `workers/facebook-live/wrangler.nonprofit.staged.json`,
`workers/facebook-photos/wrangler.nonprofit.staged.json`. The staged Photo config is missing the production
`IMAGES` binding. Prepare and validate a DESTINATION configuration with `IMAGES` before activation. Use the account
and resource IDs in this inventory. Staging Pages bindings (production and preview):
`DB`, `CONFIG`, `SESSION`, `FACEBOOK_LIVE → LiveEvents`, `FACEBOOK_PHOTO_STATUS → PhotoDiagnostics`, plain vars
`FB_SEASON_START/END`, `RAFFLE_AUTOMATIC_SELECTION_ENABLED=true`, `RAFFLE_PRIZE_CALENDAR_ENABLED=true`, compat
`2025-09-15` + `nodejs_compat`, `disable_nodejs_process_v2`. No `PHOTOS_BUCKET` until R2 exists.

Existing-state note: SOURCE Pages **preview** deployments are bound to production D1/KV/R2. This was not changed.

Operational note: the repo's `wrangler.json` binds `folh-db` to the SOURCE database ID. Run DESTINATION D1/KV
commands only with a config that names DESTINATION IDs (for example the staged Worker configs), never by name from
the repo root.

## Secrets and variables

Values cannot be read from Cloudflare and must be re-entered. Never paste them into chat, Git, or a command line
argument; use the interactive prompt (`wrangler secret put`) or the dashboard.

| Component | Encrypted secrets (sensitive) | Stored as secrets today but not sensitive | Plain variables (in config, not secret) |
|---|---|---|---|
| Pages | `ADMIN_PASSWORD`, `RESEND_API_KEY`, `TURNSTILE_SECRET` | `ADMIN_USERNAME`, `FROM_EMAIL`, `TO_EMAIL`, `PUBLIC_TURNSTILE_KEY` (site key, visible in page HTML) | `FB_SEASON_START/END`, `RAFFLE_AUTOMATIC_SELECTION_ENABLED`, `RAFFLE_PRIZE_CALENDAR_ENABLED` |
| Live Worker | `FB_PAGE_ACCESS_TOKEN`, `ALERT_RESEND_API_KEY` | `ALERT_EMAIL_TO` | `FB_*` flags, Page IDs, season, `ALERTS_*` (in `wrangler.nonprofit.staged.json`) |
| Photo Worker | `FB_PAGE_ACCESS_TOKEN`, `FB_APP_SECRET`, `FB_WEBHOOK_VERIFY_TOKEN`, `ALERT_RESEND_API_KEY` | `ALERT_EMAIL_TO` | `FB_PHOTO_*` flags, season, `ALERTS_*` (in `wrangler.nonprofit.staged.json`) |

Keep all 15 as encrypted secrets in DESTINATION, for parity with SOURCE. Pages reads them at runtime
(`locals.runtime.env`), so they take effect on the next deployment, not the build.

Turnstile: create a widget in DESTINATION for `friendsoflakehenry.com` and `friends-of-lake-henry-d16.pages.dev`
and use its keys, so the site does not depend on the SOURCE account after it is retired.

## Phase 1 data results (2026-11-07)

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
  3 `events.poster_key`) exist; 4 objects are unreferenced and will be copied anyway. (That folder is gone; see Status.)
- **Durable Object**: not migrated, see below.

Drift on 2026-11-14 (SOURCE / DESTINATION row counts): ops_alert_incidents 10/4, raffle_photo_auto_attempts 186/21,
raffle_photo_auto_imports 13/7, raffle_photo_auto_posts 23/10, raffle_photo_auto_rows 150/46, raffle_winners 60/46.
All other tables match. The final sync replaces DESTINATION entirely.

## Durable Object state

Cloudflare has no export/import for Durable Object storage, and `DiscoveryScheduler` has no dump route. Its keys:

| Key | Purpose | Impact of starting empty |
|---|---|---|
| `cache:*` | Write-through cache of CONFIG KV | None: rebuilt from KV |
| `events`, `pending-event`, `pending-event-at`, `claimed-slot`, `claimed-event` | Per-drawing webhook/Live claim state | None if cutover is outside 17:45–18:45 Central |
| `timeline:<day>`, timing journal | Drawing timing diagnostics | History is lost from the new account. It stays readable in SOURCE while SOURCE is kept. |
| `alerts:incidents`, `alerts:monitor` | Live alert deduplication | A condition that is still open may send **one** repeat email after cutover |

Live **selection** is in CONFIG KV (copied). Photo alert incidents are in D1 (copied).

## Staging requirements (before any cutover)

1. **R2** (owner): enable R2 in DESTINATION (Dashboard → R2 → enable; a payment method is required even for the
   free tier). Then create `folh-photos` (ENAM), copy every SOURCE object, and verify count, bytes and MD5 against
   SOURCE ETags and all D1 references. Add `PHOTOS_BUCKET` to staging Pages (production and preview) and redeploy.
2. **Secrets** (owner): enter the 15 secrets above; redeploy staging Pages.
3. **Staging Pages build**: use a clean checkout at `482d85107a83d8205dec7bae1f6ba77cc04d26b8`. Verify
   `node --version` reports `v22.23.5`, run `npm ci` and `npm run build`, and Direct Upload `dist` with the tested
   patched Wrangler. Verify the DESTINATION project and runtime bindings before the upload. Record the deployment
   ID as the cutover candidate and retain the artifact for recovery. Keep both accounts on schema 001–008 until
   cutover is stable.
4. **Staging tests**: public pages, `/api/photos/file`, event posters, raffle month/prizes APIs, admin login and one
   admin read (no edits), contact form against the DESTINATION Turnstile widget. Workers stay without cron, flags off.
5. **Live source commit**: identify the commit behind `ced68381` and record it here.
6. **DNS export** (owner): SOURCE dashboard → DNS → Records → Export, plus a list of zone settings (SSL/TLS mode, edge
   certificates, email obfuscation, bot/AI-crawler settings, page/redirect/cache rules, Turnstile, any Workers routes).
7. **Resend**: confirm in the Resend dashboard which domain `FROM_EMAIL` uses and which DNS records it requires.

## Domain move: Cloudflare Registrar procedure (after November 30)

The domain is registered with **Cloudflare Registrar**, so use the
[Cloudflare inter-account move](https://developers.cloudflare.com/registrar/account-options/inter-account-transfer/).

Preconditions:
- Registered more than 10 days ago (yes); no administrative lock; no `pendingDelete`/`redemptionPeriod`/`pendingTransfer`.
- Registrant email verified; no pending Change of Registrant.
- DNSSEC off (it is off); zone lock released; no zone hold.
- The domain is added to DESTINATION as a website with a plan selected (Free is enough unless SOURCE uses paid features).

Process: SOURCE → Domain Registration → Manage Domain → **Configuration** → **Start**. DESTINATION receives an email and
accepts under Manage Domains → **View Actions** within **five days**, or the request is cancelled.

Consequences:
- SOURCE zone configuration is lost on transfer. WHOIS contact data moves. Prepare DESTINATION DNS and zone settings
  in advance and allow time for certificates to become active.
- SSL certificates do not move. Universal SSL is reissued for the DESTINATION zone; custom or advanced certificates
  must be re-ordered there.
- The Pages custom domain on the SOURCE project stops working; it must be added to the DESTINATION project.
- The registration is transfer-locked for 30 days afterwards. Cloudflare does not document how quickly, or whether,
  a domain can be moved back between accounts; treat the move as **one-way**.
- The old zone shows as Moved Away, then is deleted after seven days.

### DNS preservation

Before starting the move, in DESTINATION (zone added, pending):
1. Import the SOURCE DNS export. Check every record's proxy status and TTL; an import that proxies records wrongly can
   cause error 1000.
2. Recreate the apex/`www` records the Pages custom domain needs (added through the Pages project once the zone is
   active), the `google-site-verification` TXT, and any Resend/mail records found in step 7 of the staging requirements.
3. Recreate zone settings and rules from the inventory.
4. After the move, compare a fresh DESTINATION export with the SOURCE export line by line, and re-check public answers.

## Cutover runbook (after November 30)

Schedule one supervised window outside 17:45–18:45 Central, after the last drawing and winner reconciliation.
Agree on a maintenance window and an abort point before accepting the Registrar transfer. SOURCE is authoritative
until the final sync and domain switch. DESTINATION becomes the sole writer after the public site is verified there.

1. **Rehearse on DESTINATION.** Complete the staging checks with Pages at `482d851` under Node 22.23.5 and schema
   001–008. Verify that Pages `DB` and Photo `DB` use the same DESTINATION D1 ID, Pages `CONFIG` and Live `CONFIG`
   use the same DESTINATION KV ID, the Live Durable Object and both Pages service bindings resolve there, and Pages
   reads the DESTINATION bucket. Validate the exact Worker source, cron expressions, flags, and bindings for
   activation. Keep staging automation inactive, and close staging write paths before the final sync.
2. **Verify a write freeze on both accounts.** Gate admin mutations, public photo submissions, and contact-form
   sends on the custom domain, Pages aliases, and any reachable previews. Keep SOURCE Pages available for read-only
   service while it is the public site. Pause or gate signed webhook POST delivery to SOURCE, using a tested method
   that retains events for retry or reconciliation. Keep DESTINATION webhook ingress closed. Disable SOURCE crons
   and automation/alert flags, record previous versions and settings, and confirm in-flight jobs, webhook requests,
   and Live alarms have finished or cannot write. Record pending Photo jobs for transfer and account for anything
   received during the freeze. **Turning off the Photo cron or its feature flags does not stop signed webhook
   requests from enqueueing D1 work.** Verify the gate on every reachable webhook URL before exporting.
3. **Sync under the freeze.** Export SOURCE D1, refresh DESTINATION in place, and verify schema, table hashes, and
   `sqlite_sequence`. Re-copy CONFIG KV with matching values, expiry, and metadata, and remove destination-only keys.
   Leave SESSION KV uncopied. Refresh R2 against the final SOURCE manifest and verify every D1 object reference.
   Keep snapshots of both accounts and confirm SOURCE did not change after the export. Repeat the sync if a SOURCE
   write slipped through. On the reviewed DESTINATION Pages deployment, verify read-only parity for winners, the
   prize calendar, posters, photos, and Live selection. Compare Live selection using stored CONFIG and the
   read-only service snapshot. The public Live API can record timing diagnostics during the season.
4. **Move the public domain with writes still frozen.** Start and accept the Registrar move only after the final
   parity checks pass and both owners are available. Keep both accounts' automation and webhook POST ingress
   gated while the domain or certificate is pending. Once the DESTINATION zone is active, associate
   `friendsoflakehenry.com` (and `www` if used) with the verified Pages deployment. Check the certificate, public
   routing, Pages deployment ID, and read-only parity on the actual domain. Treat the waiting period as maintenance
   if the apex or its certificate is unavailable.
5. **Activate DESTINATION against the same data the public site reads.** Confirm the old SOURCE Pages aliases and
   previews remain write-gated. Activate Live first from the verified `ced68381` source, then Photo from `893d371`,
   using the DESTINATION resource IDs, the exact UTC schedules and flags in the inventory, and the Photo
   `IMAGES` binding. The copied season ends at midnight Central on December 1. Expect no November backup polling
   after its eligible window, and verify the next eligible natural executions without extending the season.
   Switch and re-verify the Facebook callback at
   `https://folh-facebook-winner-photos.friendsoflakehenryblair.workers.dev/facebook/webhook`.
   Verify SOURCE ingestion and scheduling remain stopped before accepting DESTINATION deliveries. Reconcile
   deferred deliveries and check the D1 queue, alerts and Live replay before reopening forms and admin writes on
   DESTINATION. Keep SOURCE mutation paths gated.

The Registrar request can remain pending for up to five days. Starting DESTINATION automation before the public
domain switches would leave SOURCE Pages reading stale winners or Live state while background jobs write to the
new account. An admin-only freeze also leaves public uploads, contact email, and webhook ingestion exposed to
split writes. If a write or ingress gate, final sync, or domain handoff cannot be verified, stop at the applicable
rollback point before enabling another writer.

## Rollback

SOURCE resources stay intact for at least 7 days after the domain moves (and longer while the 30-day lock runs).

**Before DESTINATION accepts the Registrar transfer:** verify the public domain still serves SOURCE and coordinate
cancelling any pending move. Keep DESTINATION writes gated. Reconcile any writes that escaped the freeze and verify
SOURCE data before restoring its webhook at
`https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook`, Worker versions, schedules, and public
write paths. If the SOURCE Pages build itself fails, use SOURCE rollback `995a1755` and verify its production alias.

**After DESTINATION accepts:** keep the public site and any active writers in DESTINATION during recovery.
- **Application fault:** use the verified DESTINATION Pages artifact built from `482d851` or a known-good deployment
  in the DESTINATION project. SOURCE deployment `995a1755` cannot roll back the DESTINATION project.
- **Data fault:** freeze DESTINATION writes, preserve the current snapshot, and reconcile post-cutover writes before
  restoring with D1 Time Travel or the cutover export. Recheck KV and R2 consistency before reopening.
- **Automation fault:** gate the DESTINATION callback, crons, and flags until the known-good versions and bindings
  are verified. Keep SOURCE Workers stopped. Use a reviewed manual fallback on DESTINATION if needed.
- **DNS or certificate fault:** restore the DESTINATION routing and zone settings from the export. Keep the write gate
  until the apex, certificate, and Pages deployment are confirmed.

## Git deployments

Keep the tested DESTINATION Direct Upload project for cutover. Build `482d851` with Node 22.23.5, then use
the tested Wrangler v4 release at or above `4.59.1` to run
`wrangler pages deploy dist --project-name friends-of-lake-henry` with the DESTINATION account.
Cloudflare does not convert a Direct Upload project to Git integration in place. Revisit Git integration after
cutover in a separate change.
Keep the SOURCE project's GitHub connection and both automatic build modes disabled during the cutover. Restore
automatic production builds only after the newer application and migration 009 are approved for release.
