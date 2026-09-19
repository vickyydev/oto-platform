# Oto POS — Backend Logic & Requirements (previous developer, v3.0)

> **Source:** document supplied by the previous developer, received 2026-09-19
> (`oto-pos-backend-logic-document.docx`, converted to Markdown without edits to
> the wording; the original sits in `imports/oto-pos/docs/`, local only). It
> explains the business rules the Replit POS prototype encodes and what it
> deliberately fakes. **Precedence:** it ranks with the prototype code as the
> source of POS business rules (see `/CLAUDE.md` section 2);
> `PROJECT_CONTEXT.md` (September 2026) is newer and wins where they conflict —
> notably face login (banned there), branch names (the real ones are Central
> Floresta and Robinson Chalong) and the device/offline model. The reconciled
> conflicts, the numbered rules checklist (`R-nn`) that tickets cite, and the
> schema deltas are in `docs/architecture/POS_RULES_RECONCILIATION.md`.
>
> Version: 3.0 (supersedes data-model notes v1 and v2) Audience: the backend engineer(s) who will build the real system behind the Oto POS front-end prototype. Purpose: the front-end (Replit, React + Vite + TypeScript) is a clickable specification — front-end only, all data served from mock files. This document explains what the system does, the business logic and rules behind each module, the data model, what is deliberately faked, and where the real backend work lives. Read this first; then read types.ts (the single source of truth for shapes) and mockApi.ts (the swap seam).

## 0. How to read this system

### 0.1 Architecture of the prototype

Front end only. No backend, database, auth service, payment gateway, messaging, or real API calls exist.
All data flows through src/mockApi.ts. This is the swap seam — replace each mock getter/mutator with a real API call; the UI consumes identical shapes.
All types live once in src/types.ts — single source of truth.
State is React state / context only. No browser storage for app data. Mock balances, counters, and photos reset on reload — expected.
Editable config lives in src/store/catalogStore.ts (via a store context + useSyncExternalStore).

### 0.2 The two big audiences of surfaces

Operational POS (staff-facing, iPad-first landscape + a mobile/phone layer): ticket till, F&B order station, drop-off/check-in board, events, history, today, messaging, stock module.
Admin / back-office console (manager-only): all catalog and configuration — tickets, menu, tax, supervision, inventory setup, discounts, devices, members, branches, reporting.
Customer-facing surfaces: a customer display (dual-screen with the till), the self-service consent/photo capture, and the public booking site.

### 0.3 The single most important cross-cutting concept: phone = identity

A customer is identified by phone number (stored as a full international number — see §12). Their tier verification, saved children, preferred contact channel, and wallet all hang off that identity. A returning customer enters their phone and everything is recalled — no re-entry. This must hold across branches (see §11). Design the customer/member record as globally unique by normalized phone.

## 1. Tenancy & branches (multi-location)

### 1.1 The model

Branch { id, name, country?, active }. Seeded: “HKT Central”, “HKT Chalong”. The branches registry is shared/global.
An active-branch context is app-wide (like the operator context). A device operates “as” a branch; a branch switcher sets it.

### 1.2 What is global vs per-branch — critical for the schema

GLOBAL (shared across all branches): customers/members (one phone → one member everywhere), their saved children, tier verification, wallet identity, preferred contact channel; the branches registry itself.
PER-BRANCH (scoped by branchId): all operational data — sales/transactions, F&B orders, refunds, check-ins/registrations, events + attendees, station/device setup, end-of-day, floor/occupancy, inventory/stock, and the entire catalog/config (tickets, menu, categories, modifiers, merch, event pricing, tax config, supervision policy, discounts/promos, print templates, devices).
Every operational record is stamped with branchId. Every operational read is filtered by the active branch. A member’s activity aggregates across branches but each transaction shows which branch it occurred at.

### 1.3 Catalog cloning

A new branch is created by deep-cloning another branch’s entire catalog/config (fresh ids), then editing locally. After cloning, branches are fully independent — no central sync. Admin has a “Clone from another branch” action.

### 1.4 Backend requirements

Model tenancy as: global customer domain + per-branch operational/catalog domain + shared branch registry.
Enforce branch scoping on every operational query. A missed filter = one branch’s data leaking into another (the highest-risk bug class here).
Catalog clone = transactional deep copy with new primary keys.

## 2. Identity, tiers & members

### 2.1 Customer tiers (pricing tiers)

CustomerTier = tourist | expat | thai. (Markets — an earlier TH/MY concept — were removed entirely; tiers are no longer scoped by market.)
Tier drives ticket pricing (§3). Tourist is the base/top price; expat and thai are discounted. Verified by showing proof (driving license, school card, residence permit) — captured as a TierVerification (proof type, verified-by operator, timestamp).
Strict resolution: a booking/sale resolves the tier as verified-or-tourist. Online (self-service) never grants a discounted tier without the strict rule.

### 2.2 Member

Member keyed by phone (full international number). Holds: tierVerification? (single, not per-market), savedChildren?: SavedChild[], preferredChannel? (whatsapp|telegram|line), and is the anchor for the wallet.
Returning customer: enter phone → member resolves → verified tier + saved children returned. No ID re-show once verified.
A member can be created minimally (phone + name) at reception or booking, then enriched over time.

### 2.3 Saved children

SavedChild = everything except a photo: childName, childAge/dateOfBirth, allergiesMedical, dietary, foodRestrictions, notes, savedAt, updatedAt. No photo stored — re-taken every visit.
On return: saved children pre-fill the drop-off/booking/event forms; the parent re-confirms “still correct?” per child (Confirm / Edit) — never silently auto-applied. Consent + supervision still run each visit.
A member may have multiple saved children and bring a subset: each has a “coming today” toggle; only selected children proceed; “Add another child” captures a new one (saved to the member by default). Applies at reception AND booking site.

### 2.4 Backend requirements

Global unique member by normalized phone. Children’s data (saved children, photos, allergies) is minors’ personal data — requires explicit consent records, retention limits, and access control (see §8.6). The prototype holds it in memory only.

## 3. Pricing model (the heart of the system)

This is the most nuanced area. Pricing has three independent axes that combine: who the guest is (tier), what package they buy (ticket type), and when they visit (weekday/weekend/holiday).

### 3.1 Ticket type = the full entry package

Each ticket type owns its whole entry package, configured per tier (tourist/expat/thai) AND per rate mode (weekday/weekend): - kidPrice — child play price; drives length-of-stay and the bracelet. - adultRule — one of: - same_as_kid (adult price = kid price for that tier), - set_price (explicit adult amount), - free_adults (N adults included free; extra adults fall back to an overflow price). - freeAdults — integer count included. - creditRule — the F&B/wallet give-back: appliesTo = adults | kids | both; type = full_price | fixed | percent (+ value). E.g. Play & Eat = both/full_price; standard = adults/full_price. - gateAccess — adult admissions on this ticket issue gate-opening bands; kids do not (see §7). - Plus name, duration label, hours.
There is NO separate park-wide “adult admission” price — adult pricing lives inside each ticket type. (An earlier standalone adult-admission block was superseded by this per-ticket model.)

### 3.2 Worked examples (must hold)

Standard / Tourist: adults at their set price; credit to adults only.
Any ticket / Thai with freeAdults=1: first adult ฿0, additional adults at overflow price.
Play & Eat: adult price = kid price; credit = both, full price (all money spendable in F&B); free park entry.

### 3.3 Weekday / weekend / holiday (the time axis)

Every price in the system stores two values: { weekday, weekend } (per tier where applicable). This includes tickets (kid + adult), drop-off, nanny/hr, extra hour, add-ons, merch, event passes.
Rate resolution for a date (getRateModeForDate(date)):
date falls in a named holiday override range → weekend pricing;
else Saturday/Sunday → weekend;
else weekday.
Holiday overrides = pricingOverrides collection: { name, startDate, endDate } (inclusive), each forcing weekend pricing across the range. Admin-managed (e.g. “Songkran, Apr 13–15”). Can differ per branch.
The POS shows which mode is active and why. Every price read must go through the resolver.

### 3.4 Reference price data (from the printed guide — verify exact numbers with owner)

Kids entry per tier with a resident/expat discount off Tourist: −30% weekday, −20% weekend. Tourist 1h 690, 2h 890, full-day 1090; Thai 1h 420/520, 2h 520/620, full-day 620/720 (wk/wknd). Eat & Play Kids Pass 1300 all tiers.
Adult admission (where applicable via a ticket): 350 weekday / 500 weekend, full-price F&B credit, flat across tiers. Play & Eat adult stays 350 even on weekends.
Services: nanny 330/hr, drop-off 225, extra hour 300 (weekday=weekend unless changed).
Note: the Expat column is sometimes derived (Tourist −30%/−20%), sometimes an explicit number — confirm real figures with the owner before go-live.

### 3.5 Backend requirements

Price = a {weekday, weekend} pair (per tier where relevant), never a scalar. Date-based rate resolution + a holiday calendar (per branch) are core.
Ticket package resolution (kid/adult/free-adults/credit) must be a deterministic server function; the POS calls it.

## 4. Tax & service charge engine

### 4.1 Three configurable layers (cascade: product → category → global)

Global: the tax rates (e.g. VAT 7%) and the discount placement rule (before/after tax).
Category rule (CategoryTaxRule, per category — Tickets/F&B/Bar/Drop-off/Parties/Add-ons/Merch/Event Passes): which rate applies, mode (inclusive | exclusive | none), service charge % for that category, and tax-on-service-charge toggle.
Product override: an item’s taxCategoryOverride overrides its category.
Resolution order: product override → category rule → global rate.

### 4.2 Computation rules (must replicate exactly for receipts + VAT filing)

Service charge = % of line revenue.
Tax-on-service-charge on → VAT computed on (base + service). Off → VAT on base only, service sits outside the tax base.
Inclusive mode → the entered price already contains tax; the engine back-calculates VAT (and service, if inclusive-of-both) out of the displayed price.
Supported: inclusive-of-VAT-only, and inclusive-of-VAT-and-service (engine unwinds both).
Decomposition order for inclusive prices must match the build-up order — confirm the exact sequence with the accountant (rounding + order affect the reported VAT).

### 4.3 Backend requirements

Reproduce this math server-side for receipts and VAT filing; the reporting/tax export (§14) must match to the satang. Rates/sequence are the accountant’s decision — make them config, not code.

## 5. F&B module

### 5.1 Menu

MenuCategory (two-level: parentId for sub-categories) with defaultPrepStation and defaultTaxCategory; items can override (prepStationOverride, taxCategoryOverride).
MenuItem with optional modifierGroups (variants). Reusable modifier library (modifierGroups collection + linkedModifierGroupIds on items).
ModifierGroup (required?, single|multi, min/max) → ModifierOptions each with a price delta.
Line total = (base + Σ selected option deltas) × qty. Modifier deltas multiply by quantity.
A live search bar filters the menu by dish number or name (any word/part), for large menus.

### 5.2 Ordering & guest link

F&B orders can be standalone or linked to a guest by scanning their wristband/QR (charges to that guest, shows in history, enables allergy alerts).
Allergy alert: scanning a flagged child’s band fires an alert at the F&B station.
Prep-station routing (kitchen/bar) via category default + item override.
Item notes; tap-to-edit cart lines (reopens modifier sheet pre-filled).

### 5.3 Backend requirements

Canonical prep-station + tax-category resolution. Real KDS routing is a backend concern.

## 6. Wallet / F&B credit + promo vouchers (two DISTINCT concepts)

These were deliberately separated — do not conflate them.

### 6.1 F&B credit / wallet (prepaid stored value)

When an adult pays admission (per the ticket’s creditRule), they receive F&B/merch wallet credit — prepaid stored value, spent like cash.
One wallet per guest, keyed by BOTH the wristband AND a printed QR voucher — both point to the same balance (one wallet, two keys; atomic decrement; no double-spend).
Wallet { id, balanceTHB, bandCode?, qrCode?, ledger: WalletEntry[] }; WalletEntry { type: grant|spend|refund|expire, amountTHB, source, at, by?, expiresAt? }.
Prepaid child food (credit or items) rides the same wallet.
At EOD this is already-collected revenue being delivered — NOT a discount.

### 6.2 Promo voucher (marketing discount)

PromoVoucher { code, type: percent|fixed|free_item, value?, freeItemId?, appliesTo, appliesToItemId?, validFrom/Until, usageLimit, usedCount, perCustomerLimit?, active }.
Redeemed at checkout to reduce a bill; free_item adds an item at ฿0. Respects tax discountPlacement.
At EOD this is revenue foregone (a discount/markdown) — distinct from wallet spend.

### 6.3 Backend requirements

Wallet ledger with atomic decrement keyed by wallet id, resolvable from band code OR QR. Distinguish, in reporting, credit spend (collected) from promo redemption (foregone). Outstanding wallet balance = a liability — report it.

## 7. Gate access & live occupancy

### 7.1 Gate

Wristband.gateAccess: boolean — true for adult bands, false for kids’. The gate reader checks this flag only; all other scans (F&B, wallet, allergy) ignore it and work for both.

### 7.2 Occupancy counting (asymmetric — important)

Adults scan in AND out; kids scan in but cannot scan out (no gate access). Count three populations differently: - Adults: gate in/out (symmetric, reliable). - Regular kids: linked to their group (the sale/booking that issued the group’s adult bands). Kids depart when the LAST adult of their group scans out. Recompute “does this group still have an adult inside” on each adult gate event. - Drop-off/nanny kids: counted out by their explicit check-out, not the group rule (no double-count). - Live occupancy = adults in + regular kids whose group still has an adult inside + drop-off kids not checked out. End-of-day clears any stranded open groups.

### 7.3 Backend requirements

Group linkage (kids → the admission that brought them) is essential to the count. Gate hardware integration is backend.

## 8. Drop-off, nanny & supervision (child-safety critical)

### 8.1 Supervision policy (configurable)

SupervisionPolicy: age bands → requirement. Seeded: 0–4 nanny (mandatory), 5–8 drop-off, 9+ none. A sibling-waiver (staff/door-only, audited) lets a 9+ sibling waive a 5–8’s drop-off requirement (guardianMinAge 9).
Age is derived from date of birth (see §12.2) so the requirement is always correct on the visit date.
Adult presence is inferred from adult tickets in the cart. A supervision gate runs before payment.

### 8.2 Fee is decoupled from the safety flow

The fee is a consequence of the requirement: nanny → nanny fee, drop-off → drop-off fee, none (9+) → no fee. But the full safety flow runs regardless — a no-fee 9+ child still gets consent, photos, allergies, credit, authorized pickup, check-in/out, bracelet, timer. Only the fee line is omitted.

### 8.3 Registration & consent capture (customer-facing + booking site)

Captures: named children (name, DOB/age), allergies/medical, dietary, child photo AND parent/guardian photo (both; child re-taken each visit), consent, and configurable confirmation checkboxes (e.g. “remain within 15 min”, “early pickup no refund”, “acknowledge evacuation point”) — admin-editable, required ones gate completion, acknowledgements recorded with timestamp.
Per-kid flexible nanny: a shared nanny is billed once; hours = the longest covered child.

### 8.4 Check-in / check-out

One unified check-in board with tabs: Drop-off | Events.
Drop-off check-in: assign nanny (if nanny service), confirm consent/photo, load prepaid food, issue band, start timer → In Park.
DO/N can be booked but not checked in (booking-site pre-books + door “leave as booked”); the board shows these with their booked time; checking in there runs the check-in process only — never ticket sales (already paid).

### 8.5 Pickup authorization (release control)

Each registration has authorized pickup people (extends Guardian): name, phone, relationship, photo. The dropper-off/parent is authorized by default (parent photo from §8.3). Addable any time — at check-in, mid-stay, or check-out (audited).
Add from chat: a parent can send a pickup person’s photo in the messaging thread; staff promote it to an authorized pickup in one tap (photo copies onto the registration; source “from chat”). The chat is a delivery channel — the registration is the source of truth.
At check-out: staff select the collector and verify against the on-file photo. Collector = dropper-off → smooth. Different but authorized → confirm against photo. Collector NOT on the list → check-out is BLOCKED until staff add + verify them on the spot or decline. No release without active staff confirmation. Records who collected, verifier, and whether pre-authorized/from-chat/on-the-spot.

### 8.6 Backend requirements (child safety + data protection)

Real storage of both minors’ and adults’ photos requires consent records, retention limits, and access control. Photos are staff-only, never on customer-review surfaces. The mismatch block must be enforced server-side, not just UI. Audit every pickup-authorization change and every release.

## 9. Events, camps & parties

### 9.1 Unified model

OtoEvent { id, type: party|camp|event, title, branch, date? | dateRange?, attendees: EventAttendee[], (party-only: package/kitchen/timeline/tab fields), entryPriceTHB? }.
EventAttendee: childName, childAge/DOB, language, allergiesMedical, dietary, notes, parentName, emergencyContact, parentAttending, attendanceDays? (camps), rsvpStatus? (parties), checkIns[] (per-day state).
The Events module (main app) is the source of truth for creation + registration; the POS reads events and does check-in + bracelet printing + pass selling. Existing parties migrated to type: 'party' keeping their tab/balance features.

### 9.2 Check-in (Events tab)

No supervision gate for camp/event/party check-in — they’re supervised by the activity. Just check in + print bracelet. Camp check-in is per-day.
Bracelet prints for the kid (+ parent if parentAttending), carrying event name/date/dietary/allergy. Issued band fires F&B allergy alerts.
Per-event roster: checked-in vs outstanding, per day for camps, with counts.

### 9.3 Event passes (pricing = flat, per event, NOT tiered)

Entry price is set on the event (entryPriceTHB), read by the POS. An “Event Passes” section on the sell side lists active events; selling a pass creates the attendee (captures their info) → check-in choice → bracelet. Available on the booking site too (online pass → registered attendee → QR redemption at reception).
Walk-up add: camp/event → sell an event pass (pay at door); birthday → onto the party tab. No free money-less attendee creation.

### 9.4 Backend requirements

POS writes back to the Events module (walk-up “register properly”, pass sale → attendee) — needs a create-attendee endpoint. Event-pass QR redemption endpoint.

## 10. Booking site & redemption

Public booking creates a Booking with willIssue (bracelets, adult vouchers) + a QR; issuance is deferred to check-in/redemption at the park.
Reception redemption: scan the booking QR → issue bracelets + load adult wallet credit + print (regular guests); for drop-off/nanny children, propose check-in (routes into the registration-scoped check-in). Mixed and drop-off-only bookings handled. Booking marked redeemed (no double-redeem).
Booking site also supports: supervision flow (no sibling waiver online), event passes, saved-children subset selection, confirmations, language selection.

### 10.1 Backend requirements

“Redeem this booking QR” endpoint (the front-end exercises both halves of this contract). Online payment is mocked.

## 11. Inventory, stock & purchasing

### 11.1 Unified inventory (one system, any physical item)

InventoryItem { id, sku?, name, lowStockThreshold?, variants: InventoryVariant[] }; InventoryVariant { id, label?, stockQty→stockByLocation, lowStockThreshold?, restockLog[] }.
Any sellable physical product references inventory by (inventoryItemId, variantId?) — merch (folded in), and add-ons via optional inventoryItemId. Non-linked add-ons are non-stocked.
Configurable variants per item (socks S/M/L; a locker = single default variant). At sale, a multi-variant item prompts for size (one till line; that variant decrements).

### 11.2 Multi-location

stockLocations (seeded: Bulk/Accounting, Park back-of-house, Front-of-house rotation). Each variant holds quantity per location (stockByLocation). Selling draws from the rotation location.
Units / pack sizes per item: base each + packs (dozen=12, case=24…). Any quantity entry (transfer/replenish/receive/stock-take) accepts units/combos (“2 cases + 5”) → computes eaches.
Transfers between locations (logged). Par levels per location → below-par transfer suggestions (move from back-of-house).

### 11.3 Stock take

Count per location; counted ≠ expected shows a red flag. No manager approval — the count auto-adjusts stock to the counted value and records a variance entry (item, location, expected→counted, delta, timestamp, operator). Optional reason.

### 11.4 Purchasing / reordering

Per item: reorderPoint, leadTimeDays, supplier, reorderQty, unitCostTHB. At/below reorder point → “needs reordering” (buy from supplier — distinct from a transfer which moves stock you already have).
Unified “needs attention” list: one card per item with the correct single action — Transfer if stock exists elsewhere, else Reorder. Deduped (an item that’s both shows Reorder only).
Purchase list grouped by supplier, states To order → Ordered (expected arrival = today + lead time) → Received. Receiving happens ONLY in the Receive tab (Purchase is status-only); receiving picks a destination location (staff choose each time; no default), supports partials, writes stock + a log.

### 11.5 Access split (important)

Stock operations (view/transfer/replenish/receive/stock-take) = all-staff, mobile-first, a standalone module separate from admin.
Item/unit/par/reorder/cost SETUP = manager-only, in admin. Stock locations are managed in admin.
Main stock view = “actual on-hand for everything” with filters (location/item/category); Stock Take is a button on it, not a tab.

### 11.6 Backend requirements

Predictive reorder (stock ≤ usage-rate × lead-time) needs consumption history — the prototype triggers on the static reorder point and flags this. Local usage-rate math + real cost data are backend. Variance/shrinkage reporting needs the history too.

## 12. Shared input components (used everywhere — build once)

### 12.1 Phone input

Country picker (searchable, default Thailand +66) → dial code auto-loads → number typed after it, via an on-screen keypad (customer-facing) or typing. Stores the full international number as the identity key. Malaysia +60 etc. available. Existing bare-Thai numbers treated as +66. Lookups (member, wallet, saved children, messaging) must use the normalized international number consistently.

### 12.2 Child DOB picker

3-tap: Age → Month → Day. Derives the unique birth year (the one that makes the child that age today for the chosen month/day) and stores the real DOB. Age is derived from DOB everywhere → supervision + eligibility always current; saved children auto-age.

## 13. Messaging (WhatsApp / Telegram / LINE)

ContactChannel = whatsapp | telegram | line. Channel is chosen on the phone field (default WhatsApp), remembered on the member (preferredChannel), pre-selected for returning customers.
In-app messaging thread per registration; connection test (send confirmation → pending/confirmed; re-type number + re-test loop). Board flags show contact status + channel.
Used for: drop-off confirmations, pickup-photo delivery (§8.5), general contact.
Channel identity differs (backend reality): WhatsApp is phone-keyed; Telegram needs a username or the user messaging the bot first; LINE is NOT phone-based — it needs the customer to add the LINE Official Account (friend/opt-in). The prototype mocks all sends; model the per-channel handle accordingly.

### 13.1 Backend requirements

Three separate integrations (WhatsApp Business API, Telegram Bot API, LINE Messaging API), each with its own onboarding/opt-in, 24h session windows, template approval, inbound media (for pickup photos). All sends/tests are mocked in the prototype.

## 14. Reporting & tax export

### 14.1 Reporting module (manager-only, branch-scoped, date-filtered)

Sales: by category (tickets/F&B/merch/events/drop-off); ticket breakdown by type/tier/weekday-weekend; F&B and merch by item; event and drop-off revenue.
Profitability: F&B sales vs cost (uses inventory unit cost; shell where history thin).
Wallet/credit/voucher: F&B credit issued vs redeemed vs outstanding (outstanding = liability); promo usage by code.
Discount/comp impact: revenue foregone via manual discounts, promos, and staff/owner/manager benefits.

### 14.2 Tax-receipt export

Pick a date range → all POS transactions with VAT breakdown (net/VAT/service/gross from the tax engine). Filter by branch / category / payment method. Bulk CSV download. VAT summary grouped by category + period for filing (reuses the tax engine — must match receipts exactly).

### 14.3 Backend requirements

Usage/COGS/shrinkage need real transaction + cost history (prototype uses shells). Real tax-authority e-receipt format is backend. The VAT export is a compliance artifact — must reconcile to the engine’s per-transaction math.

## 15. Staff / owner / manager benefits (HR ↔ POS)

Benefit profiles live on the HR staff record (per person), optionally from a role template (Owner/Manager/Staff), each with a benefit QR the POS scans.
Composable primitives: comp (whole bill → ฿0, owner); periodic allowance (free items by category per day, e.g. 2 coffees/day; and/or a credit amount per period, e.g. manager ฿X/month); standing % discount by category (e.g. 30% off F&B).
Seeded: Owner = unlimited comp; Manager = monthly F&B credit → 30% off after → 2 daily coffees; Staff = 2 daily coffees + 30% off F&B. All configurable (qty, %, categories, reset period).
On scan, apply in order: comp → periodic free items → periodic credit → standing discount. Quotas/credit reset by period (daily/monthly). Owner comps + all usage are tracked/audited (whose QR, which operator processed).

### 15.1 Backend requirements

Cross-module link: benefit profiles + usage tracking live with HR; POS reads at scan. Enforce quotas/resets and audit server-side (an unlimited-comp QR needs a hard audit trail).

## 16. Operator / auth

Operator { id, name, role: staff|manager }; a single app-wide operator context (useOperator()). POS behind a lock screen; inactivity auto-logout (default 2 min, 15s warning), manual Lock.
Every Sale, FnbOrder, discount, refund, edit, stock action, comp, pickup authorization is stamped with the operator.
Seam: mockFaceScan() → in production, capture frame → AWS Rekognition → matched HR-enrolled employee (same faces as HR clock-in).

## 17. Devices, printing & stations

Capabilities-driven station setup (optional devices; scanner = camera on mobile; graceful degradation if a printer isn’t assigned).
Print templates collection + editor: bracelets (name, start/end time, party/event name, dietary, supervision badge DROP-OFF/NANNY, assigned nanny), receipts, wallet/credit QR vouchers.
Bracelet/receipt/voucher printing routes through the active station.

### 17.1 Backend requirements

Real print agent (per-branch mini-PC), hardware integration, self-print guest kiosks, Bluetooth scanners.

## 18. Known prototype fakes & normalizations (do NOT fix in front end — handle in the real schema)

Payment shape divergence: till stores a single paymentMethod string; F&B stores a split object. Real Payment model should support splits everywhere.
Enum divergence: card vs credit_card for the same concept — pick one canonical value. (Payment methods are now configurable with a canonical card token — carry that through.)
ManualDiscount.amountTHB is an audit snapshot — do not read it for live totals (live totals recompute).
Wallet bridge: the prototype does not top up a wristband from a ticket sale (mock balances). Real behaviour: on payment, write adult wallet credit keyed by wallet id, resolvable from band code OR QR (§6).
All photos, messaging sends, face scans, predictive reorder, usage/COGS/shrinkage numbers are mocked/shelled — flagged throughout as backend work.
In-memory state resets on reload — balances, counters, daily/monthly benefit usage, photos. Real persistence required.

## 19. Suggested backend build order

Canonical schema first: global customer (phone-keyed) + per-branch operational/catalog + branch registry (§1); split-capable Payment; canonical enums; wallet keyed by id resolvable from band/QR.
Pricing + tax engines as deterministic server functions (§3, §4) — everything downstream (POS, receipts, reporting) depends on these being exact and accountant-validated.
Wallet ledger (issue/spend/refund/expire), atomic decrement (§6).
Child-safety enforcement server-side: supervision resolution, pickup mismatch block, consent/photo storage with retention + access control, audit (§8).
Face login → Rekognition + HR (§16); HR ↔ POS benefits link (§15).
Messaging integrations (§13); Events write-back + pass redemption (§9, §10).
Inventory history → predictive reorder, COGS, shrinkage (§11); reporting + tax export reconciled to the tax engine (§14).
Replace mockApi.ts getters one at a time — the UI already consumes these exact shapes.

## 20. Design principles the prototype encodes (worth preserving)

Phone is the single identity key — enter once, recalled everywhere, across branches.
Configuration over hardcoding — tiers, tax, supervision, benefits, confirmations, pricing modes, print templates are all owner-editable, not baked in.
The fee is decoupled from the safety flow — a child in your care gets the full safety wrapper whether or not you charge for supervision.
One action, one home — status is a view (many places); mutations (receiving, releasing a child, spending a wallet) happen in exactly one place, to avoid double-execution and reconciliation drift.
Two pricing axes never contaminate each other — who the guest is (tier) vs what they buy (ticket package) vs when (rate mode).
Credit is a liability, promos are foregone revenue — kept distinct end to end for honest reporting.
Audit is the control where approval gates were removed (discounts, comps, stock variance) — the log makes the loose policy safe.
End of document. Pair with types.ts (shapes) and mockApi.ts (the swap seam). For any specific module, the corresponding Replit prompt file contains the detailed behaviour and verification checklist.

