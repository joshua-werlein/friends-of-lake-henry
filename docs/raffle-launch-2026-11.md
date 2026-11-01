# November 2026 raffle launch

Application changes are local and **not deployed**. No migrations, production writes,
resource IDs, DNS, account resources, Resend configuration or secrets were changed.
The working tree was clean at the start; existing Facebook automation work was committed
and has been preserved. Keep Claude Cowork out of this working tree.

## Existing production behavior verified

- The November poster is present on the production raffle page. No November winners
  were listed during inspection; the selected replay was last updated February 2.
- Facebook Page `61552199315213` resolves to Friends of Lake Henry in Blair.
  Existing browser access shows its Manage Page interface.
- The existing reel `817293491040748` plays inside the production iframe: clicking
  Play changed its control to Pause. This is replay evidence, not a test of tonight's Live.
- [Meta's Embedded Video & Live Video Player documentation](https://developers.facebook.com/docs/plugins/embedded-video-player/)
  was readable through the browser and confirms public Page video/live posts as supported
  sources. Search-tool requests returned 429. A Page videos list itself is not a video.
- Private Group broadcasts are not supported by this workflow. Public visibility,
  embedding permission and restrictions must be checked for each broadcast.

## Changes

- Public read-only `/api/raffle/live` reads only existing CONFIG KV `raffle_live`.
  Responses are no-store; missing/failed storage returns 503 without exposing errors.
- Open, visible raffle pages check the selection every 15 seconds and on return to
  the tab. Only a changed URL replaces the iframe, avoiding playback restarts.
  Failed checks preserve the previous player/link. KV propagation can add delay.
- The Watch on Facebook link remains visible and targets the selected video,
  falling back to the Page video list when cleared. Removed the unreliable timeout
  that hid slow players. Cross-origin player errors cannot reliably be detected.
- Direct video, watch, watch/live, live query, video.php and reel URLs are accepted;
  short/share links must be opened on Facebook and replaced with the full video URL.
- Daily Winners includes draw date, place/prize, ticket, name and hometown. Existing
  D1 `prize` text stores labels such as `2nd place — Prize description`; no new schema.
  Legacy null/free-text prizes survive and are not assigned an invented place.
- Rows sort by date descending and then first/second/third place. Winner checks run
  every 30 seconds and on tab return, preserving old results during failures.
- Admin adds a place selector and optional prize description, defaults the date to
  today in Chicago, retains the date after saving, advances the place, and focuses
  the next ticket entry. Date changes reset place to first. Existing title, poster,
  removal and manual broadcast controls remain.
- Admin gives advisory guidance: two daily prizes, three on Friday/Saturday/Sunday
  and US Thanksgiving (November 26 in 2026). It does not block historical corrections.
- Mobile keeps a keyboard-focusable horizontal table, with wrapping full names and
  prize descriptions. The fallback link announces that it opens a new tab.

## Local preview and validation

The initial Miniflare assets-router configuration produced `Fetch for user worker
without having a user worker binding`. The fixed harness supplies an ASSETS service
binding directly to the built Worker. This change affects only the preview script.
`dist/_worker.js/index.js` and `dist/_routes.json` were verified present after build.

Use two steps, stopping the running preview with Ctrl+C **before rebuilding** on
Windows (the running Worker can lock generated files):

```powershell
npm run build
node tests/local-preview.mjs
```

Open <http://127.0.0.1:8788/raffle> and <http://127.0.0.1:8788/admin/raffle>.
Disposable local login: `preview` / `local-preview-only`. This harness creates
in-memory D1/KV/R2, seeds clearly labeled sample records, binds only loopback, and
discards everything when stopped. It never loads Wrangler configuration or `.dev.vars`.
These credentials are test fixtures, not production credentials.

Do not run an unqualified `npx wrangler pages dev dist --port 8788` for this test:
ignored local TOML and tracked JSON name different D1/R2 resources and contain real
KV IDs. The isolated harness avoids config ambiguity and existing local state.

Validation completed:

- `npm test`: 21 passing tests, including local D1/R2 title/poster/rules preservation,
  duplicate/date validation, historical winners, ordered two/three-place entries,
  public KV reads/change/clear/failure, disabled automation, events, donor entry and
  approved-versus-pending photo serving. Sandbox loopback access was needed.
- `npm run typecheck`, `npm run build` and `git diff --check` passed.
- Built-site browser: public raffle renders; local admin login/save works; adding
  a second-place winner succeeds and advances the selector; a previously open
  public page acquires the selected video and new winner without reloading.
- A 390px mobile browser renders the fallback and winner table without document
  horizontal overflow. Table details scroll within their region.
- Final pre-deployment validation used installed Node **20.19.6**, without changing
  the machine-wide Node selection: all 21 tests, TypeScript and Astro build passed.
  The sandbox denied creation of generated `dist` subdirectories; the same build
  passed outside the sandbox. No deployment command was involved.
- `tsc` does not fully diagnose inline Astro scripts; `@astrojs/check` is not
  installed. Astro build compiles the pages. Existing Sharp warning remains;
  the site uses the noop image service.

## Tonight: November 1, 6:00 PM Central

1. Deploy the reviewed application build through the existing Pages deployment
   workflow, without any migration or binding/account/DNS changes. Verify the
   deployed `/api/raffle/live` endpoint and Daily Winners heading first.
2. Start a **public Friends of Lake Henry Page** Live with embedding allowed.
   Copy the broadcast's full video permalink, not a private Group or share URL.
3. In production `/admin/raffle`, paste the permalink and click **Save broadcast**.
4. Keep a second `/raffle` tab open before saving. It should select the video at its
   next 15-second check after KV propagation. Confirm Play, sound/fullscreen, and
   that Watch on Facebook opens that same video. Check an actual phone and a
   logged-out/private browser. Tonight's actual Live remains a launch-time check.
5. If embedding is blocked, visitors can use the always-visible direct Facebook link.
   Check visibility/embedding settings on Facebook. Clearing the selection restores
   the Page-list fallback; this does not delete any winners or video on Facebook.
6. After drawing, select November 2026 and November 1. Enter ticket, name, hometown,
   first place and optional prize description; click Add winner. Repeat for second
   and **third place** (tonight is Sunday). Verify every saved row. Existing duplicate
   protection prevents the same ticket being entered twice on one date.
7. The open public page should show winners at its next 30-second check. Correct a
   mistaken entry using existing Remove and re-enter controls; do not post test
   winners or clear real winners in production.
8. Repeat daily through November 30. Leaving the selected video in place provides
   the replay while Facebook makes it available. Selection does not prove it is live.

## Automatic detection remains separate

Existing policy and dormant Worker remain disabled. They stage into
`raffle_live_automatic`, never overwrite `raffle_live`, and are not public fallback
sources. No Cron, tokens or app permissions were changed.

Existing Meta developer access exposes KIL Construction Gallery Sync and Grayzn Site
Feed, both for other organizations. Page management access is confirmed, but no
appropriately authorized Friends of Lake Henry Graph adapter/token was verified.
Do not reuse another organization's app or credentials on this evidence alone.
The documented Page Videos discovery lead needs a versioned API/permission check,
read-only Page token test and reliable raffle-versus-unrelated-video classification.
That work does not block manually selecting tonight's public broadcast. See
[the automation investigation](facebook-live-automation.md) for the dormant design.

## Deployment decision

Code is ready for review; no production deployment has been performed. Before
deploying, confirm the existing Pages account/project with the migration owner so
this application release does not target an account being moved. Rollback is the
previous application deployment; existing KV and D1 records require no rollback.


## November 1 pre-deployment review — awaiting publication approval

Verified directly in Cloudflare and GitHub, without changing either service:

| Item | Verified value |
| --- | --- |
| Account | `aa86268490e681cccb3a41a62093e2aa` (existing account) |
| Pages project | `friends-of-lake-henry` |
| Repository | `joshua-werlein/friends-of-lake-henry` |
| Production branch | `main` |
| Build / output / root | `npm run build` / `dist` / repository root |
| Automatic deployments | Enabled; build watch include is `*` |
| Build system | Version 3; build cache disabled; no deploy hooks |
| Production domain | `friendsoflakehenry.com` |
| Current production commit | `47bcfd4712e69c447eaa90dce94e4ec63c7e1dd8` |
| Current GitHub main | Same `47bcfd4`, confirmed by connector and GitHub browser |
| Local outgoing parent commit | `f93bb1cc8e1688ec85a417413fdbf3d32ee0aba9` |

Production has not missed `f93bb1c`: it has not been pushed to GitHub. Historical
Git deployments succeeded and current automatic production settings are enabled.
An actual new webhook/build cannot be proven before the approved push; monitor its
creation and success rather than assuming deployment from a successful push alone.
No GitHub Actions workflow is configured to run tests; Pages currently runs the
build command only. Tests/typecheck are completed locally before approval.

The production binding IDs match tracked `wrangler.json`: CONFIG `folh-config`,
SESSION `folh-session`, D1 `folh-db`, and R2 `folh-photos`. Compatibility date and
flags also match. The cloud build log explicitly reads `wrangler.json`. The ignored
local TOML is not committed and must not be used for a manual production deploy.
No D1 migration, KV reset, R2 content change, DNS/domain/account change or secret
replacement is required. Existing records remain authoritative.

All 13 pending files were reviewed: automation status documentation, this launch
runbook, mobile evidence image, Facebook URL helper, public raffle page, admin
raffle page, admin winners API, public month API, new public live API, new browser
live polling script, both test files, and isolated preview harness. No unintended
changes or release-blocking code defect was identified. The inherited `f93bb1c`
was also reviewed: title clearing preserves poster/rules; URL handling removes
server-side short-link resolution; tests and locked dev dependencies are added;
automation is hard-disabled. Its separate Astro upgrade assessment is documentation
only, with no framework upgrade or deployment configuration change.

### Rollback prepared, not executed

The successful production deployment to retain is:

- ID: `15259186-cb3f-4c88-b546-10076fc0cfb3`
- Commit: `47bcfd4712e69c447eaa90dce94e4ec63c7e1dd8`
- Status verified: success, July 18, 2026 at 10:27 PM Central
- [Deployment details](https://dash.cloudflare.com/aa86268490e681cccb3a41a62093e2aa/pages/view/friends-of-lake-henry/15259186-cb3f-4c88-b546-10076fc0cfb3)
- [Immutable deployment URL](https://15259186.friends-of-lake-henry.pages.dev)

After an approved release, if `/raffle` returns errors, live polling fails while
bindings are healthy, admin cannot load/save, or existing site features regress,
use this project's Deployments → target deployment actions → **Rollback to this
deployment**, following [Cloudflare's rollback procedure](https://developers.cloudflare.com/pages/configuration/rollbacks/).
Do not rebuild the old source or revert live D1/KV/R2 data to roll back the app.
New winners and the manual video selection must survive the application rollback.
Pause further publishing while diagnosing; do not force-push Git history.

After approval, push the reviewed local `main` commits to the verified origin,
watch for the exact new commit in this existing account's Pages project, and
verify success plus the custom domain. Then check `/raffle`, `/api/raffle/live`,
`/admin/raffle`, November poster, historical winners, donors, events, photos and
contact form rendering. Do not send test contact email or mutate real raffle data
as a smoke test. Keep observing errors and core pages for 15 minutes. If a push
creates no deployment, investigate the Git integration before any manual retry or
fallback deployment. No account-migration runbook has been edited.


Read-only production baseline before publication: home, raffle, donors, events,
photos and contact all return HTTP 200. Contact markup still points to `/api/contact`;
no email was sent. November 2026 has its poster and zero winners; November 2025
returns 30 historical winners. The isolated preview also returns 200 for those
pages. Node 20 browser checks reconfirmed login protection, login, broadcast save,
second-place entry and automatic advancement to third, plus weekday/Thanksgiving
guidance. The previously open public tab received the changed broadcast and added
winner without refresh. Clearing the local selection retains the Facebook fallback.
