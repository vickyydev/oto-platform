# POS rules — reconciliation of the sources (2026-09-19)

The POS has four written sources of truth that partly overlap. This document
reconciles them once, so tickets and code can cite a single rule id (`R-nn`)
instead of re-deriving the answer.

| Short | Source | Standing |
|---|---|---|
| **OD** | `docs/briefs/OWNER_DIRECTION.md` | Newest; wins over everything |
| **PC** | `docs/briefs/PROJECT_CONTEXT.md` (September 2026) | Target system: boxes, devices, offline, payments, booth |
| **BL** | `docs/briefs/POS_BACKEND_LOGIC.md` (previous developer, v3.0) | Explains the rules the Replit prototype encodes; ranks with the prototype code |
| **S1** | `packages/db/src/schema/*.ts`, `docs/architecture/ARCHITECTURE.md` (D1–D10), `docs/progress/SPRINT_1_REPORT.md` | What is already built |
| **proto** | `apps/pos/src/types.ts` and the prototype under `imports/oto-pos/` | Shapes and behaviour the UI already expects |

Precedence applied throughout: OD > PC > (BL ≡ prototype code) > the schema
sketch in `/CLAUDE.md` §4.

## 1. Conflicts and how each is resolved

| # | Topic | BL says | PC says | Sprint 1 built | Resolution |
|---|---|---|---|---|---|
| C1 | Face login | §16: `mockFaceScan()` → AWS Rekognition matched to the HR-enrolled employee | §10, §13: no facial recognition anywhere; biometrics banned | Phone + password sessions; "Scan my face" left as a placeholder on the lock screen | PC wins. Remove the face placeholder; sign-in = phone + password, then station pick (PC §5). Staff *clock-in* biometrics is an OTO App question (OD; `PLATFORM_PLAN.md` §14) — not reopened for the POS. |
| C2 | Branch names / registry | §1.1: `Branch{id,name,country?,active}`, seeded "HKT Central", "HKT Chalong"; registry global | Two branches; real names are Central Floresta and Robinson Chalong (OD) | `branch` (operator_id, name, code, timezone, country, archived_at); seed has only "HKT Central" | Seed both real branches with stable codes; keep the operator-scoped registry. Branch ids are mastered in `oto_app` at first and mirrored (`PLATFORM_PLAN.md` §3) — import ids, do not hand-create. |
| C3 | Catalogue cloning | §1.3: a new branch deep-clones another branch's catalogue/config with fresh ids, then is independent | Silent | Nothing (branch-scoped config is cloneable) | BL applies: an admin "Clone from another branch" service = one transaction copying every branch-scoped catalogue/config table with new UUIDv7 ids, audited. |
| C4 | Global member vs per-branch data | §1.2: members, children, tier, wallet identity, channel are global; all operational data AND the entire catalogue/config are per branch; every read branch-filtered | §10: tier is a member property applied everywhere; §4: boxes cache members + children | Member unique on (operator, phone) ✔; tier operator-scoped ✔; ticket packages, holidays, tax config branch-scoped ✔; **product / product_category operator-scoped with nullable branch_id** ✗ | Keep S1 member and tier scoping. Make every catalogue table branch-scoped (menu, categories, modifiers, add-ons, inventory setup, promos, templates, payment routing). Guard: the branch filter is mandatory in every operational repository call. |
| C5 | Ticket package model | §3.1: per tier × rate mode kid price; `adultRule` same_as_kid / set_price / free_adults (+ overflow); `freeAdults`; `creditRule {appliesTo, type, value}`; `gateAccess` on adult bands only; no park-wide adult price | Silent on shape; §10: checkout has no tier selector | D1 ported the prototype shape: `prices` jsonb per tier `{weekday, weekend}`, `tier_pricing`, `adult_rules` (incl. `overflow`), `freebies`, `credit_rule`, `gate_access`; D5: freeAdults counts per cart line | No conflict — S1 already has BL's shape; the flat columns in `/CLAUDE.md` §4 are superseded. Tier comes from the member: no tier selector on the till; walk-in = default tier. |
| C6 | Tax engine | §4.1: cascade product override → category rule → global; rule = rate, mode inclusive/exclusive/none, service %, tax-on-service; §4.2 inclusive-of-VAT-only and inclusive-of-VAT-and-service; discount placement; decomposition order = the accountant's | Silent on the engine; §8 per-station receipt / tax-invoice prefixes; §10 settlement export | D3: `branch_tax_config.config` jsonb (rates, category rules with mode / service % / tax-on-service, discount placement) ✔; resolver branch → category → product ✔; **`tax_override` holds numeric rates** — the prototype's product override is `taxCategoryOverride` (points at a taxable category) | Keep the S1 config and resolver. Replace `tax_override` semantics with `tax_category_override` on product / menu item / add-on; category default via `menu_category.default_tax_category`. Decomposition order and rounding become config, confirmed with the accountant (Q3). |
| C7 | Wallet keys | §6.1: one wallet per guest keyed by BOTH band code and printed QR; ledger grant / spend / refund / expire; child prepaid food rides the same wallet; liability at end of day; §18 wallet bridge on payment | §1 "prepaid child wallets spent at the restaurant"; §8 wallet spend offline capped, otherwise online-only | `wallet(operator_id, member_id, balance)` + `wallet_entry(kind, amount)`; no band/QR keys, no expiry, cascade delete | Both hold: PC's child wallet is BL's per-guest wallet loaded with child prepaid food. Wallet resolvable by `wristband.code` OR `wallet.qr_code`; atomic decrement; offline cap per PC §8; no cascade on ledgers. |
| C8 | Gate and occupancy | §7.1 the gate reader checks `gateAccess` only (adult bands true, kids false); §7.2 asymmetric count: adults in/out; regular kids leave when the LAST adult of their group exits; drop-off kids by check-out; EOD clears stranded groups | §7.5: the box decides; passage events (not open commands) drive occupancy; both directions host-controlled; anti-passback: one band, one entry until an exit | `station.kind` includes `gate`; `wristband` placeholder | PC wins on mechanism (passage events, host-controlled both directions, anti-passback per adult band). BL's group rule stays for kids' bands, which never operate the gate. Occupancy = adults from passage events + group-linked kids + drop-off kids not checked out. Open: do kids' bands ever scan at exit? (Q7) |
| C9 | Supervision, consent, photos | §8.1 bands 0–4 nanny / 5–8 drop-off / 9+ none; sibling waiver staff-only; §8.3 child photo AND guardian photo each visit, consent, configurable confirmations; §8.5 pickup photos; §8.6 consent records, retention, staff-only access | §10: do not store photos of **identity documents**; §8 child release offline with evidence | `child` has no photo ✔, `consent_recorded_at`; `visit` / `visit_child` draft; no policy, registration or pickup tables | No conflict: PC bans ID-document photos only. BL applies for pickup-safety photos, stored via `file_object` with staff-only permission and retention (Q4). One combined photo vs two (Q4). |
| C10 | Events model | §9: unified `OtoEvent` party / camp / event; the Events module is the source of truth for creation and registration; the POS reads, checks in, prints bracelets, sells passes; write-back endpoints; flat `entryPriceTHB`; no supervision gate | §1 events and camps in scope; `PLATFORM_PLAN.md` §3: OTO App (live) masters events, camps, check-ins; `crm` masters members and children | `booking` / `attendee` placeholders | BL and the plan agree: OTO App = source of truth; the POS integrates through a read seam plus `create-attendee` and `redeem-event-pass` endpoints; attendees link to a `crm` child/member id. Check-in state ownership per `PLATFORM_PLAN.md` §14 decision 3 (Q6). |
| C11 | Booking redemption | §10: a booking holds `willIssue` + a QR; issuance deferred to redemption; redeem = bands + adult wallet credit + print, propose drop-off check-in, mark redeemed, no double redeem; online payment mocked | §7.2 online pay via 2C2P Redirect; §7.6 one redemption service for staff and kiosk; §8 QR signed, local redemption log; single use not safe offline across stations | `booking` (reference, date, status, total, payload), public `/book` server-priced (D9), no payment | Union: signed QR carrying the booking id; one redemption service, two surfaces; per-box redemption log; 2C2P Redirect for payment; BL's issue / propose-check-in / mark-redeemed semantics. |
| C12 | Inventory | §11: item → variants → stock per location; units / packs; par → transfer suggestions; stock take auto-adjusts with a variance entry; reorder point, lead time, supplier, purchase orders; receiving only in Receive; ops all-staff, setup manager-only | Silent (stock in §1); design review 07: stock must be a projection of movement entries so offline sales decrement late | `item`, `stock_location`, `stock_level` placeholders | BL applies, modelled as a movement ledger (receive / transfer / sale / adjust / variance) per branch; levels are projections; counts record the feed position. |
| C13 | Staff benefits | §15: benefit profile on the HR staff record, role template Owner / Manager / Staff, benefit QR; apply comp → free items → credit → standing %; quotas reset daily / monthly; audited | §14 step 4 "staff benefits"; `PLATFORM_PLAN.md` §3: employees mastered in `oto_app`, staff directory mirrored into `core` | `employee` minimal | BL applies; the profile is keyed to the mirrored employee id; the benefit QR is a cloud-signed staff badge credential, never a password or PIN; usage and audit live in `pos`. |
| C14 | Operator / auth / lock | §16: `Operator{role staff\|manager}`; lock screen; inactivity auto-logout 2 min with a 15 s warning; manual Lock | §5: sign in, pick a station; lock after inactivity, unlock with the password; offline unlock verifies the existing token; open: fresh sign-in offline (default allow 30 days) | Scoped permissions replace `role` ✔; sessions with `station_id`; the inactivity lock currently **signs out** (`OperatorContext.tsx`) | PC wins: lock ≠ sign-out — keep the session, lock the UI, unlock by password online or token verification offline. Keep 2 min / 15 s as config defaults. `isManager` → `can()`. |
| C15 | Devices, stations, print templates | §17: capabilities-driven station; print-template editor (bracelets, receipts, credit vouchers); printing routes through the active station; per-branch print agent | §4: a station belongs to one box; device assignments on the station are pushed to the box; wizard step "choose the box"; §7.3 Ethernet printers; §7.4 three scanner modes; §11 booth station type | `station(kind till / kiosk / gate / display, device_key_hash, last_seen_at)` | PC wins on topology (the box owns devices); keep BL's capabilities and templates. Add `box`, `device`, `print_template`; extend `station.kind` with `booth`. |
| C16 | Messaging channels | §13: whatsapp / telegram / line; per-channel handle (LINE is not phone-keyed; Telegram needs a username or bot-first) | §10: LINE alongside WhatsApp and Instagram; §14 step 6 adapters behind one interface | `contact_channel` enum whatsapp / telegram / line on `member.preferred_channel` | PC wins on adapters (WhatsApp, LINE, Instagram). Telegram: keep the value, no adapter (Q5). Store per-channel handles, not only the phone. Enum → text + CHECK. |
| C17 | Reporting / tax export | §14: manager-only, branch-scoped; sales by category / type / tier / mode; wallet liability vs promo foregone; VAT export CSV equal to receipts | §10 settlement export per terminal per day by TID and 2C2P invoice; §8 per-station receipt / tax-invoice prefixes; §9 nightly rollups | Nothing | Union. Numbering series and document types come from the accountant session before the ledger schema freezes. |
| C18 | Known prototype fakes | §18: split-capable payment everywhere; canonical `card` token; `ManualDiscount.amountTHB` is a snapshot; wallet bridge on payment; photos / sends / face mocked | §7.1 payment method → terminal routing config; §10 cash management | `payment` = one row per tender ✔; no method config; no wallet bridge | Configurable `payment_method` (seed cash / card / promptpay; kind cash / card / qr / other); station routing by method; the wallet grant is written in the payment transaction; manual discount stored as a snapshot and recomputed live. |
| C19 | Reference prices | §3.4: Tourist 690 / 890 / 1090, Thai 420–520 / 520–620 / 620–720, Eat & Play 1300, adult 350 / 500, nanny 330/h, drop-off 225, extra hour 300 — "verify with owner" | Silent | The seed ports the prototype catalogue 1:1 (may differ from §3.4) | Keep the seed; put the §3.4 numbers to the owner (Q1) before the go-live data load. |
| C20 | Customer display ↔ till | §0.2 dual screen with the till (harness) | §4 the box serves the current sale to till and display (two devices); OD: separate devices, session link to be planned | D8: pending lookup via `session.pending_lookup_phone` (30 s) | PC wins: a station-scoped channel on the box replaces the session field (D8 already flags this). |

## 2. Rules checklist (✔ = implemented in Sprint 1)

**Foundation**
- R-01 ✔ Phone is the identity key; a member is globally unique by normalised E.164; bare Thai numbers → +66 (BL §0.3, §2.4, §12.1)
- R-02 Global vs per-branch split: members, children, tier, wallet identity and channel are global; every operational and catalogue record is stamped with and filtered by branch (BL §1.2, §1.4) — S1 partial, see C4
- R-03 New branch = transactional deep clone of another branch's catalogue/config, fresh ids, no sync afterwards (BL §1.3)
- R-04 ✔ Tiers are editable data; a sale or booking resolves verified-or-default; online never grants a discounted tier (BL §2.1; PC §10)
- R-05 ✔ Tier set once on the member with evidence type, expiry and verifier; expiry → flag, never a silent downgrade; no ID-document photos (PC §10)
- R-06 ✔ Saved children hold everything except a photo; each is re-confirmed (Confirm / Edit) per visit; subset "coming today"; a new child is saved by default (BL §2.3)
- R-07 ✔ Age is derived from date of birth everywhere; the 3-tap picker derives the unique birth year (BL §12.2)
- R-08 ✔ Every mutation is stamped with the acting account; audit replaces approval gates for discounts, comps and stock variance (BL §16, §20)
- R-09 Configuration over hard-coding: tiers, tax, supervision, benefits, confirmations, pricing modes, templates and payment methods are owner-editable (BL §20)
- R-10 ✔ Every price is `{weekday, weekend}`; rate = holiday range → weekend, Sat/Sun → weekend, else weekday; the POS shows the mode and why (BL §3.3, §3.5)
- R-11 The cloud is the system of record, the box the system of action; nothing at a counter waits on the internet (PC §3)

**Stations and devices**
- R-12 A station belongs to exactly one box; device assignments live on the station and are pushed to the box; wizard step "choose the box"; offered devices = those the box reported (PC §4)
- R-13 Capabilities-driven station (tickets / F&B / drop-off / parties); optional devices; graceful degradation without a printer (BL §17; proto `StationProfile`)
- R-14 Sign in, then pick a station (stored on the iPad); only admins see the setup wizard (PC §5)
- R-15 Scanner modes: iPad camera, Bluetooth scanner paired to the iPad, scanner on the box (PC §7.4)
- R-16 Heartbeat every 60 s with printer reachability and paper state; red indicator on the station screen (PC §4, §7.3)
- R-17 Every device and third party sits behind an adapter with a simulator (PC §2, §7)
- R-18 Lock after inactivity (default 2 min, 15 s warning), manual Lock; unlock by password, offline via the existing token; a lock never ends the session (BL §16; PC §5)

**Checkout and pricing**
- R-19 ✔ Ticket type = full entry package per tier × rate mode: kid price, adult rule (same_as_kid / set_price / free_adults + overflow), free adults, credit rule, gate access (BL §3.1; D1)
- R-20 ✔ No park-wide adult admission price — adult pricing lives inside each ticket (BL §3.1)
- R-21 ✔ Free adults count per cart line, not per child (proto `resolveAdultLine`; D5)
- R-22 Worked examples hold: Standard / Tourist = set adult price, credit adults only; Thai with freeAdults = 1 → first adult ฿0 then overflow; Play & Eat = adult price equals kid price, credit both, full price (BL §3.2)
- R-23 ✔ Package resolution is a deterministic server function the POS calls (BL §3.5; `packages/shared` pricing)
- R-24 Checkout has no tier selector; the tier comes from the member; walk-in = default tier (PC §10)
- R-25 Cart lines snapshot resolved prices at add time; a sale never mixes rate modes (proto `SelectedAddOn`; BL §3.3)
- R-26 Add-ons: `{weekday, weekend}` price, optional inventory link, variant split per line (proto `AddOn`, `AddOnVariantQty`; BL §11.1)
- R-27 The supervision gate runs before payment; adult presence is inferred from adult tickets in the cart (BL §8.1)
- R-28 Manual discount: order / line / component scope, percent / fixed / comp, preset reason, audited; `amountTHB` is a snapshot, live totals recompute (BL §18; proto `ManualDiscount`)
- R-29 Promo voucher: percent / fixed / free_item, validity window, usage and per-customer limits, free_item adds a ฿0 line, respects discount placement; reported as foregone revenue (BL §6.2)
- R-30 Refunds against the original sale (full / partial → paid / partially_refunded / refunded); reprints and paid extensions audited on the sale (proto `Sale`, `Refund`, `Extension`)

**Tax**
- R-31 ✔ Cascade product → category → global; a category rule = rate, mode inclusive / exclusive / none, service %, tax-on-service (BL §4.1; D3) — product override shape per C6
- R-32 Service charge = % of line revenue; tax-on-service on → VAT on (base + service), off → VAT on base only (BL §4.2)
- R-33 Inclusive mode back-calculates VAT (and service when inclusive of both); decomposition order and rounding are config matching the build-up order (BL §4.2, §4.3)
- R-34 ✔ Discount placement before / after tax is a global setting (BL §4.1)
- R-35 Stored-value loads are not taxed at load; taxed at spend (proto `TaxableCategory 'stored_value'`, `ChildFoodProvision`)
- R-36 Receipts and the VAT export reproduce the engine to the satang (BL §4.3, §14.2)

**Payments**
- R-37 Payment is split-capable everywhere; one canonical `card` token (BL §18)
- R-38 Payment methods are configurable (token, label, kind cash / card / qr / other, enabled, order); kind drives refund routing and the end-of-day channel (proto `PaymentMethod`)
- R-39 Station config maps method → terminal (card → NEXGO/GHL, QR → PAX/Digio); route by method (PC §7.1)
- R-40 A sale with no final terminal response triggers an inquiry before the till continues; GHL cards → staff confirm on the terminal screen, audited (PC §7.1)
- R-41 ✔ Money is integer satang; GHL decimal string / Digio satang at the adapter edge; log every raw byte (PC §7.1)
- R-42 In-person QR via 2C2P Direct THQR on the customer display, webhook + polling; automatic fallback to the PAX QR when offline (PC §7.2)
- R-43 Online booking pays via 2C2P Redirect; in-person cards only via the EDC (PC §7.2)
- R-44 Cash management: opening float carried from the previous close, count at close with variance against the closing staff member, paid-outs, safe drops, top-ups (PC §10; proto `EndOfDay`)
- R-45 Settlement export per terminal per day keyed by TID and 2C2P invoice (PC §10)
- R-46 Sales, printing, card payments, member lookup / create, check-in / release work offline from the box cache and queue; every item idempotent by id (PC §8) — ✔ server idempotency only
- R-47 Receipt and tax-invoice numbers carry a per-station prefix (scheme from the accountant) (PC §8)
- R-48 Wallet spend and single-use redemption are not made safe offline; offline wallet spend is capped (PC §8)

**Printing**
- R-49 Templates per type (receipt, kids band, adult band, kitchen, bar, credit voucher) with section toggles; a missing template shows everything (BL §17; proto `PrintTemplate`)
- R-50 A bracelet carries name, start / end, party or event, dietary, supervision badge DROP-OFF / NANNY, assigned nanny (BL §17, §9.2)
- R-51 Template = content; station = routing; print goes iPad → box → printer, or console → cloud → box (BL §17; PC §4)
- R-52 Band codes are minted on the box: station-prefixed ULID + HMAC, verified locally by the gate (PC §8; OD: the shared key stands)
- R-53 One band per person; adult bands inherit gate access from the line's ticket, kids' bands never (proto `CreditGrant`; BL §7.1)

**Customer display**
- R-54 The display is a separate device; the box serves the current sale to till and display; one display per station (PC §4; OD)
- R-55 ✔ A lookup entered on the display reaches the till through the API, never shared browser state (CLAUDE §7.4; D8 → station channel per C20)
- R-56 ✔ Phone input: country picker default +66, keypad, stores E.164 (BL §12.1)
- R-57 ✔ Five customer languages (D10)
- R-58 Allergy, medical and food-consent data are staff-only, never on the customer display (proto `Wristband`)
- R-59 QR payment renders on the display (PC §7.2)

**Wallets and promo vouchers**
- R-60 On payment, write adult wallet credit per the credit rule keyed by wallet id, resolvable from band code OR QR; atomic decrement, no double spend (BL §6.1, §18)
- R-61 Ledger kinds grant / spend / refund / expire with source, by, expiresAt; the balance is the source of truth, the ledger the trail (BL §6.1; proto `WalletEntry`)
- R-62 Child prepaid food (credit or item entitlements with redeemed qty) rides the same wallet; unused is settled at pickup by refund / forfeit policy (BL §6.1; proto `ChildFoodProvision`, `DropOffPricing`)
- R-63 Credit spends at both F&B and merchandise stations (proto `CreditGrant`)
- R-64 Credit = liability (collected), promo = foregone; kept distinct end to end; outstanding balance reported (BL §6.3, §20)

**F&B**
- R-65 Two-level menu categories with default prep station and tax category; a sub-category inherits; an item overrides both (BL §5.1)
- R-66 Modifier groups (required, single / multi, min / max) with option price deltas; a reusable library linked by id; line = (base + Σ deltas) × qty (BL §5.1)
- R-67 Live search by dish number or any part of the name (BL §5.1)
- R-68 An order is standalone or linked to a guest by band / QR scan; a flagged child's band fires an allergy alert; `mayOrderFood = false` blocks ordering (BL §5.2; proto `Wristband`)
- R-69 Prep routing kitchen / bar / none; kitchen printer on Ethernet; item notes; tap-to-edit reopens the modifier sheet (BL §5.2; PC §7.3)
- R-70 Benefits apply at the F&B station only, in order comp → free items → credit → standing % (BL §15; proto)

**Shop and stock**
- R-71 Unified inventory: item → variants → stock per location; sellables link by (inventory item, variant); a multi-variant item prompts for size (BL §11.1)
- R-72 Locations bulk / back-of-house / rotation sell point; sales draw from the sell point; pack units, "2 cases + 5" → eaches (BL §11.2)
- R-73 Transfers are logged; par per location → transfer suggestions (BL §11.2)
- R-74 Stock take auto-adjusts to the count and records a variance entry with an optional reason; no approval (BL §11.3)
- R-75 Reorder point, lead time, supplier, reorder qty, unit cost; needs-attention list deduped (Transfer if stock exists elsewhere, else Reorder); purchase order To order → Ordered → Received; receiving only in Receive, destination chosen each time, partials allowed (BL §11.4)
- R-76 Stock operations = all-staff mobile module; setup = manager-only in admin (BL §11.5)
- R-77 Stock levels are projections of movement entries so offline sales decrement late; counts record the feed position (design review 07)

**Arrival: booking, redemption, gate, occupancy**
- R-78 A booking stores `willIssue` and a signed QR; nothing is issued until redemption (BL §10; PC §8)
- R-79 Redemption: issue bands, load wallet credit, print; drop-off children → propose check-in; mixed bookings; mark redeemed; no double redeem; local redemption log per box (BL §10; PC §8)
- R-80 One redemption service, two surfaces (staff, kiosk); the kiosk hands off when supervision is required (PC §7.6)
- R-81 Booking site: supervision flow without sibling waiver, event passes, saved-children subset, confirmations, language (BL §10) — ✔ pricing only
- R-82 Gate: the box decides; relay pulse; passage events drive occupancy; both directions host-controlled; anti-passback: one entry per band until an exit (PC §7.5)
- R-83 The gate reader checks `gateAccess` only (adults true, kids false); every other scan surface ignores it (BL §7.1)
- R-84 Occupancy = adults in (passage events) + regular kids whose group still has an adult inside + drop-off kids not checked out; the group is recomputed on each adult event; EOD clears stranded groups (BL §7.2)

**Check-in, supervision, pickup**
- R-85 Policy: age bands → nanny / drop-off / none (seed 0–4 / 5–8 / 9+); sibling waiver staff-only, audited, guardian minimum age 9 (BL §8.1)
- R-86 The fee is decoupled from safety: the full flow always runs; only the fee line is omitted (BL §8.2)
- R-87 Registration captures children, allergies, dietary, child photo (re-taken each visit) + guardian photo, consent, admin-configured confirmations (required ones gate completion, acknowledged with timestamp) (BL §8.3)
- R-88 A shared nanny is billed once; hours = longest covered child; billing starts at the booked start regardless of arrival; extra hour past the booked time (BL §8.3; proto `DropOffLine`, `DropOffPricing`)
- R-89 One board, tabs Drop-off | Events; drop-off check-in = assign nanny, confirm consent / photo, load prepaid food, issue band, start timer (BL §8.4)
- R-90 A pre-booked drop-off / nanny shows its booked time; checking in runs check-in only, never a sale (BL §8.4)
- R-91 Authorised pickups (name, phone, relationship, photo); the dropper-off by default; addable any time, audited; promote a chat photo in one tap; the registration is the source of truth (BL §8.5)
- R-92 Check-out: select the collector, verify against the on-file photo; not on the list → BLOCKED until added and verified or declined; record collector, verifier, source; enforced server-side (BL §8.5, §8.6)
- R-93 Child release is mandatory offline: cached pickup list, local record with evidence, synced later (PC §8)
- R-94 Photos staff-only; consent records, retention limits, access control; every pickup-authorisation change and release audited (BL §8.6)
- R-95 Contact-channel connection test per registration (pending / confirmed, re-test loop); board flags (BL §13)

**Events and passes**
- R-96 Unified event party / camp / event; OTO App owns creation and registration; the POS reads, checks in, prints, sells passes (BL §9.1; `PLATFORM_PLAN.md` §3)
- R-97 No supervision gate at event check-in; camps check in per day; bracelet for the kid (+ parent if attending) with event, date, dietary, allergy; roster with counts (BL §9.2)
- R-98 Event pass price is flat per event, not tiered; selling a pass creates the attendee; no money-less walk-up attendee; party walk-up → party tab (BL §9.3)
- R-99 POS write-back: create-attendee endpoint; event-pass QR redemption endpoint (BL §9.4)
- R-100 Drop-in pricing per event type (camp day / event day / party guest) as `{weekday, weekend}` (proto `EventDropInPricing`)

**Today, history, reporting, tax export**
- R-101 Reporting manager-only, branch-scoped, date-filtered: sales by category, tickets by type / tier / mode, F&B and merchandise by item, event and drop-off revenue (BL §14.1)
- R-102 Profitability vs inventory cost; credit issued / redeemed / outstanding; promo usage by code; discount / comp / benefit impact (BL §14.1)
- R-103 Tax-receipt export: date range, net / VAT / service / gross per transaction, filters branch / category / method, CSV, VAT summary by category and period (BL §14.2)
- R-104 Member activity aggregates across branches; each transaction shows its branch (BL §1.2; proto `MemberActivity`)
- R-105 End of day per branch and date: expected vs actual per channel, cash count with float carry-over, vouchers, locked on close with the closer stamped (proto `EndOfDay`; PC §10)
- R-106 Nightly rollups feed reporting (PC §9)

**Benefits**
- R-107 Benefit profile on the HR staff record, optional role template Owner / Manager / Staff, scannable benefit QR (BL §15)
- R-108 Primitives: comp; periodic free items by category; periodic credit; standing % by category; seeded Owner / Manager / Staff defaults; quotas reset daily / monthly (BL §15)
- R-109 A per-person override replaces a primitive wholesale, not field by field (proto `Operator.benefitProfileOverride`)
- R-110 Usage and every comp tracked and audited (whose QR, which operator); quotas enforced server-side (BL §15.1)

**Messaging**
- R-111 Channels WhatsApp, LINE, Instagram behind one interface with a simulator (PC §10, §14); the Telegram value retained pending Q5 (BL §13)
- R-112 The channel is chosen on the phone field, remembered as `preferredChannel`, pre-selected on return (BL §13)
- R-113 Per-channel handle: WhatsApp phone-keyed; LINE needs OA friend opt-in; Telegram needs a username or bot-first (BL §13)
- R-114 A thread per registration; used for drop-off confirmations, pickup-photo delivery, general contact; inbound media promotable (BL §13, §8.5)
- R-115 Session windows, template approval and inbound media handled per channel (BL §13.1)

**Admin config**
- R-116 ✔ Operators, branches, login users, roles / scopes, tickets, holidays, tax config (S1)
- R-117 Admin holds per-branch menu, modifiers, add-ons, supervision policy + confirmations, inventory setup, promos, devices / stations, print templates, payment methods (BL §0.2, §1.2, §8.3, §17, §18)
- R-118 The booth is a station type managed from the POS admin (layout, prizes, staff) (PC §11)
- R-119 Reporting and tax export are admin-console screens (BL §14)

## 3. Schema deltas the document implies (beyond PROJECT_CONTEXT)

Keep as built: `ticket_package` (D1 shape), `tier`, `member`, `child`,
`member_tier_verification`, `visit`, `branch_tax_config`, `branch_holiday`,
`station` (extended). The generic placeholders in `future.ts` are replaced by
the tables below; ledgers never cascade-delete.

- **Catalogue (all branch-scoped):** `add_on` (name, price pair, inventory item / variant, tax category override, translations); `menu_category` (parent, default prep station, default tax category, sort order, translations); `menu_item` (category, dish number, price pair, cost, prep-station override, tax category override, inventory item, translations); `modifier_group` (name, required, selection type, min, max, owner item nullable = inline vs library); `modifier_option` (group, name, price pair, cost); `menu_item_modifier_group` link. `product` / `product_category` become branch-scoped or fold into these.
- **Tax:** replace `tax_override(vat_rate_bp, service_charge_bp)` with a `tax_category_override` on add-on / menu item / merchandise (BL §4.1); add decomposition order and rounding to `branch_tax_config.config` (BL §4.2).
- **Sales ledger:** `sale` (branch, station, box, account, member, tier code, rate mode, business date, status, receipt number + series, booking, group / wristband codes, totals); `sale_line` (kind ticket / add-on / drop-off / F&B / merch / event pass / promo item; snapshots of unit price, tax rule, qty, variant); `manual_discount`; `promo_voucher` (code, type, value, free item, applies-to, validity, usage limit, used count, per-customer limit, stackable, active) + `promo_redemption`; `refund`, `reprint_event`, `extension`.
- **Payments:** `payment_method` (branch, token, label, kind, enabled, sort order) with `card` canonical; `payment` per tender (method token, amount, terminal id / TID, approval code, provider transaction id, masked card, 2C2P invoice, raw log reference); `payment_attempt`; `cash_session` + `cash_movement` (float, paid-out, safe drop, top-up); `end_of_day` + `recon_line`; `receipt_series` (station, prefix, next).
- **Wallet:** `wallet` gains a unique `qr_code`, issuing branch, expiry; `wristband.wallet_id`; `wallet_entry` kind grant / spend / refund / expire, source, by, expiry, fund source; `prepaid_item_entitlement` (wallet, menu item, qty, redeemed qty).
- **Bands and gate:** `wristband` gains qr code, gate access, group id (sale / booking), holder child, check-in, may-order-food, allergy flag, signature / version; `gate_event` (wristband, direction, at, box, raw event code).
- **Supervision:** `supervision_policy` (branch; bands; sibling waiver); `confirmation_item` (branch, text, required, order); `supervision_waiver`; `drop_off_pricing` (branch; one-time fee, nanny hourly, extra hour pairs, full-day hours, nanny ratio, prepaid-food refund policy); `nanny`.
- **Registration and release:** `registration` (branch, member, parent name, phone, contact channel, source door / booking, consent at, acknowledged confirmations, guardian photo file, booking); `check_in` (registration, child, service type, nanny, nanny start, status registered / in park / out, scheduled for, checked in / out at, booked duration, child photo file, pickup photo file, food provision, wristband, sale, collector record, prepaid-food settlement, change log); `authorized_pickup` (registration, name, phone, relationship, photo file, source dropper-off / in person / from chat / on the spot, added by, updated by); `consent_record` (subject child / member, purpose, text version, at, by, channel).
- **Booking:** signed QR payload / version, `will_issue`, status paid / redeemed, redeemed at, issued wristbands, registration, promo, 2C2P payment reference, lines snapshot; `booking_event_pass`; `redemption_log` (booking, box, at).
- **Events (seam to OTO App):** a read view of `oto_app` events; POS-side `event_attendee_link` (event, attendee, child / member, sale, parent attending, attendance days, check-ins per day); `event_drop_in_pricing` (branch; camp / event / party pairs). Rename S1 `attendee` → `booking_attendee`.
- **Inventory:** `inventory_item` (branch, sku, category, active, linked kind / id, units, reorder point, lead time, supplier, reorder qty, unit cost, photo); `inventory_variant` (label, sku, low-stock threshold); `stock_location` gains type, sell point, active; `stock_level` keyed (variant, location) + par; `stock_movement` ledger (kind receive / transfer / sale / adjust / variance, qty, from / to, by, reason, feed position); `purchase_order` + lines; `stock_take` + lines.
- **Benefits:** `benefit_role_template` (operator, role, profile); `employee_benefit` (employee, role, profile override, badge credential); `benefit_usage` (employee, period key, counts / credit used); `benefit_audit`.
- **Devices:** `box` (branch, name, role, device key, last heartbeat, certificate expiry, status); `device` (box, type incl. card / QR terminal, label, connection, address, reported capabilities); `station` gains box, capabilities, scanner mode, per-role device ids, payment routing, kind `booth`; `print_template` (branch, type, name, show logo, header, footer, fields).
- **Members and messaging:** `member` gains per-channel handles (LINE user id, Instagram handle, Telegram username); `contact_channel` enum → text + CHECK including `instagram`; `message_thread` / `message` (registration, channel, status, media file ids).

## 4. Questions the document itself raises

1. **Reference prices** (BL §3.4): confirm Tourist 690 / 890 / 1090, Thai 420–520 / 520–620 / 620–720, Eat & Play 1300 all tiers, adult 350 / 500 flat across tiers (Play & Eat adult 350 on weekends), nanny 330/h, drop-off 225, extra hour 300 — against the Sprint 1 seed ported from the prototype.
2. **Expat prices** (BL §3.4): derived (Tourist −30 % weekday / −20 % weekend) or explicit numbers per package? Decides whether tier-pricing rules or manual prices are seeded.
3. **Inclusive-tax decomposition** (BL §4.2, §4.3): exact unwind order and rounding for inclusive-of-VAT and inclusive-of-VAT-and-service, whether the service charge is inside the tax base, and which mode each category uses today — an accountant session before the ledger schema freezes (also settles receipt / tax-invoice numbering, PC §8).
4. **Photo and consent retention** (BL §2.4, §8.6): retention period for child, guardian and pickup photos and consent records; who may view; erasure handling — and whether the capture is one combined child + guardian photo (prototype memory) or two photos (BL §8.3).
5. **Messaging channels:** BL has Telegram, PC lists WhatsApp / LINE / Instagram — drop Telegram or keep it?
6. **Events ownership** (BL §9.1; `PLATFORM_PLAN.md` §14 decision 3): OTO App stays the source of truth for events and registration; does event *check-in state* move to the POS / box (offline) or stay in OTO App?
7. **Gate direction for kids** (BL §7.2 vs PC §7.5): with a host-controlled exit, do kids' bands scan at exit at all, or exit only alongside an adult (group rule)?
8. **Predictive reorder / cost of goods** (BL §11.6, §14.3): accept a static reorder point and a shell profitability report at go-live until history accrues?
9. **Benefit QR source** (BL §15): benefit profiles on the OTO App HR record — confirm the employee master stays in OTO App and the badge credential is issued by the platform.
10. **Wallet policy** (BL §6.1 expiry; PC §8 cap): expiry of granted credit, refund vs forfeit of unused child prepaid food, the offline spend cap amount.
