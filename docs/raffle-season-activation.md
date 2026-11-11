# Activating a future raffle season

The raffle automation is no longer tied to November 2026. A season is a pair of Cloudflare settings,
`FB_SEASON_START` and `FB_SEASON_END` (ISO instants with the Central offset; end exclusive, at most 366 days apart),
and each month's prizes become authoritative only after an administrator approves that month's prize calendar.
Nothing activates on its own: with the settings unchanged, November 2027 has no scheduled Live checks,
no photo polling, no photo AI reads and no publishable prizes.

## What the season controls

| Behavior | Source |
|---|---|
| Live backup checks (5:50–6:15 PM Central), the 5:59–6:01 burst, alert email window, fast browser refresh | Season days |
| Live coordinator (Durable Object) instance | `<month>-<year>` of the season start, e.g. `november-2026`, `november-2027`. Each season starts with fresh state |
| Timing journal and drawing timelines | Season days |
| Photo cron, photo Graph backup poll (5:55–6:15 PM), alert evaluation | Season instants and days |
| Public raffle page season line | Season label, e.g. "November 1–30, 2027" |
| Signed Live webhooks | Year-round (unchanged). A selection still requires an unexpired reviewed verification receipt whose `verifiedAt` is inside the current season, so every new season needs a new Live receipt review |

## What the prize calendar controls

The calendar for a month (`raffle_months.calendar_status`) is `draft` until approved in **Admin → Raffle → Review prize calendar**.
While it is a draft:

- the public prize calendar, admin prize suggestions and winner prize validation see no prizes for that month;
- the photo Worker records a winner post as ignored (`calendar-not-approved`) without downloading the image or calling AI;
- manual winner entry still works (ticketed winners save without a prize slot).

A calendar consists of:

1. **Main prizes**: the month's published raffle events (Events admin), one per drawing day. Bonus drawings listed in an
   event summary (`2nd drawing: Gun Safe`) are derived read-only.
2. **Recurring prizes**: prizes awarded at every drawing (2026: the $100 Safe & Secure gift certificate, 2nd place).
   Saved as private drafts, then approved one by one. A 2nd or 3rd place must be independently confirmed.
3. **Supplemental prizes**: one-off additions, as before.
4. **Main-prize heading** (optional): the winner-table column heading that names the day's main prize (2026: `Firearm`).

Poster recognition (optional, requires `RAFFLE_POSTER_AI_LICENSE_ACCEPTED=true` and the AI binding) proposes supplemental
and recurring rows as unapproved proposals only. It never writes prizes.

Migration `009_raffle_season_calendar.sql` records November 2026 exactly as it already worked: calendar approved, the gift
certificate as recurring slot 0 (stored prize ids `daily:<date>:0` are unchanged), heading `Firearm`.

## Activation checklist for a new season (example: November 2027)

Do this outside the 5:45–6:45 PM Central window, after the previous season has ended.

1. **Publish events.** Create the month's raffle events in Events admin and upload the season's poster in Raffle admin.
2. **Review prizes.** In the prize calendar, load the month and:
   - optionally run poster recognition and save any correct proposals as private drafts;
   - add or approve each recurring prize, confirming its place;
   - approve any supplemental drafts;
   - set the main-prize heading if the winner tables use one;
   - tick the review confirmation and approve the calendar.
3. **Set the season** in all three components, with the same values:
   - Pages project (`wrangler.json` `vars` and the dashboard production and preview environments),
   - Live Worker activation config (`FB_SEASON_START`, `FB_SEASON_END`),
   - Photo Worker config.

   Example: `FB_SEASON_START=2027-11-01T00:00:00-05:00`, `FB_SEASON_END=2027-12-01T00:00:00-06:00`.
   Run the Live and photo preflights (`check-activation.mjs`, `check-deployment.mjs`) and deploy.
   The existing cron expressions are month-based (November and early December UTC). A season in another month
   needs matching cron expressions.
4. **Re-review Live.** Issue a new reviewed verification receipt dated inside the new season (see
   `docs/live-receipt-reverification-2026-11-09.md`). Until then, automatic Live selection falls back to the manual video.
5. **Verify.** Check the public raffle page's season line, `/api/raffle/prizes?month=YYYY-MM`, one Live cron tick on a
   season day, and one photo cron tick.

To end or pause a season, set the season settings to the closed window, or turn off `FB_AUTOMATION_ENABLED` and
`FB_PHOTO_AUTOMATION_ENABLED`. To withdraw a month's prizes, return its calendar to draft.
