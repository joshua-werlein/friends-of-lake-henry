# Winner-photo Workers AI usage: investigation and fix (2026-11-12)

**Status: local branch `fix/photo-ai-usage` (on top of `6e8043f`), NOT pushed or deployed.** Production stays on Photo Worker `13311c6d`.

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

- `npm test`: **192 pass, 0 fail**. That's the 186 before plus new tests: the window-read Nov 12–30 suite (`tests/raffle-window-reads.test.mjs`), checkpoint/reuse/quota (`tests/photo-autopublish.test.mjs`), and the revised real-Worker replay (`tests/raffle-november-6.test.mjs`: requeue re-decides with 0 AI calls).
- Covered: normal two-winner nights; three-winner bonus nights; sparse and late bonus columns; a Firearm column read a row late (held through the anchors); misdated cells; label bleed; clipped and missing-heading images (rejected); missing and disputed cells (held one by one); no stored anchors (dated columns held); a late photo spanning the window; repeated posts (no duplicates; month ends with unique IDs and slots, history unchanged); window size and token bound through Nov 30; quota refusal and recovery; prompt-version invalidation.
- Real reads: the real Nov 9, 10 and 11 production reads, restricted to the window and anchor rows, give exactly the same inserts as before. Rendered Nov 12, 20 and 30 real reads, restricted the same way, publish exactly tonight's winners. Real focused reads of Nov 28 and 30 publish nothing wrong.
- All four TypeScript projects, Astro build, both Worker builds, `check-deployment.mjs` and `wrangler deploy --dry-run` pass. No AI calls were made.

## Remaining risks

1. **No live read of the new prompt with 7 dates yet.** The window prompt was measured live only with 3 dates (Nov 13/22/28/30 at 961 px, plus the 1540 px whole-table reads). Restricting real whole-table reads approximates a 7-date read but isn't one. The two-night live check (~800 neurons) is the justified paid test before deploying.
2. **Enlargement uses the Images binding** (Cloudflare Images transformations; free-plan monthly limit applies). It was verified once on this account by 6e8043f. A failure reads the original image.
3. A cell from an unrequested older row that the model moves into the window in both reads, identically, is caught only by the slot, duplicate and repeat-winner checks, not by `redatedRows`, which needs the stored date to be among the read dates.
4. The Nov 13 00:06 UTC refusals remain unexplained without dashboard data.
5. Main has migration-009 code (`f6c73a4`). This branch is based on the pre-009 lineage that production runs. Cherry-picking `6e8043f` alone onto `main` is conflict-free. With this commit, the only conflict is the `package.json` test-script line, where main also lists `future-season.test.mjs` (checked with `git merge-tree`). Main's tests and 009 must pass before the Worker is built from main.

## Deployment requirements (not done)

1. Owner review of this branch.
2. After a drawing has been processed (after ~00:30 UTC): `NIGHTS=13,30 NEURON_CAP=1500` live check. Require 0 false publications and tonight's bonus cells published.
3. Deploy the Photo Worker from this branch, which adds the `IMAGES` binding: `npx wrangler deploy --config workers/facebook-photos/wrangler.json`. Do it outside 5:45–6:45 PM Central. Don't requeue anything.
4. Watch the next post's `photo-ai-usage` log event and `raffle_photo_auto_attempts` usage.
5. Later, port `6e8043f` and this commit to `main`.
