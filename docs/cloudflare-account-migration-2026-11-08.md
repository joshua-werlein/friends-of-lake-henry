# Cloudflare account migration (staged 2026-11-07, re-verified 2026-11-14)

Move Friends of Lake Henry from the **personal Cloudflare account** (`aa86268490e681cccb3a41a62093e2aa`, SOURCE)
to the **nonprofit Cloudflare account** (`ffe1aa6f4a533743f8f1b624f43c6d3d`, DESTINATION).
Phase 1 created and filled destination resources only. Nothing in SOURCE was modified, and no traffic,
DNS, Facebook webhook, cron, or email was switched.

## Status on 2026-11-14 (after the Nov 14 drawing)

**Decision: no cutover before the season ends. The domain move waits until after November 30, 2026.**
The Cloudflare Registrar move (below) cannot be undone quickly and needs the destination to accept it, so it is not
done between nightly drawings.

Verified tonight (read-only, except Git):

| Item | SOURCE (production) | DESTINATION (staging) |
|---|---|---|
| Pages | production deployment from `cf8252e` (Nov 9); later `main` commits are `[CF-Pages-Skip]` (Idle) | Direct Upload staging (Nov 8 build); pages 200, `/api/photos/file` **500** (no R2) |
| D1 schema | migrations 001–008, 17 tables, **009 not applied** | same; **009 not applied** |
| D1 data | 60 winners through 2026-11-13 | 46 winners through 2026-11-07 (stale by design; final sync replaces it) |
| R2 `folh-photos` | 28 objects, 16.6 MB, ENAM (unchanged since Nov 8) | **R2 not enabled** (API code 10042) |
| Live Worker | version `ced68381-190a-42dd-b426-511e14d88ea3` (Nov 10), running | `a134d4df`, no cron, flags off |
| Photo Worker | version `3d4928c9-4fe6-46a8-8989-6c2ece78458d` (Nov 13, from `893d371`), running | `1ca3d573`, no cron, flags off |
| Secrets | Pages 7, Live 3, Photo 5 (names below) | **none** |
| `FOHL_SYNC_*` credentials | not set (legacy credentials in use) | not set |
| Domain | Cloudflare Registrar, `clientTransferProhibited`, DNSSEC off, expires 2027-12-12, NS `angelina`/`sam` | not added |

Public DNS seen from outside: proxied A/AAAA on the apex, a `google-site-verification` TXT, no MX, no CAA, no DS,
nothing at `www`, `_dmarc`, `resend._domainkey` or `send`. The full record set (including non-public settings) must still
be exported from the SOURCE dashboard; the wrangler login cannot read DNS records.

The Nov 8 local R2 backup folder is no longer on the workstation. R2 will be copied directly from SOURCE (read-only)
once DESTINATION R2 is enabled. The 24 D1-referenced keys can be read with wrangler; listing the 4 unreferenced
objects needs the dashboard object list or an R2 S3 API token (the wrangler OAuth token is refused by the list API).

### Git state on 2026-11-14

- `main` = `84f50a1` on GitHub. It contains the deployed Photo Worker changes (`6e8043f` … `893d371`, ported), the
  deployment record (`2d6878e`, as `84f50a1`), the season/calendar work (`f6c73a4`) and migration 009.
- `main` code **requires migration 009** (Pages and the integrated Photo Worker). Until 009 is applied in production,
  every push to `main` must carry `[CF-Pages-Skip]` on its head commit, and no Worker is deployed from `main`.
- Production Photo Worker source: branch `fix/photo-ai-usage` (pushed) and tag `photo-worker-3d4928c9` → `893d371`.
  Rollback Photo version `13311c6d` was built from the `../folh-hotfix` worktree lineage (believed `6c65cec`; unconfirmed).
- Kept until migration and rollback verification are complete: branches `fix/photo-ai-usage`,
  `hotfix/photo-nov11-column-association`, `integrate/photo-ai-usage-main`, `codex/raffle-stabilization`,
  `backup/bad-prod-fix`, and all worktrees.
- Local backups: `C:\Users\Jwerl\dev\folh-all-refs-2026-11-14.bundle` (verified) and
  `C:\Users\Jwerl\dev\folh-backups-2026-11-14\` (13 ignored `.sql` files with SHA-256 manifests).
- Not yet identified: the commit that built Live version `ced68381`.

### Migration 009 sequence

Migration 009 is additive (old code ignores the new columns). It also records November 2026's calendar as
`approved` with heading `Firearm`, which is the approval the integrated Photo Worker checks before any AI read.

1. Cut over first with the code that runs in production today: Pages from `cf8252e`, Photo Worker from `893d371`,
   Live Worker from the `ced68381` source commit. No schema change during the move.
2. After cutover is stable: apply 009 to DESTINATION D1 (the only production database by then), verify
   `raffle_months.calendar_status = 'approved'` for `2026-11` (or the current season's month), then deploy Pages and
   the Photo Worker from `main`.
3. If 009 is ever needed before cutover, apply it to SOURCE first and rerun the final D1 sync so both schemas match.

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
| Zone `friendsoflakehenry.com` | `521cd66466d2270d975476d8d08b967f`, active, full setup | not added |

`workers/fohl-sync` (`folh-sync-webhook-test`) is a probe and is not deployed in either account.

Inactive configs: `workers/facebook-live/wrangler.nonprofit.staged.json`,
`workers/facebook-photos/wrangler.nonprofit.staged.json`. Staging Pages bindings (production and preview):
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
3. **Staging Pages build**: deploy `cf8252e` (the production commit) with Direct Upload to the staging project.
4. **Staging tests**: public pages, `/api/photos/file`, event posters, raffle month/prizes APIs, admin login and one
   admin read (no edits), contact form against the DESTINATION Turnstile widget. Workers stay without cron, flags off.
5. **Live source commit**: identify the commit behind `ced68381` and record it here.
6. **DNS export** (owner): SOURCE dashboard → DNS → Records → Export, plus a list of zone settings (SSL/TLS mode, edge
   certificates, email obfuscation, bot/AI-crawler settings, page/redirect/cache rules, Turnstile, any Workers routes).
7. **Resend**: confirm in the Resend dashboard which domain `FROM_EMAIL` uses and which DNS records it requires.

## Domain move: Cloudflare Registrar procedure (after November 30)

The domain is registered with **Cloudflare Registrar**, so it cannot be moved by adding the zone elsewhere and
changing nameservers. Cloudflare's inter-account move is required
(<https://developers.cloudflare.com/registrar/account-options/inter-account-transfer/>, checked 2026-11-14):

Preconditions:
- Registered more than 10 days ago (yes); no administrative lock; no `pendingDelete`/`redemptionPeriod`/`pendingTransfer`.
- Registrant email verified; no pending Change of Registrant.
- DNSSEC off (it is off); zone lock released; no zone hold.
- The domain is added to DESTINATION as a website with a plan selected (Free is enough unless SOURCE uses paid features).

Process: SOURCE → Domain Registration → Manage Domain → **Configuration** → **Start**. DESTINATION receives an email and
accepts under Manage Domains → **View Actions** within **five days**, or the request is cancelled.

Consequences:
- "The move will result in the loss of all configurations and settings for the domain in the source account."
  Only WHOIS contact data moves. DNS records, zone settings, rules and certificates must already exist in DESTINATION.
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

Schedule it outside 17:45–18:45 Central and tell admins not to make changes during it.

1. **Stop SOURCE automation**: redeploy the SOURCE Photo Worker with crons `[]` and photo/alert flags `false`, and
   the SOURCE Live Worker with `wrangler.video.existing-account.json` (crons `[]`, flags off). Record the version IDs
   being replaced (Live `ced68381`, Photo `3d4928c9` as of 2026-11-14).
2. **Final D1 sync**: export SOURCE, drop every table in DESTINATION (keep the database and its ID), import, and
   compare hashes for every table and `sqlite_sequence`. All must match.
3. **Final KV sync**: re-copy CONFIG and delete DESTINATION keys that are not in SOURCE; verify hashes.
4. **Final R2 sync**: copy objects that are new or have a different ETag; verify the count, bytes and MD5s; recheck D1 references.
5. **Activate DESTINATION Workers**: Live first with the activation settings (cron `* * * * *`, automation, probe,
   alerts live), then Photo (cron `*/2 * * * *`, `workers_dev: true`, all flags as in `wrangler.json`), both from the
   production commits (not `main`), with DESTINATION account and resource IDs. Confirm no cron runs in SOURCE.
6. **Facebook webhook**: change the callback to
   `https://folh-facebook-winner-photos.friendsoflakehenryblair.workers.dev/facebook/webhook` and re-verify the subscription.
7. **Verify on `friends-of-lake-henry-d16.pages.dev`**: public pages, winners, photos, admin login, contact form, one
   cron tick in each DESTINATION Worker.
8. **Point of no return: Registrar move** (above). Start it only after steps 1–7 pass. While it is pending, the site
   keeps serving from SOURCE Pages (data is now written in DESTINATION, so freeze admin edits until the domain moves).
9. Once the DESTINATION zone is active: add `friendsoflakehenry.com` (and `www` if used) as custom domains on the
   DESTINATION Pages project; confirm certificates are active; repeat the step 7 checks on the real domain.

## Rollback

SOURCE resources stay intact for at least 7 days after the domain moves (and longer while the 30-day lock runs).

**Before step 8 (fully reversible):**
1. Disable DESTINATION crons and flags.
2. Redeploy the SOURCE Workers at their recorded versions (crons and flags back on). Point the Facebook webhook back
   to `https://folh-facebook-winner-photos.jjwerlein.workers.dev/facebook/webhook` and re-verify it.
3. Reverse-sync anything written in DESTINATION after step 2 (winners, photo imports, R2 uploads, admin edits) into
   SOURCE with the same export, compare and import steps.

**After step 8 (domain in DESTINATION, move back not available):** roll back inside DESTINATION.
- Application fault: redeploy the previous DESTINATION Pages deployment or a known-good commit; redeploy Workers at
  their previous DESTINATION versions.
- Data fault: restore DESTINATION D1 with D1 Time Travel or re-import the cutover export.
- Automation fault: disable DESTINATION Worker crons/flags; SOURCE Workers can be re-enabled temporarily for Live and
  photos (they write to SOURCE D1, so reverse-sync is then required).
- DNS fault: correct records in the DESTINATION zone from the SOURCE export.

## Git deployments

The destination project is Direct Upload, and Cloudflare cannot convert a Direct Upload project to Git integration.
For automatic deploys from GitHub, either (a) delete this staging project at cutover and create a Git-connected one
(after authorizing the Cloudflare GitHub app for the nonprofit account), or (b) keep Direct Upload and deploy from CI
or a documented local command (`npm run build`, then `wrangler pages deploy dist --project-name friends-of-lake-henry`
with the DESTINATION account). Recommended: (b) for the cutover, so the staged and verified project is the one that
goes live; revisit Git integration after the season.
The SOURCE project's GitHub connection stays as it is until the domain has moved.
