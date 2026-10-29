# Dormant Facebook polling Worker

This entrypoint is intentionally disabled in code. There is no Wrangler deployment
configuration, Cron Trigger, HTTP endpoint, Graph client, or credential access.
Calling `scheduled()` cannot contact Meta or change KV. Setting an environment
variable cannot enable it. The testable polling policy is in
`src/lib/server/facebook-automation.ts`.

See `docs/facebook-live-automation.md` before completing this shell. A supported
Meta discovery adapter, durable scheduling/backoff, explicit release of the manual
override, public automatic selection, and credentialed staging tests remain required.
Do not deploy this shell as a functioning integration.
