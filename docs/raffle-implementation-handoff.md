# Raffle implementation handoff

Updated 2026-11-02 ~02:40 UTC (2026-11-01 8:40 PM Central). Existing Cloudflare account
`aa86268490e681cccb3a41a62093e2aa` only; the account migration is postponed. No credential values appear
here. **The owner performs all commits, pushes, merges and deployments.**

## Current state

| Item | Value |
| --- | --- |
| Production `main` / Pages deployment | `0cd8d3d` / `f17def2a-0be0-4df1-b263-47a28c326474` (prize calendar) |
| Feature branch | `codex/facebook-live-worker` at `0e8fdb7` (published), plus the **uncommitted** work below |
| UI release branch | `release/raffle-spacing` (local, from `origin/main` `0cd8d3d`) in worktree `.wrangler/portrait-hotfix`, **uncommitted** |
| Worker `folh-facebook-live-discovery` | `de963a6c-0500-4795-9c99-fc94443778eb` (owner deploy 02:04 UTC, poller cron-slack fix). `/api/raffle/live` = automatic / automatic / verified-discovery |
| D1 migrations applied | `001_schema.sql`, `002_fix_timestamp_defaults.sql`, `003_raffle_prize_supplements.sql` |
| D1 migration pending | `002_raffle_photo_imports.sql` (additive; tested on a production copy) |

## Release 1: public raffle spacing/readability (ready, isolated)

Worktree `C:\Users\Jwerl\dev\friends-of-lake-henry\.wrangler\portrait-hotfix`, branch `release/raffle-spacing`.
One file changed, `src/pages/raffle.astro`:
- Daily Winners intro split into the three approved paragraphs: flex column, 0.4rem gap, zero margins,
  line-height 1.55, weight-700 date and time.
- `#prizeCalendar` gets `margin-top: var(--raffle-stack-gap)`; the Rules card that follows uses the same gap.
  `--raffle-stack-gap = clamp(1.5rem, 1rem + 1.5vw, 2rem)` (24–32px). A `[hidden]` calendar is `display:none`,
  so it leaves no empty gap.
- Calendar is a dark translucent panel `rgba(7,15,23,.78)` with blur, text `#f4f7fa`, 1px subtle border.
  Rows: 12–14px padding, `rgba(255,255,255,.12)` separators, date column 7.5rem (stacked under 550px).
  The page background is unchanged.
- No photo-import code.

Measured on the rendered page (local build of this exact tree, headless Edge with device emulation):

| Viewport | Winners→Calendar | Calendar→Rules | Calendar hidden (Winners→Rules) | Horizontal overflow |
| --- | --- | --- | --- | --- |
| 1280px | 32px | 32px | 32px | none |
| 390px mobile | 24px | 24px | 24px | none |

Checks on this tree: 44/44 tests (Node 20.10), `typecheck`, `typecheck:pages-api`, Astro build, `git diff --check`.
The feature checkout has the identical `raffle.astro`, so a later merge has no content conflict in that file.

## Photo importer (code complete, tested; deploy pending)

### Model and licensing: decision made in code
- **Default model changed to `@cf/mistralai/mistral-small-3.1-24b-instruct`** (Apache-2.0). It needs no license
  acceptance on Workers AI; a probe call succeeded on this account.
- A real Workers AI extraction of the November 2025 winner table scored **120/120 fields, 30/30 rows**, all positions
  null. Review result: 29 complete, 1 conflicting ("Gallesville" typo in the image), 0 new. Cost 126 neurons (~$0.0014).
- `@cf/meta/llama-3.2-11b-vision-instruct` is still selectable, but this account **has not accepted** Meta's license.
  The probe returned `5016: Prior to using this model, you must submit the prompt 'agree'`. Only the owner may accept.
  The official action (Cloudflare model page) is one REST call, shown here for reference only; **not needed for Mistral**:
  ```powershell
  # Uses a Cloudflare API token with Workers AI permission (create under My Profile > API Tokens). Accepts Meta's terms.
  curl.exe "https://api.cloudflare.com/client/v4/accounts/aa86268490e681cccb3a41a62093e2aa/ai/run/@cf/meta/llama-3.2-11b-vision-instruct" `
    -X POST -H "Authorization: Bearer $env:CLOUDFLARE_AI_TOKEN" -d '{\"prompt\":\"agree\"}'
  ```
- Code changes: `PHOTO_MODEL`/`LLAMA_VISION_MODEL` (`src/lib/raffle-photo-import.ts`); `winnerPrompt` and
  `visionRequest` (model-specific request shape) in `workers/facebook-live/photos.ts`; `parseExtraction` accepts a
  parsed-object or string response under the same 120 KB bound and strict row validation.
- The optional poster-prize recognition (`raffle-poster-prizes.ts`) still names Llama and stays disabled.

### Lifecycle tested on a copy of current production D1
Read-only export at 02:27 UTC, plus migrations 003 and 002 applied locally. The real Pages handlers ran with real
D1 statements and real R2 writes; only Facebook/AI were stubbed at the `PhotoService` boundary.

| Scenario | Result |
| --- | --- |
| Nov 1 announcement rows: 360 Tim Hartley La Crosse (1st), 894 Troy Zigler Cashton (2nd) | Both **complete** (existing). Approval **409**, nothing written. Main-prize suggestion shown |
| Same photo again | Existing draft returned, no second extraction |
| OCR variant "LaCrosse" | **conflicting**, approval 409 |
| Genuinely new row | `missing`. Approval without review confirmation **400**; with it **200** (+1 winner, 1 audit row); repeat approval **409** |
| Private image | Stored at `raffle-imports/{id}/{sha256}` and served `no-store` only through the authenticated admin route |
| Existing 32 production winners | Byte-for-byte unchanged |

**Not yet done: the actual Nov 1 Facebook photo.** Fetching it needs the combined Worker deployed (Graph token) or
the image file. Two ways to finish:
- After deployment (step 6 below): `/admin/raffle/imports` → historical post URL → expect both rows `complete`
  → reject the draft.
- Before deployment: save the photo locally, then in Git Bash run
  `bash <scratchpad>/preview/real-photo-check.sh "C:/path/nov1.jpg"`. That runs a real Mistral extraction, then the
  lifecycle on the production copy. Production is never written.

### Configuration prepared (uncommitted, feature checkout)
- `wrangler.json` (Pages): **adds `RAFFLE_PRIZE_CALENDAR_ENABLED=true`.** Without it, a feature-branch deploy
  would have hidden the live calendar; a test now guards this. Also adds `RAFFLE_PHOTO_IMPORT_ENABLED=false`,
  R2 `IMPORT_IMAGES → folh-photos` (r2.dev disabled, no custom domain; verified), and service
  `FACEBOOK_PHOTOS → folh-facebook-live-discovery#PhotoImports`. Wrangler 4.50 `pages dev` parses it as
  `env.FACEBOOK_PHOTOS (folh-facebook-live-discovery#PhotoImports)`.
- `workers/facebook-live/wrangler.live-photos.existing-account.json`: the approved activation profile (same Cron
  `*/5 * * * *`, both video flags `true`, CONFIG, Page IDs, marker, season, `FB_ACCESS_REVISION`) plus `ai` and two
  photo flags, both `false`. The preflight passes against the live receipt. Dry run: 44.29 KiB with the expected bindings.
  Secrets are not in config; the existing encrypted `FB_PAGE_ACCESS_TOKEN` persists across `wrangler deploy`.
- **Never deploy `wrangler.photos.existing-account.json`.** Same Worker name, empty Cron: it would stop polling.

### Test results (feature checkout, Node 20.10)
`npm test` **96/96**; `typecheck`, `typecheck:pages-api`, `typecheck:facebook-worker`; `build:facebook-worker`,
`build:facebook-photos`, `build`; `git diff --check`.

Uncommitted files in the feature checkout: `src/pages/raffle.astro`, `src/lib/raffle-photo-import.ts`,
`workers/facebook-live/photos.ts`, `wrangler.json`, `tests/raffle-photos.test.mjs`,
`docs/raffle-photo-imports.md`, `docs/raffle-implementation-handoff.md`.

## Exact release commands (PowerShell, owner-run)

```powershell
# ---- Release 1: spacing/readability UI (isolated; Pages auto-deploys main) ----
Set-Location C:\Users\Jwerl\dev\friends-of-lake-henry\.wrangler\portrait-hotfix
git status --short                      # expect only:  M src/pages/raffle.astro
git add src/pages/raffle.astro
git commit -m "Separate the Daily Winners intro and space the prize calendar"
git push origin HEAD:main               # fast-forward from 0cd8d3d
# verify after the build: winners intro has 3 paragraphs and the calendar sits 24-32px below the winners card
curl.exe -s https://friendsoflakehenry.com/raffle | Select-String -SimpleMatch 'winnersIntro','prizeCalendar'

# ---- Release 2 prep: commit and publish the feature work ----
Set-Location C:\Users\Jwerl\dev\friends-of-lake-henry
git add src/pages/raffle.astro src/lib/raffle-photo-import.ts workers/facebook-live/photos.ts wrangler.json `
        tests/raffle-photos.test.mjs docs/raffle-photo-imports.md docs/raffle-implementation-handoff.md
git commit -m "Use Mistral Small 3.1 for winner-photo OCR and prepare photo-import bindings"
git fetch origin
git merge origin/main                   # brings in Release 1; raffle.astro is identical on both sides
npm test; npm run typecheck; npm run typecheck:pages-api; npm run typecheck:facebook-worker; npm run build
git push origin codex/facebook-live-worker

# ---- Step 3: back up D1, then apply additive migration 002 (run outside the repo: pages cache hazard) ----
New-Item -ItemType Directory -Force C:\folh-migration | Out-Null; Set-Location C:\folh-migration
$env:CLOUDFLARE_ACCOUNT_ID = 'aa86268490e681cccb3a41a62093e2aa'
$w = 'C:\Users\Jwerl\dev\friends-of-lake-henry\node_modules\wrangler\bin\wrangler.js'
node $w d1 time-travel info folh-db                                   # record the bookmark
node $w d1 export folh-db --remote --output ("folh-db-pre-002-" + (Get-Date -Format yyyyMMddTHHmm) + ".sql")
Copy-Item C:\Users\Jwerl\dev\friends-of-lake-henry\migrations\002_raffle_photo_imports.sql .\002.sql
Add-Content .\002.sql "`nINSERT INTO d1_migrations(name) SELECT '002_raffle_photo_imports.sql' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='002_raffle_photo_imports.sql');"
node $w d1 execute folh-db --remote --file .\002.sql
node $w d1 execute folh-db --remote --command "SELECT name FROM sqlite_master WHERE name LIKE 'raffle_photo%'; SELECT count(*) FROM raffle_winners"

# ---- Step 4: deploy the combined Worker (photo flags false; livestream unchanged) ----
Set-Location C:\Users\Jwerl\dev\friends-of-lake-henry
# ASCII on purpose: PowerShell 5.1 ">" writes UTF-16 and "-Encoding utf8" adds a BOM; both break JSON.parse
node $w kv key get raffle_live_verification --namespace-id b70df87ff3db4230a621d4a39ab24ff7 --remote 2>$null | Set-Content -Encoding ascii $env:TEMP\receipt.json
$env:FB_TARGET_ACCOUNT_ID = 'aa86268490e681cccb3a41a62093e2aa'; $env:FB_ACTIVATION_APPROVAL = 'tagged-page-video-v1'
node --import ./tests/register.mjs workers/facebook-live/check-live-photos-deployment.mjs workers/facebook-live/wrangler.live-photos.existing-account.json $env:TEMP\receipt.json
node $w deploy --config workers/facebook-live/wrangler.live-photos.existing-account.json
# verify: Cron */5 still listed, then two more healthy polls (lastAttemptAt advances, failures 0) and /api/raffle/live automatic
node $w kv key get raffle_live_automation_state --namespace-id b70df87ff3db4230a621d4a39ab24ff7 --remote

# ---- Step 5: release Pages with bindings (photo import still off) ----
git push origin codex/facebook-live-worker:main     # only after steps 3-4 succeed (service entrypoint must exist)

# ---- Step 6: controlled real-photo test ----
# Worker: set FB_PHOTO_IMPORT_ENABLED and FB_VISION_MODEL_LICENSE_ACCEPTED to "true" in
#   wrangler.live-photos.existing-account.json (you confirm Mistral's Apache-2.0 terms); rerun the step 4 preflight and deploy.
# Pages: set RAFFLE_PHOTO_IMPORT_ENABLED to "true" in wrangler.json; commit; push to main.
# Admin: /admin/raffle/imports > month 2026-11 > paste the Nov 1 winner post URL > expect 360 and 894 "complete",
#   approval refused > Reject the draft. Leave enabled (admin-only, approval-gated) or set the flags back to false.
```

## Rollback

| Change | Rollback |
| --- | --- |
| Release 1 | `git revert <release-1 commit>` and push `main`, or dashboard rollback to `f17def2a` |
| Pages photo bindings / flags | Set `RAFFLE_PHOTO_IMPORT_ENABLED=false` and push, or roll back to the previous deployment. Import routes then return 503; manual entry is unaffected |
| Combined Worker | `node $w rollback de963a6c-0500-4795-9c99-fc94443778eb --name folh-facebook-live-discovery` (video-only poller-fix version). Manual mode remains an instant override from `/admin/raffle`; never delete `raffle_live` |
| Migration 002 | Additive, so unused tables are harmless. Restoring to the step-3 bookmark drops them but also discards later writes |
| Prize calendar | `RAFFLE_PRIZE_CALENDAR_ENABLED` not `"true"` hides it. Migration 003 tables can stay |
| Placement data | Reverse the two guarded `UPDATE raffle_winners SET prize=…` statements, or bookmark `0000255c-00000004-00005117-d2295205b4e355c923b20603aa0e80f5` |

Backups taken this session are in the session scratchpad `backup/` and should be moved to encrypted storage:
`folh-db-full-20261102T0112Z.sql`, `folh-db-pre-003-20261102T0147Z.sql` (bookmark `…d53ac707…`),
`folh-db-prod-copy-20261102T0227Z.sql`.

## Owner actions and approvals
1. Commit and push Release 1 (commands above).
2. Decide the model: keep **Mistral Small 3.1** (no license step; recommended, measured 120/120) or accept Meta's
   Llama license with the REST call above.
3. Apply migration 002 after backup; deploy the combined Worker; release the Pages bindings (steps 3–5).
4. Real Nov 1 photo test (step 6, or the local script with the saved image).
5. Optional: enter and approve daily gift-certificate supplements at `/admin/raffle/prizes`.

## Priority 4 plan: shared interactive calendar (not started; doesn't block the releases above)

Today `/events` renders a month grid with chips linking `#event-{id}` plus a long card list. `/raffle` adds a
30-date prize list. Proposal:

- **Component** `src/components/MonthCalendar.astro` + `src/scripts/month-calendar.ts`: server-rendered month grid
  (works without JS), with month navigation reusing `/api/events/month` and the raffle APIs.
- **Data adapters, not new tables.** Events mode uses all published events, with category chips from `kind`.
  Raffle mode merges published raffle events (main and bonus prizes), approved supplements (`/api/raffle/prizes`)
  and winners (`/api/raffle/month`) per America/Chicago date, reusing `prizeSchedule` date matching.
- **Day popups** use the native `<dialog>`: `aria-labelledby` the date, focus moves inside, `Esc` and backdrop close,
  focus returns to the day button. Day buttons get `aria-label` summaries ("Sat Nov 7: 3 prizes, 2 winners").
  Arrow keys move between days (roving tabindex); Home/End jump within the week.
- **URLs preserved.** `/events/{id}` detail pages are unchanged and linked from popups. `#event-{id}` deep links
  open the matching day popup.
- **Styling:** dark popup `rgba(7,15,23,.92)` with ≥ 4.5:1 text contrast. On mobile (<560px) the popup becomes a
  bottom sheet and the grid uses a two-letter weekday header with 44px tap targets.
- **List reduction:** replace the long lists with "Next 3 drawings" / "Upcoming events" summaries under the
  grid; the full detail lives in popups. Keep a "List view" toggle for screen-reader and print users.
- **Tests:** date bucketing across UTC boundaries and DST, keyboard navigation, focus return, no-JS fallback, and
  390px rendering through the same headless Edge measurement harness.
- **Estimate:** 1–2 focused sessions. Ship Events mode first behind a flag, then Raffle mode.
