# Separate Astro 5 → 6 → 7 assessment

Assessed October 29, 2026. No framework, adapter, Node engine, compatibility date or
deployment changes were made in this task.

## Timing

Keep the November 1–30 fundraiser on the existing application. Prepare migration
in an isolated branch with independent Cloudflare resources after the fundraiser
is stable and winner records are reconciled; target December 2026 or later for
production cutover. Address urgent security or hosting support issues separately
if they arise. This work is not a dependency vulnerability audit. Production changes
require approval.

## Current baseline

- Astro 5.16.6 and Cloudflare adapter 12.6.12; Pages server output.
- `pages_build_output_dir: "dist"`; bindings accessed with `locals.runtime.env`
  throughout routes, middleware and pages.
- SESSION KV authentication, CONFIG KV raffle selection, D1 records, R2 images;
  noop image service. Preserve every binding and secret during hosting migration.
- `.nvmrc` is 20 and package engines are `>=20 <21`; current local Node is 24.19.0.
  Determine actual Cloudflare build settings separately.

## Hop 1: Astro 5 to 6

[Astro's v6 guide](https://docs.astro.build/en/guides/upgrade-to/v6/) establishes
Node **22.12.0 or newer** and Vite 7. Upgrade official integrations together and
validate this hop before proceeding.

The [Cloudflare adapter migration guide](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#upgrading-to-v13-and-astro-6)
requires adapter **13** for Astro 6. It moves development to workerd, removes
`Astro.locals.runtime`, and removes Pages deployment support. Replace binding
access using the documented Cloudflare module API and generated binding types.
Prepare Worker entry/assets configuration and a preview hostname. This is a
hosting/runtime migration, not a package-only upgrade.

Recheck File/Blob uploads, streamed R2 responses, cookies, middleware, runtime
imports and image service configuration under workerd. Preserve application paths,
domains, redirects, headers and storage. Do not apply production migrations to make
a preview function.

## Hop 2: Astro 6 to 7

Follow [Astro's v7 guide](https://docs.astro.build/en/guides/upgrade-to/v7/) from a
passing Astro 6 baseline. Review Vite 8, Rust compilation, whitespace handling,
reserved filenames, Markdown processor changes and removed APIs. Check rendered
Astro pages, inline scripts/styles and layout metadata/JSON-LD, not just compilation.

Use a compatible Astro 7 / Cloudflare adapter **14** combination, verifying exact
peer requirements at implementation time. Current official
[adapter source](https://github.com/withastro/astro/blob/main/packages/integrations/cloudflare/package.json)
shows 14.4.2 paired with Astro `^7.4.0` and Wrangler `^4.125.0`; documentation and
main-branch versions can advance independently. Check the exact published release
metadata before selecting versions.

Do not assume Astro 6's minimum Node suffices for every Astro 7 patch: the current
[Astro source manifest](https://github.com/withastro/astro/blob/main/packages/astro/package.json)
identifies 7.4.4 with Node `>=22.23.4`. Select a supported compatible Node LTS,
verify Astro/adapter/Vite/Wrangler engines, and pin the same version locally and
in Cloudflare. Remove the repository's Node 20 constraint only in that separate work.

## Regression and rollout gates

1. Preserve the known-good lockfile/build and actual deployment settings. Resolve
   tracked Wrangler JSON versus ignored local TOML ambiguity before staging.
2. Add `@astrojs/check` deliberately for full Astro diagnostics. At each hop run
   clean install, tests, typecheck and build using the selected Node version.
3. Verify November 2026 poster, title clearing, daily winner entry/deletion, winner
   history/month navigation, Facebook Live/replay embed and fallback. Test manual
   precedence if automation is completed. Keep Facebook API changes separate.
4. Verify login/logout, sessions/TTL/cookies, CSRF, no-store headers, event CRUD and
   posters, donor CRUD, photo upload/moderation/gallery, contact Turnstile/email,
   sitemap/robots/metadata and mobile layout. Do not send test email without explicit
   authorization.
5. Use independent staging D1/R2/SESSION/CONFIG. Validate a controlled schema fixture;
   address the nested poster migration and historical migration assumptions before
   deployment. Upgrading Astro itself does not require a raffle schema migration.
6. Compare preview status codes, redirects, headers, cache rules, file bytes and
   rendered pages. Verify logged-out desktop/mobile playback with an eligible real
   Live/replay when authorized.
7. Obtain deployment/resource/domain-cutover approval with reviewed preview,
   passing checks, binding/secrets manifest, monitoring and rollback procedure.
   Retain known-good Pages hosting during transition. Rollback must restore routing
   and runtime while preserving newly entered winners, posters and video settings.

Exact dependencies and Cloudflare actions are deferred to the separate migration;
no upgrade assistant was run in this task.
