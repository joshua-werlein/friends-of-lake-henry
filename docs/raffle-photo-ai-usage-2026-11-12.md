# Winner-photo Workers AI usage: investigation and fix (2026-11-12)

**Status: local branch `fix/photo-ai-usage` (on top of `6e8043f`), NOT pushed or deployed. The capped live check passed on 2026-11-13.** Production stays on Photo Worker `13311c6d`.

## What happened on November 12

| When (UTC) | What | Source |
|---|---|---|
| Nov 12 01:04–01:44 | 22 saved test calls (live check and probes of rendered Nov 13–30 tables) = **6,214 neurons** | saved raw responses with `usage` |
| Nov 12, other times | More test calls whose responses were not saved (6e8043f: allocation "used up by testing") | commit message |
| Nov 13 00:06–00:26 | Nov 12 post: 5 attempts, each refused with `4006` in ~0.1 s on its first read | `raffle_photo_auto_attempts` |
| Nov 13 ~01:56 (next attempt) | With the old code the 6th refusal parks the post as `failed` (`MAX_ATTEMPTS = 6`) | `failPost` |

The Nov 13 refusals came 6 minutes after the documented 00:00 UTC reset. The saved test calls don't explain that. **Unverified:** the hourly breakdown for 00:00–00:06 UTC Nov 13 needs the Workers AI dashboard (the local wrangler token has no analytics access). Only the Photo Worker binds AI in this repository. Other projects on the account weren't checked.

## Cost model (measured, not estimated)

Mistral Small 3.1 on Workers AI: **0.031876 neurons per input token, 0.050488 per output token**. These rates reproduce every recorded neuron count. Output is **109–119 tokens per transcribed cell** (one verbose read: 154). Input is about one token per 28×28 px plus ~1.2k prompt tokens.

## Root causes

1. **Every read transcribed the whole month.** The table is cumulative, so output grew every night: 27 cells on Nov 12, 73 on Nov 30. A whole-table read went from 210 to 398 neurons (509 enlarged), even though only the window's 3 dates can publish.
2. **Repeat processing repeated everything.** Production read the Nov 9 post 3 times and the Nov 11 and Nov 12 posts twice each, through admin requeues after code fixes. At temperature 0 an identical prompt on identical bytes returns an identical reply, so the repeats added no evidence.
3. **The unreleased 6e8043f made it worse.** It added enlargement (+40% input) and two focused reads on top of the two whole-table reads: about 684 neurons on Nov 13 and 1,324 on Nov 30.
4. **Quota refusals used up the retry budget.** A `4006` was treated as an ordinary failure, so 6 refusals in about 108 minutes parked the post until someone requeued it. Each requeue then repeated every read.
5. **Testing shared the production allocation with no daily budget.** The live check's default cap was 6,000 neurons per run, and several runs plus probes happened the evening before a drawing.

Not causes: the output-token limit (a cut-off reply fails to parse and is never paid for twice), warnings, and the 12-row bound.

## Changes

| Area | Change | Files |
|---|---|---|
| Primary reads | Two reads, row by row and column by column, of **only the window (3 dates) + 4 anchor dates** on the enlarged image. The anchors' stored winners keep proving date/column alignment (`columnConfirmed`, `redatedRows`). No whole-table or extra focused reads | `workers/facebook-photos/reads.ts`, `focus.ts` |
| Fallback | If neither window read finds any requested date (a table with no printed dates) or a reply can't be parsed, the two whole-table reads run **once**. A window read that merely holds a row never triggers it | `reads.ts` |
| Token bounds | Window reads `max_tokens` 6,144 (largest November window: 18 cells ≈ 2k). Whole-table fallback keeps 16,384 | `reads.ts` |
| Checkpoint and reuse | Each completed read is stored on the import row, keyed by image SHA-256, enlargement and a hash of the model, width and prompt templates. Retries and requeues reuse matching reads, so a quota refusal on pass 2 only re-buys pass 2, and an admin requeue after a calendar fix costs 0 AI calls. Decided photos are never reopened by this. A prompt change invalidates reuse automatically | `reads.ts`, `index.ts` |
| Quota | `4006` → `QuotaExhausted`. The run stops at once (no further reads, no other posts this tick). The attempt is given back and the post retries **hourly and at 00:05 UTC**, for up to 30 hours, then `failed` (alerted). The alert says it's the allocation and that retries continue | `reads.ts`, `index.ts`, `raffle-photo-autopublish.ts` (`failPost`, `nextQuotaAttempt`), `alerts.ts` |
| Diagnostics | Each pass records kind, dates, rows, prompt/completion tokens and estimated neurons. Each photo records `aiCalls`, `reused`, `fallback`, `estNeurons`. Worker log event `photo-ai-usage` | `reads.ts`, `index.ts` |
| Live check | Runs the Worker's actual window reads, default 2 nights and a 1,500-neuron cap (checked before each call), and the instruction to run only after a drawing | `tests/live/extraction-check.test.mjs` |

Unchanged: two-pass agreement, cell-text consistency, calendar prize matching, column confirmation, misdated-winner detection, bonus label dating, conditional inserts, slot uniqueness, leading-zero ticket labels, the completeness alert for unread approved prizes, and the removed-winner guard.

## Before and after (neurons per drawing night, from measured rates)

| Night | Deployed `13311c6d` (2 whole-table reads, 961 px) | `6e8043f` (not deployed) | This branch (2 window reads, enlarged) |
|---|---|---|---|
| Nov 12–13 (27–30 cells) | ~420 | ~684 | **~330** |
| Nov 22 (53 cells) | ~668 | ~1,000 | **~370** |
| Nov 30 (73 cells) | ~796 | ~1,324 | **~415** |
| Bonus-drawing night | same, rising with the table | same | **+~11** (one more cell per read) |
| Requeue of the same photo | full cost again | full cost again | **0** |
| Quota refusal | burns 1 of 6 attempts | same | 0 attempts; ~0 neurons (refused in 0.1 s: inferred, not billed-verified) |
| Rare whole-table fallback | — | — | +~460–1,020 once |

The rest of November (Nov 13–30, 18 nights) comes to about **6,800 neurons with this branch**, about 11,000 with the deployed Worker, and about 18,000 with 6e8043f, assuming one processing per night. A single night stays well under 10% of the daily allocation.

## Validation

- `npm test`: **190 pass, 0 fail** on this branch. On `main` with these commits cherry-picked: **195 pass**, including main's season tests. New tests: the window-read Nov 12–30 suite and live-read replay (`tests/raffle-window-reads.test.mjs`), checkpoint/reuse/quota (`tests/photo-autopublish.test.mjs`), and the revised real-Worker replay (`tests/raffle-november-6.test.mjs`: requeue re-decides with 0 AI calls). The four tests that only exercised the removed focused-read merge were deleted; their remaining cases are ported.
- Covered: normal two-winner nights; three-winner bonus nights; sparse and late bonus columns; a Firearm column read a row late (held through the anchors); misdated cells; label bleed; clipped and missing-heading images (rejected); missing and disputed cells (held one by one); no stored anchors (dated columns held); a late photo spanning the window; repeated posts (no duplicates; month ends with unique IDs and slots, history unchanged); window size and token bound through Nov 30; quota refusal and recovery; prompt-version invalidation.
- Real reads: the real Nov 9, 10 and 11 production reads, restricted to the window and anchor rows, give exactly the same inserts as before. Rendered Nov 12, 20 and 30 real reads, restricted the same way, publish exactly tonight's winners. Real focused reads of Nov 28 and 30 publish nothing wrong.
- All four TypeScript projects, Astro build, both Worker builds, `check-deployment.mjs` and `wrangler deploy --dry-run` pass.

## Live check (approved, 2026-11-13 01:22–01:24 UTC)

One run of `tests/live/extraction-check.test.mjs`, `NIGHTS=13,30 NEURON_CAP=1500`.
- **Isolation:** the test's only network call is Workers AI inference (`/ai/run`). Its D1 is in-memory Miniflare (`d1Persist: false`), the tables are rendered locally, and output goes to a scratch directory. No production D1, KV, R2, winner or queue state can be touched.
- **Cap:** checked before every call against that call's worst case (4,000 prompt + 6,144 output tokens = 437.7 neurons), so the run can't exceed 1,500. Billing comes from each response's own usage, and a response without usage stops the run.
- **Quota:** a `4006` stops at once without retry (dry-run verified with a stubbed `fetch`).
- **Allocation:** production had still been refused at 00:56:50 UTC. The first live call served as the allocation check and succeeded.
- **Tables:** PIL-rendered, then resized to 1540 px. That's representative, but not the Images binding's own output.

| Night | Read | Input tokens | Output tokens | Neurons | Time | Cells copied exactly | Window | Bonus | Field errors | Warnings |
|---|---|---|---|---|---|---|---|---|---|---|
| Nov 13 (1540×495) | row-wise | 1,976 | 1,857 | 156.7 | 45 s | 17/17 | 7/7 | 3/3 | 0 | 0 |
| | column-wise | 1,974 | 1,857 | 156.7 | 36 s | 17/17 | 7/7 | 3/3 | 0 | 0 |
| Nov 30 (1540×1095) | row-wise | 3,214 | 1,928 | 199.8 | 33 s | 18/18 | 8/8 | 4/4 | 0 | 0 |
| | column-wise | 3,212 | 1,928 | 199.7 | 36 s | 18/18 | 8/8 | 4/4 | 0 | 0 |

- **Totals:** 4 calls, **712.9 neurons**, 0 fallback calls (none would have been triggered), 0 parse errors, 0 failures.
- **Accuracy:** "Cells" counts every printed cell on the 7 requested rows, anchors included. Every date, ticket, name, hometown and bonus label was exact, and no extra rows were returned.
- **Decisions:** Nov 13 published 3/3 (Firearm, Gift Card, Panfish Rod bonus). Nov 30 published 2/2. **No false publications and no missing winners.**
- **Per night:** 313 neurons (Nov 13) and 400 (Nov 30), consistent with the estimates (~330, ~415).
- **Independence:** the two prompts returned byte-identical rows on both nights. Their agreement therefore proves little on its own; see risk 1.
- **Not run:** a real Nov 12 photo check. The Chrome extension isn't connected, and there's no other authorized route to the image (the importer never stored it).
- **Replay:** both reads are kept as `tests/fixtures/simulated-table-2026-11-{13,30}.window-live.json` and replayed in `npm test`.

## Which parts of `6e8043f` are still needed

| Part of `6e8043f` | Verdict |
|---|---|
| Images-binding enlargement to 1540 px (`readableImage`, `IMAGES` binding, preflight) | **Keep.** The live window reads ran at 1540 px. Real 961 px window reads missed 2 of 8 cells (Nov 30 pass 0). Cost: about +37 neurons per read on Nov 30 |
| `focus.ts` date-only prompt | **Keep.** It is now the primary prompt |
| Two extra focused reads after the whole-table reads (`focusedPasses`) | **Replaced.** Removed in `e8a35f8` |
| Merge of whole-table and focused reads (`withFocus`, `Merged` warning routing, `decidePhoto` `focused` option) | **Unreachable.** Removed in `857e718` (the pre-6e8043f warning classifier is restored) |
| Printed-name check (`name differs from the name printed in the cell`) | **Keep.** Applies to every read |
| Lease renewal per read, 600 s lease | **Keep.** The whole-table fallback can take ~108 s per read |
| CPU memoisation in the decision | **Keep.** Harmless, and needed for a whole-table fallback decision |
| `render_tables.py`, `november-table.mjs`, live check, Nov 28/30 fixtures | **Keep** (tests; the Nov 28/30 focused reads are used by the window-read tests) |
| `docs/raffle-photo-two-stage-2026-11-12.md` | Marked superseded |

`6e8043f` is still needed as a base: it carries the enlargement, prompt, lease and memoisation. Its focused-read stage is fully undone by `e8a35f8` and `857e718`, so it can't run.

## Remaining risks

1. **Shared misreads.** The two reads are byte-identical in practice, so a cell both read identically wrong (for example a wrong name with matching cell text) publishes. Only stored-winner, slot, calendar and duplicate checks catch it. The same was true of the deployed two whole-table reads. Setting `FB_PHOTO_EXTRACTION_PASSES=3` does not help: pass 3 repeats pass 1's prompt. **Option for review:** read pass 2 from the original 961 px image (cheaper input, an independent rendering). The trade-off is that a 961 px read missed window cells once, which holds them rather than publishing them.
2. **Real Images-binding output is untested with the new prompt.** The live check used PIL resizing. 6e8043f verified the binding once on this account (Cloudflare Images free-plan transformation limits apply). A failure reads the original image.
3. A cell from an unrequested row that both reads move into the window identically is caught only by the slot, duplicate and repeat-winner checks. A stray row from an unrequested date can also hold a column whose stored winner won again (tested: held, never wrong).
4. The Nov 13 00:06–00:56 UTC refusals remain unexplained without dashboard data. Calls succeeded again by 01:22 UTC, which fits a rolling 24-hour window better than a 00:00 UTC reset.
5. The Nov 12 post is parked `failed` in production. Its winners were entered manually. Don't requeue it: it has no stored reads, so a requeue would make two AI reads only to record duplicates.

## Integration sequence (not done; each step needs approval)

**A. Production Photo Worker (pre-009 lineage, as today):**
1. Review `fix/photo-ai-usage`: `6e8043f`, `e8a35f8`, `3fe4d3b`, `857e718`, `ad718a9` and this doc commit, on top of `6c65cec`.
2. Deploy from the `../folh-ai-usage` worktree, outside 5:45–6:45 PM Central: `npx wrangler deploy --config workers/facebook-photos/wrangler.json`. This adds the `IMAGES` binding; the flags are unchanged. Record the new version ID. Rollback is version `13311c6d`, or the same command from `../folh-hotfix`.
3. Requeue nothing. Watch the Nov 13 post (about 00:05 UTC on Nov 14): the `photo-ai-usage` log event, the pass usage in `raffle_photo_auto_attempts`, and the public table.

**B. `main` (after A is verified):**
4. Don't merge `hotfix/photo-nov11-column-association`. Its `b0ce99b`, `363e81d` and `6c65cec` duplicate main's `f460ba9` and `d7b15a7`.
5. On a branch from `main`: `git cherry-pick 6e8043f e8a35f8 3fe4d3b 857e718 ad718a9 <doc commit>`. Resolve the one `package.json` conflict by keeping main's test list (with `future-season.test.mjs`) and adding `tests/raffle-window-reads.test.mjs`. This was done locally as `integrate/photo-ai-usage-main` in `../folh-main-integration`: 195/195 tests, typechecks, build and preflight pass. It is not pushed.
6. Push and open a PR. `[CF-Pages-Skip]` keeps Pages unchanged. Build the Photo Worker from main only after migration 009 is applied in production.
