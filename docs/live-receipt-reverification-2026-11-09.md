# Live verification receipt: reverification for a one-year term (2026-11-09)

Goal: renew `raffle_live_verification` (schema 5, contract `page-video-live-origin-v3`, evidence
`page-video-live-origin-policy-reviewed`) so automatic selection continues until **2027-12-01 00:00 Central**.
The current receipt (verified video `1129604836279234`, verifiedAt 2026-11-06T03:03:33.834Z, expiresAt
2026-12-01T06:00:00Z, SHA-256 prefix `879608b54dfa2f31`) is **unchanged**. No receipt has been written.

## Owner policy decision (2026-11-09)

Automatically display any **verified Live broadcast from the Friends of Lake Henry Page**, at any time of year,
including broadcasts unrelated to the raffle, through December 1, 2027. All existing protections stay:
signed webhooks, Page ownership, LIVE-origin proof, same-day and 2-hour recency, the ambiguity hold, manual-override
precedence, admin disable, and the KV fallback.

## Requirement status

| Receipt field / requirement | Evidence | Status |
|---|---|---|
| `policyReviewed`: reviewed policy and scope | Owner decision above. Code: commits `96a17a2`, `15de231`, `6c48d9a`; 172/172 tests including negative controls | **Done** |
| `graphPageId`, `publicPageId` | Production checks on Nov 9 (5:56–6:20 PM): identity read returned the expected Page with HTTP 200 on every check | **Done** |
| `apiVersion` v26.0 | Released 2026-07-29. Expiration TBD; Meta guarantees at least 2 years (v25.0 runs until 2028-07-29), so it outlasts the term | **Done** |
| Real LIVE-origin evidence | Nov 9 video `1466425035434328`: Graph `live_status=LIVE`, published, embeddable, Page-owned. A signed webhook caught it and it was staged automatically in 11 s. Nov 7 and 8 likewise. The origin rule doesn't depend on the time of day | **Done** |
| Signed webhook verification | Nov 7–9 journal `webhook-received` entries, recorded only after HMAC verification and the active-Page check | **Done** |
| Negative controls | Tests: previous-day, older than 2 h, never-Live VOD, other Page, reel/share link, photo post, two simultaneous broadcasts, forged post-season stage, expired receipt | **Done** |
| Rollback, part 1: automatic to manual fallback | Test "signed webhook … rolls back to manual". Production: the manual override on Nov 9 at 6:01:31 PM took precedence (`reason: manual-override`) | **Done** |
| Rollback, part 2: Worker version rollback and restore drill | Nov 5–6 drill was on older versions. Re-running it on `a7f19cca` was blocked by the session's permission policy (production deploy) | **Pending: needs approval** |
| `publicPlaybackVerified` | Server-side: the logged-out Facebook embed for `1466425035434328` returns HTTP 200 with a `<video>` element and no "unavailable" notice. This is not proof that it plays | **Pending: needs a person in a browser** |
| `verifiedVideoId` | Proposed: `1466425035434328` (freshest real Live, automatically detected) | Ready once playback is confirmed |
| `expiresAt` 2027-12-01T06:00:00Z | `verificationValid` caps a receipt at 366 days after `verifiedAt`. From a Nov 2026 verification, Dec 1, 2027 is about 386 days | **Needs a reviewed code change** |

## A real off-schedule broadcast is not required for the receipt

Every receipt requirement can be met with the evidence above plus the two pending checks. An off-schedule test
broadcast would prove something the receipt doesn't cover: that Meta sends a Live webhook outside the 5:50–6:15 PM
window, when no backup poll runs. The Nov 7–9 selections were all triggered by webhooks, and Meta doesn't know the
window, so this is very likely. If it ever fails, the result is safe: the video simply isn't shown automatically,
and manual selection still works. A short test broadcast is recommended but optional. Under the new policy it would
be shown on the website automatically.

## Remaining steps to issue the receipt

1. Owner: open `https://friendsoflakehenry.com/raffle` in a logged-out private window, on desktop and on a phone,
   press play on the video, and report whether it plays.
2. Approve the Live Worker rollback drill: roll back to `d6b38e8d-e0eb-4108-bfe3-799338d63838`, confirm
   `/api/raffle/live` works, then restore `a7f19cca-7b72-444b-8706-42b7d30fbeb1`.
3. Approve raising the receipt lifetime cap from 366 to 400 days (tests and deploy for the Worker and Pages).
4. Only then write the receipt: same contract and evidence fields, `verifiedVideoId 1466425035434328`,
   `verifiedAt` = the time the last check passes, `expiresAt 2027-12-01T06:00:00Z`. Verify with the activation preflight.
