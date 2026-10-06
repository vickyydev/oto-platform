# Wallets and stored value — the build plan for S2-14a

_Written 2026-10-01 from the requirement (SPRINT_2_PLAN §S2-14a, lines
2166-2218, intro 2151-2164), the rules R-35/R-48/R-60..64 and conflict C7
(POS_RULES_RECONCILIATION), open decision 14, and two read-only studies —
the prototype's complete wallet domain and the platform's landed seams.
The prototype's code is the binding behaviour (CLAUDE.md); where the
requirement deliberately supersedes it (the ledger becomes the truth, the
offline cap, expiry, concurrency), this plan says so. S2-13 is Deployed;
its check-in, sale and offline patterns are the foundation here._

## 1. Stored value, in the park's terms

A family buys admission and the package gives food credit back: each person
who earns it gets their own wallet, printed as a voucher with a QR and
carried on their band. A drop-off parent preloads lunch money onto the
child's own band. At the F&B counter the band scans, the balance shows on
the customer display, credit pays first and the remainder is taken in cash;
two tills grabbing the last ฿50 at once get one success and one honest
zero, never a negative and never a double charge. A refund puts credit back
where credit paid. At the end of the branch's day unused credit expires by
the seeded policy (same day), and only a manager with a typed reason can
bring it back. When the internet dies, a wallet still spends — up to ฿300
per wallet per day — and an overdraft discovered at sync becomes a loud
anomaly on Failures, never silent money. The office sees the liability:
what is outstanding, granted, spent, expired, every day.

## 2. The architecture

### 2.1 Data model (migration 0045, round 1)

The landed `pos.wallet` / `pos.wallet_entry` placeholders (schema/future.ts
:214-238) are empty everywhere and are reshaped in place, forward-only:

- `pos.wallet` — operator_id, holder_name (nullable), member_id stays as a
  nullable backlink, `balance_satang` becomes the GUARDED projection (only
  ever written inside the same transaction as its entry, under SELECT ...
  FOR UPDATE), status (active/expired), created_at/updated_at. The ledger
  is the truth; a test asserts balance == sum(entries) after every flow.
- `pos.wallet_key` (NEW) — wallet_id, kind (band | voucher_qr | child |
  phone), value (the band code, the voucher QR, the child id, the E.164
  phone), unique on (kind, value) per operator; lookup is key → wallet.
  The prototype's two-key rule (band code and `QR-<id>` find the same
  record, mockApi.ts:325-333) becomes two rows.
- `pos.wallet_entry` — gains action_id (unique per operator — the
  concurrency/idempotency key), kind CHECK (grant | spend | refund |
  expire | reactivate), source (ticket_sale | prepaid_food | fnb_order |
  merch_order | refund | expiry | reactivation), sale_id / refund_id /
  payment_attempt_id backlinks, branch_id, station_id, box_id, offline
  flag, business_date, actor_account_id, expires_at (grants), balance_after.
- `pos.wallet_policy` (NEW) — per branch: expiry (same_day | days_n |
  never, seeded same_day per the proposal), offline cap satang (seeded
  30000 = ฿300, OD-14), prepaid-unused policy (refund, the landed
  drop-off seed). Changeable without a deploy.
- `analytics.fact_wallet_liability_daily` (NEW) — branch, date, granted,
  spent, refunded, expired, outstanding.

### 2.2 Grants become platform writes (round 1)

The server has no grant code at all today: `creditRule` (catalog.ts:80) is
stored and never read, and the till mints wallets in mockApi after the
platform finalises. Round 1 moves the law into `finaliseSale`'s
transaction, which walk-in commit, booking redemption and offline replay
all pass through: per-person grants from the LIST price exactly as the
prototype computes them (lib/sale.ts:146-264 — full_price/fixed/percent,
adults-first order, free adult earns 0 under full_price, promo and
drop-off lines skipped), one wallet per earning person with band +
voucher_qr keys, the voucher print job (`credit_voucher`) becomes a real
platform job carrying {qrCode, balanceTHB, holderName} to the receipt
printer, and the sale's answer carries the grants so the till's hidden
"Credit Grants to Print" block (StepConfirmation.tsx:228-236) comes alive
unchanged. Child prepaid credit loads the CHILD's own wallet inside
check-in-now (the landed checkin service), writing grant/prepaid_food, and
release's unused-prepaid reconciliation (release.ts:416-427) switches from
"assume nothing spent" to the real balance. Booking redemption earns
credit through the same finalise path (correcting today's gap where OD-A7
promised walk-in parity and no credit is recorded at all).

### 2.3 Spend is a tender the platform writes (round 2)

Wallet never appears on the operator's tender grid. The till sends the
scanned wallet key with the cart, and the PLATFORM writes the wallet
tender itself on the `onlineTender` model (sale.ts:3550-3577): a
payment_attempt with method `wallet`, code `wallet_credit`, amount =
min(balance, outstanding), inside the same transaction as the spend entry
(FOR UPDATE on the wallet row, action_id from the attempt). Two racing
spends of the last balance: one succeeds, one gets the honest zero —
refused, not floored (the prototype's silent clamp at mockApi.ts:397-405
is corrected per the requirement). The remainder is tendered normally and
defaults to CASH (the requirement's QA; the prototype defaulted to card —
recorded as a deliberate change). `tenderMethodOf` (attempt.ts:378-411)
learns the wallet method; `countsAsTillTakings` (shared/payments.ts:54)
returns FALSE for it, so wallet spend never reads as till money; the
drawer stays shut (cash-only kick, sale.ts:3644). The F&B and merch
stations' "S2-14a" placeholders wire to the real flow with the prototype's
exact visuals: preselected credit, the balance chip, "from credit / left
to pay" on the display, the ledger popover. The terminal's Alipay/WeChat
"wallet" word (payload.tender) is left strictly alone.

### 2.4 Refunds settle wallet-first (round 2)

The landed allocation already puts wallets first and parks the slice
pending (shared/refund.ts:161-235, refunds.ts:100-112). Round 2 settles
it: a wallet slice credits back to the SAME wallet (refund/refund entry,
action_id from the refund), capped at credit actually used minus already
restored (the prototype's restorable rule, TransactionDetail.tsx:134-138);
only the genuinely-cash remainder reaches cash. The `method === 'wallet'`
vs terminal `payload.tender === 'wallet'` clash is disambiguated by
method code. Ticket refunds do NOT claw back their grant (the prototype's
recorded stance, mockApi.ts:2831-2832 — OD-W4 for the owner).

### 2.5 Expiry, reactivation, reporting (round 3)

A branch end-of-day job (jobs.ts pattern) expires per `wallet_policy`,
writing expire/expiry entries and flipping status; prepaid meal
entitlements expire with it. Reactivation is its own entry behind
`pos:wallet:reactivate` with a typed reason, audited. The Wallet view in
the POS: key → ledger, balance, status, reactivate for those allowed. The
Wallet & Promo report and the End of day `credit` line move off mock; the
daily liability fact writes per branch; History's credit labels go real.

### 2.6 Offline spend under the cap (round 4)

The box's "no wallet balances" rule is deliberately widened: the cache
ships balance SNAPSHOTS and the policy cap; the box allows wallet spend up
to min(snapshot, ฿300/day/wallet counted locally), refuses above it with
"online only above ฿300 per day", write-ahead like offline sales, synced
once with the action key. A sync that lands a spend over the live balance
records the entry AND a `sync_anomaly` (the booking-double pattern) shown
on Failures — including the two-box double-spend (Reception Till 1 and
Counter 2 in the same outage window). Entries carry offline, station and
box ids. BOX_LANE_WALLET_REFUSED dies.

### 2.7 Promotional vouchers (round 5)

The landed voucher engine (kinds, holds, S2-10b redemption) gains the
wallet_credit issue path (vouchers.ts:969 stops throwing) plus category /
item / free-item targeting, global and per-customer limits, validity
windows, tax placement via the landed S2-09a seam, issue at the till or
minted for a campaign, and foregone-revenue reporting separate from
discounts.

### 2.8 Not this story

Staff benefit allowances (BenefitProfile.credit — S2-21). The cash-up
screen itself (S2-15a; this story only guarantees countsAsTillTakings
answers correctly for it). Member-level family pools and transfers
(no prototype logic, not required). LINE-verified phone wallets (the
risk note stands: an unverified phone holds no wallet — phone keys are
created only from verified member phones).

## 3. The rounds

| Round | Scope | Surfaces | Lands |
|---|---|---|---|
| 1 | Model + grants: migration 0045, ledger-truth, server grants at finalise (walk-in, redemption), child prepaid at check-in, voucher print real, release reconciliation on real balance | packages/db, apps/api sale/booking-redemption/checkin/release + NEW services/wallet.ts + routes, packages/shared wallet schemas, packages/print voucher, apps/pos confirmation seam | first |
| 2 | Spend + refunds: the platform-written wallet tender, concurrency, countsAsTillTakings false, F&B/merch stations live, display surfaces, refund settle wallet-first | apps/api sale/payments/refunds + wallet.ts, apps/pos OrderStation/MerchStation/FnbPayment/displays/History labels, packages/shared payments | after 1 |
| 3 | Expiry + policy + reactivation + Wallet view + reporting + liability fact | apps/api jobs/wallet.ts + routes, apps/pos Wallet view + admin report + EOD line, packages/db (policy seed only) | after 2, parallel with 4 |
| 4 | Offline cap: cache snapshots, box spend under cap, sync-once, overdraft anomaly on Failures | packages/box-agent, packages/shared bridge, apps/api sync.ts, apps/console Failures kind | after 2, parallel with 3 |
| 5 | Promotional vouchers + the closing audit + the staging walkthrough | apps/api vouchers, apps/pos voucher surfaces, reporting | last |

File fences for 3 ∥ 4: round 3 owns apps/api/src/services/wallet.ts,
jobs.ts and all apps/pos surfaces; round 4 owns packages/box-agent/**,
sync.ts, the bridge schemas and apps/console; neither touches sale.ts
after round 2 lands.

## 4. Open decisions (recommended answers hold unless the owner objects)

**OD-W1 (= OD-14).** Offline cap ฿300/wallet/day, expiry same-day,
prepaid-unused refunded — all seeded, all changeable in wallet_policy
without a deploy. Recommended as the requirement wrote them.

**OD-W2.** Credit is computed from the list price before promo and manual
discounts (the prototype's unstated behaviour, made explicit).

**OD-W3.** The remainder after credit defaults to cash (requirement),
changing the prototype's card default. The till still offers card and QR.

**OD-W4.** A refunded ticket does not claw back the credit it granted
(the prototype's stance). If the owner wants clawback it is its own
later ticket; the entries make it computable.

**OD-W5.** Walk-in wallets are anonymous (holder name only); a phone key
is attached only when a verified member is on the sale. No wallet on an
unverified phone, ever.

## 5. Landed seams this builds on

finaliseSale's single transaction and onlineTender precedent; the
payment_attempt action_id uniqueness and tenderMethodOf; the refund
allocation with its pending wallet slice; the voucher engine and holds;
the checkin service's check-in-now transaction and release reconciliation;
the box write-ahead store, outbox and quarantine pattern; business_date on
payment_attempt (sale.ts:3580-3587) for the cash-up S2-15a will build;
audit.record; the Failures surface.

## 6. Known hazards (from the seams study, each gets a test)

countsAsTillTakings currently answers TRUE for wallet (payments.ts:54) and
bookings-redeem.test.ts:1261 pins the paid_online case — extend without
breaking it. The payment-method kind CHECK exists in THREE copies
(shared/payments.ts:173, db catalog.ts:539/591, pos types.ts:1961) plus
the box zod enum (station-bridge.ts:590) — one migration, every copy, and
a box version gap to respect. MerchCustomerDisplay already subtracts
balance it cannot spend (prototype bug — fix with round 2, not port). The
display thank-you QR seeded from grant.id vs the printed `QR-...` voucher
(prototype bug — one QR, the wallet key, everywhere). wallet_entry had no
action key — the unique index IS the double-spend defence; prove it with
two racing spends and a replayed sync.
