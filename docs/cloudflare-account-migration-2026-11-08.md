# Cloudflare account migration (staged 2026-11-07, production re-verified 2026-11-19)

Move Friends of Lake Henry from the **personal Cloudflare account** (`aa86268490e681cccb3a41a62093e2aa`, SOURCE)
to the **nonprofit Cloudflare account** (`ffe1aa6f4a533743f8f1b624f43c6d3d`, DESTINATION).
Phase 1 created and filled destination resources only. Nothing in SOURCE was modified, and no traffic,
DNS, Facebook webhook, cron, or email was switched.

## Status on 2026-11-19

**Decision: no cutover before the season ends. The domain move waits until after November 30, 2026.**
The Cloudflare Registrar move (below) cannot be undone quickly and needs the destination to accept it, so it is not
done between nightly drawings.

Production and staging Pages, Worker and D1 evidence is from the November 18–19 releases (read-only checks after each). DNS and
the R2 inventory below reflect the November 14 checkpoint. **Migration 009 is not applied to either database.**

## Next-session cutover action tracker (updated 2026-11-19)

**Current disposition: NO-GO for cutover.** SOURCE production `93fe0d3b` and DESTINATION staging
`1c163014` both use the tested `da5333c` Astro 5 security release; `/_image` returns 404 in both.
DESTINATION staging is **not feature-complete** because R2 and secrets are missing. Do not treat a
successful Pages upload as proof that account migration is ready. No further FOHL operations are
authorized by this checklist; each production-impacting stage requires a fresh preflight and explicit
owner approval. **Resume this tracker after the November 30 raffle-season cutoff**, not during
nightly drawings. Update the checkboxes only after recording evidence, IDs and UTC times in this runbook.

**Owner prerequisites (block staging readiness):**

- [ ] **Enable DESTINATION R2 / payment method.** Confirm the correct nonprofit account and create
  private `folh-photos` in ENAM. Do not enable public `r2.dev` access.
- [ ] **Transfer and verify R2 objects.** Copy all SOURCE `folh-photos` objects (baseline: 28,
  16,606,134 bytes); verify each object/checksum or ETag, the total, and every D1 photo/poster
  reference. Bind `PHOTOS_BUCKET` to DESTINATION Pages and redeploy the **patched** build.
- [ ] **Provision all 15 DESTINATION secrets and Turnstile.** Record only secret names, presence and
  verification results; decide which Facebook and Resend credentials require rotation. Configure a
  DESTINATION Turnstile widget for the public domain and staging hostname. Do not place secret
  values in Git, logs, chat or CLI arguments.
- [ ] **Export SOURCE DNS and zone settings; plan DESTINATION parity.** Include HSTS
  (`max-age=15552000; includeSubDomains`), SSL/TLS, redirect/cache/WAF configuration and required
  Resend DNS records. Confirm registration/transfer prerequisites without initiating the move.

**Engineer prerequisites (validate while automation remains OFF):**

- [ ] **Photo Worker parity.** Add the missing DESTINATION `IMAGES` binding, check the exact source
  commit and staged bindings; keep cron, public Worker URL, auto-import and alert flags off.
- [ ] **Live Worker provenance.** Identify the source commit corresponding to SOURCE `ced68381`,
  rebuild and stage that exact version in DESTINATION; verify Durable Object/service bindings with
  schedules and alert/automation flags off.
- [ ] **Full DESTINATION staging regression.** After R2, secrets and Turnstile exist, verify public
  photos/posters, raffle/prizes/Live, admin login and one read including Photo imports, review-photo
  privacy, contact/photo submit and correct email behavior using safe isolated checks. Confirm
  `/_image` remains 404; record the exact Pages deployment SHA and bindings. Do not exercise
  production mutations from staging.
- [ ] **Reconcile final November operations.** Confirm all drawings/winners, photo imports,
  unresolved whole-photo Issues and failed/retry jobs have been reviewed. Document any deferred
  webhook or delivery events before allowing a freeze.
- [ ] **Cutover dry-run and sign-off.** Recheck SOURCE and DESTINATION version parity; list pending
  migrations (001–008 and 010 applied, **009 absent**); verify a safe write/ingress freeze covers
  custom domains, Pages aliases/previews, admin, public forms, webhook POSTs, crons and in-flight
  jobs. Prove rollback and keep DESTINATION automation disabled until domain and data are verified.

**Only after all prerequisites pass and the owner authorizes cutover (after November 30):**

- [ ] Execute the supervised final SOURCE D1/CONFIG KV/R2 sync under a proven write freeze.
  Compare schema, table/row fingerprints, raffle/photo records and object manifests. Do not copy
  SESSION KV. Resolve drift before the Registrar move.
- [ ] Obtain separate approval for and execute the Cloudflare Registrar inter-account move;
  restore DNS/HSTS/SSL and confirm the public domain, patched `/_image` behavior and read-only
  parity in DESTINATION before enabling any writer. Treat the move as operationally one-way.
- [ ] Activate verified DESTINATION Live/Photo Workers and webhook delivery in the documented
  sequence only after SOURCE ingestion and cron processing are off; reconcile queued events,
  then reopen forms/admin writes. Preserve SOURCE backups and rollback evidence.
- [ ] **Post-cutover only:** after stability, separately approve migration 009 on DESTINATION,
  verify calendar approval, port/supersede `da5333c` on Git `main` before any main-based Pages
  deployment, and schedule Astro 7/Workers modernization as an independent project.

**Hard stop / NO-GO:** R2 or secrets absent; wrong binding/account; a staging 500 for a required
photo/poster; failed authenticated admin, privacy or Turnstile checks; exposed `/_image`; unknown
Live Worker source; unreconciled winners; unproven write/webhook freeze; unverified data parity;
missing registrar/DNS/HSTS recovery plan; or a proposed migration 009 before stability.
Do not compensate by using unpatched `d92eb2c` / `7cdc9851` builds.

**Security release (Nov 19, 21:54 UTC SOURCE, 22:04 UTC DESTINATION).** Both accounts run
`da5333c782ad9a401c4877e36b9d515874daaa85` (`security/astro5-pages-d92eb2c`, pushed, not merged; parent `d92eb2c`): Astro
`5.18.2`, `@astrojs/cloudflare` `12.6.13`, `@astrojs/sitemap` `3.7.1`, passthrough image service, and `/_image` excluded from
Pages Functions with its route mapped to a constant 404. Before it, `/_image?href=/favicon.svg` returned **200** on both
hostnames (the adapter image endpoint proxied local assets). After it, every tested variant returns 404 in both accounts. The
two uploads used the same `dist` (110 files, fingerprint `9bb9881efa4188c8`, Node 22.23.5, clean `git archive` export, 188 + 16
tests, four typechecks, built-Worker smoke test). No binding, secret, Worker, D1 or KV change. **`d92eb2c` and every older
Pages build expose that endpoint; do not upload them to either account except as an emergency rollback.** The Astro AVIF
advisory (GHSA-26w7) and other Astro 5 advisories remain in the installed package until the Astro 7 upgrade; the release
removes the reachable image-processing path, it does not resolve them.

| Item | SOURCE (production) | DESTINATION (staging) |
|---|---|---|
| Pages | `93fe0d3b-8991-41c1-bad2-3d9594ca2a0c` (Nov 19, 21:54 UTC), **Direct Upload** of `da5333c` (the security release above on `d92eb2c`: inline photo review, history with Needs review / Issues / Completed / All, mobile scrolling) built from a clean `git archive` export with Node **22.23.5**. Production branch `main`; automatic production deployments paused; preview builds off. Previous: `2f96df08` (`d92eb2c`, unpatched `/_image`), `ba1bc408` (`f789234`), `3a16b88e` (hosted build of `482d851`) | `1c163014-f387-4bdc-8ee9-ce6a831680da` (Nov 19, 22:04 UTC), Direct Upload of the **same `da5333c` `dist`** with DESTINATION bindings, on `friends-of-lake-henry-d16.pages.dev` only. Previous: `7cdc9851` (`d92eb2c`, unpatched), `df1fc387` (Nov 8, `97c81a0`). `/api/photos/file` and both poster routes **500** until R2 exists |
| D1 schema | migrations 001–008 **and 010** (010 adds only `raffle_photo_row_resolutions`); **009 not applied** | same: 001–008 and 010; **009 not applied** |
| D1 data | 70 winners (verified unchanged through every Nov 19 release); 20 photo-review resolutions (Nov 19); 2 open whole-photo Issues (the Nov 12 quota failure and a Nov 5 rejection) to mark handled after checking their winners | 46 winners through 2026-11-07 (stale by design; final sync replaces it) |
| R2 `folh-photos` | 28 objects, 16.6 MB, ENAM (unchanged since Nov 8) | **R2 not enabled** (API code 10042) |
| Live Worker | `ced68381-190a-42dd-b426-511e14d88ea3` at 100% (unchanged) | `a134d4df`, no cron, flags off |
| Photo Worker | `077637f8-f77a-4773-a0cc-289a7313defa` at 100% (Nov 19 02:18 UTC), built from `49b3fd3` (`fix/photo-name-separator`): `7a9d4c4` plus the Nov 16 name-separator fix. Previous: `dc1ad438` (`7a9d4c4`), `3d4928c9` (`893d371`) | `82b7d603-6bcb-4fff-ba1b-c427b80c9f11` (Nov 19), built from `49b3fd3` with `wrangler.nonprofit.staged.json`: no cron, workers.dev off, all automation and alert flags off, **no `IMAGES` binding yet**. Previous: `1ca3d573` (Nov 8) |
| Secrets | Pages 7, Live 3, Photo 5 (names below) | **none** |
| `FOHL_SYNC_*` credentials | not set (legacy credentials in use) | not set |
| Domain | Cloudflare Registrar, `clientTransferProhibited`, DNSSEC off, expires 2027-12-12, NS `angelina`/`sam` | not added |

SOURCE Pages rollback order: `2f96df08-e195-4a5f-8e14-36070fb6d74c` (`d92eb2c`, same features as `93fe0d3b` but with the unpatched `/_image` endpoint; verified listed and serving on its alias Nov 19; use only for an application regression and re-release a patched build promptly), then `ba1bc408-a311-4285-bb37-09552713373c` (`f789234`, inline review without the history view), then `3a16b88e-5ff4-447b-b982-5da9e8ba6b1a` (hosted build of `482d851`, Node 22.23.5; its code ignores migration 010), then the emergency [`995a1755-4d19-4d31-af4e-a3227b2d9130`](https://dash.cloudflare.com/aa86268490e681cccb3a41a62093e2aa/pages/view/friends-of-lake-henry/995a1755-4d19-4d31-af4e-a3227b2d9130) built from `cf8252e` under Node 20.20.0. Photo rollback: `dc1ad438-bb57-4705-a9f6-0d8e3945ee80`. DESTINATION rollbacks: Pages `7cdc9851` (`d92eb2c`, unpatched), then `df1fc387`, Photo `1ca3d573` (all outdated; only for a failed staging upload, never for cutover). The Nov 19 releases kept the Pages project settings, bindings, variables and secrets, and the Worker bindings, flags, compatibility dates and cron settings, identical (compared before and after).

**Remaining before the account cutover (none started):** enable R2 in DESTINATION and copy `folh-photos` (staging step 1;
billing/payment method needed); enter the 15 DESTINATION secrets, and decide whether to rotate the Facebook Page token, app secret,
webhook verify token and Resend key as part of the move rather than copying them (staging step 2); add `IMAGES` to the staged
Photo config; identify the Live `ced68381` source commit and refresh the staged Live Worker `a134d4df` from it; export DNS and
zone settings (including HSTS: `Strict-Transport-Security: max-age=15552000; includeSubDomains` comes from the SOURCE zone, not
the application, and is absent on every `pages.dev` alias) and confirm the Resend records; then the freeze, final D1/KV/R2 sync, Registrar move and activation in the cutover
runbook. Migration 009 is applied only after the cutover is stable, to DESTINATION.

Cloudflare analytics recorded 79 successful Live cron invocations and 1,445 successful Photo cron invocations, with zero cron errors in the 48-hour investigation window. The Live Worker verified the November 14 broadcast at 6:15 p.m. Central with zero consecutive failures and no pending videos or backoff. Photo ran all ten cron ticks in that night's polling window. D1 has no active Photo jobs or November 14 winner rows, and the one webhook item for that window was ignored. The records do not establish whether Facebook offered a qualifying winner photo. Reconcile that drawing and review the [November 13 rejected rows and older failed job](raffle-photo-ai-usage-2026-11-12.md#production-follow-up-2026-11-15) before the final sync.

Public DNS seen from outside: proxied A/AAAA on the apex, a `google-site-verification` TXT, no MX, no CAA, no DS,
nothing at `www`, `_dmarc`, `resend._domainkey` or `send`. The full record set (including non-public settings) must still
be exported from the SOURCE dashboard; the wrangler login cannot read DNS records.

The Nov 8 local R2 backup folder is no longer on the workstation. R2 will be copied directly from SOURCE (read-only)
once DESTINATION R2 is enabled. The 24 D1-referenced keys can be read with wrangler; listing the 4 unreferenced
objects needs the dashboard object list or an R2 S3 API token (the wrangler OAuth token is refused by the list API).

### Release sources and dependency maintenance

- **Pages production source:** `da5333c` on `security/astro5-pages-d92eb2c` (pushed; the Astro 5 security release), a child of
  `d92eb2c` on `feat/photo-import-history`, built on `f789234` (`feat/photo-import-review`)
  and `482d851` (`codex/pages-node-22-security`, itself `cf8252e` plus the Node 22.23.5 pin). This pre-009 lineage is what runs
  in both accounts; deploy Pages releases from `da5333c` (or a branch from it), never from `main` or an older commit, until 009 is applied.
- **`main` does not contain the security release** (it still pins Astro `^5.16.6`, adapter `^12.6.12`, sitemap `^3.6.0` and the
  default image endpoint). Port `da5333c` (config, pins, lockfile, `src/lib/server/disabled-image-endpoint.ts`,
  `tests/pages-security-smoke.mjs`) to `main`, or supersede it with the Astro 7 upgrade, and confirm `/_image` returns 404 before
  any Pages release from `main`.
- **Photo Worker production source:** `49b3fd3` on `fix/photo-name-separator` (pushed; tag `photo-worker-077637f8` on origin), a
  child of `7a9d4c4` (`fix/photo-prize-spacing`, tag `photo-worker-dc1ad438`), which extends `893d371` (tag `photo-worker-3d4928c9`).
  Deploy Photo Worker changes from this pre-009 lineage, never from `main`, until 009 is applied.
- **`main`** (fast-forwarded and pushed Nov 19 from `integrate/photo-review-main`): `da838bb` plus the Node pin, the Nov 15 and Nov 16
  Photo fixes, inline review, the history view and Issues filter, migration 010, the ported tests (run with 009) and these notes.
  Full suite 219/219 on Node 22.23.5; Astro 5.16.6, migration 009 and the prize-calendar work intact. `main` code **requires
  migration 009** (Pages and the integrated Photo Worker). Until 009 is applied in production, every push to `main` must carry
  `[CF-Pages-Skip]` on its head commit, and nothing is deployed from `main`.
- The four Node-pin files that were uncommitted on `main` (identical to `6ef8dad`, now part of `main`) are kept in
  `stash@{0}` ("main Node 22.23.5 pin, identical to 6ef8dad…") and byte-for-byte in `C:\Users\Jwerl\dev\folh-backups-2026-11-19-main-pin\`
  (with `SHA256SUMS.txt`). Drop the stash once you no longer need it; nothing in it differs from `main`.
- Kept until migration and rollback verification are complete: branches `codex/pages-node-22-security`, `fix/photo-ai-usage`,
  `fix/photo-prize-spacing`, `fix/photo-name-separator`, `feat/photo-import-review`, `feat/photo-import-history`,
  `integrate/photo-review-main`, `hotfix/photo-nov11-column-association`, `integrate/photo-ai-usage-main`,
  `codex/raffle-stabilization`, `backup/bad-prod-fix`, and all worktrees.
- Local backups: `C:\Users\Jwerl\dev\folh-all-refs-2026-11-14.bundle` (verified),
  `C:\Users\Jwerl\dev\folh-backups-2026-11-14\` (13 ignored `.sql` files with SHA-256 manifests), and
  `C:\Users\Jwerl\dev\folh-backups-2026-11-18-pre010\` (both D1 exports immediately before migration 010, with `SHA256SUMS.txt`).
- Not yet identified: the commit that built Live version `ced68381`.

**November 19 audit of the `da5333c` lockfile:** 17 package entries (1 critical, 15 high, 1 low), down from 23. Resolved:
devalue, h3, js-yaml, smol-toml, defu, diff and the sitemap/Zod finding. Open: Astro (AVIF RCE GHSA-26w7, fixed only in 7.2.8,
plus XSS/SSRF advisories whose triggering features this site does not use: no `define:vars`, template spreads, view
transitions, server islands, prerendered pages, MDX or `base`); the adapter image-transform SSRF (endpoint no longer bundled);
Sharp `0.34.5` (optional, not bundled; Miniflare's `0.33.5` is test-only); and build/dev-only tooling (Vite, esbuild,
Rollup, PostCSS, SVGO, picomatch, source-map-js, undici, ws, zod via Miniflare). The production-declared audit reports zero,
but Astro is a dev dependency whose runtime is bundled into the Worker, so that figure is not a clean bill. Do not expose
`astro dev`. Carry the open items into the Astro 7 review.

The November 15 audit of the Pages lockfile (`d92eb2c`) found **23 package findings** (1 critical, 21 high, 1 low). The production-declared audit shows two high entries (`@astrojs/sitemap` and its Zod dependency) for one Zod issue, with no public validation path identified. Zod's fix starts at `4.6.6`. A sitemap-only upgrade needs an Astro 5 build and XML parity check. The Astro AVIF finding requires untrusted input to reach Sharp optimization. The deployed R2 photo routes serve stored bytes, and no public path to that optimizer was identified.

Before cutover, pin and test a Wrangler v4 release **at least `4.59.1`** for Direct Upload. This is the [CLI command-injection fix floor](https://github.com/advisories/GHSA-36p8-mvp6-cv38), and the audit can still report inherited findings above that floor. If passing `--commit-hash`, use the verified full Git SHA. Use the patched CLI outside the application lockfile. Schedule the broader [Astro and Cloudflare adapter upgrade](astro-7-upgrade-assessment.md) after the account cutover stabilizes. The newer adapter removes Pages support and requires a separate move to Workers and changes to how binding access works.

### Migration 009 sequence

Migration 009 is additive (old code ignores the new columns). It also records November 2026's calendar as
`approved` with heading `Firearm`, which is the approval the integrated Photo Worker checks before any AI read.

1. Cut over first with the code that runs in production at the time of the cutover. As of November 19 that is Pages
   `da5333c` built with Node 22.23.5 (SOURCE `93fe0d3b`, staged as `1c163014`; not `d92eb2c`/`7cdc9851`, which expose `/_image`), Photo Worker `49b3fd3` (staged as `82b7d603`), and Live Worker
   from the `ced68381` source commit. If a later Pages or Photo release reaches SOURCE production before the cutover, stage
   and use that release instead; never an older build. No schema change during the move.
2. After cutover is stable: apply 009 to DESTINATION D1 (the only production database by then), verify
   `raffle_months.calendar_status = 'approved'` for `2026-11` (or the current season's month), then deploy Pages and
   the Photo Worker from `main` (which must already contain the production fixes; see Release sources).
3. Treat any proposal to run 009 before the cutover as a separate change to the plan. The reviewed cutover uses schema
   001–008 plus 010 in both accounts.

### Migration 010 (applied 2026-11-19)

`010_raffle_photo_row_resolutions.sql` adds one audit table (`raffle_photo_row_resolutions`) and one index for the
Photo imports review (Approve, Edit / Save & Publish, Mark resolved). It depends on 004 only, not on 009, and is
additive: older code ignores it. Applied on November 19, 2026 (about 02:35 UTC) to **both** SOURCE `527df871` and
DESTINATION `ecde3f50` with `wrangler d1 execute DB --remote --file migrations/010_raffle_photo_row_resolutions.sql`
and the account-pinned Photo configs (`workers/facebook-photos/wrangler.json`, `wrangler.nonprofit.staged.json`), then
recorded in `d1_migrations` after schema verification. Both databases now record 001–008 and 010 (010 has row id 9;
Wrangler matches by name). Pre-change exports: `C:\Users\Jwerl\dev\folh-backups-2026-11-18-pre010\`.

- **Do not run `wrangler d1 migrations apply` from `main`** before 009 is approved: it would apply 009 too.
- 009 and 010 touch different tables and produce the same schema in either order (verified locally).
- The final SOURCE → DESTINATION sync carries the table, its rows and the `d1_migrations` entry.
- Rollback (destructive, not needed for code rollback): `migrations/rollback/010_raffle_photo_row_resolutions.down.sql`
  and delete the `010_…` row from `d1_migrations`.

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
| Worker `folh-facebook-winner-photos` | UTC cron `*/2 * * * *`; workers.dev on; `FB_PHOTO_AUTOMATION_ENABLED=true`, `FB_PHOTO_AUTOPUBLISH=true`, `FB_PHOTO_POLL_ENABLED=true`, `ALERTS_ENABLED=true`, `ALERTS_MODE=live`, `ALERT_WEBHOOK_DELIVERY_ENABLED=false` | version `82b7d603-6bcb-4fff-ba1b-c427b80c9f11` (`49b3fd3`, Nov 19; previously `1ca3d573`), no cron, no workers.dev, flags off, no secrets, no `IMAGES` yet |
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
3. **Staging Pages build** — done Nov 19, 22:04 UTC: `1c163014` from `da5333c`, the SOURCE production commit (replacing
   `7cdc9851` from `d92eb2c`). It reused the verified SOURCE `dist` (fingerprint `9bb9881efa4188c8`); the config was generated
   from the committed `wrangler.json` with the IDs below and checked for SOURCE IDs (none). The project's downloaded settings
   were identical before and after. Verified on `friends-of-lake-henry-d16.pages.dev`: `/_image` and its variants 404 (200
   before); public pages, sitemaps, `robots.txt` and the raffle month/prizes/Live and events APIs return 200, with the APIs
   byte-identical to before the upload; Replay embeds render; admin pages redirect to login; the admin file route returns 401;
   cross-site login returns 403; login returns `err=server` (no secrets); `nosniff`, `X-Frame-Options`, `Referrer-Policy` and
   `Permissions-Policy` present. Not exercisable until R2 and secrets exist: gallery images and posters (500), admin sign-in
   and admin reads, photo-review privacy on real objects, contact and photo submit (both refuse without `TURNSTILE_SECRET`).
   Staged Workers (`a134d4df`, `82b7d603`) and DESTINATION D1 (46 winners, 21 photos, 001–008 + 010) were unchanged. Repeat if SOURCE gets a
   later Pages release; never stage a build older than SOURCE production. Procedure: a clean `git archive` export of that commit, Node `v22.23.5`, `npm ci`, `npm run build`;
   copy `dist` to a separate folder with a temporary `wrangler.json` made from the committed one with the DESTINATION IDs
   (`DB` → `ecde3f50-a040-415b-ae61-06045302c37e`, `SESSION` → `4d6784e6b44d4353a7f8b54f76e5a4e1`, `CONFIG` →
   `c4ea8ffeb28a419abc8dafc250a0b6ba`, no `r2_buckets` until R2 exists; same services, vars and compatibility settings), then
   `CLOUDFLARE_ACCOUNT_ID=ffe1aa6f4a533743f8f1b624f43c6d3d wrangler pages deploy dist --project-name friends-of-lake-henry
   --branch main --commit-hash <full SHA>` with the patched Wrangler. The committed `wrangler.json` names SOURCE resources and
   must never be uploaded to DESTINATION unchanged. Once R2 exists, add `PHOTOS_BUCKET` → `folh-photos` and redeploy. Keep both
   accounts on schema 001–008 plus 010 until cutover is stable.
4. **Staged Photo Worker** — done Nov 19: `82b7d603` from `49b3fd3` with `workers/facebook-photos/wrangler.nonprofit.staged.json`
   (no cron, workers.dev off, all `FB_PHOTO_*` and alert flags off). **Before activation**, add the `IMAGES` binding to that
   staged config (production has it; the importer enlarges photos with it) and confirm Images is available on the DESTINATION
   account, then redeploy and validate. Do not activate it before the cutover runbook.
5. **Staging tests**: public pages, `/api/photos/file`, event posters, raffle month/prizes APIs, admin login and one
   admin read (no edits, including Admin > Raffle > Photo imports, which needs 010), contact form against the DESTINATION
   Turnstile widget. Workers stay without cron, flags off.
6. **Live source commit**: identify the commit behind `ced68381` and record it here.
7. **DNS export** (owner): SOURCE dashboard → DNS → Records → Export, plus a list of zone settings (SSL/TLS mode, edge
   certificates, email obfuscation, bot/AI-crawler settings, page/redirect/cache rules, Turnstile, any Workers routes).
8. **Resend**: confirm in the Resend dashboard which domain `FROM_EMAIL` uses and which DNS records it requires.

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
   active), the `google-site-verification` TXT, and any Resend/mail records found in step 8 of the staging requirements.
3. Recreate zone settings and rules from the inventory.
4. After the move, compare a fresh DESTINATION export with the SOURCE export line by line, and re-check public answers.

## Cutover runbook (after November 30)

Schedule one supervised window outside 17:45–18:45 Central, after the last drawing and winner reconciliation.
Agree on a maintenance window and an abort point before accepting the Registrar transfer. SOURCE is authoritative
until the final sync and domain switch. DESTINATION becomes the sole writer after the public site is verified there.

1. **Rehearse on DESTINATION.** Complete the staging checks with Pages at the SOURCE production commit (today `da5333c`,
   staged as `1c163014`; it must be `da5333c` or a later release containing the same security changes, and `/_image` must
   return 404 on the DESTINATION deployment before the domain moves) under Node 22.23.5 and schema 001–008 plus 010. Verify that Pages `DB` and Photo `DB` use the same DESTINATION D1 ID, Pages `CONFIG` and Live `CONFIG`
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
   `sqlite_sequence`. Both databases must still be on 001–008 plus 010 (no 009); the export must carry
   `raffle_photo_row_resolutions` (review and handled-issue audit) and the `d1_migrations` row for 010. Check the winner count
   and fingerprint against SOURCE (70 winners on Nov 19, plus any later drawings) and that no Photo job is pending. Re-copy CONFIG KV with matching values, expiry, and metadata, and remove destination-only keys.
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
   previews remain write-gated. Activate Live first from the verified `ced68381` source, then Photo from the SOURCE production Photo source (today `49b3fd3`),
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
write paths. If the SOURCE Pages release itself fails, roll SOURCE back to `93fe0d3b` (the security release) if it is not
already live; use `2f96df08` (unpatched `/_image`) only if `93fe0d3b` itself is at fault, then `3a16b88e` (or the emergency
`995a1755`), and verify its production alias. If the SOURCE Photo Worker fails, roll back to `dc1ad438`.

**After DESTINATION accepts:** keep the public site and any active writers in DESTINATION during recovery.
- **Application fault:** use the verified DESTINATION Pages artifact built from the cutover commit (staging step 3) or a
  known-good deployment in the DESTINATION project (today `1c163014`, `da5333c`). `7cdc9851` and `df1fc387` are older and
  expose `/_image`; use them only as a last resort and re-release a patched build. SOURCE deployments (`93fe0d3b`, `2f96df08`,
  `ba1bc408`, `3a16b88e`, `995a1755`) cannot roll back the DESTINATION project.
- **Data fault:** freeze DESTINATION writes, preserve the current snapshot, and reconcile post-cutover writes before
  restoring with D1 Time Travel or the cutover export. Recheck KV and R2 consistency before reopening.
- **Automation fault:** gate the DESTINATION callback, crons, and flags until the known-good versions and bindings
  are verified. Keep SOURCE Workers stopped. Use a reviewed manual fallback on DESTINATION if needed.
- **DNS or certificate fault:** restore the DESTINATION routing and zone settings from the export. Keep the write gate
  until the apex, certificate, and Pages deployment are confirmed.

## Git deployments and release procedure

**SOURCE Pages releases (verified November 19: `ba1bc408`, then `2f96df08`, then `93fe0d3b` from `da5333c`).** Pushing a
non-`main` branch whose head carries `[CF-Pages-Skip]` creates only an Idle (skipped) preview record that serves nothing
(seen as `513aa184` for the security branch). The project is Git-connected with production branch `main`
and automatic production deployments paused. The dashboard offers no way to make a production *hosted* build of a
non-`main` branch: "Retry deployment" rebuilds a record's own branch in its own environment. The account audit log shows
`3a16b88e` (Nov 15) was created by a PowerShell API script that PATCHed the project settings before and after the deployment.
Releases from a non-`main` branch therefore use Direct Upload, which Cloudflare supports for Git-integrated projects
without changing the Git connection or settings:

1. Outside 17:45–18:45 Central. Confirm the live deployment and project settings (read-only), and back up D1 if the
   release depends on a migration.
2. Build the exact commit: `git archive <full SHA> | tar -x -C <empty dir>`, then Node 22.23.5 (`node --version`),
   `npm ci`, `npm test`, `npm run build`.
3. Use a patched Wrangler v4 at or above `4.59.1` from outside the application lockfile (4.156.0 was used) and run from the
   export directory with `CLOUDFLARE_ACCOUNT_ID=aa86268490e681cccb3a41a62093e2aa`. The login can see both accounts, and
   Pages ignores `account_id` in `wrangler.json`; Wrangler 4.50 once preferred a cached `node_modules/.cache/wrangler/pages.json`
   from another account. A fresh export has no cache; confirm with `wrangler pages project list` that the project shows
   `friendsoflakehenry.com`, and that any `pages.json` it writes names `aa86…`.
4. Compare `wrangler.json` (D1, KV, R2, services, vars, compatibility) with the project's production configuration; secrets stay
   in the project and are not touched by an upload.
5. `wrangler pages deploy dist --project-name friends-of-lake-henry --branch main --commit-hash <full SHA>
   --commit-message "<summary>" --commit-dirty=false`. `--branch main` (the production branch) makes it a production
   deployment; it does not change Git `main` or any project setting.
6. Verify: the new deployment is canonical and aliased to `friendsoflakehenry.com`, an asset unique to the new build is served
   on the domain, the public winners/prizes APIs are unchanged, the project settings match the pre-release snapshot, and the
   Worker versions are unchanged. Roll back with "Rollback to this deployment" on the previous production deployment.

**DESTINATION.** Keep the tested Direct Upload project for cutover and build the SOURCE production commit as in staging step 3,
with `CLOUDFLARE_ACCOUNT_ID=ffe1aa6f4a533743f8f1b624f43c6d3d` and `--project-name friends-of-lake-henry`.
Cloudflare does not convert a Direct Upload project to Git integration in place. Revisit Git integration after
cutover in a separate change.

Keep the SOURCE project's GitHub connection and automatic production deployments paused during the cutover. Restore
automatic production builds only after the newer application and migration 009 are approved for release.
