# Open questions for the owner

Collected as they arise so building never stops on them. Each one names what
was decided in the meantime, so nothing is blocked and nothing is silently
assumed. Answered items move to `OWNER_DIRECTION.md` and leave here.

_Last updated 2026-09-20, after S2-03._

## 1. One cookie value shared across app origins, or one per origin?

**Where it bites:** S2-02's hand-off gives each app its own cookie, but every
one of them carries the same underlying session token. That is what makes
revocation inherently global — there is no second credential anyone can
forget to kill — but it also means a cookie stolen from one origin is usable
at another.

**Meanwhile:** the shared value is in place and the token is sealed in
transit, wiped the moment the hand-off is claimed.

**The alternative:** a `core.session_credential` table plus a change to
`loadAuth`, so each origin holds a distinct value against one session row.
Roughly half a day, and cheapest **before** S2-03 (console), S2-17 (OTO App)
and S2-18 (Radar) multiply the origins.

**Needed:** a yes or no. Not urgent this week; awkward in three tickets' time.

## 2. Which phone numbers should the Twilio trial account verify?

**Where it bites:** a trial account can only text numbers added to Verified
Caller IDs. Any walkthrough that creates a staff account or resets a password
needs the receiving phone on that list first.

**Meanwhile:** the seeded demo accounts have known passwords, so a
walkthrough does not have to send a code at all.

**Needed:** the numbers to verify, or Jim's production credentials, whichever
arrives first.

## 3. `TWILIO_AUTH_TOKEN` in `.env` looks like a placeholder

It is 13 characters; a real Twilio auth token is 32. Harmless today — the
deployment authenticates with the API key, and the auth token is unused — but
worth knowing if it was meant to be the real one.

**Meanwhile:** the variable is deliberately blank on the Render service.

## 4. Alert channel and recipients (plan decision 17)

**Where it bites:** S2-03 builds alerting. It can deliver to a console, an
email address or a generic HTTPS webhook (Slack, Discord, LINE Notify).

**Meanwhile:** `ALERT_CHANNELS=console` — alerts are recorded and visible on
the Console's Failures page, but nothing leaves the building.

**Needed:** which channel, and who should receive an alert at 9pm on a
Saturday.

## 5. Gateway credentials (plan decision 32)

The 2C2P sandbox merchant id and secret, into `.env` as `PGW_*`. Not blocking
until S2-10; the gateway simulator answers in the meantime so CI and a fresh
checkout never need the sandbox.

## 6. Alerting is built but delivers only to a console

S2-03 built the alert record, dedupe, auto-resolve and flap suppression, and
a channel interface an email or webhook adapter slots into. Nothing leaves
the building until question 4 is answered — so today an alert is visible on
the Console and nowhere else. That is fine while someone is looking at the
Console; it is not fine at 9pm on a Saturday.

## Recorded, not blocking — deferred work

- **"Expire hand-off now"** (S2-02 QA step 3): the test control is not built.
  Expiry is covered by an integration test but not by a button. It belongs
  with the other staging-only controls behind `OPS_TEST_CONTROLS` in S2-03.
- `purgeExpiredIdempotencyKeys` and `purgeExpiredHandoffTokens` are written
  and exported but nothing schedules them yet — S2-03's job runner.
- ARCHITECTURE.md sections 3 and 6 still describe the pre-2026-09-19
  repository layout.
