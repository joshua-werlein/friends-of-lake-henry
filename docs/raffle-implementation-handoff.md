# Raffle implementation handoff

Updated 2026-11-02 ~01:55 UTC (2026-11-01 7:55 PM Central). Existing Cloudflare account
`aa86268490e681cccb3a41a62093e2aa` only; the account migration is postponed. No credential
values appear here or in the repository.

## Branches and commits

| Ref | Commit | State |
| --- | --- | --- |
| `origin/main` (production) | `0cd8d3d` | Prize calendar release, on top of `c02b69f` placement fix |
| `origin/codex/facebook-live-worker` | `569d776` | Published feature branch (merged main `c02b69f` in `fecdc79`) |
| local `codex/facebook-live-worker` | `ccb496f` | **1 commit ahead of origin, not pushed:** poller cron-slack fix |
| local `release/prize-calendar` (worktree `.wrangler/portrait-hotfix`) | `0cd8d3d` | Same as `origin/main`; clean |
| `refs/backup/feature-wip-tracked-20261102` | `b4fa237` | Safety snapshot of the 17 pre-existing WIP files (tracked part) |

The local `main` branch is stale (`13f0e03`). Use `origin/main`.

**Uncommitted in the main checkout (ready, validated, for the owner to commit):**

- `src/pages/raffle.astro`: Daily Winners intro split into three paragraphs (flex column, 0.4rem gap,
  zero margins, line-height 1.55, 700-weight date/time). The file was identical to `origin/main`
  before the edit, so the same diff applies to `main`.
- `workers/facebook-live/live-photos-entry.ts`, `wrangler.live-photos.existing-account.json`,
  `check-live-photos-deployment.mjs`: combined Worker profile (see Photo importer).
- `tsconfig.json`: excludes `live-photos-entry.ts` from the browser project, like the other two entries.
- `tests/facebook-worker.test.mjs`: combined-profile tests.
- `docs/raffle-implementation-handoff.md`: this file.

## Production deployments (Pages project `friends-of-lake-henry`, Git-integrated from `main`)

| Deployment | Commit | Content |
| --- | --- | --- |
| `f17def2a-0be0-4df1-b263-47a28c326474` | `0cd8d3d` | **Current.** Prize calendar enabled (`RAFFLE_PRIZE_CALENDAR_ENABLED=true`) |
| `b2034876-5b56-4548-9578-ef26ef2ffad2` | `c02b69f` | 1st/2nd placements and trailing-period cleanup |
| `3689b2c8-ec36-4cb8-bb69-9eb0b3eb2750` | `9d08ae9` | Separate Place/Prize columns |

Worker `folh-facebook-live-discovery`: version `b3789062-a605-442d-949c-6f39e2e5cd68` (deployed 00:48:56 UTC
from `7a3c9e8`, `video-entry.ts` + `wrangler.video.activation.existing-account.json`). Unchanged this session.

## Cloudflare resources and bindings (no credentials)

| Binding | Resource | ID / name |
| --- | --- | --- |
| Pages `DB` | D1 `folh-db` | `527df871-e876-4924-81d0-5d0572b4dd7b` |
| Pages `SESSION` | KV `folh-session` | `d7ea3cc7deef422789bfa015a3c1a6db` |
| Pages/Worker `CONFIG` | KV `folh-config` | `b70df87ff3db4230a621d4a39ab24ff7` |
| Pages `PHOTOS_BUCKET` | R2 `folh-photos` | r2.dev access **disabled**, no custom domain (verified 2026-11-02) |
| Worker secret | `FB_PAGE_ACCESS_TOKEN` | Encrypted; never read |
| Pages secrets (production) | ADMIN_USERNAME, ADMIN_PASSWORD, RESEND_API_KEY, FROM_EMAIL, TO_EMAIL, TURNSTILE_SECRET, PUBLIC_TURNSTILE_KEY | Names only |

CONFIG keys: `raffle_live` (manual URL + `selectionMode`), `raffle_live_automatic`,
`raffle_live_automation_state`, `raffle_live_verification` (schema 3, expires 2026-12-01T06:00Z).

Local hazard: `node_modules/.cache/wrangler/pages.json` pins Pages commands to another account
(`8481…`) and overrides `CLOUDFLARE_ACCOUNT_ID`. Run Pages Wrangler commands from outside the repo.
The ignored local `wrangler.toml` points at the production KV IDs.

## D1 migrations (production `d1_migrations`)

| Migration | Status |
| --- | --- |
| `001_schema.sql`, `002_fix_timestamp_defaults.sql` | Applied (pre-existing) |
| `003_raffle_prize_supplements.sql` | **Applied 2026-11-02 ~01:48 UTC** via `d1 execute --file`, recorded in `d1_migrations`. Additive only |
| `002_raffle_photo_imports.sql` | **Not applied.** Required before enabling photo imports |
| `migrations/migrations/00x_raffle_poster.sql` | Columns exist in production; not recorded. Never run `d1 migrations apply` blindly |

Backups (outside the repo, in the session scratchpad `backup/`):
- `folh-db-full-20261102T0112Z.sql` (sha256 `42f09275…`), bookmark `0000255c-00000004-00005117-d2295205b4e355c923b20603aa0e80f5` (before the placement fix)
- `folh-db-pre-003-20261102T0147Z.sql` (sha256 `d9a710f2…`), bookmark `0000255c-0000000a-00005117-d53ac707da45d87a19a972cbdf7a4c9e` (before migration 003)

Move these to the owner's encrypted backup storage. The scratchpad is temporary.

## Feature status

### Winner placements: done, live
Tickets 360 (1st, Tim Hartley) and 894 (2nd, Troy Zigler) were updated in place, with only the `prize` column changed.
Display and new submissions drop trailing periods but keep `.45 ACP`, `Co.`, `U.S.A.` and similar.

### Livestream automation: working, one fix pending deployment
- Verified read-only: mode **automatic**, public source `automatic/verified-discovery`, video `1706736221227932`.
  Healthy polls observed at 01:30:03, 01:35:04, 01:45:03 and 01:50:03 UTC, all with `failures:0`.
- **Defect:** the 01:40 tick was skipped. A cron tick that lands before `lastAttempt+300s` returns `not-due`, so
  the cadence drops to 10 minutes. The public selection falls back to the manual URL when health is older than
  10 minutes. Tonight the manual URL is the same video, but after Nov 2's drawing the page could flip back to the
  Nov 1 video during those gaps.
- Fix `ccb496f` (local, not pushed) adds 60 seconds of slack for healthy schedules. Backoff and Retry-After stay exact.
  Covered by a regression test. **Deploy before the Nov 2 6 PM drawing if approved** (commands below).
- Manual override, stale-health fallback and rollback are covered by tests. They weren't exercised live, because doing so writes to production KV.

### Prize calendar: done, live
- 30 main prizes come from the published raffle events, matched by America/Chicago date (stored `00:00Z` the next day).
- 13 weekend/holiday bonus drawings are derived read-only from event summaries (`2nd drawing: …`).
- Supplements go in `raffle_prize_supplements` as private drafts. Approve individually, or in bulk after an explicit
  confirmation; a numeric place always needs individual confirmation. Every change is logged in `raffle_prize_review_log`.
- Production currently has **0 supplements.** The daily $100 gift certificates have not been entered: only Nov 1's
  sponsor is confirmed. An admin should add them at `/admin/raffle/prizes` ("Use every published drawing date"),
  review them, then approve.
- Optional poster recognition stays disabled (needs an AI binding plus `RAFFLE_POSTER_AI_LICENSE_ACCEPTED`).

### Photo importer: code complete, not deployed
Blockers that need the owner's decision:
1. **Model license.** `@cf/meta/llama-3.2-11b-vision-instruct` needs the account owner to accept Meta's license/AUP
   (a one-time `prompt: "agree"` request). Accepting terms is the owner's action. The alternative is to switch to a
   vision model without click-through terms, which needs a code change and re-validation.
2. **Worker topology.** `wrangler.photos.existing-account.json` deploys to the **same Worker name** with no Cron and
   automation off. **Deploying it would stop livestream polling. Do not use it.** Use the combined profile
   `wrangler.live-photos.existing-account.json`: identical to the approved activation profile plus the AI binding and
   the photo RPC, with both photo flags `false`. Offline preflight and Wrangler dry run pass.
3. **Pages bindings** (on the feature branch `wrangler.json`, not yet added): service `FACEBOOK_PHOTOS` →
   `folh-facebook-live-discovery` entrypoint `PhotoImports`; R2 `IMPORT_IMAGES` → `folh-photos` (verified private);
   `RAFFLE_PHOTO_IMPORT_ENABLED=false` initially.
4. **Migration `002_raffle_photo_imports.sql`.** Apply after a backup.
5. **Real Nov 1 photo test.** This needs items 1–4 and runs through the authenticated admin page. No unreviewed
   result is ever published.

## Test results (Node 20.10, 2026-11-02)

Main checkout (feature branch plus uncommitted changes):
- `npm test`: 94/94 passed
- `npm run typecheck`, `typecheck:pages-api`, `typecheck:facebook-worker`: pass
- `build:facebook-worker`, `build:facebook-photos`, `npm run build`: pass
- `git diff --check`: clean

Combined-profile preflight passed against the production receipt. Wrangler dry run produced 43.67 KiB with bindings
CONFIG, AI and the expected vars. The release branch (`0cd8d3d`) had 44/44 tests passing, with type checks and build passing.

`tsconfig.worker.json` previously failed with TS2339 (7 errors on main, 13 on the feature branch) because it never
loaded `src/env.d.ts`. Fixed, and exposed as `npm run typecheck:pages-api`.

Browser checks:
- Production `/raffle`: winners 1st/2nd with clean prizes; calendar grouped by date below Daily Winners.
- Admin routes: 401 / 302 without a session, 403 cross-origin.
- Local disposable preview: admin draft → individual and bulk approval → public display; winner-entry suggestions.
- 390px mobile emulation of the new Daily Winners intro: no page overflow.

## Continuation commands

Run Wrangler from a directory outside the repo (cache hazard), with Node 20 for tests.

```bash
# Commit the uncommitted, validated work, then publish the feature branch
git add src/pages/raffle.astro tsconfig.json tests/facebook-worker.test.mjs docs/raffle-implementation-handoff.md \
  workers/facebook-live/live-photos-entry.ts workers/facebook-live/wrangler.live-photos.existing-account.json \
  workers/facebook-live/check-live-photos-deployment.mjs
git commit -m "..." && git push origin codex/facebook-live-worker

# Ship only the intro fix to production: apply the raffle.astro diff on top of origin/main
# (in the .wrangler/portrait-hotfix worktree), commit, then git push origin HEAD:main

# Poller fix (approval needed): preflight, then deploy the SAME approved video profile
export FB_TARGET_ACCOUNT_ID=aa86268490e681cccb3a41a62093e2aa FB_ACTIVATION_APPROVAL=tagged-page-video-v1
node --import ./tests/register.mjs workers/facebook-live/check-activation.mjs \
  workers/facebook-live/wrangler.video.activation.existing-account.json receipt.json   # receipt = CONFIG raffle_live_verification
node node_modules/wrangler/bin/wrangler.js deploy --config workers/facebook-live/wrangler.video.activation.existing-account.json
# or, once photo importing is approved, the combined profile instead (keeps the same Cron/flags):
node --import ./tests/register.mjs workers/facebook-live/check-live-photos-deployment.mjs \
  workers/facebook-live/wrangler.live-photos.existing-account.json receipt.json
node node_modules/wrangler/bin/wrangler.js deploy --config workers/facebook-live/wrangler.live-photos.existing-account.json
# After either deploy: confirm the next two polls in raffle_live_automation_state and /api/raffle/live
```

## Rollback

- **Pages:** `git revert <commit>` on `main` and push, or roll back in the dashboard to `b2034876` (pre-calendar)
  or `3689b2c8` (pre-placement). Setting `RAFFLE_PRIZE_CALENDAR_ENABLED` to anything other than `"true"` hides
  the calendar without code changes.
- **Placement data:** reverse the two guarded `UPDATE raffle_winners SET prize=…` statements, or restore D1 to
  bookmark `…d2295205…`.
- **Migration 003:** additive; leaving the tables unused is safe. Restoring to bookmark `…d53ac707…` drops them
  but also discards later writes.
- **Worker:** `wrangler rollback b3789062-a605-442d-949c-6f39e2e5cd68 --name folh-facebook-live-discovery`.
  An admin manual save returns the page to Manual mode immediately. Never delete `raffle_live`.

## Approvals still required
1. Deploy the poller fix (`ccb496f`) before the 2026-11-02 6 PM Central drawing.
2. Meta Llama 3.2 Vision license acceptance by the account owner, or a model change.
3. Photo importer: deploy with the combined Worker profile, add the Pages service and R2 bindings, apply migration 002.
4. Enter and approve the daily gift-certificate supplements, once sponsor details are confirmed for each day.
