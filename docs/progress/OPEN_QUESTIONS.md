# Open questions for the owner

Collected as they arise so building never stops on them. Each one names what
was decided in the meantime, so nothing is blocked and nothing is silently
assumed. Answered items move to `OWNER_DIRECTION.md` and leave here.

_Last updated 2026-09-20, during S2-17a._

## 0. The OTO App now lives in this repository — say if that is wrong

**What was done:** its source moved from the read-only export at
`imports/oto-app/` to `apps/oto-app/`, where it is maintained and deployed
from. Render builds it there from its own Dockerfile; it keeps npm and its
own lockfile and is excluded from the pnpm workspace.

**Why:** OWNER_DIRECTION 2026-09-20 item 2 says the whole live app is lifted
onto the platform, improved where it can be, and the owed features built
inside it. That makes this repository its home. Render is already connected
here, so no second repository, connection or deploy key is needed.

**What it costs:** this copy forks from whatever the outgoing developer
commits to the live repository from the export date onward. The intake
already accepted that trade ("lift as-is first — a rewrite would fork from
code still under daily commits"), but the fork is now real rather than
planned.

**Needed:** either confirmation, or the live repository's remote so the copy
can be a fork of it with history rather than a snapshot. Worth settling
before S2-17b puts weeks of work on top of it.

## 0b. A change freeze on the live OTO App, and when

**Where it bites:** every commit made to the live app after the export widens
the gap this copy has to close before cutover.

**Meanwhile:** nothing is blocked — S2-17a only needs the app to boot.

**Needed:** a date after which the outgoing developer stops committing, or
confirmation that the park accepts re-applying their changes by hand.

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

## ~~Which branch and operator a provisioned person has inside the OTO App~~ — answered 2026-09-20

**The answer: the admin decides, by picking from the OTO App's own list.**

The problem was that the OTO App carries its own `tenants → operators →
branches` tables whose ids have no correspondence with `core.operator` and
`core.branch`, so nothing could be derived without inventing a mapping that
would look right and not be.

So nothing is derived. The provisioning dialog reads the OTO App's own branch
list and the administrator chooses — the same shape as choosing a box for a
station, or choosing who may use one. Role was already chosen this way.

**Assumed, not asked:** the OTO App has a `tenants` table above operators with
a single `default` row. Provisioning uses it. Revisit if a second tenant ever
exists.

## 3b. WhatsApp delivery is built but parked, waiting on a real sender

**Where it bites:** `scripts/sprint-report.mjs` composes the Sprint 2 report
and delivers it through Twilio's WhatsApp channel, but nothing is sent until
`TWILIO_WHATSAPP_FROM` and `REPORT_WHATSAPP_TO` carry real values. Parked by
the owner on 2026-09-20 until Jim's Twilio details arrive, rather than
standing up the sandbox and having to redo it.

**Meanwhile:** email works and is live — Antonie Polfliet watches all 28
sprint epics and stories, so every comment and every status move reaches him.
The report also prints, so it can be pasted anywhere in the meantime.

**Needed, when the real account lands:** a WhatsApp-enabled sender on it (a
WhatsApp Business sender needs a Meta Business account and a few days of
approval — worth starting before it is wanted), and the number the report
goes to. Then this merges with question 4 below: one channel carries both the
sprint report and the 9pm-Saturday operational alert.

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
- ~~The two sweeps are unscheduled~~ — **done in S2-03.** The job runner
  schedules `purgeExpiredIdempotencyKeys` and `purgeExpiredHandoffTokens`,
  and the watchdog is live on the deployment.
- ~~The Console's Health page cannot list the job register yet~~ — **done.**
  `GET /ops/health`, `/ops/failures`, `/ops/runs`, `/ops/integrations` and the
  staging test controls landed in d2e4568 and are live. All four Console pages
  read real rows; the evidence on SCRUM-190 was re-captured against them.
- **`job.fail` raises no `ops.failing` alert.** The staging control writes the
  failure record a broken job would, rather than registering a deliberately
  broken job — because a registered job is one the watchdog then expects to
  succeed, so every staging deploy would open an alert nobody asked for. The
  consequence is that the plan's acceptance line for the `ops.failing` alert
  is met by the watchdog and not by this control.
- **An acknowledged alert does not say who took it.** `acknowledgedBy` is a
  staff member's name, which the audit route masks unless the caller holds
  `admin:audit:read_sensitive`. The Health page shows "taken 5m ago" without
  it. Returning it to a caller who holds that permission is a one-line change
  if the owner wants it.
- Still outstanding from S2-03, all additive and none of it blocking the next
  ticket: OpenTelemetry traces and the OTLP bridge, `POST /telemetry/client`
  for browser errors, the `audit_log` classification columns with a BRIN
  index, and a scheduled ping of `/ready` from outside the platform.
- ARCHITECTURE.md sections 3 and 6 still describe the pre-2026-09-19
  repository layout.
