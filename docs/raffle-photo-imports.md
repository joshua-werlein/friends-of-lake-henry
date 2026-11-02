# Facebook raffle winner-photo imports

Implementation branch: `codex/facebook-live-worker`. This feature is **not deployed or enabled**. The production website and Live-only Worker keep tonight's manual video/winner controls. Production D1 was queried with SELECT only during validation; no production records, resource bindings, images, DNS or secrets were changed.

## Data flow and boundaries

1. An authenticated administrator opens `/admin/raffle/imports`, chooses the source raffle month and either scans current tagged Page posts or supplies a historical photo/post URL.
2. Pages calls the private `PhotoImports` RPC entrypoint on the existing discovery Worker. The default Worker HTTP handler remains 404 and no public URL or photo Cron is added. The Page token stays in the Worker's existing encrypted `FB_PAGE_ACCESS_TOKEN` secret.
3. VIDEO and PHOTO reuse `graphReader` and the same bounded `readPagePosts` implementation. The photo scan accepts only Page photo attachments, albums and nested subattachments with numeric photo IDs and the standalone `#LakeHenryRaffle` tag. The scan itself never labels a photo as a winner or calls OCR. This is an administrator-triggered operation, not another scheduled scanner.
4. An explicit historical source bypasses the hashtag only for that admin request. Numeric photo IDs, full Facebook `photo/?fbid=`, `photo.php?fbid=`, numeric photo paths, numeric Page-post paths and `permalink.php` URLs are accepted. Short/share/pfbid links, Groups, arbitrary hosts and URL credentials are rejected rather than followed. For a direct photo selection, confirm its Page/source identity in the preview; a direct photo's metadata does not by itself prove Page ownership. Post lookups enforce the configured Graph Page ID.
5. Photo resolution uses `GET /v26.0/{photo-id}?fields=id,images,link`. The owner verified this exact request for `122279759156073310`, returning eight variants and an 831 × 1554 largest image. The adapter sorts by pixel area rather than assuming array order. It downloads the largest image immediately, refreshes Graph metadata once if the signed image URL returns 403/404, and never stores or logs the temporary URL. Only HTTPS `*.fbcdn.net`, no redirects/credentials/ports, JPEG/PNG/WebP signatures and content types, bounded dimensions and an 8 MiB response are accepted. The Page token is never forwarded to the CDN or AI model.
6. Workers AI receives the image bytes as a base64 data image and a constrained transcription prompt for daily announcements and monthly tables, maximum 100 rows. Missing fields remain empty; missing positions are null. Output is untrusted JSON: strict structural limits, no tools/actions, and all rows require review. Non-winner photos return no rows. A truncated/malformed model response fails extraction rather than silently publishing a partial table.
7. Pages retains the downloaded original under the private `raffle-imports/{draft-id}/{sha256}` prefix through a private Pages `IMPORT_IMAGES` R2 binding. The binding must point to a bucket with public access disabled; a prefix alone is not an access boundary. It is not inserted into the public gallery's `photos` table. Only the existing authenticated/CSRF-protected admin routes serve its no-store image response. Review continues to work after Facebook's signed URL expires.
8. Staging saves raw extraction, warnings, editable rows, original image hash/dimensions and source identity. It never inserts winners. Administrators can correct/remove/add transcription rows, save a draft, reject the photo, or explicitly select reviewed rows and confirm approval. Approval finalizes that photo; unchecked rows remain unpublished and can be entered through the existing manual controls. This is explicitly stated before approval.

## Comparison and publication rules

The review shows four statuses:

| Status | Meaning | Publication |
| --- | --- | --- |
| Complete / duplicate | Four stored core fields match | Disabled; never insert again |
| Incomplete | An existing identity matches and one or more stored fields are blank | Only approved blank-field fills |
| Missing / new candidate | No existing identity matches | Approved valid new row only |
| Conflicting | Different populated values, uncertain identity or multiple possible matches | Disabled; correct the extraction/review existing data |

Match candidates use draw date, positive ticket number and normalized name. Hometown participates in exact comparison, not fuzzy identity substitution. Case/whitespace normalization does not silently fix spellings. An uncertain date with a unique matching ticket can still be recognized as an existing identity and flagged as conflicting; it is not treated as a new winner. Repeated tickets across different dates remain valid; ambiguous matches fail closed.

The historical table supplies no prizes. Every fixture row's position is null, and no 2025 prize is filled. For future announcement photos, positions are accepted only as explicit reviewed values; unknown stays null. Existing populated values and existing prizes are preserved even when filling a genuinely blank field.

Photo ID uniqueness prevents repeat extraction of a previously staged/approved/rejected photo, including the same photo shared in several posts. Winner date/ticket uniqueness, normalized field fingerprints and import audit rows prevent duplicate publication. Failed extractions have at most three explicit attempts; new imports are limited to twelve per ten minutes. There are no automatic retries or publications.

Approval uses a single four-statement D1 transaction (not one query per winner), so a full monthly table is supported. It claims the exact pending draft version, inserts new winners or fills only blank fields, and writes immutable publication audit rows. The additive audit trigger validates the final winner values and approval nonce. A duplicate, concurrent change, stale draft or mismatch rolls back the whole transaction. Existing winners are never replaced, deleted or updated with different populated values. Rejected/approved imports cannot be approved again.

## November 2025 audit and OCR regression

Read-only audit target: existing account `aa86268490e681cccb3a41a62093e2aa`, D1 `folh-db`, ID `527df871-e876-4924-81d0-5d0572b4dd7b`.

- All 30 November 2025 records have dates, positive ticket numbers, names and hometowns. All 30 prizes are null, as expected. No data needs prize enrichment from this image.
- The supplied original PNG is a regression fixture under `tests/fixtures`, never a public website asset. It contains publicly posted winner information provided by the user. The fixtures contain no Page token, Graph errors, signed URLs or private account data.
- The separately labeled public API snapshot is the existing D1 comparison baseline. The human-checked reference is not represented as model output.
- **Actual local Windows.Media.Ocr baseline**, not Cloudflare: 30 row identities recognized; ticket numbers 30/30, dates 27/30, names 28/30, hometowns 30/30 versus the source reference. This is 115/120 core fields (95.8%) and 26/30 fully matching source rows, with no guessed corrections.
- Three OCR date separators were ambiguous (`1113/25`, `1118/25`, `1119/25`). Two boundary names were clipped (`John & Rita Halam-`, `Mary & Scott Marti`). These are retained as review issues/conflicts.
- Against D1, the raw OCR baseline yields 25 complete/duplicates, five conflicts and zero new candidates. All 30 map to existing identities, so it creates no duplicate candidates.
- The source image spells **Gallesville**, while the correct stored November 1 hometown is **Galesville**. The human-checked source reference yields 29 complete/duplicates plus that one conflict. The import does not "correct" the historical database to match the image typo.
- Explicit tests assert November 1 ticket 66/Kurt Thesing/source town Gallesville, November 15 ticket 529/Scott Tiepleman/Blair and November 30 ticket 75/Al Chikowski/Berlin. All positions remain null.

**Cloudflare model accuracy, measured 2026-11-02.** The default model is now `@cf/mistralai/mistral-small-3.1-24b-instruct` (Apache-2.0, no click-through gate on Workers AI). A real Workers AI run through the importer's own `winnerPrompt`/`visionRequest`/`parseExtraction` on the supplied November 2025 PNG transcribed **120/120 core fields (30/30 rows)**, all positions null, warning "Possible truncation at the bottom of the image". Against the existing D1 baseline: **29 complete/duplicate, 1 conflicting (the image's "Gallesville"), 0 new**. Cost 126 neurons (about $0.0014). Workers AI returns this model's JSON already parsed; `parseExtraction` accepts an object or a string under the same size and validation rules.

Llama 3.2 Vision remains supported (`LLAMA_VISION_MODEL`, prompt+image request shape), but this account has **not** accepted Meta's license: a probe on 2026-11-02 returned `5016: Prior to using this model, you must submit the prompt 'agree'`. Only the account owner may accept, per Cloudflare's model page, with a one-time REST request whose body is `{"prompt":"agree"}`. That isn't needed while Mistral is the default.

## Cloudflare requirements (prepared, not applied)

Worker model: `@cf/mistralai/mistral-small-3.1-24b-instruct` (`PHOTO_MODEL`). `FB_VISION_MODEL_LICENSE_ACCEPTED` is the operator's confirmation of the selected model's terms (Apache-2.0 for Mistral). For Llama 3.2 Vision it also requires the owner's Meta license acceptance. The code never sends an automatic `prompt: "agree"` request.

Worker opt-in template: `workers/facebook-live/wrangler.photos.existing-account.json`:

```json
{
  "main": "photos-entry.ts",
  "ai": { "binding": "AI" },
  "vars": {
    "FB_PHOTO_IMPORT_ENABLED": "false",
    "FB_VISION_MODEL_LICENSE_ACCEPTED": "false"
  }
}
```

**Never deploy this stand-alone profile to the production Worker:** it shares the Worker name `folh-facebook-live-discovery` with an empty Cron and disabled automation, so it would stop livestream polling. Use `wrangler.live-photos.existing-account.json` (combined entry `live-photos-entry.ts`, preflight `check-live-photos-deployment.mjs`), which keeps the approved five-minute Cron and video flags. The full file pins the existing account/CONFIG and keeps Live polling, video probes, Cron, public routes and previews disabled. It is separate from the deployed Live-only configuration. The new `check-photo-deployment.mjs` explicitly validates this profile while reusing all account/isolation checks; it rejects enabled imports, Cron, public URLs, wrong AI binding and unexpected resources. Do not use it to bypass real API or license verification.

After review, Pages needs a private service binding in its authoritative configuration, alongside its unchanged existing D1/R2/KV bindings:

```json
{
  "services": [{
    "binding": "FACEBOOK_PHOTOS",
    "service": "folh-facebook-live-discovery",
    "entrypoint": "PhotoImports"
  }],
  "r2_buckets": [{ "binding": "IMPORT_IMAGES", "bucket_name": "VERIFIED_PRIVATE_BUCKET" }],
  "vars": { "RAFFLE_PHOTO_IMPORT_ENABLED": "false" }
}
```

Use [Cloudflare RPC service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/); both sides already target compatibility dates after RPC support. Only the private entrypoint receives photo operations. The Worker gains no D1/R2/session access; Pages keeps the publication/storage boundary. No new Facebook token or Cloudflare plaintext token is needed in Pages.

The RPC entry is checked in the isolated Worker TypeScript project; the root web TypeScript project excludes that single entry file to avoid Cloudflare global `Element` types colliding with browser DOM types. Both checks are required.

Database requirement: apply only the new additive `migrations/002_raffle_photo_imports.sql` after review/backup. It creates import staging/audit tables and their audit trigger. It does not alter, clear, rebuild or prepopulate `raffle_winners`. Do not run broad migration commands against production without first reconciling its existing migration history. This migration was tested only in disposable local databases.

Storage requirement: add the separate Pages `IMPORT_IMAGES` alias. It may point to the existing photo bucket ONLY if its public r2.dev/custom-domain access is verified disabled. Otherwise the owner must provision a separate private bucket. Do not change the existing gallery `PHOTOS_BUCKET` binding. Never assume a key prefix makes a public bucket private. Retain originals and audit records according to an owner-approved retention policy. No cleanup/deletion job is enabled. Verify public gallery endpoints cannot serve private import keys before activation (they resolve approved gallery rows, not arbitrary R2 keys).

## Activation and rollback after tonight's drawing

1. Review the code/fixtures, run all checks, and have the owner verify account, namespace and bucket ownership. Keep all flags false. No deployment or production migration is implied by this document.
2. Apply the additive import migration after backup and explicit deployment approval. Deploy the private RPC Worker with AI binding and the Pages service binding while imports remain disabled. Preserve the existing encrypted Page secret; never export it into config or logs.
3. Owner confirms applicable AI model terms and access. Enable the photo Worker flag/license gate for a controlled test, independently of all Live flags. Enable the Pages photo-review flag. Do not add Cron. Import only the known historical source and select month `2025-11`.
4. Measure actual Workers AI output against the supplied image reference and existing records. Confirm full-resolution retained original, all 30 identities, review statuses, empty prize positions, signed-URL handling and no new winner rows. Test a real daily announcement too. Capture sanitized output only.
5. After accuracy review, operators can explicitly approve new future winners. Continue manual entry whenever image quality or provider access is inadequate. AI output alone can never authorize publication.
6. Roll back by disabling the Pages and photo Worker flags. Leave the additive tables/images and existing winners intact; the manual workflow is independent. Reverting the application code does not require deleting any data.

## Account migration handoff

This supplements the feature design; it does not modify the separate migration runbook. Before cutover, disable old photo importing and any separately approved old Live Cron. Copy both import tables (including audit/fingerprints) with the existing D1 migration, and copy the private `raffle-imports/` image prefix along with the bucket. Rebind Pages' private service to the new-account Worker and existing new-account D1/R2/KV resources. Re-enter the encrypted Page secret securely; verify AI model access/terms for the new account. Use `wrangler.photos.json` for the new account, set its verified account/CONFIG IDs and run `check-photo-deployment.mjs new-account` with `FB_TARGET_ACCOUNT_ID`; the unchanged placeholder template deliberately fails until ownership is configured. Keep flags and Cron off until the original image, draft comparisons, duplicate checks and manual workflow are validated. Never run old/new authoritative importers concurrently.

## Estimated inference costs

Published model rates at implementation time are $0.0485 per million input tokens and $0.676 per million output tokens ([model pricing](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/)). Assuming 1–10k input tokens and 1–8k output tokens gives roughly **$0.001–$0.006 per image**, or $0.03–$0.18 for thirty images, before free allowances and small D1/R2/storage charges. This is a token-based estimate, not a measured bill; image tokenization and dense table output vary. Maximum output is 8192 tokens. No paid model result was obtained during this validation.

## Checks

```powershell
npm test
npm run typecheck
npm run typecheck:facebook-worker
npm run build:facebook-worker
npm run build:facebook-photos
npm run build
$env:FB_TARGET_ACCOUNT_ID = 'aa86268490e681cccb3a41a62093e2aa'
node workers/facebook-live/check-photo-deployment.mjs
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config workers/facebook-live/wrangler.photos.existing-account.json
git diff --check
```

Dry-run uploads nothing. All tests use injected Graph/AI responses and disposable local D1/R2; the workerd RPC test confirms disabled private calls fail closed and default public HTTP stays 404. Production checks are read-only.


Final local validation: **67 tests passed** on Node 20.19.6, root and isolated Worker TypeScript passed, both Worker bundles and the Astro 5 production build passed, and the disabled photo-profile Wrangler dry run passed. A Windows build-file lock was resolved by stopping the local Pages preview before rebuilding. Desktop and 390-pixel browser checks displayed the retained 831 × 1554 original and all 30 rows. Correcting OCR ambiguities in the local draft produced 30 complete/duplicates, zero new candidates and 30 blank positions. Saving corrections left local historical winners at 30 and assigned prizes at zero. No production winner changes occurred.
