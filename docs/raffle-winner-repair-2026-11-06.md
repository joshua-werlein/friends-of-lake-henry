# November 6 raffle winner and photo repair: review packet (revision 2)

**Status: local and uncommitted.** Nothing was committed, pushed or deployed. No production migration, requeue, D1 or KV write was made. Replaces the first revision, whose winner assignments were wrong.

**Sol's review wasn't available locally.** The three blockers are addressed as the owner's brief described them. Please check them against your own notes.

## Authoritative November 6 results

From the corrected announcement (`tests/fixtures/facebook-winners-2026-11-06.jpg`, SHA-256 `1cf96fca…`) and the approved calendar:

| Place | Winner | Hometown | Ticket | Prize | Calendar slot |
|---|---|---|---|---|---|
| 1st | Troy Lindberg | Hixton, WI | 288 | Springfield Armory 1911 Emissary 9MM | `event:2026-11-06-day-6-springfield-armory-1911-emissary-9mm` |
| 2nd | Lyle Schlomer | Osseo, WI | 838 | $100 gift certificate from Safe & Secure Firearms | `daily:2026-11-06:0` |
| Bonus | Kent Johnson | Blair, WI | 681 | Cutting Board, Cheese Board & Knife sponsored by Cutting Canteen | `event-bonus:2026-11-06-day-6-springfield-armory-1911-emissary-9mm` |

## Owner-confirmed corrections

The owner confirmed ticket 838 for Lyle and ticket 681 for Kent. Preserve Kent's existing ID and ticket when changing his assignment. Check for an existing Lyle record before adding one. If he already exists, edit that ID. The captured AI fixture must still show the blank tickets printed in the corrected image. The owner-confirmed regression supplements that evidence.

For November 4, update the existing ticket 226 record's hometown to **Galesville, WI** after production approval. Preserve its ID, ticket, placement and prize. The captured announcement spells the name **Jim Wilber**. Verify the proposed **Jim Wolber** against the original ticket or an organizer's authoritative record before changing the name. Retain the recorded spelling while that evidence is unresolved.

## Time-sensitive risk: November 7

The **old Worker is still live** and still has the wrong three-prize mapping. November 7 and 8 both have bonus drawings. If it publishes those days, Bonus is saved as 2nd and the gift card as 3rd. Release before about 5:45 PM Central on November 7, or have the owner decide whether to set `FB_PHOTO_AUTOPUBLISH=false` and enter winners manually. This repair can't reach production until Sol approves it.

## Exact code changes

| Area | Change | Files |
|---|---|---|
| Prize slots | New `raffle_winners.prize_slot_id` holding the calendar entry's stable ID. Unique index `uniq_raffle_winner_prize_slot`. Replaces the Bonus display-text index from revision 1 | `migrations/006_bonus_winner_tickets.sql` |
| Missing tickets | `CHECK` requires a slot, a prize and no label when the ticket is NULL. Any verified category qualifies: main, gift card or bonus | `006`, `src/pages/api/admin/raffle/winners.ts`, `winner-prize.ts`, `src/lib/server/raffle-photo-autopublish.ts` |
| Backfill | 006 fills `prize_slot_id` for November 2026 rows naming exactly one calendar prize. No other column changes | `006` |
| Correction evidence | New append-only `raffle_winner_corrections`, written in the same batch as each admin edit, prize edit or delete, with full prior values | `006`, both admin APIs |
| Winner IDs | Ticketless ID comes from the slot, so manual entry and the importer collide rather than duplicate. Adding or clearing a ticket keeps the existing ID | `src/lib/winner-prize.ts` |
| Calendar | `calendarPosition` moved to `raffle-prizes.ts`: main 1st, gift 2nd, every bonus drawing Bonus. Several bonus lines in an event summary, or a `Bonus drawing` supplement, each get their own slot. Any other extra entry leaves places unproven | `src/lib/server/raffle-prizes.ts`, `src/scripts/raffle-prize-calendar-admin.ts`, `src/pages/admin/raffle/prizes.astro` |
| Aliases | A label matches when it's a whole-word phrase of two or more words from exactly one approved description that day (`Cutting Board`). Display keeps the full description | `identifyPrize` |
| Prompt | Handles headingless columns, the three cell forms, and a new `cellText` raw cell copy | `workers/facebook-live/photos.ts` (not in the Live bundle) |
| Raw-cell check | Parsed ticket, name and hometown must be consistent with `cellText`, which a ticket-free row must supply. Added after real AI reads produced a false blank | `cellTextProblems` |
| Replay safety | A matching person in a different slot is `rejected`, not `duplicate`. Unverifiable prize text is `held`. Stored rows lacking a slot resolve from their description | `decidePhoto` |
| Atomic requeue | `requeuePost` queues the post and reopens photos in one batch, and refuses a post being processed. `finishPost` and `failPost` are fenced by attempt number, so an expired run can't overwrite a newer one | `raffle-photo-autopublish.ts`, `photo-imports.ts`, `workers/facebook-photos/index.ts` |
| Display | `ticketLabel` never shows `0` or `null`; `047` and `050` pass through | `winner-prize.ts`, public and admin pages |
| Admin | No-ticket confirmation now covers every category; suggestion text for a bonus drawing is prefix-free | `src/pages/admin/raffle.astro`, `src/scripts/raffle-prize-suggestions.ts` |

Revision 1's other work remains: placements, structured warnings, identity-based row matching, diagnostics (migration 007, unchanged) and the sanitized attempts table.

**Tests:** `tests/raffle-november-6.test.mjs` (rewritten), `tests/raffle-winner-migration.test.mjs` (revised). New fixtures: the real image, `facebook-winners-2026-11-06.json`, and `facebook-winners-2026-11-03.cell-vision.json` and `-04.cell-vision.json`. `tests/raffle.test.mjs` and `winner-prize.test.mjs` now load 006. The transcribed fixture from revision 1 was deleted.

## Test results

| Check | Result |
|---|---|
| `npm test` on Node 24.22 | **115 pass, 0 fail** |
| Same suite on Node 20.20 (project's version) | **115 pass, 0 fail** |
| Four TypeScript projects, Astro build, photo Worker build, `check-deployment.mjs`, `wrangler deploy --dry-run` | pass, nothing uploaded |
| Live Worker bundle | byte-identical (`c907710e…`); Live sources unchanged |
| Built site in a local in-memory preview, including the full correction | 17/17 |
| Migration replay through `wrangler d1 execute --local` | pass (below) |
| Admin form JavaScript in a real browser | **not run**: the Chrome extension isn't connected. Its APIs are covered |

**Real-image validation (this is real, not transcribed).** Workers AI (`@cf/mistralai/mistral-small-3.1-24b-instruct`) ran on the genuine bytes through the inference endpoint only: no Worker upload, D1, KV or Facebook access. It used the owner's Wrangler login. 12 calls in total:

- **Nov 6, final prompt, 3 runs (6 passes):** every pass read all 13 cells correctly. Troy 288 Firearm; Lyle no ticket, Gift Card; Kent no ticket, `Cutting Board`; no warnings.
- **Nov 3 and Nov 4 two-column images (4 passes):** correct, including `047` and Jim Wilber's blank hometown.
- **Nov 6, first prompt attempt (2 passes), before the raw-cell change:** both passes reported Troy Zigler's ticket 894 as blank, and one swapped Jim's and Rob's hometowns. That prompted the raw-cell check.

**Corrected regression coverage.** Your ten required cases all pass:

1. Troy is 1st with 288.
2. The image reads Lyle as 2nd without a printed ticket. The owner-confirmed production target is ticket 838.
3. The image reads Kent as Bonus without a printed ticket. The owner-confirmed production target preserves ticket 681 on his existing ID.
4. All three display correctly, on the public API and on the server-rendered page in the preview.
5. Admin add and edit support both ticketless winners.
6. Kent's existing record is a conflict, not silently accepted or duplicated.
7. The owner-confirmed correction regression preserves Kent's ID and ticket 681, adds Lyle with 838, updates ticket 226's hometown without changing its stored prize or name, and proves repeated image replay changes no winner.
8. The real capture produces the right associations.
9. Repeat processing never inserts duplicates, including through the real Worker bundle in workerd. Only the AI response is replayed there, from the real capture.
10. Older winners and legacy `3rd` records stay intact.

Also covered: a Kent/Lyle column disagreement holds both; a replayed superseded announcement writes nothing; multiple Bonus drawings; punctuation can't open a slot; requeue atomicity and lease fencing.

**Migration replay.** Seeded from the newest local production snapshot (40 winners, November 5) plus Troy and Kent as the site reports them. That addition is from your description, not production data.

- All 42 existing values were byte-identical after 006 and 007.
- 12 of 12 November rows received the correct slot; other months received none.
- Lyle inserted twice gave one row.
- Rollback refused while a ticketless winner existed, then restored the original rows exactly, and re-applying forward matched.

## Remaining risks

1. **The production state is unverified.** I only have your description for November 6 and a November 5 snapshot for the rest. The local replay in step 2 below checks this before anything touches production.
2. **The AI passes aren't truly independent.** At temperature 0, repeat runs were identical and the two prompts produced the same output on this image. Agreement guards against prompt-dependent misreads, not a shared one. The raw-cell check catches parsing errors, not a wrong `cellText`.
3. **Agreement can't catch a shared swap.** If both passes put the same person in the wrong column with self-consistent cell text, that read is accepted. Identity is deliberately never inferred from the calendar. One image type has been validated; other layouts haven't.
4. **Ticketless publishing is now possible for any category.** A cell whose ticket both passes miss, in the same way, including in `cellText`, publishes as "Not published". The failure is a missing ticket, not a wrong winner, and a ticket can be added later.
5. **Remote `--file` atomicity is unverified.** Atomic failure was tested with a D1 batch; the copy guard fires before the DROP, but the backfill runs after it. The local replay of a production export is the protection, and the restore point is the fallback.
6. **A cleared ticket's ID still contains it.** Kent's ID would remain `…-681`. It's opaque, but a later manual add of ticket 681 for that date would collide and return 409.
7. **The backfill hard-codes the gift certificate text and November 2026,** mirroring `DAILY_PRIZES`. A test compares it with the application calendar for all 30 days. Approved supplements aren't backfilled; they resolve at decision time.
8. **Slots only exist where a calendar entry matches.** A numbered winner with a custom prize has no slot and no slot protection. Older ticket and place checks still apply.
9. **Requeueing a `partial` photo re-runs AI,** and non-`inserted` audit rows are replaced by the latest decision. The history stays in the sanitized attempts table.

## Release procedure

**Owner GO received.** The owner confirmed the drawing finished and lifted the former 5:45 PM–midnight restriction. The Live Worker is outside this release.

**1. Backup and schema verification (read-only).**
```
npx wrangler d1 time-travel info folh-db --config wrangler.json # record the bookmark
npx wrangler d1 export folh-db --remote --config wrangler.json --output folh-db-pre-repair.sql
```
`wrangler.toml` targets `folh-db-dev`, and `wrangler.json` targets production, so confirm the target every time. Keep the export out of git. Then run:
```sql
SELECT type, name FROM sqlite_master WHERE tbl_name='raffle_winners' AND name NOT LIKE 'sqlite_%';
SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') AND sql LIKE '%raffle_winners%';
PRAGMA table_info(raffle_winners);
SELECT rowid, * FROM raffle_winners ORDER BY rowid;
SELECT id, status, date_start, summary FROM events WHERE id LIKE '2026-11-06%';
```
Stop if the table has unexpected columns, indexes or triggers, or if November 6 isn't what's described above.

**2. Rehearse on the real data, locally.** Load the export into a throwaway `--local --persist-to` database, apply 006 and 007, and compare every original column. Check `SELECT draw_date, winner_name, prize_slot_id FROM raffle_winners WHERE raffle_key='2026-11'`. A UNIQUE failure here means two winners name one prize: resolve it before touching production.

**3. Migrations.**
```
npx wrangler d1 execute folh-db --remote --config wrangler.json --file migrations/006_bonus_winner_tickets.sql
npx wrangler d1 execute folh-db --remote --config wrangler.json --file migrations/007_photo_import_diagnostics.sql
```
Re-export and compare with step 1. Old Pages and the old Worker keep working on this schema.

**4. Pages.** Commit and push to `main`, which deploys Pages. Confirm `/raffle` is unchanged and the admin pages load.

**5. Photo Worker verification in isolation.**
```
node workers/facebook-photos/check-deployment.mjs
node --import ./tests/register.mjs --test tests/raffle-november-6.test.mjs
```

**6. Verify the release candidate against isolated data.** Use the genuine corrected image and a disposable copy of the winner state. Keep the production November 6 posts out of requeue. A global auto-publish disable is an operational pause requiring approval because new arrivals become held and can need explicit requeue afterward.

**7. Correct the winners in `/admin/raffle`, in this order.** Kent must vacate the gift card first.
- **Kent → Edit:** select **Bonus**, enter the full cutting board prize (or pick the suggestion), and set hometown `Blair, WI`. Keep ticket **681** and its exact printed label. Save on the existing ID.
- **Lyle → Edit or Add:** first check for an existing record by name and ticket **838**. Preserve its ID if present. Otherwise add one row dated `2026-11-06`, ticket **838**, **Second place**, the gift certificate suggestion and hometown `Osseo, WI`.
- **Troy:** no change expected; confirm `Hixton, WI`.

**November 4 ticket 226 → Edit:** set hometown `Galesville, WI` on the existing record. Keep the ticket, placement, and stored prize unchanged. Change the name to Jim Wolber only after independent spelling confirmation.

**8. Confirm the public site.** `/raffle` and the November API must show Troy 1st 288, Lyle 2nd 838, and Kent Bonus 681, with the full verified prizes and hometowns. Ticket 226 must show Galesville, WI. Compare every preexisting ID and every unrelated record to the pre-edit snapshot. Check phone width and that November 6 has left the upcoming calendar. Then verify:
```sql
SELECT id, ticket_number, ticket_number_text, winner_name, town, prize, prize_slot_id FROM raffle_winners WHERE draw_date='2026-11-06';
SELECT winner_id, action, before_json, created_at FROM raffle_winner_corrections ORDER BY id DESC LIMIT 5;
SELECT id, winner_name FROM raffle_winners WHERE raffle_key='2026-11' AND prize_slot_id IS NULL;
```

**9. Photo Worker release and verification.** After isolated processing checks and approved corrections, deploy the reviewed photo Worker with the existing publication and polling settings:
```
npx wrangler deploy --config workers/facebook-photos/wrangler.json
```
Verify the active version, bindings, feature flags and two-minute schedule. Observe the next real eligible event and compare `publication_status` with the public table. In isolated replay, the owner-confirmed November 6 rows must remain unchanged. Jim's newly confirmed hometown can conflict with the blank hometown printed in the old table and must remain preserved. Avoid production requeue of either November 6 post.

## Independent review additions

The owner confirmed 838 for Lyle and retained 681 for Kent. The raw image and AI fixtures remain unchanged. The new owner-confirmed correction test covers the public and admin APIs, IDs, exact ticket labels, prize assignments, ticket 226's hometown, duplicate rejection and repeated image replay.

An additional regression found that explicit Bonus labels collapsed distinct approved slots during the preliminary conflict check. The local fix reserves that check for numeric places. Approved slot identities still enforce Bonus uniqueness later in the decision and database write.

The production schema and targeted November 4 and 6 reads confirmed the pre-migration nine-column winner table and existing Kent, Troy and Jim IDs. A read-only Time Travel bookmark was obtained. The owner subsequently approved a private local export. The current-data rehearsal is now complete. Capture a fresh bookmark immediately before any approved migration.

## Rollback that keeps new winners

1. **Export first:** `wrangler d1 export` again.
2. **Stop publishing:** `wrangler deploy --config workers/facebook-photos/wrangler.json --var FB_PHOTO_AUTOPUBLISH:false`.
3. **If the Worker code must go back:** deploy the previous commit with that same `--var` flag. **A plain `wrangler rollback` restores auto-publish with the old mapping.**
4. **Pages:** roll back the deployment if needed. Old pages show a ticketless winner with a blank ticket, and Bonus as place `—` with `Bonus — …` as prize text. They can't save edits to those rows. Display is degraded, but data is intact.
5. **Leave the schema in place.** 006 and 007 are compatible with old code, and this is what keeps Lyle and Kent.
6. **Avoid these unless the owner decides otherwise:**
   - `rollback/006_*.down.sql` refuses to run while any ticketless winner exists. **Never invent a ticket to pass it.**
   - Time Travel restore discards every D1 write since the bookmark, including winners and other site data. Use it only for a failed migration, before new writes.

## Reviewed source manifest

Stage these paths explicitly after approval. Leave the proposed Live instrumentation patch outside this release. The timeline test is read-only regression coverage already referenced by the package test command.

git add --
- docs/raffle-photo-autopublish.md
- docs/raffle-winner-repair-2026-11-06.md
- migrations/006_bonus_winner_tickets.sql
- migrations/007_photo_import_diagnostics.sql
- migrations/rollback/006_bonus_winner_tickets.down.sql
- migrations/rollback/007_photo_import_diagnostics.down.sql
- package.json
- src/lib/raffle-photo-import.ts
- src/lib/server/raffle-photo-autopublish.ts
- src/lib/server/raffle-prizes.ts
- src/lib/winner-prize.ts
- src/pages/admin/raffle.astro
- src/pages/admin/raffle/photo-imports.astro
- src/pages/admin/raffle/prizes.astro
- src/pages/api/admin/raffle/photo-imports.ts
- src/pages/api/admin/raffle/winner-prize.ts
- src/pages/api/admin/raffle/winners.ts
- src/pages/api/raffle/month.ts
- src/pages/raffle.astro
- src/scripts/raffle-prize-calendar-admin.ts
- src/scripts/raffle-prize-editor.ts
- src/scripts/raffle-prize-suggestions.ts
- tests/fixtures/facebook-winners-2026-11-03.cell-vision.json
- tests/fixtures/facebook-winners-2026-11-04.cell-vision.json
- tests/fixtures/facebook-winners-2026-11-06.jpg
- tests/fixtures/facebook-winners-2026-11-06.json
- tests/live-detection-timeline.test.mjs
- tests/local-preview.mjs
- tests/photo-autopublish.test.mjs
- tests/raffle-november-6.test.mjs
- tests/raffle-winner-migration.test.mjs
- tests/raffle.test.mjs
- tests/winner-edit.test.mjs
- tests/winner-prize.test.mjs
- workers/facebook-live/photos.ts
- workers/facebook-photos/index.ts

The approved current-data backup and isolated migration rehearsal are complete. The owner authorized release after final gates. Actual phone-width verification passed at 375px and 390px. The migration ledger currently lists 001, 002 and 003 only, although the 004 photo tables and 005 ticket label column exist. Reconcile the ledger with the schema during preflight. Execute only the reviewed 006 and 007 files, and avoid a bulk migrations-apply command against this ledger.


## Verified production baseline for the final review

- Account aa86268490e681cccb3a41a62093e2aa. D1 folh-db, 527df871-e876-4924-81d0-5d0572b4dd7b.
- Photo Worker version 5f27fe89-77b2-440a-bb10-a926a381f5a3. Auto-publish and automation are true, extraction passes 2, polling true and schedule */2 * * * *.
- Pages deployment 6a04ed5c-ba9e-4576-9bd9-887b44137d20, production branch main, build image 3, npm run build. No explicit NODE_VERSION was returned. Keep .nvmrc and engines at Node 20.
- Live version 94f621e8-b8a2-47e6-bd9e-fb126858b805. The read-only deployed module and the Wrangler dry-run artifact both hash to bc9784f9e638f5f87ad5e981fa28d66c1e8fd157f47f165fb4d0ee46ec616f09. Raw esbuild output has different packaging and is not the comparison artifact.
- Two independent fresh Workers AI reads on the genuine corrected image returned 13 rows and no warnings. Both identified Troy 288, Lyle Gift Card without a printed ticket, and Kent Cutting Board without a printed ticket. The owner-confirmed tickets remain admin corrections, never additions to raw extraction evidence.
- The final regression suite has 116 tests. Node 20 passed all 116, the four typechecks, three builds and the offline photo Worker deployment preflight.
- In the disposable browser preview, Kent retained ID 2026-11-2026-11-06-681 and ticket 681 when moved to Bonus. Lyle was added as ticket 838 in 2nd. Jim's ID 2026-11-2026-11-04-226 retained its stored name, ticket and prize while the hometown became Galesville, WI. The public board and November API displayed all four correctly after month navigation.
- Production winner corrections remain pending explicit owner GO. The current production export rehearsal passed. The authorized isolated Playwright alternative subsequently verified actual 375px and 390px viewports.
- Node 24 also passed all 116 tests. Its first full run hit a Miniflare fetch bad-port failure. A logged repeat passed all 116 without a code change. This is retained as a local harness limitation.

## Approved backup and current-data rehearsal completed

The full export is stored in a private temporary folder outside the repository. The folder and export file allow only the owner's Windows account, SYSTEM and Administrators. No SQL or local database copy is included in this repository. Recovery metadata and the Time Travel bookmark are stored alongside the private export.

SHA-256 of the export is c1abf5e0eecf400065f80e6661795768f1fa0924b37365e5f953eb427c088121. The initial SQLite restore passed integrity_check. A separate disposable local D1 restored all application tables and applied the exact 006 and 007 statements. Comparison of all 11 preexisting application tables preserved every original column value and rowid, including all 42 original winners.

On that local D1 copy, the normal admin API moved Kent to Bonus with 681 on the same ID, added Lyle with 838 in 2nd, and changed ticket 226's hometown to Galesville, WI while keeping Jim Wilber and the stored prize. The resulting public API had 43 winners and the three November 6 tickets 288, 838 and 681 in order. Two repeated corrected-photo replays left all winners unchanged. The down migration preserved every corrected winner row and ID after stripping only the new slot column. A code rollback with the expanded schema retained remains preferred.

Cloudflare D1 blocks its protected internal table access and the local integrity_check PRAGMA. Application table comparisons excluded protected platform internals, and export integrity was independently checked in SQLite before the D1 run.

After an approved deployment and successful production verification, delete temporary sensitive SQL, SQLite and restore-statement copies. Confirm any separately approved secure recovery backup before cleanup. Refresh the Time Travel bookmark immediately before migration. Restoring that bookmark later would roll back intervening site writes, so use it only under a reviewed recovery plan.

The initial Computer Use phone check was unavailable. Under the subsequent explicit authorization, isolated Playwright verified actual 375px and 390px viewports. Document and body scroll widths matched each viewport. Only the 960px winners table scrolls inside its wrapper. Bonus, tickets, prizes, hometowns, month refresh and admin edit/save passed at both widths with no browser script errors. The owner authorized the production release after these gates.

## Owner display correction during release

After viewing the live board, the owner requested 3rd in the Place column and removal of Bonus and its separator from the displayed prize. Winner-board formatting now renders the approved Bonus slot as 3rd and keeps only the clean prize description. The stored approved slot, ticket 681 and Kent's existing ID remain intact, so photo matching and duplicate protection continue to use the reviewed calendar identity. Regression expectations cover both the cleaned display and preservation of the internal category.
