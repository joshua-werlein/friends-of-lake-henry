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
| Rollback, part 2: Worker version rollback and restore drill | Nonproduction drill at the owner's direction (no production rollback). The real bundles of the new build, `6c48d9a` (production `a7f19cca`) and `15de231` (`d6b38e8d`) ran in local workerd against shared persisted DO + KV storage, with Facebook mocked. Each rolled back and forward with state intact and the selection unchanged; the ambiguity hold and admin-disable manual fallback were preserved | **Done (nonproduction)** |
| `publicPlaybackVerified` | Earlier automatically selected videos played on the website (owner). Server-side: the logged-out embed for `1466425035434328` returns HTTP 200 with a `<video>` element. Current in-browser playback still needs the owner's confirmation | **Pending: owner confirmation** |
| `verifiedVideoId` | Proposed: `1466425035434328` (freshest real Live, automatically detected) | Ready once playback is confirmed |
| `expiresAt` 2027-12-01T06:00:00Z | Cap raised to 400 days (commit `cf8252e`, Live Worker `ced68381-190a-42dd-b426-511e14d88ea3`, Pages `995a1755-4d19-4d31-af4e-a3227b2d9130`). Nov 10, 2026 to Dec 1, 2027 is 386.1 days | **Done** |

## A real off-schedule broadcast is not required for the receipt

Every receipt requirement can be met with the evidence above plus the two pending checks. An off-schedule test
broadcast would prove something the receipt doesn't cover: that Meta sends a Live webhook outside the 5:50–6:15 PM
window, when no backup poll runs. The Nov 7–9 selections were all triggered by webhooks, and Meta doesn't know the
window, so this is very likely. If it ever fails, the result is safe: the video simply isn't shown automatically,
and manual selection still works. A short test broadcast is recommended but optional. Under the new policy it would
be shown on the website automatically.

## Remaining step to issue the receipt

1. Owner confirms current playback: open `https://friendsoflakehenry.com/raffle` in a logged-out private window, on
   desktop and on a phone, and press play.
2. Then write the receipt: same contract and evidence fields, `verifiedVideoId 1466425035434328`, `verifiedAt` = the
   confirmation time, `expiresAt 2027-12-01T06:00:00Z`. Verify with `verificationValid`, the activation preflight and
   the admin `receiptValid`.
