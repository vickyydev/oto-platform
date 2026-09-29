# Open questions for the owner

## Current follow-ups - 29 September 2026

- **GitHub Actions availability.** Main source b052767 is checked locally,
  but CI 36570597484 ran zero steps because account billing/spending prevents
  jobs starting. Restore Actions availability; no spending setting is changed
  by development. Meanwhile SCRUM-201 continues independently. Deployment,
  staging proof and the next CI-packed Pi artifact remain pending.
- **Retained simulated partial outcome.** The historical run 0d008153 remains
  unresolved; existing controls cannot retrieve its lost final result. Its
  eight inventory rows and original payment evidence are retained. A fresh
  isolated proof will verify the corrected release without replaying SALE or
  claiming the old payment was reversed. Any later reconciliation proposal
  must state that this is simulated evidence and preserve the original audit.
- **SCRUM-269 implementation decisions to resolve before local trading.**
  The first safe slice is an authenticated box station bridge. Follow the
  existing Caddy/DNS and device-auth decisions; confirm the concrete LAN origin
  and permissions contract before wiring it to the POS. Cash trading also
  needs a complete cache-age/payment-method rule and atomic local action,
  receipt and outbox writes. Existing offline replay primitives alone do not
  satisfy these requirements. These are recorded implementation gaps, not a
  request to reopen the agreed architecture or a blocker for SCRUM-201.

Older questions below retain their original dated evidence.


Collected as they arise so building never stops on them. Each one names what
was decided in the meantime, so nothing is blocked and nothing is silently
assumed. Answered items move to `OWNER_DIRECTION.md` and leave here.

_Last updated 2026-09-21, after the menu / Twilio / LINE / OTO App / re-test
investigations. The actions arising from them — as opposed to the decisions
recorded here — are in `OWNER_ACTIONS_AND_NEXT_BUILD.md`._

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

## 2. Which phone numbers should the Twilio trial account verify? — **widened 2026-09-21: verifying numbers is not enough**

**Where it bites:** a trial account can only text numbers added to Verified
Caller IDs. Any walkthrough that creates a staff account or resets a password
needs the receiving phone on that list first.

**What was measured on 2026-09-21**, against the live API: every attempt is
refused with `572002` — *"No Twilio trial phone number is assigned for
messaging to this destination number."* A Thai mobile, a US mobile and a
sender the account does not own all returned the identical refusal, so Twilio
stops before it evaluates either the destination country or the sender. The
account **owns no phone numbers, has no verified caller IDs, and has a zero
balance**. Because a 422 means no message resource is ever created, none of
this appears in the message log — which is why it took direct API calls to
find.

**So the ask has grown:** adding numbers to the allow-list does not fix it on
its own. Lifting the account out of trial (any prepaid balance) is the step
that matters, and even that does not guarantee Thai delivery — Twilio's own
Thailand guidelines say a US long code cannot deliver to Thailand at all, and
that unregistered senders have been fully blocked there since October 2025.
The route that avoids a 10-business-day sender registration is **Twilio
Verify**, which uses Twilio's pre-registered Thai senders. Full write-up and
the three routes: `OWNER_ACTIONS_AND_NEXT_BUILD.md` half one, actions 1 and 5.

**Meanwhile:** the seeded demo accounts have known passwords, so a
walkthrough does not have to send a code at all; and an administrator can
stand up a new account with a temporary password, which needs no SMS. That
path currently dead-ends on the POS station picker — build item B1 fixes it.

**Needed:** the numbers to verify, a prepaid balance on the account, and a
decision on the production route.

## 3. `TWILIO_AUTH_TOKEN` in `.env` — **confirmed invalid 2026-09-21**

It is 13 characters; a real Twilio auth token is 32. Twilio now answers
`20003 "auth token is not valid for account AC…"` when it is used, so it is
not merely short — it does not work.

Harmless on the deployment, which authenticates with the API key and has the
variable deliberately unset. The trap is local: the SMS adapter falls back to
the auth token whenever the API key pair is absent, so anyone who clears the
key variables on their own machine gets a 401 and a confusing hunt.

Worth knowing if it was meant to be the real one. Separately, the API key in
use is **restricted** — it can send messages and look up numbers but cannot
read account status, which is why diagnosing the trial state needed a
different call.

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

## ~~3c. Pricing: four rulings~~ — answered 2026-09-20, applied in 7d66dd5

Four agents searched the prototype, the lifted OTO App, the intake documents
and every brief. **One was never a ruling; three were genuinely undocumented
and were decided.** The distinction is kept in the code: a cited rule carries
its citation, a decision is labelled as one with its reasoning.

**(a) The free item goes on at ฿0 and the rest of the bill is untouched —
a CITED RULE, and the engine had a defect against it.** Said outside the
prototype three times (`POS_BACKEND_LOGIC.md` §6.2, rule R-29 in
`POS_RULES_RECONCILIATION.md:78`, the signed acceptance criterion in
`AGENCY_PROPOSAL.md`) and four more times in the prototype's own comments.
Its arithmetic even computed ฿2,130 and then discarded it, because a promo
line returns no taxable base so the offsetting discount fell on the tickets.
The park was giving the cone away twice and booking it once. WE-8 now reads
฿2,130 and the markdown books against F&B, not admission.

**(b) A scoped discount spends only what its own scope has left — a
DECISION.** Nothing rules on it anywhere. Taken because this system has no
manager approval on discounts by design, so the arithmetic is the only thing
between a scoped code and the stockroom; and two neighbouring systems (staff
benefits, manual discounts) already track what a line has left, so it follows
the park's own pattern. Guests pay more where it bites — EC-15 ฿0 → ฿1,000,
EC-17 ฿0 → ฿300 — and no code the park holds today is scoped this way, so it
becomes reachable only when somebody creates one.

**(c) and (d) Both dates are the business date — DECISIONS.** The park trades
10:00–20:00, so no guest sale falls in the window where the calendar day and
the business day disagree. One sentence then covers pricing, expiry, the till
roll and the cash-up. (d) also fixed a plain bug: promo validity compared
against UTC while pricing used local midnight — measured as a 05:00–06:59
window, wrong in **both** directions.

**Still to do, outside `packages/shared` and therefore not in that commit:**
- `apps/api/src/routes/catalog.ts:299` — the pricing resolver still defaults
  to `branchToday`; ruling (c) makes it `businessDate`.
- `apps/pos/src/pages/Till.tsx:508,624` and `components/mobile/MobileTill.tsx:522`
  — still UTC for promo validity; ruling (d) makes them `promoValidityDate`.
  These call the POS's own lifted `lib/promoVoucher.ts`, not the engine.

**What actually protects the money is not the date but the freeze** — price
and code validity resolved once when a line enters the cart and stored, with
re-pricing a deliberate act. Recorded in `findStaleLines`' docstring where
S2-09a's cart work will find it.

**Separately, a mismatch to correct in one place or the other.** S2-09a's
acceptance criterion names a cart *"2 Hours Play, 2 kids + 3 adults, weekend,
for James (expat), with the free-adults rule applied per line"*. In the
seeded catalogue that ticket prices expat adults at a set price, so that cart
exercises no free-adults rule at all — the only seeded one is Full Day Pass
at the Thai tier. The fixture is built as the catalogue actually prices it
(฿2,924). Either the seed or the criterion should change before QA is asked
to screenshot a figure that cannot be produced.

## 3f. The seeded closing time was an hour late — **corrected 2026-09-21**

`packages/db/src/seed/index.ts` seeded HKT Central closing at **21:00**, and
`packages/db/src/schema/tenancy.ts` asserted "the park closes at 21:00". The
park's own SOP says **20:00** ("Daily: 10:00 AM – 8:00 PM", order counter
closes 19:30), and Radar has been watching the live tills against a 20:00
close for months.

The box watchdog only raises an alert during opening hours, so the extra hour
meant expecting every box to be alive for an hour after the park was dark —
a nightly false alarm, and false alarms are how people learn to ignore the
real ones.

**Now 20:00,** matching the park's own document, which wins. The half hour
after the doors close — the cash count, an end-of-day print, a late party —
is covered by `business_day_start` (05:00), which is what decides the trading
day a late fact belongs to; it does not need the park to be pretending it is
still open. Nothing turned on the old value because staging has no real boxes
yet, and the watchdog tests carry their own hours fixture rather than reading
the seed.

**If the owner tells us the park's hours differ from the SOP**, a person
edits them in Console → Branches: the seed only backfills a branch that has
none, and never overwrites an answer somebody gave.

## 3d. Phone numbers in the production dump are not all E.164 (bites at S2-22)

**What was found:** the platform reads a leading `00` as the international
access code, so `0066818953926` becomes `+66818953926` — which is what finds
the member, because that is how a visitor's handset and contact list write
the number. The prototype does not: it strips non-digits and leaves
`0066818953926`, a 13-digit key that matches nobody and silently creates a
second member for somebody who already exists.

**Why it matters later:** the park's production dump was written by the
prototype's rule. Any `00…` values in it are therefore **not** E.164 and
must be re-normalised at import and de-duplicated against members already
present — not copied across. Copying them makes duplicate people, and a
duplicate member is a child's allergy note attached to the wrong record.

**Meanwhile:** nothing is blocked; the platform's own normalisation is
correct and Sprint 1 shipped it, so it is not being changed.

**Edge already handled:** Thailand's own outbound prefixes are 001, 007,
008 and 009, so `001…` reads as a `+1` number and is rejected as impossible
rather than stored wrong.

## 3e. The Eat & Play adult price: the rule and the seed disagree

`POS_RULES_RECONCILIATION.md` R-22 says Play & Eat's adult price equals the
kid price. The seeded Eat & Play Kids Pass charges ฿350 for an adult against
a ฿1,300 kid ticket. The pricing fixtures encode the seed, because the seed
is what the till actually sells.

**Needed:** which is right. Recorded here rather than resolved, and the
fixture deliberately cites no rule id so the disagreement is not papered
over.

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

## 7. Six decisions from the 2026-09-21 investigations

All six are the owner's. None blocks building, because each one names what we
are doing meanwhile.

### 7a. Should importing a menu spreadsheet ever remove things?

**What was found:** the menu screens keep everything in the browser's memory
today — there is no menu table and no way to save a menu item at all. So the
import's rules are being set from scratch rather than inherited, and this one
decides the feature's character.

**The two readings.** Ours: a sheet is a *set of changes*, so an item present
in the system but absent from the file is left completely alone, and removal
is explicit only (an `archive` value in a column, or marking an item
unavailable). His, possibly: the sheet *is* the menu, so anything not in it is
gone.

**What it costs either way.** Our reading means an import can never remove
something he forgot to include — which the preview screen will say in as many
words. His reading means a file exported before a desserts section was added,
then re-imported, silently withdraws the desserts. The realistic use is
partial — export, add a section, import — which is why we chose ours.

**Deletion is not on the table in either reading:** past orders reference menu
items, so an item is archived, never deleted.

**Meanwhile:** built as "never remove, archive only", behind a preview that
states it.

### 7b. A short code on every menu item

**What was found:** menu items have no human-facing key — only a generated
internal id. Retail items already have one.

**Why it is needed:** something has to decide whether a row in a spreadsheet
is a new item or an edit of an existing one. Matching on the name instead
would silently create a second item the first time "Fresh Orange Juice" is
renamed to "Orange Juice" — and leave the first one on the till.

**What it costs him:** friction he will feel. Every new row in the sheet
carries a short code he invents, e.g. `FB-PIZZA-MARG`. Export fills it in
automatically for everything that already exists, so it only bites on new
items typed straight into the sheet.

**Meanwhile:** specified as required, and recommended.

### 7c. The member-tier control on the admin Members screen: wire it or remove it?

**What was found — this is a bug, not a missing feature.** The dialog offers
a tier picker and a proof-type picker, accepts a change, closes without
complaint, and never sends it. Reproduced on staging: a member showing
`Thai · exp 2028-09-19` was set to Expat with a passport, saved, and the only
request sent carried nickname, phone and channel — no tier. The row was
unchanged. Meanwhile the panel's own footer reads *"Changes are saved to the
database and audited."*

**Exactly what he remembers.** The code carries a comment saying tier editing
stays out of Sprint 1, so this is half-built rather than overlooked — but the
control was left on screen.

**The till path works** and is complete: proof type, required expiry date,
audited, stamped with who checked it and at which branch, none of which the
caller can spoof.

**Why it matters beyond tidiness:** the pricing engine reads tier, so a member
left on the wrong one is charged the wrong price.

**The two options**, roughly equal in effort: **(a)** wire it — which also
means adding the document-expiry date field the admin dialog does not have at
all, ~40 lines; or **(b)** remove the control so the till is the single place
a tier changes, ~30 lines deleted. (a) is better if reception should be able
to correct a tier without ringing up a sale.

**Meanwhile:** unchanged and still misleading. This one should be settled
quickly for that reason.

### 7d. What "staff category / department" should mean

**What was found:** missing end to end above the database. The department
table exists, a staff record has a department field, and the permission engine
fully supports a department as a permission scope — but the invite dialog has
no such field, the account endpoints accept none, and no route lists
departments. The invite dialog's only fields are name, phone, role and branch.

**Why the answer changes the build:** rostering ("Ploy is Restaurant") and
permission scoping ("Ploy may manage Restaurant, at this branch only") share a
word and almost nothing else. The second is a bigger piece and touches the
permission resolver.

**What it costs:** 2–3 days either way, and it needs a database migration, so
it sits behind the Lucky Wheel booth's hold on the migrations folder.

**Meanwhile:** not built. A staff member's department is not recorded anywhere
a person can see or set.

### 7e. How far LINE should go

**What was found:** LINE is already scoped as a *messaging* channel — the
project context names it, the member record already lists it as a contact
channel, and the inbox design has the right home for a per-channel identifier.
What is scoped nowhere is LINE as a **registration surface for visitors**,
which is the new question.

**Also found:** Twilio cannot carry LINE. It announced support in 2018 and the
press release is still online, but the live documentation no longer lists it.
Going direct to LINE is free and well documented.

**What it costs:** the messaging adapter rides along with the inbox ticket at
no extra cost. Visitor self-registration is separate work after it, and brings
one consequence worth deciding early — LINE will not give us a phone number,
and the member record is keyed on phone. Our answer is to ask for the phone in
the registration form, keeping phone as the single identity. That leaves two
residues: the phone is claimed rather than verified, and the same person can
end up on two numbers, which phone uniqueness cannot catch. The second
eventually needs a merge tool — a proper ticket, because a merge must move
children deliberately rather than let allergy notes vanish with a guardian.

**Free and worth starting regardless:** creating the Official Account and
applying for verification (5–10 business days), under **one provider owned by
the park**. That last part is the only irreversible bit — LINE cannot move a
channel to a different provider later, and messaging and sign-in only share an
identifier when both sit under the same one.

**Meanwhile:** nothing built, nothing blocked. The adapter is in the inbox
ticket's scope; the live connection is explicitly out of it.

### 7f. Three smaller questions about the menu spreadsheet

**Allergens.** The task brief floated an allergens column. There are no
allergens anywhere in the approved design — allergies exist only on a child's
record. Adding one would invent a field the park has never asked for, with its
own screen work. **Meanwhile:** excluded.

**Weekday / weekend prices for food and drink.** The type supports a pair and
**not one seeded item uses it** — every weekend price equals its weekday
price. If the park never varies food by day, that column will sit empty
forever and can be dropped. **Meanwhile:** included, blank meaning "same as
weekday".

**Cost per item in the sheet.** It drives the profitability report, but it
also means the menu file he emails around contains his margins. **Meanwhile:**
included, and easy to drop.

**One more, smaller still:** the sheet is specified with English and Thai
only. The design carries five languages; ten name and description columns make
a sheet nobody can read. The other three stay in the item form until asked
for.

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
- **Photo upload: the server half now works, the browser half does not.** The
  write permission granted on the storage token was verified end to end on
  staging on 2026-09-21 — register, upload, ask for it back, exact bytes
  returned, and the boot probe is clean. A browser upload still fails at the
  preflight because the bucket carries **no CORS policy at all**; the rule to
  paste is in `OWNER_ACTIONS_AND_NEXT_BUILD.md` half one, action 2. Nothing is
  visibly affected either way, because **no screen in any app uploads or
  displays a photo**, and the profile-editing endpoint has no callers either.
- **`TWILIO_FROM` is set to a number that is not an SMS sender.** It is a US
  `+1` number whose digits match a WhatsApp sender on the same account — the
  only messages this account has ever carried are six WhatsApp ones. It is not
  the cause of the SMS failure (Twilio refuses before it looks at the sender,
  §2), but it will need correcting once the account can send at all.
- **The menu's database migration collides with the Lucky Wheel booth work.**
  Drizzle writes every migration into one shared journal and the booth session
  has an uncommitted one there now. The menu tables must be generated after
  that lands, or handed to that session to generate. It is the only hard
  ordering dependency in the current build queue.
