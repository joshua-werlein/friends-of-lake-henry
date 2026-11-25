# Cloudflare account migration (staged 2026-11-07, production re-verified 2026-11-19)

Move Friends of Lake Henry from the **personal Cloudflare account** (`aa86268490e681cccb3a41a62093e2aa`, SOURCE)
to the **nonprofit Cloudflare account** (`ffe1aa6f4a533743f8f1b624f43c6d3d`, DESTINATION).
Phase 1 created and filled destination resources only. Nothing in SOURCE was modified, and no traffic,
DNS, Facebook webhook, cron, or email was switched.

## Current status and historical checkpoints

**Decision: no cutover before the season ends. The domain move waits until after November 30, 2026.**
The Cloudflare Registrar move (below) cannot be undone quickly and needs the destination to accept it, so it is not
done between nightly drawings.

The release inventory below records the current Photo Worker versions and the earlier Pages and Live Worker checkpoints.
DNS and the R2 inventory reflect the November 14 checkpoint. **Migration 009 is not applied to either database.**

## Next-session cutover action tracker

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

- [ ] **Photo Worker parity.** DESTINATION `ee409ca8` is staged from the same source as SOURCE `40eba822` (`476637c`).
  Add and verify the outstanding DESTINATION `IMAGES` binding. Keep cron, the public Worker URL, auto-import
  and alert flags off during staging.
- [ ] **Live Worker provenance.** Identify the source commit corresponding to SOURCE `ced68381`,
  rebuild and stage that exact version in DESTINATION; verify Durable Object/service bindings with
  schedules and alert/automation flags off.
- [ ] **Full DESTINATION staging regression.** After R2, secrets and Turnstile exist, verify public
  photos/posters, raffle/prizes/Live, admin login and one read including Photo imports, review-photo
  privacy, contact/photo submit and correct email behavior using safe isolated checks. Confirm
  `/_image` remains 404; record the exact Pages deployment SHA and bindings. Do not exercise
  production mutations from staging.
- [ ] **Reconcile final November operations.** Verify the Photo Worker release during the next live raffle drawing.
  Confirm all drawings/winners, photo imports, unresolved whole-photo Issues and failed/retry jobs have been reviewed.
  Document any deferred webhook or delivery events before allowing a freeze.
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
- [ ] **Post-cutover: 2027 raffle prize places.** The deployed pre-009 Photo Worker lineage (current source `476637c`)
  derives 1st/2nd/Bonus from the calendar only for `2026-11-*` dates (`calendarPosition` in
  `src/lib/server/raffle-prizes.ts`); any other month's winners would all be held for review. `main` already replaces this
  with the migration 009 season calendar (recurring-prize `place`, approved month). Before the 2027 season: apply 009,
  deploy the Photo Worker from `main`, approve the 2027 calendar, and add a test that replays a 2027 night (main, gift card,
  bonus) to `published`. Recorded 2026-11-20 from the Nov 20 investigation; not changed in the Nov 21 Photo release.

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
| D1 data | **57 November 2026 winners through Nov 24**, verified after the missing-position release. Historical all-winner checkpoints: 85 winners through Nov 23 (Nov 25 00:20 UTC; all rows byte-identical before and after the `3ae49baf` release, sha256 of `SELECT * ... ORDER BY id` `2644380f5f5187c0`; the Nov 22 bonus hometown, ticket 781, corrected manually by the owner Nov 24, correction id 9); 83 winners through Nov 22 (Nov 23 01:10 UTC; unchanged by the `256d96d6` release; the Nov 22 bonus entered manually); 80 through Nov 21 (Nov 22 15:36 UTC: no duplicate IDs, tickets or prize slots per day); 24 photo-review resolutions; both whole-photo Issues (the Nov 12 quota failure and a Nov 5 rejection) marked handled Nov 21; 6 hometowns corrected and the Nov 12 alert closed Nov 22 (see the November 12 reconciliation below); all 14 photo-automation alert incidents resolved | 46 winners through 2026-11-07 (stale by design; final sync replaces it) |
| R2 `folh-photos` | 28 objects, 16.6 MB, ENAM (unchanged since Nov 8) | **R2 not enabled** (API code 10042) |
| Live Worker | `ced68381-190a-42dd-b426-511e14d88ea3` at 100% (unchanged) | `a134d4df`, no cron, flags off |
| Photo Worker | `40eba822-d6df-42d7-85ea-54ab8249ae68` at 100%, built from `476637c` (tag `photo-worker-40eba822`, `main` integration `35ed114`). Previous: `3ae49baf` (`e44af14`, tag `photo-worker-3ae49baf`, `main` port `2314982`), `256d96d6` (`7571781`, tag `photo-worker-256d96d6`), `165eb38c` (`def561f`, tag `photo-worker-165eb38c`), `9a14b7c3` (`e2f9aa4`), `077637f8` (`49b3fd3`), `dc1ad438` (`7a9d4c4`), `3d4928c9` (`893d371`) | `ee409ca8-a236-4a57-8c6d-d11ae63f942d`, built from `476637c` with `wrangler.nonprofit.staged.json`. No cron, workers.dev off, automation and alerts disabled, **`IMAGES` outstanding**. Previous: `8ebd67eb-cfc9-47ed-934f-9f59b74d7c66` (`def561f`, Nov 22 15:08 UTC), `af328d6d` (`e2f9aa4`), `82b7d603` (`49b3fd3`), `1ca3d573` (Nov 8) |
| Secrets | Pages 7, Live 3, Photo 5 (names below) | **none** |
| `FOHL_SYNC_*` credentials | not set (legacy credentials in use) | not set |
| Domain | Cloudflare Registrar, `clientTransferProhibited`, DNSSEC off, expires 2027-12-12, NS `angelina`/`sam` | not added |

SOURCE Pages rollback order: `2f96df08-e195-4a5f-8e14-36070fb6d74c` (`d92eb2c`, same features as `93fe0d3b` but with the unpatched `/_image` endpoint; verified listed and serving on its alias Nov 19; use only for an application regression and re-release a patched build promptly), then `ba1bc408-a311-4285-bb37-09552713373c` (`f789234`, inline review without the history view), then `3a16b88e-5ff4-447b-b982-5da9e8ba6b1a` (hosted build of `482d851`, Node 22.23.5; its code ignores migration 010), then the emergency [`995a1755-4d19-4d31-af4e-a3227b2d9130`](https://dash.cloudflare.com/aa86268490e681cccb3a41a62093e2aa/pages/view/friends-of-lake-henry/995a1755-4d19-4d31-af4e-a3227b2d9130) built from `cf8252e` under Node 20.20.0.

**SOURCE Photo rollback order**

1. `3ae49baf-fe0d-45e3-b1d4-a340ee67848a` (`e44af14`) restores the previous missing-position behavior and retains hometown self-correction.
2. `256d96d6-9635-4b35-9d8c-f01941a34cff` (`7571781`) restores manual hometown review. Queued month scans stop running.
3. `165eb38c-c2b5-48ab-8bf8-ce40394ef670` (`def561f`) restores the Nov 22 hold for a brand-only or swapped-letter bonus label such
   as "Vexliar", or an unidentified label for the night's only remaining bonus.
4. `9a14b7c3-2a25-4309-bd85-999c550fd2c4` (`e2f9aa4`) restores the Nov 21 hold for a one-letter variant such as "Ice Auger".
5. `077637f8-f77a-4773-a0cc-289a7313defa` (`49b3fd3`) retains the Nov 16 fix. This version and the next restore the Nov 20 hold
   for bonus cells printed as `Label - Ticket - Name, Town`.
6. `dc1ad438-bb57-4705-a9f6-0d8e3945ee80` (`7a9d4c4`).

DESTINATION staging rollback order: Pages `7cdc9851` (`d92eb2c`, unpatched), then `df1fc387`. Photo `8ebd67eb-cfc9-47ed-934f-9f59b74d7c66` (`def561f`), then `af328d6d-7cad-4a04-99ed-837a9e4be67b` (`e2f9aa4`, staged Nov 21 01:58 UTC), `82b7d603` (`49b3fd3`, staged Nov 19), and `1ca3d573`. Use these Photo versions to recover staging with automation off. Cutover requires parity with the current SOURCE release and a verified DESTINATION `IMAGES` binding.

The Nov 19 releases kept the Pages project settings, bindings, variables and secrets, and the Worker bindings, flags, compatibility dates and cron settings, identical (compared before and after).

**Photo Worker release for the November 24 missing-position incident** (`photo:review:122337579074073310`).
SOURCE `40eba822-d6df-42d7-85ea-54ab8249ae68` and inactive DESTINATION staging
`ee409ca8-a236-4a57-8c6d-d11ae63f942d` were built from `476637c` (tag `photo-worker-40eba822`,
`main` integration `35ed114`). The fix derives a missing position only when all extraction passes agree on the
verified column, the date and column identify one approved calendar slot, and every explicit position agrees with
that slot. Explicit contradictions and ambiguous matches still require review. The audit records the derived
position while preserving the original extraction responses and existing publication safeguards.

All 93 targeted tests passed. Local replay of both stored passes in both orders against the pre-incident state
produced 2 publishable winners (ticket 588 first and ticket 848 second), 15 duplicates, 0 held and 0 rejected.
Release checks verified each account's `DB`, `AI`, `FACEBOOK_READS` and `FACEBOOK_LIVE` bindings, idle queues in both
accounts and 57 November winners in SOURCE through November 24. SOURCE has `IMAGES` and the two-minute cron.
DESTINATION automation remains disabled, and its `IMAGES` binding is outstanding. Live raffle verification is deferred
until the next drawing.

**Photo Worker release, 2026-11-25 00:14 UTC (Nov 24, 6:14 PM Central; owner-approved outside the usual window after the Live
ended with no winner photo pending; Photo Worker only; SOURCE account `aa86268490e681cccb3a41a62093e2aa`).** Fixes incident
`photo:review:122337496586073310`: both passes of the Nov 22 table read ticket 781's hometown as "Westby, WI" (also the next cell's town)
and it was published after a review that changed only the prize; both passes of the Nov 24 cumulative table read "Maple Park, IL" and the
row was rejected, because the importer never changed a stored winner. The Page's table was edited between the posts ("Brodhead, Wi"
became "WI"); the photos are not stored, so a model misread cannot be ruled out. Changes:
- **Window path.** A stored hometown that the importer read (not edited by an administrator, not hand-entered) is replaced only when
  date, ticket, name and approved prize slot match one winner, the hometown is the only difference, every pass agrees, there is no
  image-wide warning, and one targeted AI re-read of that cell (told the date, ticket and name, never a hometown) confirms it. The write
  is atomic and idempotent and is audited in `raffle_winner_corrections` (`action` 'update', `after_json.source` 'photo-auto', the photo ID,
  old and new hometown); the photo row reads "hometown corrected automatically by the photo importer, not by an administrator".
- **Month-wide scan.** The publishing run queues it (audit row 9000); the next cron run that processes no post takes it atomically, downloads
  the same image again (hash must match), makes two whole-table reads, and corrects only dates before the window reads, under the same
  rules. The two-correction limit per photo is shared with the window path. No AI read starts after 8 minutes. Failures end the scan quietly;
  the next table is scanned again. About 800-1,000 neurons a night at month end.
- **Shown conflicts.** Older conflicts that may not be corrected (administrator-edited, hand-entered, failed checks, over the limit,
  unconfirmed) appear once in Photo imports as `outside-window` rows: no review item, no alert, never repeated by later tables.
- Harmless hometown formatting (case, accents, spacing, commas, periods) compares equal. `FB_PHOTO_MONTH_SCAN` = `report` (show only) or
  `false` (off); unset in production (corrections on).
No migration, no Pages, Live Worker, D1 schema or DESTINATION change. Source `e44af14` (one commit on `7571781`, tag `photo-worker-3ae49baf`;
`main` port `2314982`), Wrangler 4.156.0. Validation: relevant suites 140/140 on the branch and 161/161 on `main` (the release diffs were
byte-identical to the validated patches); production and staged dry-run bundles, offline `check-deployment.mjs`. Preflight: `256d96d6` at
100%, queue idle, 0 unresolved incidents. After: `3ae49baf` at 100%; handlers, compatibility date, 5 secrets and every binding and variable
identical to `256d96d6`; triggers `*/2 * * * *`; three scheduled runs (00:14:48, 00:16:48, 00:18:48 UTC) `ok` with no exceptions at 5-6 ms
CPU each, and a webhook delivery at 1 ms; all 85 `raffle_winners` rows byte-identical; 9 correction rows; 0 incidents. The first scan runs
after the next winner photo (expected the morning of Nov 25). At release time 41 November hometowns counted as importer-read (correctable)
and 14 as protected (9 administrator-edited, including ticket 781; 5 hand-entered).

**Photo Worker release, 2026-11-23 01:04 UTC (Nov 22, 7:04 PM Central; owner-approved; Photo Worker only; SOURCE account
`aa86268490e681cccb3a41a62093e2aa`).** Fixes the Nov 22 hold: `Vexliar - 781 - Troy Mish, Westby, WI` was held because "Vexliar"
swaps two letters of the approved "Vexilar Fish Finder" and names only the brand; the firearm and gift card had published. The
winner was entered manually and was not reprocessed. Changes: a one-letter spelling variant also covers two neighbouring letters
swapped; a one-word label may name the night's bonus by its 6+ letter opening brand word (never re-dating a cell); a winner whose
prize text names no approved prize takes the drawing's only unaccounted approved bonus when both passes place it in the bonus column
(explicit Bonus place, bonus heading or the cell's own label), every numbered place of the date is stored or published, no other bonus
of the window is open, the column's dates are not refuted, and the label names nothing else (one-word labels must be 5+ letters and the
prize's final noun or brand; "Ice", "Master" stay held). "Chainsaw" stays manual. Source `7571781` (one commit on `def561f`, tag
`photo-worker-256d96d6`; `main` port `7a3002d`), Wrangler 4.156.0; focused suites 84/84 on the branch, 89/89 on `main`. Preflight:
clean worktree at `7571781`, `165eb38c` at 100%, queue idle (20 done, 19 ignored), production schema without 009 columns, offline
`check-deployment.mjs` passed, dry-run bundle with no 009 code. After: `256d96d6` at 100%; compatibility date, handlers, 5 secrets
and all 20 bindings identical to `165eb38c`; triggers `*/2 * * * *`; scheduled runs at 01:06:47 and 01:08:47 UTC `Ok` with no
exceptions, 0 open alerts; all 83 `raffle_winners` rows byte-identical (sha256 of `SELECT * ... ORDER BY id`, `47338863e9b46761`,
before and after); queue unchanged. No Pages, Live Worker, D1 schema, migration 009 or DESTINATION change.

**November 12 reconciliation and hometown corrections, 2026-11-22 (owner-approved; SOURCE D1 data only).** The Nov 12 post
`144051422124740_122335449590073310` (photo `122335449560073310`) failed on Nov 12 after 6 attempts on the Workers AI daily quota
(code 4006). No image or reads were stored, and its winners were entered manually. Day 12 had two approved prizes (Henry Side Gate 410,
the daily gift certificate) and no bonus. Both stored winners, 377 Kurt Kuehl and 103 Carmen Peters, match the ticket, name and slot in
all 8 later reads (4 cumulative photos, Nov 14–18, 2 passes each). The photo was marked handled on Nov 21 (resolution #22, "entered
manually").

- **Hometowns** (town only, via the admin edit's compare-and-set update and a `raffle_winner_corrections` row each, ids 3–8):
  `Tomah, W` to `Tomah, WI` (#377) and `Coon Valley, W` to `Coon Valley, WI` (#103), from 8 verbatim cell reads each; `LaCrosse` to
  `LaCrosse, WI` (Nov 1 #360), `Cashton` to `Cashton, WI` (Nov 1 #894) and `Hixton` to `Hixton, WI` (Nov 2 #709), from the printed
  table in `tests/fixtures/facebook-winners-2026-11-03.jpg` and 18 later reads each; `Auburn,WA` to `Auburn, WA` (Nov 2 #323, printed
  without the space). Prize text, IDs, tickets and slots were not changed.
- **Alert** `photo:post:144051422124740_122335449590073310`: the Photo Worker re-raises a `photo:post:` alert for every post whose
  status is `failed` (a new alert email if the incident were only marked resolved; a recovery email if only the post changed). One
  request at about 15:33 UTC, right after a cron tick, set the post `failed` to `done` (attempts, error codes, the 18 attempt rows, the
  `failed` import row and resolution #22 kept) and the incident `open` to `resolved` (`resolvedAt` 15:31:05Z, the time the change
  was prepared; first-seen and notified times kept). The 15:34:48 tick ran clean: no new incident and no email. Requeue eligibility
  is unchanged (`done` and `failed` requeue alike).
- **Backup and reversal:** `C:\Users\Jwerl\dev\folh-backups-2026-11-22-nov12-cleanup\` (`before.json` with every affected row and
  all 80 winners, `after.json`, `change.sql`, `restore.sql`, rehearsed locally: applies once, reruns as a no-op, restores
  byte-for-byte). The D1 Time Travel bookmark before the change is `000037c4-00000000-0000512b-b45daf1eaeea5b598ffef0c144801864`
  (whole database; last resort). Running `restore.sql` re-opens the alert: the next tick would email it again.
- **After:** 80 winners, 80 distinct IDs, no duplicate tickets or slots; only the 6 towns differ from the backup; the public
  `/api/raffle/month` serves the corrected towns. DESTINATION D1 is stale by design and receives these rows in the final sync.

**Photo Worker release, 2026-11-22 15:03 UTC (Nov 22, 9:03 AM Central; owner-approved; Photo Worker only).** Fixes the Nov 21
hold (`photo:review:122337048518073310`): both reads of `Ice Auger - 029 - Pat Keating, LaCrosse, WI` were correct, but the calendar
spells the bonus "Strike Master Ice Augur", and prize identification had no rule for a shortened label with a one-letter spelling
variant. Source `def561f` (`3040b9b` + test-only `def561f` on `e2f9aa4`; 217/217; `main` port `9adbe47` + `85dc75c`), Wrangler 4.156.0.
Preflight: clean worktree at `def561f`, `9a14b7c3` at 100%, rollbacks listed, no queued/processing/retry/locked posts, cron `*/2`
`ok` on `9a14b7c3` at 15:00:48 UTC. After: `165eb38c` at 100%; handlers, compatibility date, 5 secrets, bindings and flags identical
to `9a14b7c3`; triggers `*/2 * * * *`; scheduled runs at 15:04:48 and 15:06:48 UTC `ok` with no exceptions; all 80 `raffle_winners`
rows byte-identical (fingerprint `307e6b35d0856718` before and after, the administrator's Nov 21 correction included); queue
unchanged; no AI calls. DESTINATION staged `8ebd67eb` from the same commit, configuration identical to `af328d6d`. No Pages, Live
Worker, D1 schema or migration 009 change; no cutover step.

**Photo Worker release, 2026-11-21 01:53 UTC (Nov 20, 7:53 PM Central; owner-approved; Photo Worker only).** Fixes the Nov 20
hold (`photo:review:122336881070073310`): both reads of `Bubba Filet Knife - 628 - John Wickum, Wilson, WI` were correct, but the
printed-name check could not parse a labelled cell with a ticket. Source `e2f9aa4` (206/206; `main` port `4c34d8f`, 227/227),
Wrangler 4.156.1. Preflight: clean worktree at `e2f9aa4`, SOURCE account, `077637f8` at 100%, rollback versions listed, no
queued/processing/retry posts, cron `*/2` healthy on `077637f8`. After: `9a14b7c3` at 100%; handlers, compatibility date, 5 secrets,
bindings and flags identical to `077637f8` (`wrangler versions view` compared); triggers `*/2 * * * *` and workers.dev as before;
scheduled runs at 01:54:48 and 01:56:48 UTC `ok` with no exceptions; all 77 `raffle_winners` rows byte-identical (fingerprint
`a7f19ac0e3973a89` before and after); queue unchanged; no AI calls. DESTINATION staged `af328d6d` from the same commit: configuration
identical to `82b7d603` (no cron, workers.dev off, flags off, no secrets, no `IMAGES`). No Pages, Live Worker, D1 schema or
migration 009 change; no cutover step.

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
- **Photo Worker production and staging source:** `476637c` (tag `photo-worker-40eba822`), with the fix integrated
  into `main` as `35ed114`. Build and deploy the Photo Worker from the pre-009 release lineage until 009 is applied.
  Earlier lineage: `e2f9aa4` on `fix/photo-cell-parser` (tag `photo-worker-9a14b7c3`, ported to `main` as `4c34d8f`),
  a child of `49b3fd3` (`fix/photo-name-separator`, tag `photo-worker-077637f8`), which extends `7a9d4c4`
  (`fix/photo-prize-spacing`, tag `photo-worker-dc1ad438`) and `893d371` (tag `photo-worker-3d4928c9`).
- **Historical `main` checkpoint** (fast-forwarded and pushed Nov 19 from `integrate/photo-review-main`): `da838bb` plus the Node pin, the Nov 15 and Nov 16
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

1. Cut over with the code running in SOURCE production at the time of the move. The current baseline is Pages
   `da5333c` built with Node 22.23.5 (SOURCE `93fe0d3b`, staged as `1c163014`), Photo Worker `476637c`
   (SOURCE `40eba822`, staged as `ee409ca8` with `IMAGES` still outstanding), and the Live Worker from the
   `ced68381` source commit. Stage any intervening SOURCE release before the move and use that release at cutover.
   Keep the current schema during the move.
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
| Worker `folh-facebook-winner-photos` | Version `40eba822-d6df-42d7-85ea-54ab8249ae68`, UTC cron `*/2 * * * *`; workers.dev on; `FB_PHOTO_AUTOMATION_ENABLED=true`, `FB_PHOTO_AUTOPUBLISH=true`, `FB_PHOTO_POLL_ENABLED=true`, `ALERTS_ENABLED=true`, `ALERTS_MODE=live`, `ALERT_WEBHOOK_DELIVERY_ENABLED=false` | version `ee409ca8-a236-4a57-8c6d-d11ae63f942d` (`476637c`), no cron, no workers.dev, automation and alerts disabled, no secrets, `IMAGES` outstanding |
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
4. **Staged Photo Worker** — `ee409ca8-a236-4a57-8c6d-d11ae63f942d` from `476637c` (tag `photo-worker-40eba822`)
   with `workers/facebook-photos/wrangler.nonprofit.staged.json`. Keep cron, workers.dev, automation and alerts off.
   Before cutover rehearsal, confirm Images is available to DESTINATION, add the `IMAGES` binding, and redeploy
   and validate the same release with automation disabled. Verify the DESTINATION D1, AI, Images and Live service bindings
   and record the refreshed staging version ID. If staging must be rolled back, use `8ebd67eb-cfc9-47ed-934f-9f59b74d7c66` with automation off and restore parity
   before proceeding.
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
   reads the DESTINATION bucket. Rehearse the Photo Worker from `476637c`, current SOURCE version `40eba822`, after
   refreshing the inactive DESTINATION stage (`ee409ca8`) with the verified `IMAGES` binding. Validate the planned
   activation schedules, flags and bindings. Keep staging automation inactive, and close staging write paths before the final sync.
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
   and fingerprint against SOURCE, including the 57 November winners verified through Nov 24 and any later drawings.
   Confirm that no Photo job is pending. Re-copy CONFIG KV with matching values, expiry, and metadata, and remove destination-only keys.
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
   previews remain write-gated. Activate Live first from the verified `ced68381` source, then Photo from the SOURCE
   production lineage (current source `476637c`, tag `photo-worker-40eba822`). Use the release rehearsed with
   DESTINATION resource IDs, the exact UTC schedules and flags in the inventory, and the verified Photo `IMAGES` binding.
   The copied season ends at midnight Central on December 1. Expect no November backup polling after its eligible window,
   and verify the next eligible natural executions without extending the season.
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
`995a1755`), and verify its production alias. If the SOURCE Photo Worker fails, use
`3ae49baf-fe0d-45e3-b1d4-a340ee67848a` first, then follow the SOURCE Photo rollback order above. Use
`wrangler versions deploy 3ae49baf-fe0d-45e3-b1d4-a340ee67848a@100% --name folh-facebook-winner-photos`
with `CLOUDFLARE_ACCOUNT_ID=aa86268490e681cccb3a41a62093e2aa`.

**After DESTINATION accepts:** keep the public site and any active writers in DESTINATION during recovery.
- **Application fault:** use the verified DESTINATION Pages artifact built from the cutover commit (staging step 3) or a
  known-good deployment in the DESTINATION project (today `1c163014`, `da5333c`). `7cdc9851` and `df1fc387` are older and
  expose `/_image`; use them only as a last resort and re-release a patched build. SOURCE deployments (`93fe0d3b`, `2f96df08`,
  `ba1bc408`, `3a16b88e`, `995a1755`) cannot roll back the DESTINATION project.
- **Data fault:** freeze DESTINATION writes, preserve the current snapshot, and reconcile post-cutover writes before
  restoring with D1 Time Travel or the cutover export. Recheck KV and R2 consistency before reopening.
- **Automation fault:** gate the DESTINATION callback, crons, and flags until the known-good versions and bindings
  are verified. Keep SOURCE Workers stopped. For Photo, the nonprofit rollback version is
  `8ebd67eb-cfc9-47ed-934f-9f59b74d7c66` with automation gated. Confirm a working DESTINATION `IMAGES`
  binding and verify the activation configuration before resuming automation. Use a reviewed manual fallback on
  DESTINATION if needed.
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
