# POS gap register

_Compiled 2026-09-21 from five parallel audits of the deployed POS. Every line
below was established from the code at this commit or by driving
**https://oto-pos-staging.onrender.com** and
**https://oto-console-staging.onrender.com** — never from a document. Where a
document disagrees with the code, the code is recorded here and the document is
listed in §5 as a defect of its own._

**This file is the single answer to "is X built?".** If you are about to answer
that question from `CLAUDE.md`, from `SPRINT_2_PLAN.md`, or from memory: don't.
Answer from here, and if the answer is not here, drive it on staging and add it.

**Why it exists.** The owner remembered that changing a member's tier did not
work, and nobody could say whether it was never built, built and broken, or
built and working. It turned out to be built, working in the API, and thrown
away by the screen — because a comment in that screen cited a Sprint 1
document that was already false. §6 is the rule that stops that happening
again.

---

## 1. The headline

| | Count |
|---|---|
| **WORKS** — driven on staging, did the right thing | **33** |
| **BROKEN** — exists and misbehaves | **15** |
| **NOT BUILT** — no code path exists | **36** (20 we owe as ports, 16 never specified) |
| Total line items classified | **84** |

The full table, one row per line item, is Appendix A — the three numbers above
are countable from it.

**How complete the POS is, honestly.** The admission path — lock screen, sign
in, pick a station, take a phone number on the visitor-facing display, find the
member through the API, confirm their children, price the tickets by tier and
by weekday/weekend/holiday, apply a promo or a manual discount, report
inclusive VAT, and arrive at "Pay ฿1,440" — is real, end to end, against the
database. That is a genuine achievement and it is most of the counter's daily
work. **What happens after "Pay" is not built at all:** no tender is recorded,
no `sale` row is ever written, and a refresh loses the sale. Everything the
park sells that is not admission — F&B, shop, stock, events, the check-in
board, Today, History — renders beautifully and touches no database on any
screen, ever. Of the 24 admin panels in the POS, seven write to the database
and fifteen write to a JavaScript object that dies on reload, with no warning on
eleven of them. So: the front half of one of five selling flows is finished to
production standard; the back half of it and the other four are scenery. The
POS is not finished, and the distance is honestly measured in the BROKEN and
"we owe it" lists below, not in new ideas.

---

## 2. BROKEN — ranked by what a person hits soonest

Money and member records first, regardless of how often they are hit.

### B1 — The admin Members screen throws away a tier change

**In the owner's words:** you set a member to Thai, pick their proof, press
Save, the box closes without complaining — and they are still Tourist.

**What happens.** `/admin` → Members → Edit → *Verified tier* = Expat → proof
*Passport* → **Save changes**. The dialog closes, no error, no toast. Driven on
staging against member "Alex"; the complete network trace was
`PATCH /api/members/{id} {"nickname":"Alex","phone":"+66844444444","preferredChannel":"whatsapp"}`
then `GET /api/members`. `POST /members/:id/tier-verification` is never called.
`GET /members/:id` afterwards: `"tierCode":"tourist","tierVerification":null`.

**Where.** `apps/pos/src/components/admin/members/MembersPanel.tsx:76-90`.
`MemberFormDialog` computes `data.tierVerification` at
`MemberFormDialog.tsx:143-161`; `handleSave` destructures `nickname`, `phone`,
`preferredChannel` and drops the rest. The comment two lines above the bug is
the cause:

```
// Tier-verification editing stays out of Sprint 1 (CLAUDE.md §6 — the
// evidence UI is a later ticket); phone/nickname/channel persist to the API.
```

**Why it matters.** The tier sets the price of every ticket that member buys —
Tourist ฿1,090 vs Thai ฿620 on the same Full Day Pass. The API route, the
evidence rules, the audit row and the price path all exist and are tested. Only
the call is missing.

**Size:** ~6 lines in one file, plus a test. Half a day.

### B2 — The order panel shows the child price on the Adults row

**In the owner's words:** the screen the person taking the money reads quotes
the wrong price for adults, on every package we sell.

**What happens.** `apps/pos/src/components/till/OrderSummary.tsx:374` passes
`unitPrice={priceForTier(line.ticketType, line.tier)}` — the **child** price —
to the Adults row. It must be `resolveAdultLine(...).paidUnit`. Driven on
staging, Tourist / Full Day Pass, 1 child + 1 adult:

| | staff panel | visitor display | charged |
|---|---|---|---|
| Kids | ฿1090 each | 1 × ฿1090 | ฿1090 |
| Adults | **฿1090 each** | 1 × ฿350 | ฿350 |
| Total | | ฿1440 | ฿1440 |

Thai / Full Day with a free adult: the panel reads "Adults ฿620 each" beside an
adult who is free. The total and the visitor display are right; only the staff
panel lies. All four packages on this branch use `set_price` or `free_adults`,
so the one rule where the row happens to be correct (`same_as_kid`) is used
nowhere.

**Why it matters.** A staff member reading their own screen quotes ฿2,180 for a
฿1,440 sale, or charges for an adult who should walk in free. The file is
byte-identical to the prototype, so this is a faithfully ported prototype bug —
which is exactly why porting faithfully is not the same as shipping correctly.

**Size:** one line and a test. An hour.

### B3 — A tier verified before the visitor gives their details is lost

**What happens.** When staff verify a tier *before* the member exists in the
database (the ordinary walk-in order: verify the discount, take the details
after), `handleCustomerDone` creates the member with mockApi `createMember` and
records the verification with mockApi `verifyMemberTier` — in browser memory.
It is gone on refresh, and no evidence row is ever written.

**Where.** `apps/pos/src/pages/Till.tsx:1218-1226`,
`apps/pos/src/components/mobile/MobileTill.tsx:969`. The real API path in
`VerifyTierModal.tsx:79-105` runs only when `member.id` is already a UUID
(`isApiMemberId`, `VerifyTierModal.tsx:31-32`). Counter verification of an
existing member: **WORKS**. Deferred verification of a new walk-in: broken.

**Why it matters.** A discounted rate given with no record of who verified it
or what they saw is the one thing the evidence rules exist to prevent.

**Size:** half a day — create the member through the API first, then reuse the
existing verify call.

### B4 — A temporary password locks the person out of the till

**In the owner's words:** you issue someone a temporary password so they can
start their shift, and they cannot get in and cannot fix it.

**What happens.** Signed in as an account holding a temporary password:

```
200 POST /auth/sign-in
200 GET  /me
200 GET  /me/permissions
403 GET  /branches      MUST_CHANGE_PASSWORD
403 GET  /me/stations   MUST_CHANGE_PASSWORD
```

They land on the station picker reading *"Password change required before
continuing — Try again"* and *"No station here is yours to work"*. A full page
scan finds **no password field and no mention of changing a password anywhere**.
Staging's own denial log shows this happening to `zz-readiness-check` twice on
the day of the audit, before anyone went looking.

**Where.** `POST /auth/change-password` exists (`apps/api/src/routes/auth.ts:379`)
and the client wrapper exists (`apps/pos/src/api/platform.ts:64-65`) — **it has
no caller anywhere in `apps/pos`.** `OperatorContext.signIn`
(`apps/pos/src/auth/OperatorContext.tsx:231`) ignores the `mustChangePassword`
the sign-in response returns. The pattern already exists twice in this repo:
`apps/console/src/App.tsx:160` renders `<MustChangePassword />`, and
`apps/launcher/src/components/ChangePasswordPanel.tsx:28` calls the route.

**Why it matters.** A real person cannot start a shift, and the admin screen
promises *"a change is forced at next sign-in"* — true of the server, impossible
in the app.

**Size:** 1–2 days. Copy the Console's screen into the POS lock flow.

### B5 — The temporary password is printed on screen

**What happens.** `apps/pos/src/components/admin/access/LoginUsersPanel.tsx:196-199`
renders the generated password into a toast as its description, for 20 seconds,
in the DOM, on a shared counter screen. It is a working credential for another
person's account.

**Why it matters.** This codebase has already shipped a credential-on-screen
mistake once and the rule since was that a code on a screen is a credential.
Deliver it through the SMS adapter, or behind a deliberate reveal that is not
rendered by default and is never in a toast.

**Size:** ~10 lines, plus deciding the delivery. Half a day with B4.

### B6 — A child added at the supervision gate is never saved

**What happens.** The membership-check modal writes real children
(`PATCH /members/children/:id` → 200, audited, `lastConfirmedAt` bumped). The
till's supervision / drop-off gate calls mockApi `addSavedChild` /
`updateSavedChild` at `apps/pos/src/pages/Till.tsx:986, 1111, 1113`. A child
added — or an allergy corrected — at that gate lives in browser memory and dies
on refresh, while the same child edited one screen away persists. Same record,
two stores, no warning on either.

**Why it matters.** The record that is lost is the one carrying allergies and
medical notes for a child left in the park's care.

**Size:** half a day — point those three call sites at `membersApi`.

### B7 — The event-pass path cannot find a real member

**What happens.** `apps/pos/src/pages/Till.tsx:425` looks the member up in
mockApi on the event-pass path, so a member who exists in the database is not
found there.

**Size:** an hour.

### B8 — Adding or editing a customer tier saves nothing

**What happens.** `/admin` → Pricing & Money → Tiers & Pricing → *Customer
tiers* → **Add** is live on staging. A tier added this way appears in admin and
then in the till's tier list, and the complete server write log for the
operation is `[]`. `upsertTier` and `deleteTier` are passed raw into the mutator
bundle at `apps/pos/src/store/CatalogStoreContext.tsx:113` while ticket types,
holidays, tax and branches get `wired*` wrappers; `apps/api/src/routes/catalog.ts:39`
carries the comment *"Tiers (read path… CRUD stays mock, Q4)"* and there is no
write route.

**Why it matters.** It is the same shape as B1 — a live control over pricing
with nothing behind it — and it compounds into B9.

**Size:** 1 day — the route, the wiring, a test.

### B9 — A tier or adult rule with no price silently sells at ฿0

**What happens.** A tier that no package carries a price for resolves through
`priceForTier` → `resolveRate(undefined, mode)` → **`return 0`**. There is no
branch that avoids it. Two validation holes let that state be created through
the API: `TicketPackageBodySchema.prices` is an open
`z.record` (`packages/shared/src/catalog-shapes.ts:55`) so nothing requires
every active tier to be priced, and `TierAdultRuleSchema`
(`packages/shared/src/catalog-shapes.ts:23`) does not require `price` when
`kind: 'set_price'`, nor when `overflow: 'set_price'`. Either omission is ฿0 per
adult. The admin form always fills these today, which is the only reason it has
not happened.

**Why it matters.** Free tickets, silently, with no error anywhere.

**Size:** half a day — refine the schema and fail loudly on an unpriced tier.

### B10 — The till decides weekday or weekend on the browser's clock

**What happens.** The API resolves the rate mode on `branchToday(br.timezone)`
(`apps/api/src/routes/catalog.ts:299`). The cart uses `new Date()` in the
browser's timezone (`apps/pos/src/lib/pricingMode.ts:58`). Holiday ranges are
shared so holidays agree; the *clock* does not. Across a Friday→Saturday
boundary, or on any device not set to Asia/Bangkok, the header chip and the
price charged can disagree.

**Size:** ~2 hours — pass the branch timezone into `todayRateMode()`.

### B11 — The till prices in the browser with an untested copy of the rules

**What happens.** `apps/pos` imports exactly one symbol from `@oto/shared`:
`newId`. The tested engine — `packages/shared/src/{pricing,cart-totals,tax,discount,rounding,pricing-mode}.ts`,
~1,600 lines behind a 1,694-line test suite and a regression fixture file — has
**one** caller in the whole system: the public booking quote
(`apps/api/src/routes/public.ts:209`). The till prices in the browser, in baht
floats, from the prototype's copy of the same rules. The numbers agree today
because both are ports of the same logic. They are still two engines, and the
one under test is not the one taking money — B2 is precisely what that costs.

**Why it matters.** Every pricing fix now has to be made twice, and only one of
the two has a test that would catch a regression.

**Size:** large, and it is the core of S2-09a — 3–5 days to make the till quote
through the API (or through the shared engine) and delete the duplicate.

### B12 — A booking made online cannot be redeemed at the counter

**What happens.** `POST /public/bookings` writes the real `booking` table and
prices server-side. The till's `getAllBookings` and `redeemBooking` come from
mockApi. There is no path from one to the other.

**Size:** 1–2 days; it is inside S2-12's scope.

### B13 — Eleven admin screens save nothing and say nothing

**What happens.** Each one: the edit dialog closes, the row updates, **zero
network requests**, the change is gone on reload. Proven on staging by editing
and reloading: **Devices** (renamed Scanner 2), **Add-ons** (renamed Glow
Band), **drop-off pricing** (฿225 → ฿232 → back to ฿225), **Staff Benefits**.
Proven by an unwired mutator plus a missing route: **F&B Menu**, **F&B
Categories**, **Modifiers**, **Merch / Retail**, **Inventory**,
**Supervision**, **Markets & Tiers**.

Two panels in the group do say so (Add-ons and Modifiers carry *"Changes are
kept in memory for this prototype and reset on page reload"*, and Discounts &
Payments says it plainly). **Nine do not.**

**Where.** `apps/pos/src/store/CatalogStoreContext.tsx` bundles 45 mutators and
wraps exactly six in API write-through (`wiredUpsertTicketType`,
`wiredDeleteTicketType`, `wiredUpdateTaxConfig`, `wiredUpsertPricingOverride`,
`wiredDeletePricingOverride`, `wiredUpsertBranch`). The other 39 go straight to
`catalogStore.ts`, which has no persistence of any kind — not the API, not even
`localStorage`.

**Worst of the group: Tiers & Pricing is three behaviours in one panel.**
Holiday ranges persist. The drop-off and nanny prices directly above them do
not. The tier list beside them does not. Nothing on screen distinguishes them.

**Size:** 1 day to make all eleven state it truthfully; wiring them is the
"we owe it" work in §3.

### B14 — The POS Devices screen configures printers that nothing uses

**What happens.** `/admin` → Devices lists 14 printers, scanners and gates plus
4 EDC terminals with IP addresses, and offers full add/edit/delete. Every
consumer of the in-memory `devices` and `edcTerminals` collections was grepped:
**nothing outside the panel itself reads them.** `StationSetup.tsx:308` and
`station/fleet.ts` both read the real fleet API, and the Console's Devices area
is the real fleet. A manager can spend an afternoon configuring printers here
and it will affect nothing, persist nothing, and never be noticed — while the
Print Templates panel one row above correctly explains that routing is set per
iPad in Station Setup.

**Size:** half a day to remove it or label it; the real surface already exists.

### B15 — The whole POS admin area is gated on one client-side boolean

**What happens.** `apps/pos/src/components/admin/AdminAccessGate.tsx:31` checks
`operator.role !== 'manager'`, where `isManager` is "holds any `admin:*`
permission except `admin:branch:read`"
(`apps/pos/src/auth/OperatorContext.tsx:234-237`). There is no per-panel
permission check. Anyone over that one bar gets all 24 panels in the nav,
including the platform-admin Operators panel, which then fails at the API and
renders *"Platform administrators only."* The API refuses correctly, so this is
not a data breach — it is a nav that promises what it cannot do, and it means
the eleven in-memory panels are effectively ungoverned, because they never
reach the API to be refused. The Console does this properly, gating each
section on a real permission and hiding what an account lacks.

**Size:** 1 day.

---

## 3. NOT BUILT

Two groups. **They must not be confused.** The first is work we owe — the
prototype has it, the park's staff have used it, and we did not finish the
port. The second is work nobody ever specified as a screen; some of it was
named in a Sprint 1 document and never built, which is recorded per line.

### 3a. The prototype has it and we owe it

Prototype paths are relative to `imports/oto-pos/artifacts/oto-till/`.

| # | Capability | Prototype source | Note |
|---|---|---|---|
| P1 | Ticket cart, `sale` / `sale_line` / `payment_attempt` records | `src/lib/sale.ts` (`buildSale`), `src/mockApi.ts:1295` (`recordSale`) | **All three parts built in the tree; STILL BROKEN where they meet.** An integration check drove a real server with the till's own commit body: a ฿0 comp lands, and **every sale with money on it answers 409 `SALE_NOT_PAID` and writes nothing** — the till always sends `finalise: true` and the service will not finalise a sale that owes money until tenders (S2-10a) exist. With it: a refused cart can afterwards only be sold by discarding it (the idempotency key is the sale id and is never re-minted), and a branch-scoped account can write a sale at a branch it has no permission on. Pricing itself is right — quote equals the stored row on all thirteen shapes driven. Evidence and the two ways out: SPRINT_2_PROGRESS ticket log, *"S2-09a — the integration check"*. Not committed, not deployed. SCHEMA: migration `0014_sales_ledger` and `packages/db/src/schema/sales.ts` give `sale`, `sale_line`, `sale_discount` and `receipt_series` their real columns — station, box, business date, pricing mode and why, tier at sale time, net/service/VAT split, receipt number, checked totals, and a trigger freezing a finalised sale. TILL: the cart is priced through `@oto/shared` in satang (`src/lib/cartWire.ts`, `src/lib/cartQuote.ts`) instead of the browser's baht copy, and Pay calls `POST /sales` with a till-minted UUIDv7 so two presses are one sale (`src/lib/saleWriter.ts`); a refusal is a panel with Try again, and nothing prints or mints until the platform has the sale. PLATFORM: `apps/api/src/services/sale.ts` + `routes/sales.ts` answer those calls — quote from the shared engine, commit the sale with its lines and discounts in one transaction, ฿0 comp finalise with a per-station receipt number, `GET /sales` and `GET /sales/:id`; the tier comes from the member and a till-sent total can only cause a refusal. 28 tests drive the real routes with a real session. **Until it is deployed the till still prices locally, says so under the total, and the confirmation carries "Saved on this till only".** Tenders remain S2-10a; the Sale detail VIEW is still not built
| P2 | F&B menu persistence | `src/components/admin/menu/` | Editor complete, no route. Driven on staging: changed French Fries ฿90 → ฿97, saved, **zero requests**, reload restored ฿90 |
| P3 | F&B categories (two-level tree, prep station, tax category) | `src/components/admin/categories/` | `product_category` has no `parentId`, `sortOrder` or `defaultPrepStation` — the tree has nowhere to go |
| P4 | Modifier groups | `src/components/admin/modifiers/` | No modifier table exists at all |
| P5 | Merch / retail catalogue | `src/components/admin/merch/` | Includes cost and SKU, which `product` does not hold |
| P6 | Inventory: items, variants, locations, adjustments | `src/components/admin/inventory/` | `stock_item` / `stock_location` / `stock_level` exist and are referenced in exactly one place in the API: `demo-reset.ts`, which deletes them |
| P7 | F&B order checkout | `src/mockApi.ts:1335` (`recordFnbOrder`) | `apps/pos/src/pages/OrderStation.tsx:542` |
| P8 | Shop checkout | `src/mockApi.ts:1352` (`recordMerchOrder`) | `apps/pos/src/pages/MerchStation.tsx:216` |
| P9 | Add-ons as data | `catalogStore` `upsertAddOn` | Socks ฿50, Drink Cup ฿150, Glow Band ฿60 are priced components of a ticket line coming from mock data. No table, no route |
| P10 | Discount and promo definitions as data | `catalogStore` `upsertDiscount` | `STAFF10` / `MEMBER20` / `SAVE100` / `ICECREAM` are mock, usage counters are in memory, and no code is validated server-side |
| P11 | Child fields reception can see and edit | `src/mockApi.ts:771-799` (`SavedChildInput`: `dietary`, `foodRestrictions`, `notes`) | `ChildBody` accepts `medicalNotes`, `medicalAlert`, `dietary`, `foodRestrictions`, `notes`, `dateOfBirth`; `VisitChildrenModal` edits **`allergies` only**. A child on staging carries `medicalAlert:true` and `foodRestrictions:"No pork"` that reception can see nowhere |
| P12 | Member enrichment fields | `src/components/admin/members/MemberFormDialog` | `PATCH /members/:id` accepts `name`, `email`, `notes`; the dialog offers none of them |
| P13 | Check-in board, drop-off, nanny, pickups | `src/mockApi.ts:4477-5826` | Renders in full on `/drop-off` with zero API calls. On plan for S2-13 — but see §4 |
| P14 | Events, parties, camps | `src/mockApi.ts:3605` (`getEventsForDate`) | On plan for S2-20 |
| P15 | Today, and End of Day reconciliation | `src/mockApi.ts` + `src/components/today/` | On plan for S2-15a |
| P16 | History, refunds, voids, reprints | `src/components/history/` | `ReprintModal.tsx` is mock against a live, unwired `POST /print-jobs/:id/reprint`. On plan for S2-11 |
| P17 | Supervision and drop-off / nanny pricing persistence | `src/components/admin/supervision/` | One of the eleven in B13 |
| P18 | Staff benefits persistence | `src/components/admin/benefits/` | One of the eleven in B13 |
| P19 | Customer tier persistence | `src/components/admin/tiers/` | Same as B8 |
| P20 | Proof types and tier lists at the counter | `src/mockApi.ts` (`getProofTypes`, `getTiers`, `getDefaultTier`) | The list of proofs a staff member picks from when verifying a discount is mock, while `GET /tiers` is called only for catalogue hydration. Also `getAvailableDevices` in `StationSetup.tsx:26` and `lib/printRouting.tsx:2`, and `getOperatorThemePref` in `OperatorContext.tsx:12` |

### 3b. Nobody specified it as a screen

| # | Capability | Where it came from | Note |
|---|---|---|---|
| Q1 | **Create a branch** | `CLAUDE.md` §5/§10 acceptance ("create operator, branch, administrator") | `POST /branches`, `branchesApi.create` and `wiredUpsertBranch` all exist and **nothing calls them**. `BranchesPanel.tsx` offers only "Switch here" and clone-catalogue, and its own empty state reads *"Add more branches to use this feature."* An operator created today has no branch and no way to get one. The prototype has no create either |
| Q2 | **Add a role to an existing account** | SCRUM-22 ("add and remove role assignments") | `adminApi.assignRole` (`apps/pos/src/api/platform.ts:320`) has **zero callers** in any front end. Roles can only be chosen once, in the invite dialog, and the permissions drawer renders a **Remove** per assignment with no Add. Strip an account's last role and it cannot be restored from any screen. A one-way door |
| Q3 | Edit an account's phone | SCRUM-28 ("edit") | `adminApi.updateAccount` accepts `{ status, phone }`; `LoginUsersPanel.tsx:188` only ever passes `status`. A mistyped phone on an invite is permanent. (The API route itself works.) |
| Q4 | Employees and departments | `CLAUDE.md` §4 schema | `department` and `employee` are tables; there is no route and no screen. Staff names only ever arrive as a side effect of `POST /accounts` |
| Q5 | Department-scoped role assignment | `CLAUDE.md` §3 | `'department'` is a legal `scope_type` and unreachable in practice — the invite form offers operator or branch only |
| Q6 | Tax category and product overrides | `CLAUDE.md` §4, SCRUM-37 acceptance | `tax_override` exists, `GET`/`POST /branches/:id/tax-overrides` exist, no front end references them, and there is no `DELETE` — an override made by hand could never be removed. In practice the prototype's `taxConfig` cascade supersedes this model |
| Q7 | Profile photo upload | `CLAUDE.md` §10 acceptance | `POST /files` and `GET /files/:id/url` exist; `apps/pos/src` contains no upload call at all and every `photoUrl` is a mock or data URL |
| Q8 | `GET /visits` list | SCRUM-32 ("the visit is visible in the API") | `POST /visits` and `GET /visits/:id` exist; there is no list route, so you must already know the id |
| Q9 | Customer display as its own device | S2-08 (SCRUM-201), planned | The whole station-session surface is built and has no caller: `GET /stations/:id/session`, `POST .../lease`, `.../lease/renew`, `.../lease/release`, `.../intents`, `GET .../channel`. There is no `/display` route in `apps/pos/src/App.tsx`; the split view is still a shared-state harness. Membership lookup itself does cross through the API, so `CLAUDE.md` §7.4 is satisfied for lookup only |
| Q10 | Freebies and tier credit honoured at a sale | Configurable in our admin form and in the prototype; **honoured by neither** | The owner can configure "1 free adult ticket included" and no sale will apply it |
| Q11 | Menu import / export | Raised for Sprint 2 | None exists. `apps/pos/src/lib/csv.ts` is a browser download used only by the reporting panels over mock data. Note the import lands on a schema that needs reshaping first (P3–P5) |
| Q12 | Shift-token administration | S2-06 built the routes | `GET /accounts/:id/staff-tokens`, `DELETE /staff-tokens/:jti`, `GET /staff-tokens/settings` — no screen lists or revokes a staff badge token |
| Q13 | Real print routes wired to screens | S2-06 / S2-11 | `POST /stations/:id/test-print` (the POS queues a box command instead), `GET /branches/:branchId/print-jobs`, `POST /print-jobs/:id/reprint`, `POST /boxes/:id/simulate`, `GET /devices/:id/printouts/:seq/preview.png` all have no caller |
| Q14 | Scanner routes wired to screens | S2-06 | `POST /stations/:id/scan/simulate`, `POST /stations/:id/button` |
| Q15 | A settings surface | — | Console Integrations reports Twilio, R2, jobs and alert channels as Configured/Off with no way to change any of them, and there is no settings screen in either app |
| Q16 | A product/menu schema that can hold the menu | prerequisite for P2–P6 | `product` has six business columns; the prototype's `MenuItem` (`apps/pos/src/types.ts:755`) additionally carries a weekday/weekend price pair, `cost`, inline `modifierGroups`, `linkedModifierGroupIds`, `prepStationOverride`, `taxCategoryOverride`, `inventoryItemId` and `translations`. The seed inserts one category and one product ("Ice Cream Cone") whose own comment says it exists so the tax resolver has a target — anyone querying `product` to see the menu gets one ice cream |

---

## 4. Looks real and is not

Every screen below renders convincingly and touches no database. The column
that matters is the last one.

| Screen | Route | What it shows | Does anything admit it? |
|---|---|---|---|
| **Low-stock strip in the header** | **every screen** | *"1 out of stock · 2 low — Mascot Keyring, Grip Socks (Merch), Slushie (Green)"* (`StationHeader.tsx:64-67,261`) | **No.** It sits on the Tickets tab and the membership check — screens that *are* real — so it reads as live telemetry from a working stock system |
| **Inventory panel** | `/admin` | 15 items, 19 variants, and a footer asserting *"Sale decrements and refund restores happen automatically… these are stamped with your operator ID"* | **No — and it claims the opposite.** None of that happens. It is the only panel in its group with no in-memory notice, and the one asserting server-side behaviour |
| **Events** | `/parties` | 5 events generated relative to today, named children, outstanding balances of ฿5,800 / ฿9,940 / ฿9,800 | **No** |
| **Today → End of Day** | `/today` | Four EDC terminals by TID, float ฿6,000, per-channel expected vs actual, and a live **Close Day** button | **No** |
| **Today → Performance** | `/today` | Revenue and occupancy figures | **No** |
| **History** | `/history` | 8 transactions with staff attributions and Paid / Partial refund states | **No.** The only accidental tell is that the dates are stale, which stops being a tell the moment someone refreshes the fixtures |
| **Reporting panels** (5) | `/admin` | *"Revenue by category — ฿500.00 total, 1 txn"*, *"LIVE BALANCE (TODAY) ฿2,120.00"* — from `lib/reporting.ts:19` → mockApi in-memory arrays | **No.** These will be read as real money |
| **Check-in board / drop-off / nanny** | `/drop-off` | Family cards, DROP-OFF and NANNY badges, overdue timers, allergy lines, guardian WhatsApp state, *"Sim: parent confirms"* | **No.** Zero API calls beyond the station PUT |
| **Shop sell grid** | `/merch-station` | *"40 in stock"*, *"Low stock · 6 left"*, *"Out of stock"* | Only the wristband step is labelled **DEMO WRISTBANDS**; the grid is not |
| **F&B menu grid** | `/order-station` | 20 items, 7 categories | Same — wristbands labelled, grid not |
| **POS Devices** | `/admin` | 14 printers/scanners/gates and 4 EDC terminals with IP addresses, full CRUD | **No** (B14) |
| **9 of the 11 unpersisted admin panels** | `/admin` | Ordinary tables and edit dialogs | **No** (B13) |

The pattern that works is already in the building: the F&B and Shop wristband
steps carry a plain **"DEMO WRISTBANDS"** heading and nobody is fooled. Twelve
surfaces need the same and do not have it.

**Owner decision, 2026-09-21 — this changes the remedy for most of the table.**
Staging is to be seeded from the park's own production rows rather than from
invented fixtures, at roughly **10–15% of the data**, because this is internal
testing. So for these screens the target is not a label but real rows behind
them (S2-22, SCRUM-222, and the per-area tickets above). Until a screen has
them, it says so on the screen. Two things stay true whatever the seed:
staging is on the public internet, and a 10–15% sample still contains real
staff and real children with real allergy notes — so access to staging stays
restricted and nothing from it goes into a document, a screenshot or a ticket.

---

## 5. Stale documents — each one is a defect

| Statement | Where | What is actually true |
|---|---|---|
| The tier field has *"no UI to change it yet"* | `CLAUDE.md` §11 | **False.** `POST /members/:id/tier-verification` records evidence and updates the tier in one transaction, with a verify modal at the counter and a Tier Verifications panel in admin listing 3 recorded upgrades. **This sentence is cited in the code as the reason the admin screen drops the tier (B1) — a stale document that caused a defect** |
| *"Member tier change UI with evidence (schema exists; UI is a later ticket)"* | `CLAUDE.md` §6 | **False**, same as above, and it is the exact line quoted in `MembersPanel.tsx:77-78` |
| *"Evidence rules for expat and Thai tiers are not yet defined"* | `CLAUDE.md` §11 | Evidence type and expiry are defined, enforced, and rejected on failure — missing evidence is `400 VALIDATION`, an expired document is refused by message |
| *"Included adults on a ticket package are counted per child ticket"* | `CLAUDE.md` §11 | **False.** `resolveAdultLine` computes `Math.min(adults, rule.freeAdults)` with no reference to children — per line. Proved on staging: Thai Full Day (1 free), 2 children + 2 adults = ฿1,590, not the ฿1,240 a per-child rule gives |
| `ticket_package` has `kid_price_weekday`, `adult_price_weekday`, `included_adults`, `overflow_adult_price` | `CLAUDE.md` §4 | A single-tier model that was never built and does not fit the park's rules. The real shape is a per-tier `prices` map plus a per-tier `adultRules` map with three kinds. §4 has been wrong since Sprint 1 |
| `branch_tax_rule` as `vat_rate_bp` + `service_charge_bp` | `CLAUDE.md` §4 | Superseded by the prototype's category cascade — per-category mode, service charge, tax-on-service, secondary rates, `discountPlacement` — which is what is deployed |
| The §6 out-of-scope list | `CLAUDE.md` §6 | Largely overtaken: printing, stock schema, check-in, station and device work are built or building. The header does flag §§5, 6, 9, 10, 11 as superseded — and the §11 tier line was still read as current, which is the point |
| *"6.4 Branch catalog, pricing, checkout — Complete"*, *"6.11 Inventory and purchasing — Complete"* | `SPRINT_2_PLAN.md:274-281` | That column means **plan coverage**, not code. Anyone scanning it for what is built reads it the other way — which is how the tier question went wrong. It should say "planned" |
| *"63 routes in 12 groups… zero `db.transaction(`… 63 Vitest cases in 7 files"* | `SPRINT_2_PLAN.md:110` | Not stale — it is the "Built in Sprint 1" column of a before/after table. Today: **153 routes in 21 files**, 23 services, 33 test files, `withTx` in 21 files. It needs a dated header or a reader will misread it |
| The POS row claiming "tier verification (upgrade with expiry only)" is wired | `SPRINT_2_PLAN.md` | True at the till, false in admin (B1) |
| *"reviewed by the client"* | `STATUS.md:12` | Names the commercial relationship, against this repo's own standing rule. Say "reviewed by the owner" |
| *"The agency proposal's future scope"* | `SPRINT_2_JIRA_MAP.md:79` | Same rule. Say "the delivery proposal's future scope" |
| *`STAGING_READINESS.md`* | — | **Not a defect.** §5 is accurate, and it already carries four of these findings (no branch-creation screen at lines 40 and 227-231, the toast white-screen at 221-224, reports on mock at 270, the "(temp)" labels at 267). It does **not** carry: `assignRole` unreachable, the Devices panel orphaned, the eleven silently unpersisted panels, or the client-side admin gate |

`CLAUDE.md` §11's remaining assumptions check out: weekend = Saturday and
Sunday (`packages/shared/src/dates.ts:100-101`), holidays as branch date ranges
(`catalog.ts:286-310`), 7% VAT inclusive, phone unique per operator.

---

## 6. What this changes about how we work

The tier gap was not missed through carelessness. It was missed by a mechanism:
an assumption was written into a Sprint 1 document, the assumption was never
turned into a ticket, the document outlived the assumption, and then a
developer read the document, believed it over the code, and wired a live form to
nothing — *citing the document in a comment as the justification*. Every step of
that is repeatable today. These five rules are the specific things that break
it, and each one is checkable by a person or by CI.

**Rule 1 — An assumption is a ticket or it is closed. It is never just a
sentence.** Every bullet in a §11-style assumptions list and every line in
`OPEN_QUESTIONS.md` must end with either a `SCRUM-nnn` key or
`CLOSED: <commit>`. *Check:* a CI step greps those sections for a bullet
matching neither and fails the build. This is a five-line script and it would
have caught the tier line on the day Sprint 2 opened.

**Rule 2 — No source comment may cite a document as a reason not to do
something.** A document has no status; a ticket does. If work is deliberately
deferred, the comment cites the Jira key that owns it. *Check:* CI greps
`apps/**` and `packages/**` for `CLAUDE.md §` or `docs/` in a comment and fails.
The exact comment that caused B1 is the test case.

**Rule 3 — A capability's state is set by driving it, never by reading.** A
ticket moves to Testing only with an evidence comment naming what was clicked
and the request and response that resulted. *Check:* the reviewer rejects a
Testing comment with no request line in it. "Tests pass" is not evidence that a
screen calls a route — B1, B4 and Q2 all have green tests around code no screen
reaches.

**Rule 4 — A screen that does not persist says so on the screen, or it does not
ship.** *Check:* a Vitest case asserts that every key in the
`CatalogStoreContext` mutator bundle is either in the wired set or in an
explicit `MOCK_MUTATORS` list, and that every panel using a mock mutator renders
the shared in-memory notice. New mutator, no decision, red build. This is the
one that turns B13 from a recurring surprise into a compile-time choice.

**Rule 5 — This register is the single answer, and it is re-driven at every
checkpoint.** At each Sprint 2 checkpoint, one pass re-runs Appendix A and
updates each row from staging; a row may not change state without the evidence
line that changed it. When a row moves to WORKS, the document that said
otherwise is edited in the same commit. *Check:* a checkpoint is not passed
while `POS_GAP_REGISTER.md`'s header date is older than the previous
checkpoint.

One more, which is not a rule but a habit worth naming: **three of the four
findings that cost the most here are the same shape** — a route that is built,
tested and reachable by nobody (`assignRole`, `change-password`, the whole
station-session surface). A route with no caller is not half-done work; it is
an untested claim. Appendix B lists the 25 that exist today, and each should
either get a caller or be deleted.

---

## 7. Where each item is tracked

Sixteen issues were raised from this register on 2026-09-21, all labelled
`pos-gap-register` and `sprint-2`, all created at To Do. **No existing ticket's
status was changed.** Items already owned by a Sprint 2 story are listed with
that story rather than duplicated.

| Register item | Jira | Placed under |
|---|---|---|
| B1 tier change discarded | **SCRUM-225** | S2-09 (SCRUM-202) |
| B2 child price on the Adults row | **SCRUM-226** | S2-09 |
| B3 deferred verification lost | **SCRUM-227** | S2-09 |
| B8 + B9 tier CRUD unwired, ฿0 fallback | **SCRUM-228** | S2-09 |
| B10 + B11 browser clock, two engines | **SCRUM-229** | S2-09 |
| P9 + P10 add-ons and discount codes as data | **SCRUM-230** | S2-09 |
| P11 + P12 member and child fields | **SCRUM-231** | S2-09 |
| Q16 + P2–P6 menu schema reshape | **SCRUM-232** | S2-09 |
| B6 + B7 supervision-gate child, event-pass lookup | **SCRUM-233** | S2-13 (SCRUM-210) |
| B12 online booking unredeemable | **SCRUM-234** | S2-12 (SCRUM-209) |
| B4 + B5 temporary password, credential on screen | **SCRUM-235** | epic SCRUM-181 |
| B13 + B14 eleven silent panels, orphaned Devices | **SCRUM-236** | epic SCRUM-181 |
| B15 client-side admin gate | **SCRUM-237** | epic SCRUM-181 |
| P20 mock lists on live screens | **SCRUM-238** | epic SCRUM-181 |
| Q2 + Q3 add a role, edit a phone | **SCRUM-239** | epic SCRUM-181 |
| Q1 create a branch | **SCRUM-240** | epic SCRUM-181 |

Already owned, not duplicated: P1 sale ledger → **SCRUM-203** (S2-09a);
P2–P8 catalogue and carts → **SCRUM-204** (S2-09b), gated on SCRUM-232;
P13 + P17 check-in, drop-off and its pricing → **SCRUM-210** (S2-13);
P14 events → **SCRUM-217**; P15 Today and End of Day → **SCRUM-215**;
P16 History, refunds and reprints → **SCRUM-208**; P18 staff benefits →
**SCRUM-218**; Q9 the visitor display as its own device → **SCRUM-201**;
Q12–Q14 the unwired print, scan and token routes → **SCRUM-197** / **SCRUM-208**;
staging on the park's own data → **SCRUM-222**. Payments (no tender is recorded
anywhere today) → **SCRUM-206**.

Not ticketed, recorded here only: Q4–Q8, Q10, Q11, Q15 — each is either
schema-without-a-screen or a decision to take before it becomes work.

## Appendix A — the classification, one row per line item

**WORKS (33)** — each driven on staging.

| # | Capability | Evidence |
|---|---|---|
| W1 | Sign in by phone, per-origin session, lock screen | Driven on both origins by every sweep |
| W2 | Rate mode from the API (weekday / weekend / holiday) | `GET /branches/:id/pricing-mode`: weekday Mon–Tue, weekend Sat 26 / Sun 27 Sep, *"Weekend pricing — Loy Krathong"* 24–25 Nov, correctly outside the range on 23 and 26 Nov |
| W3 | Per-tier child prices on the ticket grid | Tourist ฿690/890/1090/1300, Thai ฿420/520/620/1300 — exactly the API's satang |
| W4 | Adult rule `set_price` | Tourist Full Day, 1 child + 1 adult = ฿1,440 |
| W5 | Adult rule `free_adults` with overflow | Thai Full Day (1 free, overflow ฿350), 1 child + 3 adults = ฿1,320 |
| W6 | A tier change re-prices the open order | `restateLinesToTier` (`Till.tsx:551`); the whole grid re-priced on Mali's verified Thai tier |
| W7 | Inclusive VAT 7%, reported not added | ฿1,440 → "VAT included ฿94.21" |
| W8 | Promo code applied before tax | `SAVE100` on ฿1,240 → ฿1,140, VAT recomputed to ฿74.58 |
| W9 | ฿0 order reaches payment with the VAT row suppressed | Driven |
| W10 | Manual discount dialog | Whole order / single item, percent / fixed / comp, seven reasons, note |
| W11 | Admin: ticket packages create / edit / archive | `200 PATCH /api/branches/{id}/ticket-packages/{id}`, held through reload |
| W12 | Admin: holiday ranges | `200 POST`/`DELETE …/holidays`, held through reload |
| W13 | Admin: branch VAT and service charge | `200 PUT /api/branches/{id}/tax-config`, 7 → 10 → reload → 10 → restored |
| W14 | Visitor display → till membership lookup, through the API | `PUT /me/session/pending-lookup` → `/consume` → `GET /members/lookup`. No shared browser state — `CLAUDE.md` §7.4 satisfied |
| W15 | Lookup by Thai local phone | `0899000111` → `+66899000111` |
| W16 | Create a member from phone + name | `200 POST /members` |
| W17 | "Skip — walk-in (Tourist)" | Advances with no member, Tourist pricing |
| W18 | Children re-confirm, allergy edit, visit created | `PATCH /members/children/:id` 200 → `POST /visits` 200, `lastConfirmedAt` set on both children |
| W19 | Tier verification recorded with evidence (existing member) | One transaction, verifier stamped from the session, audit row written |
| W20 | Evidence rules enforced | No evidence → `400 VALIDATION`; expired document → `400 BAD_REQUEST`; unknown tier → `400 BAD_REQUEST` |
| W21 | An expired verification is suppressed on read | `members.ts:122-125` — the till asks for fresh proof, the row survives for audit |
| W22 | Admin: Tier Verifications list | 3 records with proof, expiry, verifier, branch |
| W23 | Admin: member nickname / phone / channel | `200 PATCH /api/members/{id}`, held through reload |
| W24 | Effective permissions resolve and display with scopes | 45 permissions, branch-scoped |
| W25 | Admin: deactivate an account, evict its sessions, refuse sign-in | Driven |
| W26 | Admin: operators create / archive | `200 POST /api/operators`, `200 PATCH`; archived operators leave the pickers |
| W27 | Admin: print templates | `200 PATCH /api/print-templates/{id}`, held through reload |
| W28 | Switch the active branch | Branch context reloads the catalogue from the API |
| W29 | Console: Health | Live DB pool, `/ready` timing, both boxes, watchdog, scheduled jobs |
| W30 | Console: Failures | Grouped problems, request ids, quarantine with replay and discard |
| W31 | Console: Activity (audit log) | Filters by actor, action, outcome, request id, entity, date; records its own sensitive reads |
| W32 | Console: Devices | Add a box, new station, edit station, pair a screen, claim codes — fully writable |
| W33 | Console: Integrations (read-only status) | Twilio, R2, jobs, alert channels reported Configured/Off |

**BROKEN (15)** — B1…B15 in §2.

**NOT BUILT (36)** — P1…P20 in §3a (20, ports we owe) and Q1…Q16 in §3b (16,
never specified as a screen).

## Appendix B — built, tested, and called by nobody

25 routes. Each has API tests; no front end reaches them. (Four apparent
orphans were query-string artifacts and *are* called: `pricing-mode`,
`boxes/:id/heartbeats`, `ops/quarantine`, `ops/anomalies`.)

- **Station session, the whole surface** (`routes/stations.ts:235, 274, 331, 356, 386, 423`) — Q9
- **Printing** (`routes/print.ts:239, 336, 393, 428, 513`) — Q13
- **Scanning** (`routes/scanning.ts:175, 309`) — Q14
- **Staff tokens** (`routes/staff-token.ts:168, 195, 218`) — Q12
- **Tax overrides and catalogue** (`routes/catalog.ts:368, 379, 425, 452`) — Q6
- **Files** (`routes/files.ts:109, 157`) — Q7
- **Visits read-back** (`routes/visits.ts:103`)
- **Accounts** — `POST /accounts/:id/role-assignments` (`routes/accounts.ts:193`) — Q2
- **Auth** — `POST /auth/change-password` (`routes/auth.ts:379`) — B4
- **Box key rotation and cache pull** (`routes/box.ts:236, 276`) — not a defect: the agent ships its key on push and heartbeat and pulls via `/box/v1/cache`; this is the rotation door, built for a rotation nothing performs yet

One call in the other direction: `apps/console/src/api/fleet.ts:490-501` calls
`GET /boxes/:id/log`, which does not exist. Its own comment says so, the client
reads 404 as "not on this deployment", and `BoxDrawer.tsx:929` degrades to
command results. Honest — and still a permanently-404ing call in shipped code.

The seven cloud booth routes (`routes/booth.ts:178-291`) are **not** counted:
`apps/booth/src/booth/client.ts:38` points at the box agent, and that wiring is
in flight as this was written.

## Appendix C — how this was established, and what was touched

Five parallel sweeps (money, people, catalogue, admin, structural) read the
code at this commit and drove staging as admin `900000001` and reception
`900000002`. **No application source was modified; nothing was staged or
committed.** Everything changed on staging was put back: the renamed ticket
package, VAT 7% → 10% → 7%, a print-template toggle, a member nickname, a
holiday range (deleted), a test operator (archived), a child's allergy note
(restored verbatim). Two rows remain because they cannot be deleted, only
archived: member `ZZ Audit Tier` (archived) and account `ZZ Audit TempPw`
(inactive). One ordinary draft `visit` from the normal confirm flow was left as
the business record it is. In-memory edits (a menu price, a device name, an
add-on, a drop-off fee, a staff benefit) reverted themselves on reload, which
was the finding.

Nothing indeterminate was left in the money, people, catalogue or structural
areas. Two things were deliberately not pressed: **Close Day** on the End of
Day tab (mock, but the only control whose name implies an irreversible act) and
the Console's write actions (Add a box, Pair a screen, quarantine replay, the
Health test controls), because another workflow is building against that shared
state. Classifications of `packages/box-agent`, `apps/booth`,
`routes/booth.ts` and `services/{sync,booth,box,ops}.ts` are as of this read —
those files were changing while they were being read.
