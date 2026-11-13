# Winner-photo bonus cells: two-stage extraction (2026-11-12)

> **Superseded by `docs/raffle-photo-ai-usage-2026-11-12.md` (branch `fix/photo-ai-usage`).** The resolution findings and image enlargement
> below still apply. The extra focused reads (stage B) and their merge with whole-table reads were replaced by two window+anchor reads
> and removed. Keep this page for its measurements only.

**Status: committed on `hotfix/photo-nov11-column-association`, NOT deployed.** Production stays on Photo Worker
`13311c6d` (rollback `c3f121f6`). Deploy only after the live check below passes.

## Why bonus cells went missing

Measured with real Workers AI calls (Mistral Small 3.1, production prompts) on rendered cumulative tables; expected cells were
recorded before each call.

| Table | Whole-table read, original ~961 px | Same, enlarged to 1540 px | Focused window read, 961 px |
|---|---|---|---|
| Nov 22 (53 cells) | 48/53 cells, bonus 5/9 | 51/53, bonus 8/9 | window 9/9 both passes |
| Nov 28 (68 cells) | 54/68, bonus **0/12** | 65/68, bonus 11/12 | window 9/9, bonus 3/3 both passes |
| Nov 30 (73 cells) | 56/73, bonus **0/13** | 70/73, bonus 12/13 | pass 0: 6/8 (bonus 0/2), pass 1: 8/8 |

* **Resolution, not parsing.** The model encodes the image at its own size (~1 token per 28 x 28 px; prompt tokens grow with
  image height, so there is no downscaling). With 22 px rows a row of small text gets under one token of height; the sparse
  bonus column is dropped first. Bonus names were absent from the raw responses: the parser drops nothing.
* Not the 12-row limit (it counts only rows that could publish) and not the output-token limit (fixed in `13311c6d`:
  16,384 tokens; a 9k-token read was cut off at 8,192 before).
* At 961 px both passes read the same wrong name for one stored winner, so low-resolution errors are correlated across passes.

## What changed (Photo Worker only, production schema)

1. **Enlarge before reading** (`workers/facebook-photos/reads.ts`): the Cloudflare Images binding resizes the photo to 1540 px
   wide (aspect kept, never reduced), outside the Worker's CPU budget. Any failure reads the original. Verified on this account
   through a temporary `wrangler dev --remote` preview: 961x683 -> 1540x1094 JPEG in 0.84 s. Adds `images` to `wrangler.json`
   and the preflight.
2. **Stage A**: the announcement window's dates come from the post date; the approved calendar says which prizes to expect
   (existing completeness check alerts on any expected prize no cell accounts for).
3. **Stage B** (`workers/facebook-photos/focus.ts`): for a cumulative table, two focused reads ask only for the window rows,
   read across to the far right edge. They are told dates, never winners or prizes. Pass k's window rows = focused read k plus
   any cell only whole-table read k saw. The same printed cell parsed differently by the two prompts is flagged and held. All
   existing checks apply unchanged: two-pass agreement, cell-text consistency, calendar prize matching, stored-winner column
   confirmation, duplicate guards. A failed focused read falls back to the whole-table reads (no full retry).
4. **Stricter name check**: the name must equal the printed text between the dash and the first comma; a real focused read
   copied "442 - Winner 28G, Taylor, WI" but returned name "Winner".
5. **Lease renewal**: every AI read first renews this run's lease (fenced by attempt number); if another run took the post, this
   run stops. No lease outlives its invocation.
6. **CPU**: the decision step cost ~12.7 ms on a 73-cell table (Workers Free allows ~10 ms per invocation). Memoising prize
   lookups, string folding and date checks brings it to ~2.8 ms. This also affects the deployed `13311c6d` from about Nov 25.

## Workers AI allocation (Workers Free)

10,000 neurons per day, reset 00:00 UTC (6:00 PM Central), shared by production and testing. A production night costs ~900
(two reads) and ~1,500 with stage B. Testing on Nov 11 used the Nov 12 UTC allocation; a post before 6 PM Central on Nov 12
retries after the reset (AI quota errors are transient). A full live sweep of Nov 12-30 (~28,000 neurons) needs several days.

## Live check before deploying (after a drawing has been processed)

```
CF_TOKEN=<wrangler oauth token> LIVE_OUT=<empty dir> NIGHTS=13,22,28,30 NEURON_CAP=6000 \
  node --import ./tests/register.mjs --test tests/live/extraction-check.test.mjs
```

It renders realistic tables (names without digits), runs 2 whole-table + 2 focused reads per night on the 1540 px image and
reports per night: window cells and bonus cells extracted per read, wrong dates, tonight's winners published, false
publications (must be 0), whether an alert fires, read durations and neurons. Deploy only if false publications are 0 and
tonight's bonus cells publish; then requeue nothing, watch the next real post.
