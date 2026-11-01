> November 1 Worker update: a separate disabled Graph v26.0 discovery Worker is
> implemented in [workers/facebook-live](../workers/facebook-live/README.md).
> That document is authoritative for current Page IDs, FB_PAGE_ACCESS_TOKEN,
> experimental metadata limits, verification gates and activation steps. Historical
> notes below describe the earlier scaffold; they do not imply current API proof.
> Public production selection remains manual. Cron and API polling remain disabled; see the Worker deployment record for initial deployment status.

> November 1 launch update: public refresh and daily prize display are now implemented.
> The Page ID and replay playback were verified in-browser, and Meta's embedded
> video documentation was readable there. Earlier 429/unverified notes below describe
> the prior investigation. Automation itself remains disabled and unverified against
> a Page token. See [launch validation and runbook](raffle-launch-2026-11.md).

# Facebook Live preparation — November 2026

Prepared locally October 29, 2026. Page: `61552199315213`.

## Decision and current status

**Automatic discovery is unverified and disabled.** Meta developer reference pages
repeatedly returned HTTP 429 or inaccessible responses during research; searches
did not provide usable official reference text. This is a research/access blocker,
**not evidence that Meta has discontinued all supported discovery**. Page access
has also not been granted. No Graph client or webhook was built on an assumed API.

The public site still uses the manual video in `CONFIG.raffle_live`; clearing it
shows the Facebook fallback. Winners remain manual. No deployment, push, production
data change, secret upload, Cloudflare resource change or Cron activation occurred.

## Architecture and audit findings

The repository inventory includes pages/admin routes/APIs, middleware, shared
components, public assets, migrations, deployment configuration and existing docs.
There were no existing tests or test/typecheck scripts.

| Component | Existing behavior and reuse |
| --- | --- |
| Astro | Installed 5.16.6, Cloudflare adapter 12.6.12, server output; framework versions unchanged |
| Public raffle | SSR reads CONFIG and embeds the video with Facebook plugins and a direct fallback; `/api/raffle/month` supplies monthly navigation |
| Admin raffle | Manual video, monthly titles, daily winners and poster upload; middleware protects admin routes |
| KV | CONFIG stores `raffle_live` as `{latestVideoUrl, updatedAt}`; SESSION stores admin sessions/throttles |
| D1 | `raffle_winners` holds history; `raffle_months` holds titles, rules and poster references |
| R2 | PHOTOS_BUCKET holds posters and other site images |
| Middleware | Server-side admin sessions and same-origin Origin/Referer validation for mutations; admin no-store headers |
| Scheduling | No preexisting scheduled Worker or Cron configuration |
| Configuration | Tracked `wrangler.json` targets Pages; ignored local TOML names different development D1/R2 resources but shares the KV IDs. Select configuration explicitly before future Cloudflare work |
| Migrations | Poster columns live in nested `migrations/migrations/00x_raffle_poster.sql`; base schema lacks them. Migration 002 assumes donor columns missing from 001. Do not blindly apply the chain |
| Historical SQL | An ignored backup is not evidence of current production data or poster content |

The public hero selects a current/upcoming poster, falling back to the latest
poster. Winner history uses separate month navigation. Existing admin controls
support `2026-11`; no title, poster, winner or production configuration was invented
or seeded. An administrator must verify the actual November title/poster before launch.

## Local implementation

- `src/lib/facebook.ts`: typed legacy configuration, strict URL normalization,
  safe config parsing, Page constants and shared embed URL construction.
- Public raffle and admin API reuse this module. `raffle_live` retains its existing
  key and fields. Duplicate manual saves skip writes.
- Full videos, `watch?v=...`, reels, mobile URLs and locally decoded Facebook link
  wrappers are accepted. Tracking is stripped; foreign hosts, URL credentials,
  ports, unsafe schemes and malformed paths are rejected.
- Removed outbound `fb.watch` redirect fetching. Admins must open short/share
  links themselves and copy the full video URL. This avoids scraping and arbitrary
  redirect destinations in the server URL handler. Existing stored canonical URLs work.
- Clearing a title now updates only title/timestamp. Poster key/alt, rules,
  creation time and winners survive. Clearing a nonexistent title creates no row.
- `src/lib/server/facebook-automation.ts` supplies a disabled-by-default polling
  policy with an injected source. Its Broadcast type is an **application contract,
  not a claimed Meta JSON schema**. It validates Page, video identity, timestamp,
  live/replay state and explicit raffle classification, then picks the newest
  eligible drawing without duplicate writes or regression to older drawings.
- Empty/malformed data, unavailable videos, expired-token/rate-limited provider
  results, thrown API errors and storage failures preserve the last staged value.
  No raw error, URL containing credentials, or token is logged.
- Default interval: 300 seconds, configurable in the policy. Caller supplies the
  last-attempt timestamp. The fundraiser window is November 1 at 00:00 CDT through
  December 1 at 00:00 CST, end exclusive, accounting for the DST change.
- `workers/facebook-live/index.ts` is a dormant scheduled shell, hard-disabled,
  with no source, credentials, binding/config or HTTP endpoint.

The policy stages results only at `raffle_live_automatic`, never `raffle_live`.
Presence of any manual record, including a deliberate blank or malformed record,
blocks discovery. Public rendering does not read the staged key. This preserves a
manual save even if it races a future poll. There is no automatic-mode UI or manual
override release yet. Do not delete `raffle_live` as an activation shortcut.

## Meta feasibility and official references

Inaccessible references below are **follow-up verification targets**, not verified
contracts. No unsupported API capability or deprecation is asserted.

| Question | Result and evidence still needed |
| --- | --- |
| Current/latest Live discovery | Unresolved: [Live Video API](https://developers.facebook.com/docs/live-video-api/) and [Page live_videos](https://developers.facebook.com/docs/graph-api/reference/page/live_videos/) returned 429. Do not assume the legacy edge supports GET for this Page |
| Video metadata | Unresolved: verify readable fields and Live/replay/ownership semantics in [Page videos](https://developers.facebook.com/docs/graph-api/reference/page/videos/) and [Video](https://developers.facebook.com/docs/graph-api/reference/video/). A video list alone does not identify a raffle broadcast |
| Page posts | Unresolved: verify supported attachments/permalinks and permissions in [Page feed](https://developers.facebook.com/docs/graph-api/reference/page/feed/) and [Pages API](https://developers.facebook.com/docs/pages-api/) |
| Webhooks | Unresolved: [Page webhook reference](https://developers.facebook.com/docs/graph-api/webhooks/reference/page/) was inaccessible. Do not assume payloads provide a video URL or complete Live lifecycle |
| New Pages Experience | Unresolved: verify exact edges/fields, Page token and Page tasks using [Pages overview](https://developers.facebook.com/docs/pages-api/overview/) and this Page once authorized |
| Live and replay embeds | Existing plugin behavior is preserved and URL generation tested. [Embedded Video Player](https://developers.facebook.com/docs/plugins/embedded-video-player/) returned 429; current eligibility and logged-out playback require confirmation. No guarantee for private, restricted, deleted videos or reels |
| Replay retention | Verified: Meta announced new Live broadcasts are available for replay for 30 days, then removed. See [Meta storage policy announcement](https://about.fb.com/news/2025/02/updating-our-facebook-live-video-storage-policy/). Plan preservation separately if long-term recordings are required |

Do not scrape Facebook, automate Facebook browsing or use undocumented endpoints.
Third-party tutorials or SDK method names are insufficient proof of current support.

## Meta setup when Page access is granted

**The exact final permission/review set remains blocked on a verified method.**
The following is an explicit verification checklist, not a claim these permissions
alone enable automatic discovery.

1. Obtain organization-authorized Facebook access to Page `61552199315213`. Confirm
   the Page tasks granted; an app administrator/developer role alone is insufficient.
2. Select an available Pages-related app use case/product offering the required
   read scopes. Record app type, mode, API version and access levels. Do not add
   publishing permissions merely to read content.
3. Recheck [permissions](https://developers.facebook.com/docs/permissions/),
   [Pages getting started](https://developers.facebook.com/docs/pages-api/getting-started/),
   [access tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/)
   and [App Review](https://developers.facebook.com/docs/app-review/).
   Candidate scope names to confirm: `pages_show_list` for authorized Page discovery,
   `pages_read_engagement` for Page-owned content. Verify whether a selected method
   additionally needs `pages_read_user_content`; do not request by default.
   Consider `pages_manage_metadata` only for a verified webhook subscription.
   `publish_video` and `pages_manage_posts` are not assumed necessary.
4. Obtain the documented Page token through an authorized user flow and confirm
   Page identity, granted scopes/tasks and expiry with Meta's tools. Follow current
   token lifecycle instructions. Do not assume a long-lived token cannot be revoked.
   Never paste tokens into chat, source, fixtures, shell history or screenshots.
5. Confirm Standard/Advanced Access, app-role restrictions, Live mode, App Review,
   business verification, privacy policy and data deletion requirements for the
   actual app. Do not assume an owned Page creates a blanket review exemption.
6. Test documented read-only calls against this Page with a pinned supported Graph
   version. Capture sanitized schemas for live, ended, empty, permission-denied,
   expired-token and throttled results. Verify permalink, ownership and embeddability,
   and establish how unrelated uploads are excluded.
7. Verify a real Live and its replay in logged-out desktop/mobile website embeds,
   with direct Facebook fallback. Age/location/privacy restrictions, deletion and
   retention can prevent playback.
8. If no documented method supports this Page/use case, retain manual entry and
   record the confirmed limitation. Never enable a guessed `live_videos` request.

## Cloudflare checklist and remaining implementation — approval required later

If supported polling is confirmed, use a separate small Worker alongside Astro 5
Pages. References: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
and [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

- [ ] Resolve Meta API/permissions/NPE verification; implement the supported adapter.
- [ ] Use a fixed official HTTPS Graph host, explicit version/fields, Authorization
  header, bounded timeout/response size and bounded pagination. Do not follow
  response-supplied pagination URLs that might leak credentials to another host.
- [ ] Establish a reliable raffle publishing identifier. The adapter must validate
  ownership, Live/replay status, original start time and `isRaffle` before returning
  the application contract; newest Page video is not sufficient.
- [ ] Persist last/next attempt state; implement jittered rate-limit backoff,
  reauthorization handling and sanitized actionable alerts. Current interval logic
  accepts state but does not persist/schedule attempts or implement retries.
- [ ] Add an authenticated explicit release/automatic-mode control and public reading
  of staged data with manual precedence. Test save/clear races and rollback. Retain
  the legacy key; do not overwrite it silently.
- [ ] Prepare reviewed Worker config with no public route (`workers_dev = false`),
  disabled flag, Page ID, supported API version and 300-second interval. No Cron
  Trigger initially. Current shell has no deployment config at all.
- [ ] Use independent staging KV. Only CONFIG should be needed by the future Worker;
  no D1/R2/SESSION access. Bind production CONFIG only after approval. Explicitly
  select account/config/namespace; local ignored TOML shares KV IDs. KV is eventually
  consistent, not a locking or compare-and-swap mechanism.
- [ ] After approval, provision `FACEBOOK_PAGE_ACCESS_TOKEN` exclusively as a Worker
  secret. If the verified adapter needs app-secret proof, provision
  `FACEBOOK_APP_SECRET` similarly. Current code consumes neither. Never put credentials
  in KV, public env, config vars, browser bundles or logs.
- [ ] Credentialed staging tests: Live start/end/replay, unrelated/private/deleted
  videos, duplicates/older results, token expiry/revocation, throttling, manual
  overrides during discovery and disable/rollback behavior.
- [ ] Administrator verifies actual November title/poster and manual daily entries.
- [ ] Obtain approval before deploying, uploading secrets, changing bindings/resources
  or activating Cron. Future five-minute schedule: `*/5 * * * *`; it has **not**
  been added to deployable configuration. Keep the Chicago window; disable/remove
  scheduling after November 30. Rollback leaves manual selection and raffle data intact.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 18 passed, including three nested D1/R2 workflow checks |
| `npm run typecheck` | Passed (`tsc --noEmit`), also passed before edits |
| `npm run build` | Passed on Astro 5.16.6/adapter 12.6.12; existing adapter warning about runtime Sharp; project already uses noop images |
| Full Astro diagnostics | Unavailable: `@astrojs/check` is not installed; CLI prompts for it. No full `.astro` diagnostic pass claimed; build compiled the changed pages |
| Runtime | Node 24.19.0/npm 11.17.0; repo engines and `.nvmrc` target Node 20. npm warned about that mismatch. Node 20 validation outstanding |
| Dependencies | Explicitly declared already-installed/locked esbuild 0.25.12, Miniflare 4.20251118.1 and TypeScript 5.9.3 as dev dependencies. Lock updated offline without lifecycle scripts; no existing version upgraded |
| Emulator | Isolated in-memory Miniflare D1/R2. Sandbox initially denied loopback; authorized local test rerun passed. No Cloudflare account/config accessed |
| Whitespace | `git diff --check` passed |
| Actual Meta API/playback | Untested; Page access and API contract verification remain blockers |

Tests cover URL/config validation and legacy compatibility, video/reel embeds,
manual saves/clear and no-op writes, disabled Worker, provider-boundary validation,
new Lives/replays, duplicates/older responses, unavailable/expired/throttled/empty/
invalid/thrown/storage failures, manual precedence/race, interval/window boundaries,
real local SQL title/poster/rules preservation, poster upload/serving, winner dates/
duplicates/history and month navigation. Provider fixtures represent normalized
application results, **not verified raw Meta JSON**. Add raw Graph response tests
with the verified adapter.

See the separate [Astro upgrade assessment](astro-7-upgrade-assessment.md).
