> Publication rules below are superseded by the [November 6 repair packet](raffle-winner-repair-2026-11-06.md), pending its release.

> Current production status after token rotation: [follow-up report](facebook-automation-production-2026-11-03.md).

> Superseded production status: see [November 3 automation repair](raffle-automation-repair-2026-11-03.md). The historical setup/status below predates that repair.

# Unattended Facebook winner-photo publication

Branch `codex/photo-autopublish`, based on `96dab63` (= `origin/main`, the deployed 15-second Live scheduler).
**Not deployed.** Nothing in production was changed while preparing it.

## Architecture

A new, separate Worker, `folh-facebook-winner-photos` (`workers/facebook-photos/`). It **never** shares a name with
`folh-facebook-live-discovery`, so deploying it cannot replace the `DiscoveryScheduler` SQLite Durable Object,
its `discovery-scheduler-v1` migration, its `* * * * *` cron or the Live flags. `check-deployment.mjs` refuses
that name, Durable Objects, migrations, KV and inline secrets. The Live Worker's bundle is byte-identical to `96dab63`.

```
Facebook Page post ──webhook (signed)──┐
                   └─poll every 2 min──┴─► D1 queue raffle_photo_auto_posts (dedupe on post_id, lease, backoff)
     ─► Graph: re-read post (Page-owned only) ─► photo metadata ─► download largest image (fbcdn only, 8 MiB)
     ─► Workers AI Mistral Small 3.1, 2 independent passes ─► decidePhoto() ─► one D1 batch:
        INSERT raffle_winners (conditional) + audit rows ─► public /raffle reads D1 directly (no cache)
```

* **Discovery.** Webhook `POST /facebook/webhook` (verifies `X-Hub-Signature-256` with the App Secret, constant
  time; queues before replying 200 so Meta redelivers on failure) **and** a polling fallback that uses only the
  Page token's already-working `published_posts` read: every 2 minutes from 17:45 to midnight Central, every
  30 minutes otherwise, only inside `FB_SEASON_START/END`. Either path, and Meta redeliveries, land on the same
  `post_id` row, so a post is processed once.
* **Qualifying posts.** Caption contains `#LakeHenryRaffle`, or "winner(s)" plus raffle/calendar/drawing/ticket.
  Posts an administrator queues explicitly skip the caption and age filters (row rules still apply).
* **Retries.** Transient failures (Graph, CDN, AI) retry after 1, 2, 5, 10, 30, 60 minutes, honoring
  `Retry-After`; then the post is parked as `failed` for admin requeue. Each photo is final once decided
  (any status except `failed`), so a requeue or redelivery never extracts or publishes it twice.

## Publication rules (`src/lib/server/raffle-photo-autopublish.ts`)

A row is inserted only if **all** hold; otherwise it is recorded with its reason and nothing is changed:

1. Both AI passes agree it is a winner announcement, on the row count, and on every field of that row.
2. Valid date, positive ticket, name and hometown present, no `?`/`…`, no model uncertainty note.
3. Dated on the post's Central date or up to 2 days before (older rows = `outside-window`, never inserted).
4. ≤ 12 rows (full-month recap tables are never auto-published).
5. No ticket or place repeated for one date within the image.
6. Not already stored (exact match = `duplicate`), not contradicting a stored winner (spelling, town, ticket),
   and its place is not already held by another winner that day. **Existing records are never updated.**

Prize: only printed prize text that matches exactly one approved scheduled prize for that date (published event
main prize, bonus drawing, supplement, or the poster's daily **$100 gift certificate from Safe & Secure Firearms**).
Place comes only from a printed label. No prize text → `"1st place"` only; unmatched text → place only + reason.
Stored format matches manual entry: `1st place — Tikka T3X Hunter 7MM Rem Mag`; IDs match manual entry too.

`FB_PHOTO_AUTOPUBLISH=false` runs everything but records publishable rows as `held` (dry run).

## Site changes (released through Pages, not needed for the Worker to run)

* `/admin/raffle/photo-imports`: per-photo outcomes and reasons, requeue, queue a post link.
* Raffle admin: **Edit details** (date/ticket/name/hometown, with concurrent-edit and duplicate-ticket guards),
  alongside the existing Edit prize and Remove.
* Prize calendar/suggestions: daily Safe & Secure certificate on every published November 2026 drawing day.
* Readable dropdowns: opaque dark option list (`src/styles/global.css`).

## Validation

`npm test` (71 pass), four TypeScript projects, Astro build, `wrangler deploy --dry-run`, Live bundle identity.
`tests/photo-autopublish.test.mjs` runs the real Worker bundle in workerd with an isolated D1: signed webhook →
mocked Graph/CDN → AI shim → D1 → public `/api/raffle/month`, redelivery/poll idempotency, AI failure → retry,
conflicting announcement left untouched, admin edit/delete, admin queue of an untagged post.
A real Workers AI run on a representative daily image was **not** possible here (Wrangler could not open a remote
preview session); the measured model evidence remains 120/120 fields on the November 2025 table. Use the dry-run
step below on tonight's real post.
