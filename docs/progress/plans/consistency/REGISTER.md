# Till behaviour consistency register

_2 October 2026. Story SCRUM-493. A line-by-line comparison of each
delivered area with the approved till design (imports/oto-pos), so the
whole till follows one set of rules. Each entry gives the approved
design's source, the platform's current code, and the change._

Data-reliability changes stay as they are: own branch only, the park's
business day, real ids, money in satang, persistence, permissions, audit,
offline boxes and real devices. Any other difference from the approved
design is listed below.

## SCRUM-494 - band details and services carried through (first)

### 1. Tier-proof expiry is mandatory, and an expired document silently drops the rate with no re-verify flag, so the member's sales then fail with a 409

- Area: checkout-pricing, accounts-members-offline · size M
- Approved design: components/shared/VerifyTierModal.tsx:36-58: proof type only, canConfirm = !!proofType, no expiry. Lines 70-73 say 'Saved to the member profile so they won't be asked again'. lib/membership.ts:51-55 resolveAutoTier holds the verified tier indefinitely.
- Platform today: apps/pos/src/components/shared/VerifyTierModal.tsx:147-148: expiryValid is required for canConfirm, while line 207 keeps the 'won't be asked again' text and its own comment at 82 says 'a document with no expiry never does'. apps/api/src/routes/members.ts:490 requires evidenceExpiresAt. members.ts:130-142 hides an expired verification, so the till's resolveAutoTier (apps/pos/src/lib/membership.ts:51-55) falls back to the default tier. Nothing resets member.tier_code on expiry: tierCode is written only at members.ts:541 and member-tier.ts:171, and no review flag or expiry job exists. sale.ts:526-534 prices from m.tierCode. The till sends lineTotalSatang at the default price (apps/pos/src/api/sales.ts:844) for the discounted member tier, so sale.ts:1485-1497 throws 409 SALE_LINE_PRICE_MISMATCH. This was traced by reading the code, not driven on staging.
- Effect: Every verification now lapses. Once it lapses, that member's ticket sales fail at quote or Pay with an unexplained price-mismatch error until a document is re-checked. The visible dialog promises the opposite.
- Change: Revert to the approved design: a verification does not lapse. Keep the expiry field optional (the brief allows that). If an expiry date is recorded, flag the member for re-verification instead of dropping the rate, and make the till and the server read the same tier.

### 2. The platform ignores the tier staff pick, so a verified member cannot be sold at the default (Tourist) rate and the quote ends in a 409

- Area: checkout-pricing · size S
- Approved design: components/till/StepCustomerType.tsx:93-111: the default tier is never needsVerify, so onPickTier always runs for it. pages/Till.tsx:488-492 handlePickTier calls setTier and restateLinesToTier. A Thai- or Expat-verified member can be sold at Tourist.
- Platform today: StepCustomerType.tsx:107/119 and Till.tsx:1018-1022 are unchanged, so staff can still pick Tourist. The cart sends memberId (Till.tsx:584, api/sales.ts:877) and tier (sales.ts:802), but services/sale.ts:1359-1361 resolves the tier from the member (resolveTier 526-534 returns m.tierCode). input.tier is recorded only as tierDiffers (1740). The line price sent at Tourist differs from the price at the member's tier, so sale.ts:1485-1497 throws 409 before the till's 'priced at the X rate, not the one selected here' notice (api/sales.ts:1350) can show. This was traced by reading the code, not driven on staging.
- Effect: A working approved design path at the counter now ends in a refusal. To sell at the default rate, the member's verification must be revoked, and revoking needs a manager.
- Change: Port the missing rule: when the till's tier is the operator's default tier, price at it even for a verified member. It needs no proof, so it opens no price list. Ask the owner about Open decision 3's lock separately.

### 3. The restock trigger keys on the refund mode instead of the approved design's full-scope rule

- Area: tenders-refunds · size S
- Approved design: RefundModal.tsx:95-97: scope = 'full' whenever the clamped amount reaches what is left, in any mode. :107-112: by-item passes the picked lineIds, and custom passes undefined. mockApi.ts:2884-2886: for merch, a custom (lineIds undefined) full-scope refund restocks every line. :2911 and :2950: ticket and F&B restock when scope === 'full'. :2916-2918: the guard is 'no earlier scope full'. :2920-2943: it restocks socks and add-ons for EVERY ticket line.
- Platform today: packages/shared/src/refund.ts:254-260 (restockLineIds): ticket and F&B restock only when mode === 'whole', and merch custom returns []. refunds.ts:251-252: a whole refund's covered lines exclude lines an earlier refund covered, and only covered lines get lineEntries with restock (:263-269). A by-item ticket refund covers every component sale line of the cart line, socks included (api/history.ts:656-673). The guard is earlier.mode === 'whole' (:260). The file's own comment says 'the approved design's rule, kept'.
- Effect: Stock is understated in three cases: (1) a by-item or custom refund of a ticket or F&B sale that takes the whole remainder; (2) a whole refund after an earlier by-item ticket refund, where that cart line's socks and add-ons never come back; (3) a custom refund of the full remainder of a shop sale.
- Change: port the missing rule: trigger on amount >= remaining (scope full), and on the first full-scope refund restock all stocked lines not already restocked, including lines an earlier partial refund covered.

### 4. The gate and the occupancy count ignore the ticket's 'Gate access' setting, so every adult band opens the gate

- Area: arrival-gate · size M
- Approved design: Gate access comes from each line's ticket: lib/sale.ts:185 `const gate = line.ticketType.gateAccess ?? false`, :195 adults get `gateAccess: gate`, :202 kids get false. Bands carry it (mockApi.ts:2549 'from the adult's ticket package', :2593, :2606). Till.tsx:410-413 says 'Gate access comes purely from the ticket - not a park-wide config'. Occupancy counts only gate-access bands as adults (mockApi.ts:358 getAdultsInsideNow, 'Gate-access bands'). Every band without gate access, adult or kid, follows its group (mockApi.ts:2172-2174 `!w.gateAccess && !w.checkInId && groupsWithAdultInside`). Admin switch: TicketTypeForm.tsx:792-800. The client brief says the same: POS_BACKEND_LOGIC.md:189 'The gate reader checks this flag only'; reconciliation R-53 and R-83 (POS_RULES_RECONCILIATION.md:108, :148) and C5 '`gateAccess` on adult bands only'.
- Platform today: On origin/main 48e5bd7a, planBands mints kind kid/adult only (apps/api/src/services/bands.ts PlannedBand/planBands, about :59-86). The gate decision checks only `if (known.kind === 'kid') return deny('KID_BAND')` (packages/box-agent/src/gate/decision.ts, about :143), so any adult band is admitted. Occupancy counts every adult band (`b.kind = 'adult'`) and treats only `k.kind = 'kid'` bands as followers (apps/api/src/services/occupancy.ts, `inside` CTE and kids subquery). A git grep for gateAccess/gate_access under packages/box-agent and the gate/occupancy services finds nothing. The flag is stored (routes/catalog.ts:506) and copied only into wallet-grant payloads for credit-earning people (services/wallet.ts:875-900), which the gate never reads. The admin switch still shows (apps/pos/.../TicketTypeForm.tsx:796). The arrival plan quietly narrowed the rule to 'read from band.kind' (docs/progress/plans/arrival/PLAN.md:68).
- Effect: Turning Gate access off on a ticket changes nothing. Adults on that ticket still open the entrance and count as gate adults instead of following their group. A visible admin control has no effect.
- Change: Port the missing rule. Give each adult band a gate-access flag taken from its line's ticket package when the band is planned or minted. Send it in the box's bands scope. Deny entry to a band without it (as the gate already denies kids' bands). Have occupancy treat any band without gate access as a group follower.

### 5. Mobile till redemption issues the booking twice: a platform sale plus a browser sale, mock bands and a mock print

- Area: arrival-gate · size S
- Approved design: One redemption gives one sale, one set of bands (issueBookingBands) and one print dispatch: MobileTill.tsx follows Till.tsx:376-468.
- Platform today: apps/pos/src/components/mobile/MobileTill.tsx (origin/main) calls bookingsApi.redeem at about :593. That is POST /bookings/:id/redeem (apps/api/src/routes/bookings.ts:306-337, 'the sale, its bands and its print jobs'), which commits the sale, mints signed bands and queues prints. The handler then also runs recordSale(sale) (:619), issueBookingBands(sale) (:628, mock codes and browser wallets) and dispatchPrintJobs(ticketPrintJobs(...)) (:631). It ignores the platform response's bands and printing. The iPad Till was converted; the mobile one was not.
- Effect: On the phone till, staff are shown unsigned mock band codes, a phantom browser sale in History, mock wallets and a mock print toast. The real bands and any real print failure are never shown.
- Change: Port the missing rule. Use the Till.tsx handling of the redeem response (its bands, printing and box) in MobileTill, and drop the local recordSale, issueBookingBands and dispatchPrintJobs calls.

### 6. A Drop-Off/Nanny switch made on the till's cart line never reaches the check-in, so the stay keeps the service it was registered with

- Area: checkin-supervision · size S
- Approved design: DropOffLineConfig shows Drop-Off and Nanny buttons with no age lock (components/till/DropOffLineConfig.tsx:165-180). handleUpdateDropOffLine applies the switch and clears the nanny when it goes to drop-off (pages/Till.tsx:686-713). At payment the line's service and nanny become the check-in input: serviceType: d.service, nannyId (Till.tsx:1309,1314). checkInFamilyWithPayment then sets c.serviceType = it.input.serviceType, and assigns that nanny or clears it (mockApi.ts:4984-4994).
- Platform today: Origin/main keeps the same switch (apps/pos/src/components/till/DropOffLineConfig.tsx:181-192; Till.tsx:1471-1478), but the till sends only {checkinId, nannyId} to checkInNow (Till.tsx:2806-2809). checkInNow decides from the stay's stored service: `if (s.service !== 'nanny') continue` and `nannyId = s.service === 'nanny' ? ... : null` (apps/api/src/services/checkin.ts:792-801). The patch it writes has no service field (:803-811). Nothing writes the line's service back first: Till.tsx calls only checkinApi.createRegistration, uploadPhoto and recordWaiver, and sale.ts supervisionOf (:2755-2795) reads only the stay ids. Result: a 5-8 child switched to Nanny pays the nanny fee but goes in as drop-off with no nanny. A 0-4 child switched to Drop-Off pays the flat fee and is then refused NANNY_REQUIRED after the money is taken.
- Effect: High. What the family paid for and the supervision the board shows can disagree: a nanny paid for and never assigned, or a paid sale whose check-in is refused at the counter.
- Change: Port the missing rule. checkInNow should take each entry's service from the paid line, or the till should send it, apply it to the stay inside the same transaction, and run the nanny-on-shift check against it, as checkInFamilyWithPayment does.

### 7. On phone-size screens (under 768 px), registration, check-in and release still run on the in-memory mock

- Area: checkin-supervision · size L
- Approved design: The mobile shell runs the same rules against the same store as the desktop: MobileTill's gate, registration and check-in with payment, and MobileDropOffBoard's check-in, markArrived and checkOut with the pickup photo.
- Platform today: MobileTill still imports registerWalkInChildren, recordSupervisionWaiver, checkInFamilyWithPayment and linkCheckInSaleId from '@/mockApi' (apps/pos/src/components/mobile/MobileTill.tsx:30-36) and calls them at :1169, :1189 and :1497. MobileDropOffBoard reads getCheckIns() from the in-memory store (dropoff/MobileDropOffBoard.tsx:5,129) and calls mock checkOut (:491) and markArrived (:540). App.tsx:124-127 renders MobileShell whenever useIsMobile is true. EditCheckInModal.tsx:56 says so: 'The mobile shell still runs on the approved design's in-memory records'.
- Effect: Medium to high wherever a phone-size device is used. A registration, check-in or release there writes nothing to the platform: no server-side R-92 check, no audit, no band, and it is lost on reload. The desktop board still shows a child released on a phone as in the park.
- Change: Port the missing wiring: move the mobile shell onto the same checkinApi, boardApi and releaseApi calls as the desktop. Until then, block check-in and release on the mobile shell rather than writing to the mock.

### 8. Scanning a real band at F&B or Shop loses the child's allergy banner, food restrictions and prepaid-food mode

- Area: wallets, fnb-shop · size M
- Approved design: When a drop-off child is checked in with food provision, the approved design mints or loads a band carrying allergiesMedical, foodRestrictions, foodProvision and mayOrderFood = fp.mode !== 'none' (mockApi.ts:5017-5058; demo bands wb-5..wb-8 at mockApi.ts:250-313). OrderStation shows the red allergy banner, the 'Food not authorized' block and the prepaid panels from those fields (pages/OrderStation.tsx:595-647; the add block is at the handleAdd guard; the same in MobileOrderStation.tsx:156, 489-510). Correction to the original finding: for a child with mode 'none', the approved design's walk-in path mints no band either (mockApi.ts:5023 `if (!wb && fp.mode !== 'none')`). So 'no tab found for a no-food child' is the approved design's own outcome too. In practice the mayOrderFood=false block is reached only from pre-existing bands such as demo wb-6.
- Platform today: origin/main apps/pos/src/components/fnb/ScanWristband.tsx:208-227 (loadScannedTab) returns scanWallet's result as it is and merges nothing from the check-in. wristbandOfWallet (apps/pos/src/api/wallet.ts:99-113) builds only id, code, qrCode, memberId, holder, credit and ledger. /wallets/lookup (routes/wallets.ts:61-80) returns the wallet and ledger with no stay data. The stay row does hold allergies, foodRestrictions, mayOrderFood and foodProvision (services/checkin.ts:196-236), but nothing carries them to the tab. So OrderStation.tsx:569 (block), 1293 (allergy banner), 1312 (no-food notice) and 1330/1367 (prepaid panels) never fire for a real prepaid_credit child, whose wallet is keyed by the band (wallet.ts loadChildPrepaid). A prepaid_items child has no wallet at all, so the scan answers 'No tab found', where the approved design opened the band with its allergy and meals.
- Effect: Child safety. For any child checked in on the platform, the food counter sees no allergy alert and no restrictions, and a prepaid-items child cannot be served against the band. It works only for the eight demo bands.
- Change: Port the missing rule. Resolve the scanned band to its in-park stay on the server (same branch, status in_park), and return allergies, foodRestrictions, mayOrderFood and foodProvision with the wallet, or alone when there is no wallet. Merge them in wristbandOfWallet so the approved design's banner, block and prepaid panels fire unchanged.

### 9. Prepaid meal entitlements (prepaid_items) were never ported: no server record, redemption only on the mock, pickup counts every item as unused

- Area: wallets, fnb-shop · size M
- Approved design: Check-in stores fp.items on the child's band (mockApi.ts:5041-5058). The F&B station lists the entitlements (pages/OrderStation.tsx:611-647). redeemPrepaidItem increments redeemedQty once, when the order is confirmed (mockApi.ts:407-420; called from OrderStation at order confirm). Pickup reconciles only the unredeemed items (lib/dropoff.ts computePrepaidFoodReconciliation). Wallet sample wb-7 shows nuggets served and juice unredeemed (mockApi.ts:278-299).
- Platform today: loadChildPrepaid returns null for anything except prepaid_credit (origin/main apps/api/src/services/wallet.ts:1171). No server code writes redeemedQty: the only API mention is a comment at services/release.ts:431, and ChildFoodProvisionPicker seeds redeemedQty: 0. The POS still imports redeemPrepaidItem from its local mockApi (apps/pos/src/pages/OrderStation.tsx:12, 1132), so redemption only touches demo bands. At pickup, reconciliationOf (release.ts:440-444) reads the stay's frozen snapshot, so every item counts as unused. PLAN.md §2.5 says 'prepaid meal entitlements expire with it', but the expiry code has no items handling.
- Effect: Meals a parent paid for cannot be shown or served against the band. Under the refund policy, pickup refunds the full items amount even when the food was served, so money is lost on every served prepaid meal.
- Change: Port the missing rule: persist item entitlements against the child's wallet or stay, redeem them on the server when the F&B order is confirmed (idempotent, audited), replace the mock redeemPrepaidItem call, and have the release read the real redeemed quantities.

## SCRUM-495 / SCRUM-496 - match the approved till design

### 10. A manual percent discount rounds to the satang; the approved design rounds to the whole baht

- Area: checkout-pricing · size S
- Approved design: lib/manualDiscount.ts:11: Math.min(base, Math.round(base * (pct / 100))) on baht. This is the approved design's only rounding call in the engine, and it is explicit.
- Platform today: packages/shared/src/discount.ts:137-141: resolveManualDiscountAmount defaults to DEFAULT_ROUNDING = {unit:'satang'} (rounding.ts:65). cart-totals.ts:636 uses options.rounding ?? DEFAULT_ROUNDING. git grep finds no caller in apps/api/src or apps/pos/src that passes a rounding policy. PROTOTYPE_BAHT_ROUNDING (rounding.ts:71) appears only in tests.
- Effect: Every percent manual discount can differ by up to ฿0.50 from the approved design's figure. Receipts and the customer display show satang discounts, for example −฿97.30 where the approved design shows −฿97.
- Change: Revert to the approved design: make PROTOTYPE_BAHT_ROUNDING the default for manual percent discounts. The switch already exists.

### 11. The proof-type list gains 'Other' with a required free-text description

- Area: checkout-pricing · size S
- Approved design: mockApi.ts:826-830 getProofTypes() = ['Passport', 'Residence certificate', 'School card'], used by VerifyTierModal.tsx:37 and admin MemberFormDialog.tsx:81.
- Platform today: packages/shared/src/tier-proof.ts TIER_PROOF_TYPES adds 'Other'. Its comment claims 'the four names are the park's real documents', but no source on record lists 'Other'. VerifyTierModal.tsx:146-148 and 317-329 add the 'Other' button and a required description. routes/members.ts:490-492 stores the description in note.
- Effect: Low. One extra button and field in the verification modal, plus a free-text field on a durable member record.
- Change: Revert to the approved design's three types.

### 12. The ticket till's promo box now empties after Apply (SCRUM-442)

- Area: checkout-pricing · size S
- Approved design: components/till/OrderSummary.tsx:502-524: Enter and Apply call onApplyPromoCode(promoInput.trim()). Nothing in the file ever clears promoInput (its only setter is onChange at 505). The approved design's F&B screens have no promo entry at all.
- Platform today: apps/pos/src/components/till/OrderSummary.tsx:223-228 applyPromoInput() calls setPromoInput('') after every apply or refusal, 'as the F&B station's box does'. That F&B box is apps/pos/src/components/fnb/PromoCodeEntry.tsx, SCRUM-362 component, which says it copies the till's design. So the till was changed to match our copy of itself.
- Effect: Trivial, but it is a visible flow change to the ticket till beyond A-C.
- Change: Revert the till to the approved design (leave the code in the box). Make the F&B PromoCodeEntry match the till too.

### 13. 'Start corrected order' after a refund is gone from every History screen

- Area: tenders-refunds · size S
- Approved design: TransactionDetail.tsx:250-266 (handleCorrectedOrder) calls setCorrectedOrder({tier, lines, memberId, customerPhone, customerNickname}) for tickets and {lines, wristband} for F&B, then navigates. :619-638: the 'Refund recorded' card shows 'Start corrected order' (for ticket and F&B), then 'New sale' and 'Done'. MobileTransactionDetail.tsx:655 has the same.
- Platform today: apps/pos/src/components/history/SaleDetail.tsx:1347-1369: the refund-recorded card offers only 'New sale' and 'Done'. The only setCorrectedOrder callers are in MobileTransactionDetail.tsx:278 and :288, and nothing imports that file any more (git grep shows no importer). The consumers, takeCorrectedOrder in Till.tsx:462, OrderStation.tsx:234 and MobileTill.tsx:384, are therefore dead code.
- Effect: After refunding a wrong sale, staff must re-key the tier, the lines and the member. The approved design prefilled all of these.
- Change: port the missing rule: map the platform sale detail into the existing correctedOrder seam.

### 14. Add time (paid time extensions) on a ticket sale is disabled

- Area: tenders-refunds · size M
- Approved design: TransactionDetail.tsx:212-228 (handleConfirmAddTime calls recordExtension with label, minutes, braceletCount, amountTHB, paymentMethod and operator) and :653-665 (an Add time button when sale && braceletCount > 0). A 'Time added' card is shown, and AddTimeModal has its own method grid (payment-ui-map.md:170).
- Platform today: SaleDetail.tsx:1387-1395: the Add time button is permanently disabled with title LEDGER_ONLY_NOTICE (ledgerNotice.ts:15). MobileHistory does the same (MobileHistory.tsx:66-68). No schema or ticket schedules extensions.
- Effect: A family that stays longer cannot be charged for extra time from History, a flow the approved design had working.
- Change: port the missing rule (an extension row plus a tender through the payment stage).

### 15. Deleting a payment method that has taken money is refused (decision O-7 was )

- Area: tenders-refunds · size S
- Approved design: admin/payments/PaymentMethodsSection.tsx:56-67: a confirm reads 'referenced by N transactions... Delete anyway? (Disabling it instead...)', and OK deletes it. The only stated cost is that records are 'labelled by their raw token in reports'.
- Platform today: apps/api/src/services/payment-methods.ts:429-436 throws PAYMENT_METHOD_IN_USE. Its delete is already a soft archive (:439-442, archived_at plus enabled false), so an archived row would still label old records, which removes the approved design's raw-token cost. apps/pos PaymentMethodsSection.tsx:129-139 rewrites the confirm to '...so it cannot be deleted. Disable it instead?'.
- Effect: A manager cannot remove a retired tender from the admin list, only disable it. A approved design rule was replaced by a preference.
- Change: revert to approved design: keep the 'Delete anyway?' confirm and archive the method, since the archive already keeps past records readable.

### 16. 'Other' kind tenders can be neither created nor used

- Area: tenders-refunds · size M
- Approved design: PaymentMethodsSection.tsx:10-15: 'Other' is a kind, and :38/:50 make it the default kind for a new method. lib/payments.ts:40-46: unknown tokens resolve to other, with the Wallet icon (:52). :65-71: other is refunded manually. till/StepPayment.tsx renders other-kind methods with KIND_STYLE.other. (FnbPayment deliberately does not offer them, payment-ui-map.md:151-152.)
- Platform today: apps/api/src/services/payment-methods.ts:61-63 (LEDGER_BACKED_KINDS excludes other) and :202-210 refuse create or patch with kind other. apps/pos PaymentMethodsSection.tsx:74-78 changes the default new kind to cash and refuses other (:82-89, :108-113). The tender path's kind check is in services/payments/attempt.ts:380 (tenderMethodOf), not services/sale.ts as first cited. packages/shared/src/payments.ts:30 already has 'transfer' and 'voucher' ledger words.
- Effect: The park cannot configure a non-cash, non-card, non-QR tender, such as a bank transfer or a partner voucher, which the approved design supported on the ticket till.
- Change: port the missing rule: give other a ledger word (or map it to transfer or manual) and restore 'Other' as an admin kind, including the default.

### 17. The rest after wallet credit defaults to cash instead of the approved design's card (OD-W3)

- Area: tenders-refunds, wallets, fnb-shop · size S
- Approved design: pages/OrderStation.tsx:66 has useState<FnbRemainder>('card'), reset to 'card' at :455 and :468. pages/MerchStation.tsx:40 does the same, with resets at :173 and :181.
- Platform today: apps/pos/src/components/fnb/FnbPayment.tsx:73-85 ('OD-W3 — THE REMAINDER DEFAULTS TO CASH (the approved design defaulted to card...)') auto-selects the cash method whenever credit is selected and something is left to pay.
- Effect: Low: a different preselected tender at the F&B and shop counters, with a risk of recording the wrong tender when staff confirm without looking.
- Change: revert to approved design: default the remainder to the card method.

### 18. The handheld History detail and refund and reprint flows were replaced by the shared SaleDetail

- Area: tenders-refunds · size M
- Approved design: components/mobile/history/MobileHistory.tsx:11 and :139 open MobileTransactionDetail (724 lines), which uses the step-by-step MobileRefundFlow (Step = 'scope' | 'reason' | 'confirm' with step dots and the titles 'How much to refund?', 'Why?' and 'Confirm refund', MobileRefundFlow.tsx:9 and :103-106), MobileReprintFlow, AddTimeModal and 'Start corrected order' (:655).
- Platform today: apps/pos/src/components/mobile/history/MobileHistory.tsx:26 and :380-391 render SaleDetail with layout="stacked". (Correction: it is a stacked single column, not the two-column desktop grid, but it carries the desktop RefundModal dialog and cards.) MobileTransactionDetail.tsx and MobileRefundFlow.tsx are still in the tree and imported by nothing.
- Effect: The supervisor's phone shows the desktop dialog flow in place of the approved three-step mobile refund and reprint flows, a layout and flow change against CLAUDE.md §7.1.
- Change: revert to approved design: rewire MobileTransactionDetail, MobileRefundFlow and MobileReprintFlow to the same history API that SaleDetail uses.

### 19. The handheld History lost its Today / Yesterday / This week / All time chips

- Area: tenders-refunds · size S
- Approved design: components/mobile/history/MobileHistory.tsx:36-41 (DATE_FILTERS Today, Yesterday, This week, All time), rendered at :310.
- Platform today: apps/pos/src/components/mobile/history/MobileHistory.tsx:69-71 says the chips 'became one date control: the ledger read answers ONE trading day', with a date input at :599. But routes/sales.ts:654-663 and :697-698 already accept a from/to business-date range.
- Effect: A supervisor can no longer see yesterday's or this week's orders on the phone at a glance, a visible control change the API can now support.
- Change: port the missing rule: restore the chips and map them to from/to (with a bounded span for 'All time' if needed).

### 20. The ticket payment button labels changed: 'Record cash' and 'Select a payment method' replace 'Confirm Payment Received'

- Area: tenders-refunds · size S
- Approved design: components/till/StepPayment.tsx:105-112: one button, 'Confirm Payment Received', for every tender, disabled until a method is chosen.
- Platform today: apps/pos/src/components/till/PaymentTenderPanel.tsx:12-18 (paymentSubmitLabel) and i18n/dictionary.ts:14 and :17 give cash 'Record cash' and an unselected method 'Select a payment method'. Card ('Start card payment') and QR ('Show payment QR') changed for real-device reasons (B). Cash also gained a cash-received and change keypad that the approved design did not have.
- Effect: Cosmetic: the visible label changes on the most-used button, and cash did not need to change.
- Change: revert to approved design: keep 'Confirm Payment Received' for cash and for the disabled no-method state.

### 21. /book lets a family add supervised (drop-off/nanny) children and event passes, then refuses them at payment

- Area: arrival-gate · size L
- Approved design: createBooking (mockApi.ts:1045-1140) handles both. It registers event-pass attendees through addEventAttendee and sets booking.eventPasses. For drop-off lines it creates a registration with consent, a registrant check and registrationId. At redemption, Till.tsx handleRedeemConfirm checks passes into their events and prompts the drop-off check-in. RedeemBookingModal.tsx:163-167 shows the drop-off marker; :216-221 and :250-267 show the event-pass rows. The client brief says the same at POS_BACKEND_LOGIC.md:77-78 (saved and drop-off children 'Applies at reception AND booking site').
- Platform today: apps/pos/src/pages/Book.tsx:776-789 (origin/main) sets `bookedAtReception = passes.length > 0 || normalizedLines.some(l => l.dropOff)` and stops at Pay with the toast 'Online payment covers play tickets - Event passes and supervised children are booked at reception.' The earlier stages still let the family build that basket. The server quote does not price either. toPosBooking (apps/pos/src/api/bookings.ts:451-455 docblock, :494-510) never sets registrationId or eventPasses. That leaves the redemption-side event check-in and drop-off prompt (apps/pos/src/pages/Till.tsx:960-984) unreachable, and the modal's drop-off marker removed (RedeemBookingModal.tsx:375-376 comment).
- Effect: A family sets up a nanny or drop-off child or an event pass online and learns only at the last step that it cannot be paid. A whole approved design flow (book online, then check in at reception from the registration or event roster) is missing, and the code that would handle it at redemption can never run.
- Change: Port the missing rule: price drop-off lines and event passes in the public quote, create the registration and attendees when the booking is paid, carry registrationId and eventPasses on the booking, and map them in toPosBooking. Until that lands, at least hide the pass and supervise options on /book rather than refusing at Pay.

### 22. The redeem summary never shows the '฿X credit' line under 'Will issue at the door'

- Area: arrival-gate · size S
- Approved design: createBooking computes willIssue.creditTotalTHB from buildCreditGrants(params.lines) (mockApi.ts:1046-1053). RedeemBookingModal.tsx:244-245 shows '• ฿{creditTotalTHB} credit' when it is above 0.
- Platform today: apps/pos/src/api/bookings.ts:503 hard-codes `willIssue: { ..., creditTotalTHB: 0 }`, and the docblock at :457-459 explains why. The mapped lines already carry the catalogue ticketType, so buildCreditGrants(lines) could compute the figure exactly as the approved design does. The redemption sale does grant the credit (booking-redemption plus wallet.ts grantSaleCredit, OD-A7). The modal's line at RedeemBookingModal.tsx:453-454 can never show.
- Effect: Reception is not told that the family's bands carry credit, though the sale grants it.
- Change: Port the missing rule. Compute creditTotalTHB from the mapped lines with the shared buildCreditGrants, or return the figure from the server's grant computation.

### 23. The redeem summary's payment row (Card / PromptPay / QR) is always hidden

- Area: arrival-gate · size S
- Approved design: RedeemBookingModal.tsx:226-227 always shows paymentMethodIcon and paymentMethodLabel(booking.paymentMethod), with labels 'card' -> 'Card' and 'promptpay' -> 'PromptPay / QR' (:19-28).
- Platform today: The row renders only when `foundBooking.paymentMethod` is set (apps/pos/src/components/till/RedeemBookingModal.tsx:432). bookingView reads payload.paymentMethod (apps/api/src/services/bookings.ts:372), but booking-checkout.ts never writes it: the booking payload at :602-611 has no paymentMethod. The method exists only on the attempt (booking-checkout.ts:673-674, :763 methodCode 'card' or 'promptpay', the same codes the approved design labels). The comment in apps/pos/src/api/bookings.ts:500-502 ('S2-10a owns that') is out of date.
- Effect: A approved design label is lost although the data exists. Reception cannot tell a card booking from a PromptPay one.
- Change: Port the missing rule. When the booking is paid, write the paid attempt's methodCode into the booking payload, or join it in bookingView.

### 24. The booking reference changed format from OTO-XXXX-XXXX to a decimal OTO-NNNNNNN-NNNN

- Area: arrival-gate · size S
- Approved design: mockApi.ts:1054-1057 builds `OTO-` + 4 base-36 upper-case characters + `-` + 4 base-36 upper-case characters. The till input placeholder is 'OTO-XXXX-XXXX' (RedeemBookingModal.tsx:125).
- Platform today: apps/api/src/services/booking-checkout.ts:568 builds `OTO-${String(randomInt(0, 36 ** 4)).padStart(4, '0')}-${randomInt(1000, 9999)}`. The `.toString(36)` is missing, so the first part is a decimal of up to 7 digits and the second part is decimal 1000-9999 (for example OTO-349113-9391). The till placeholder still reads 'OTO-XXXX-XXXX' (apps/pos/.../RedeemBookingModal.tsx:312).
- Effect: The code families read out and staff type differs in length and character set from the approved design and from the till's own hint.
- Change: Revert to the approved design: four base-36 upper-case characters in each part, keeping crypto randomInt and the unique constraint on reference.

### 25. Booking list rows lost the drop-off marker and gained the parent's name, and the summary gained 'N × extra' lines

- Area: arrival-gate · size S
- Approved design: RedeemBookingModal.tsx:157-167 list row: reference, then tier · N guests · (Baby icon) drop-off when registrationId is set. 'Will issue at the door' (:236-251) lists child and adult wristbands, credit, drop-off check-in and event check-in only.
- Platform today: apps/pos/src/components/till/RedeemBookingModal.tsx:369-376 (origin/main) adds `· {b.parentName}` and leaves out the drop-off marker (comment :375-376). :456-458 adds '• {quantity} × {name}' lines for paid socks and extras.
- Effect: Small visible changes to an approved POS screen that the owner has not approved.
- Change: Revert to the approved design row and summary, and bring the drop-off marker back with the online drop-off port. If the parent's name or the extras lines are wanted, list them as proposed UI additions for the owner.

### 26. The server forces an added sibling's service to match the age band, refusing the staff Drop-Off/Nanny choice the approved design allowed

- Area: checkin-supervision · size S
- Approved design: The add-sibling form in AddDropOffModal has a staff toggle `kind` that defaults to 'drop_off' and has no age limit (components/till/AddDropOffModal.tsx:64,71,200-218). addChildToRegistration does no age check and stores 'drop_off' (mockApi.ts:4675-4704). The toggle reaches the line as serviceOverride (Till.tsx:623-647), and the line's service wins at check-in (mockApi.ts:4993). updateCheckIn lets staff set any service (mockApi.ts:5427,5439).
- Platform today: The POS add-sibling sends `service: kind` (apps/pos/src/components/till/AddDropOffModal.tsx:151-157). addRegistrationChildren then runs assertService (apps/api/src/services/checkin.ts:538), which refuses SERVICE_MISMATCH unless service === resolveRequirement(age) (:336-346). So a 3-year-old sibling left on the default Drop-Off is refused, a 6-year-old switched to Nanny is refused, and a sibling aged 9 or over cannot be added at all, because the toggle offers only drop_off and nanny. editCheckin still accepts any service (checkin.ts:1401,1409), so the platform contradicts itself. The same check in createRegistration (:468) only re-checks what the age-driven gate already worked out, which is defensible. The add-sibling refusal is the real departure.
- Effect: Medium. Reception cannot add a sibling the way the approved design's screen invites, and the refusal only appears after the form is filled in.
- Change: Revert to the approved design: drop assertService from addRegistrationChildren, or apply it only at the gate.

### 27. The automatic connection-check message to the parent's number on registration was not ported

- Area: checkin-supervision · size S
- Approved design: registerWalkInChildren sends one connection-check message for the whole walk-in group once all siblings are written: `if (sender) autoSendWaConfirmation(sender)` (mockApi.ts:4785-4790; same at :1202). autoSendWaConfirmation sends the tpl-confirm-connection template once per registration and stamps every sibling 'pending' (mockApi.ts:5717-5741). ConsentCapture.tsx:282 says the phone is captured at the gate so that this fires immediately on registration.
- Platform today: createRegistration (apps/api/src/services/checkin.ts:440-525) and POST /checkin/registrations (apps/api/src/routes/checkin.ts:109-136) send nothing. The box desk registers with contact: null (packages/box-agent/src/checkin-desk.ts:786). sendContactTest (checkin.ts:1816) is called only from the manual contact-test route (routes/checkin.ts:457) and from a phone or channel edit (checkin.ts:1552). The board calls it only from Resend and Save & resend (apps/pos/src/pages/DropOff.tsx:668,712).
- Effect: Medium. Every walk-in family starts with an unverified channel and shows in the 'unconfirmed' filter. No connection check goes out until staff press Resend.
- Change: Port the missing rule: call sendContactTest once per registration inside createRegistration when the guardian phone is set, and queue the same on the box path.

### 28. The 'Add drop-off' waiting-registrations picker lists oldest first; the approved design listed newest first

- Area: checkin-supervision · size S
- Approved design: getRegistrationsAwaitingCheckIn sorts the groups newest registration first: `.sort((a, b) => bAt.localeCompare(aAt))` (mockApi.ts:4530-4534).
- Platform today: registrationsAwaitingCheckIn uses .orderBy(asc(registration.createdAt)) (apps/api/src/services/checkin.ts:307). AddDropOffModal maps the groups without re-sorting; it sorts only the children inside each group (apps/pos/src/components/till/AddDropOffModal.tsx:101-112).
- Effect: Low. The list is reversed on screen, so the family most likely to be at the counter is at the bottom.
- Change: Revert to the approved design: order by desc(createdAt), or re-sort newest first in the modal.

### 29. F&B/Shop payment screen: inline remainder buttons removed and tender wording changed

- Area: wallets, fnb-shop · size S
- Approved design: components/fnb/FnbPayment.tsx:206-232: the credit card holds 'Credit covers ฿X. Collect remaining ฿Y by:' and a 3-column Cash/Card/QR button grid. :240, 249, 258 read 'Collect ฿{total} in cash', 'Charge ฿{total} to card' and 'Customer scans to pay ฿{total}'. :131 '...nothing to collect. Tap below to send it to the kitchen.' with a 'Complete Order' button (:147).
- Platform today: origin/main apps/pos/src/components/fnb/FnbPayment.tsx:174-179: the 'Collect remaining ฿Y by:' sentence is kept with no buttons under it. :233 replaces the descriptions with 'Collect cash, with the amount handed over and change.', 'Take card through this station’s payment route.' and 'Show the payment QR and wait for the payment result.' (amount dropped). :206 shortens the ฿0 text to 'This order is fully covered — nothing to collect.', and the confirm moves into PaymentTenderPanel (:250).
- Effect: Visible labels and layout differ from the approved design, and 'Collect remaining ฿Y by:' now ends in nothing.
- Change: Revert to the approved design wording and layout. Keep per-kind descriptions with the amount ('Collect ฿X in cash', and so on), and restore the remainder grid inside the credit card, driven by the configured methods and feeding the stage's selectMethod. Leave PaymentTenderPanel for the actual collection.

### 30. Credit can only be spent at the branch that issued it; the approved design and BL treat wallets as global

- Area: wallets · size S
- Approved design: Corrected evidence: the 'ONE universal balance' comment (mockApi.ts:240-242) is about the F&B and merch stations, not branches. The real approved design evidence is that the Wristband type carries no branch at all (types.ts, Wristband interface) and getWristbandByCode resolves any band whatever the active branch (mockApi.ts:325-333). BL §1.2 lists 'wallet identity' among the GLOBAL data shared across all branches (POS_BACKEND_LOGIC.md:46), and resolved rule R-02 repeats it (POS_RULES_RECONCILIATION.md:47).
- Platform today: origin/main apps/api/src/services/wallet.ts:540-543: debitForSale answers WALLET_NOT_FOUND when found.branchId !== input.branchId. The lookup returns 404 when the account cannot read the wallet's branch (routes/wallets.ts:47-55, 77). vouchers.ts /:id/credit hides another park's wallet (routes/vouchers.ts credit route).
- Effect: Low today (one live branch on the platform, same-day expiry). It becomes real when a second branch runs on the platform or a multi-day expiry is set: a guest's paid credit is refused at the other branch with a misleading 'not found'.
- Change: Revert to the approved design behaviour (spendable at any branch of the operator, with the spend recorded at the spending branch) unless the owner rules otherwise. Raise it as a question with the inter-branch liability trade-off. At minimum, replace 'not found' with an explicit wrong-branch reason.

### 31. Low-stock alerts are suppressed while an open purchase order covers any size of the item, which also hides the transfer suggestion

- Area: stock · size S
- Approved design: imports/oto-pos/artifacts/oto-till/src/components/mobile/stock/StockSuggestions.tsx:17-43 buildOnOrderMap. :180 attaches onOrder to the entry, and every entry still gets a card. :375-378 shows the transfer button first, regardless of onOrder. :385-400 shows 'Already ordered - N arriving <date>' for an ordered PO, or 'Already on the purchase list - place the order in Purchase' for a to_order PO. Nothing in the approved design suppresses a card.
- Platform today: apps/api/src/services/stock.ts (origin/main):2978-2980 doc comment says 'SUPPRESSED while an open purchase order (to order or ordered...) covers any of its sizes'. :3033-3047 builds `covered` from to_order+ordered lines with outstanding qty. :3093 does `if (sizes.some((s) => covered.has(s.id))) continue;`, which drops the whole row, the below-par transfer case included. apps/pos/src/components/mobile/stock/StockSuggestions.tsx:6-22 now renders only platform rows, so 'Already on the purchase list - place the order in Purchase' can no longer appear for a suppressed item. New visible sentence at :306: 'An item already on an open order is not listed.'
- Effect: An item placed on the purchase list but never sent to the supplier loses the approved design's 'place the order in Purchase' reminder. An item with size S on order vanishes even while size M is out. A counter shelf below par that has stock in BOH loses its 'Move N from Back of House' card while any PO is open. The Alerts count also differs from the approved design's.
- Change: Revert to the approved design: keep the row and show the 'Already ordered' or 'Already on the purchase list' card (the POS code at StockSuggestions.tsx:465-480 still has both texts). Remove the 'not listed' sentence.

### 32. The usage-based reorder point adds an +1 safety day

- Area: stock · size S
- Approved design: lib/inventory.ts:55-58: 'a production system would trigger on totalStock <= usageRate x leadTimeDays'. components/mobile/stock/StockPurchasing.tsx:533-536: '(stock <= usage rate x lead time)'.
- Platform today: packages/shared/src/stock.ts:680-682 STOCK_TREND_SAFETY_DAYS = 1. :730-734 reorderPointFor computes ceil(used x (lead + 1) / 30). apps/api/src/services/stock.ts:2984-2988 says the same. Visible text in apps/pos StockSuggestions.tsx:303-306 (and StockPurchasing): 'x (lead time + 1 day), rounded up'.
- Effect: Every item past 30 days of history reorders earlier than the approved design's stated rule. Bottled Water (approved design catalogStore.ts:638, lead 2) gets a point 50% higher.
- Change: Revert to the approved design formula ceil(used x lead / 30). Set STOCK_TREND_SAFETY_DAYS to 0 or remove it, and drop '+ 1 day' from the visible text.

### 33. Refunded units go back to the place each unit was taken from, not to the sell point

- Area: stock · size S
- Approved design: mockApi.ts:2896, 2922-2936 and 2959 restock refunds with adjustInventoryStock(+qty) and no location. store/catalogStore.ts:1233-1236 defaults the target to the sell point, and :1250-1252 puts a positive delta entirely in the target, so returned goods go back on the counter shelf.
- Platform today: apps/api/src/services/stock.ts restockForRefund (905-1000): the doc comment at ~896-898 says 'to the PLACE each unit was taken from'. It writes one refund movement per original sale movement with stockLocationId: row.stockLocationId (~967-978), so a sale that cascaded to BOH or bulk restocks BOH or bulk.
- Effect: The guest hands the item back at the counter, but the record puts it in the back room or store room. FOH reads short and BOH long until the next count, which then shows phantom differences at both places.
- Change: Revert to the approved design: put refund restocks at the sell point. The idempotent action id can stay keyed per sale line.

### 34. Stock Overview 'Low' filter compares the item total, not each size, against the reorder point

- Area: stock · size S
- Approved design: components/mobile/stock/StockOverview.tsx:65-78: an item is low if ANY variant's qty (non-zero) is at or below its lowStockThreshold, or, for all locations, at or below item.reorderSettings.reorderPoint, size by size.
- Platform today: apps/pos/src/components/mobile/stock/StockOverview.tsx:27-45 isLowInScope uses itemTotal <= reorderPointNow (the item total against the platform point), plus the per-size threshold.
- Effect: Different items appear under 'Low'. Grip Socks add-on S=25 against reorder point 30 (approved design catalogStore.ts:617-623) is low in the approved design. The platform sees a total of 85 and leaves it out.
- Change: Revert to the approved design's per-size comparison against the reorder point. The point itself may be the platform's point for today.

### 35. Admin Adjust refuses a decrease beyond what is held instead of clamping at 0; with a named place it no longer cascades

- Area: stock · size S
- Approved design: components/admin/inventory/StockAdjustModal.tsx:59 previews 'New stock after adjustment' as Math.max(0, current + delta). mockApi.ts:1458 calls adjustInventoryStock(..., locationId), and store/catalogStore.ts:1253-1268 takes from the target, cascades through the other places, and clamps each at 0.
- Platform today: apps/api/src/services/stock.ts adjustStock 1634-1690: the comment at 1631 says 'refused, not clamped', and STOCK_ADJUST_TOO_MANY at 1674 returns '... holds only N ... - nothing was changed'. With a named location, `places = [named]` (~1646), so there is no cascade. apps/pos StockAdjustModal.tsx:59 still previews the clamped figure.
- Effect: Low. The modal promises a figure that the save then refuses, and a named-place decrease no longer draws from the other places.
- Change: Revert to the approved design: clamp at 0 and cascade from the named place.

### 36. Pack entry refuses part packs and negatives instead of rounding or flooring them, and a pack must hold 2 or more

- Area: stock · size S
- Approved design: lib/stockUnits.ts:12-14 calls the parser 'intentionally lenient (the parsed result is always shown to the user before confirming)'. :22-23 and :42 floor negatives at 0, and :54 returns Math.round(total). admin/inventory/InventoryItemFormDialog.tsx:102 defaults eaches to '1', and :335-336 requires >= 1.
- Platform today: packages/shared/src/stock.ts:90-135 parsePackQuantity refuses non-whole results and negatives with reason text (the comment says 'The approved design ROUNDED ... this refuses both'). apps/pos InventoryItemFormDialog.tsx:104 defaults eaches to '2', and :363-365 shows 'Must be >= 2.'
- Effect: Low. Entries the approved design accepted ('1.3 dozen' -> 16, a 1-each pack) are now refused, with new error words.
- Change: Revert to the approved design's lenient parse and the >= 1 pack rule. The parsed total is already shown before confirming.

### 37. Item form's 'Total stock' field is read-only; the approved design lets the manager type the starting stock of a new item

- Area: stock · size M
- Approved design: admin/inventory/InventoryItemFormDialog.tsx:655-664 has an editable 'Total stock' input, validated at :322-323 and saved at :367. :370-373 says stockByLocation is 'owned by stock ops', so the typed figure only takes effect for a new item, which has no per-place stock yet.
- Platform today: apps/pos/src/components/admin/inventory/InventoryItemFormDialog.tsx:707-717 makes it readOnly and disabled, titled 'Count or receive stock in the Stock module to change it' (the comment cites OD-S5).
- Effect: A manager creating an item can no longer give it starting stock in the form, and has to do a count or a receive.
- Change: Port the missing rule: for a new item, write the typed total as one audited movement at the sell point. Or put it to the owner with OD-S5.

### 38. Till 'Insufficient stock' toast wording changed

- Area: stock · size S
- Approved design: pages/Till.tsx:1201, 1226 and 1232: 'Cannot complete sale — stock too low: Regular Socks (need 5, have 3)'.
- Platform today: apps/pos/src/pages/Till.tsx:2442 and 2448: 'Cannot complete sale — Only 3 Regular Socks left' (stockShortMessage, packages/shared/src/stock.ts:59).
- Effect: A visible label changes on the till. Low.
- Change: Revert the client toast to the approved design wording. Server refusals may keep the new message.

### 39. Admin Inventory help text reworded and reordered

- Area: stock · size S
- Approved design: admin/inventory/InventoryPanel.tsx:261-262: 'Sale decrements and refund restores happen automatically. Use "Adjust" for receive, shrinkage, or recount corrections — these are stamped with your operator ID.'
- Platform today: apps/pos/src/components/admin/inventory/InventoryPanel.tsx:290-293: 'Use "Adjust" for receive, shrinkage, or recount corrections. Sale decrements and refund restores follow automatically and each adjustment carries the operator who made it.'
- Effect: Cosmetic wording drift.
- Change: Revert to the approved design text.

### 40. The whole-order note never reaches the ledger or the platform-printed kitchen and bar tickets

- Area: fnb-shop · size S
- Approved design: lib/fnb.ts:198-201 and 233: 'Whole-order note - printed on BOTH prep tickets'. pages/OrderStation.tsx:525 and mobile/order-station/MobileOrderStation.tsx:73 and 351 record orderNote on the order, and fnbPrintJobs prints it.
- Platform today: origin/main pages/OrderStation.tsx:1043-1047 writeInput builds { cart, finalise:false, preferSaleId? } with no note. MobileOrderStation.tsx:369 calls saleWriter.commit({ cart, finalise:false }) without one either. The writer and the route already accept a note (lib/saleWriter.ts:129 and 420; routes/sales.ts:310 and 494), and the composer prints snapshot.note as orderNote (packages/shared/src/sale-print.ts:314 and 338, filled from saleRow.note at sale-printing.ts:936). The till's own fnbPrintJobs fallback runs only when the platform returns no print jobs (lib/printRouting.tsx:370-387 announceSalePrinting). So the note typed into the order-note bar (MobileOrderStation.tsx:657, and the OrderStation cart :1595) reaches only the till's local record and its customer display.
- Effect: Medium. Order-level instructions typed at either F&B station ('serve at 16:00', 'candles on the side') never reach the kitchen or the bar, and they are not on the sale record.
- Change: Port the missing rule: pass note: orderNote.trim() || undefined in OrderStation writeInput and in the MobileOrderStation commit. The plumbing on the server side already exists.

### 41. The shop's in-till customer display skips the approved design's payment screen and draws a new one

- Area: fnb-shop · size S
- Approved design: components/merch/MerchCustomerDisplay.tsx:240-306. While a QR is due: the 'Thai QR / PromptPay' badge, 'Scan to pay', the QR, the amount, 'paid from credit', 'Open your banking app' and a waiting spinner. Otherwise: a 'From credit' row and a 'Left to pay' / 'To pay' row, then 'Confirm with staff'.
- Platform today: origin/main pages/MerchStation.tsx:812-833: while stage === 'payment', the station renders its own markup (an h2 amountToPay, the QR, the credit row, the amount, a status line) and never reaches MerchCustomerDisplay's payment stage. It also passes promptpayAmount={null} (:840). The F&B station keeps its approved design customer display and feeds it the payment state, so the two stations are now inconsistent.
- Effect: Low. The guest-facing shop payment screen differs from the approved design: no PromptPay badge, no banking-app prompt, and no 'To pay' label when no credit is used.
- Change: Revert to the approved design: render MerchCustomerDisplay's payment stage with the platform's QR payload, amount and credit figures, as the F&B display does.

### 42. Developer status strips with ticket numbers shown on the staff F&B screen and the admin Menu and Merch panels

- Area: fnb-shop · size S
- Approved design: pages/OrderStation.tsx:569-666: the order stage shows only the staff safety banners and the menu grid. The admin Menu and Merch panels carry no ticket text.
- Platform today: origin/main pages/OrderStation.tsx:1383-1396 always renders a strip, 'This till's own record - Prepaid items - S2-14a', plus 'Stock counts and out-of-stock - S2-14b' when stock is not server-backed. MerchStation.tsx:650-662 does the same conditionally. components/admin/menu/MenuPanel.tsx:117 and admin/merch/MerchPanel.tsx:91 (and AddOnsPanel.tsx:63) show 'Stock counts are this tab only - SCRUM-204.' S2-14a and S2-14b (SCRUM-212 and SCRUM-213) are both Deployed, so the ticket references no longer match the state of the work.
- Effect: Low. Staff see sprint ticket numbers on the counter and in the back office, and some of the statements may be out of date.
- Change: Revert to the approved design: remove the strip from the F&B order stage. Where a real limitation remains (prepaid items, until the third finding is fixed), state it in plain words without ticket keys, and drop or re-verify the admin SCRUM-204 banners.

### 43. 'Badge or PIN' field added to the locked till screen, though it unlocks nothing

- Area: accounts-members-offline · size S
- Approved design: The approved design has no such control. Grep for 'badge or pin' and 'scan a badge' in the approved design finds nothing. Locking is components/auth/LockScreen.tsx plus InactivityWarning.tsx.
- Platform today: apps/pos/src/components/auth/LockScreen.tsx:254-283 adds a 'Badge or PIN' input and a 'Present' button under Unlock. presentBadge (:198-214) only posts to scanApi.badge and shows the answer as a notice. It never unlocks. Its own comment (:186-188) says 'Nothing links a badge to an account on this build'. It arrived in wip commit 64407619 (S2-06).
- Effect: Staff see a second way to unlock that does nothing and may think the till is broken. It is a visible addition beyond what A-C require.
- Change: Remove it from the POS lock screen and keep the badge test where the scanning service is exercised (the box simulator and Box log drawer). Put it back only when badge or PIN unlock is built and ruled for the till.

## SCRUM-497 - details for the owner to confirm

### 44. Ruling 2: a scoped promo code may take only what its own scope has left (the approved design clamps only to the order balance)

- Area: checkout-pricing · size S
- Approved design: imports/oto-pos/artifacts/oto-till/src/lib/sale.ts:101-110: for a scoped code, base = Math.min(discountTargetBase(lines, target), running), where the scope base is undiscounted and the only clamp is the order's running balance. NOTE: the finding quoted only 87-90. The comment at sale.ts:95-96 also says 'The code applies only to the ฿ within its scope ... never more than what remains after earlier discounts'. The approved design's arithmetic breaks that comment (EC-17 lets two ticket-scoped codes take ฿300 of socks and lockers). So the approved design's own comment partly supports the platform, by the same kind of comment evidence that made ruling 1 count as a cited rule.
- Platform today: origin/main packages/shared/src/cart-totals.ts:731-781: base = orderWide ? running : Math.min(scopeLeft, running). The header comment calls it a local decision. Line 801 adds exhaustedReason when a code takes nothing.
- Effect: Correction: the 2.96% and 9.69% figures (cart-totals.ts:236-237, pricing-regression.json EC-17 note) measure the ATTRIBUTION change that was reverted, not ruling 2. They should not be cited for this finding. Ruling 2's measured effect is EC-15 going from ฿0 to ฿1,000 and EC-17 from ฿0 to ฿300 (comp or code stacked on the same component). The bill can only go up. It is dormant, because no code the park holds is scoped this way.
- Change: Ask the owner, which is already queued in OPEN_QUESTIONS. Frame the question as 'the approved design's comment says a code works only within its scope, and its arithmetic does not': this is the closest call in this module, not a clear case of .

### 45. A tier with no price on a ticket is refused everywhere; the approved design sells it at ฿0

- Area: checkout-pricing · size M
- Approved design: lib/pricing.ts:12-24 and lib/pricingMode.ts:62-66 resolveRate (if (!price) return 0). TicketCard.tsx:29 always shows ฿{priceForTier}. StepCustomerType.tsx:92 lists every tier from getTiers(), unfiltered. The admin TicketsPanel.tsx:60-66 shows 'not priced' for the cell, but the till still sells at ฿0.
- Platform today: apps/api/src/services/sale.ts:1390-1398 refuses with 400 '"{pkg}" has no {tier} price'. Its comment calls the ฿0 'the approved design's defensive answer for a picker that only lists priced tiers', which is wrong: the approved design picker lists every tier. apps/pos/src/lib/pricing.ts:66 isTierPriced is used by TicketCard.tsx:46-51 ('Not priced' plus the unpricedReason sentence), OrderSummary.tsx:704 ('This tier has no price'), CustomerDisplay.tsx:440, displaySession.ts:82, MobileTill.tsx:865-868/1349 and MarketsTiersSection.tsx:117.
- Effect: A newly added tier cannot sell until it is priced, where the approved design charged ฿0. It also adds about eight new visible strings and states on the till, the customer display, the phone till and admin. The safety argument is reasonable, but this is our preference.
- Change: Ask the owner (a real trade-off). Also correct the sale.ts:1390-1393 comment, which misdescribes the approved design.

### 46. Prices and promo dates follow the 05:00 business day instead of the calendar day (rulings 3 and 4)

- Area: checkout-pricing · size S
- Approved design: lib/pricingMode.ts:34-59 getRateModeForDate and todayRateMode use device-local midnight. pages/Till.tsx:560 checks promo validity against the UTC date (new Date().toISOString().slice(0,10)). The UTC date is a data-source fault (A), so the A-correct fix is Bangkok local midnight.
- Platform today: packages/shared/src/pricing-mode.ts:48-81 rateModeToday(businessDate(now, tz, dayStart)) is labelled a local decision. promo.ts:53-58 and 114 are ruling 4. apps/pos/src/lib/pricingMode.ts:108-109 branchTradingDate is used at line 275.
- Effect: Low. Sales rung between 00:00 and 05:00 are priced at the previous day's weekday or weekend rate, and promo codes roll over at 05:00 instead of local midnight. The park trades 10:00-20:00.
- Change: Ask the owner (a real trade-off). Otherwise use Bangkok local midnight for pricing and promo validity, which is the A-only fix, and keep the business date for ledger and End of Day.

### 47. Ending a verified tier needs a manager (pos:member:tier_downgrade)

- Area: checkout-pricing · size S
- Approved design: The approved design has no revoke or downgrade (grep of src finds none) and no permission gate on any tier action. Any staff member can sell a verified member at the default tier (StepCustomerType.tsx:111).
- Platform today: apps/pos/src/components/shared/VerifyTierModal.tsx:97 mayRevoke = can('pos:member:tier_downgrade'), and lines 239-241 show 'Taking that rate back off a member needs a manager.' apps/api/src/routes/members.ts:572-581 guards DELETE /:id/tier-verification with the same permission.
- Effect: Low on its own. Together with the server-side tier lock above, reception cannot correct a wrongly recorded tier or sell a verified member at the default rate without a manager. If that finding is fixed, only a permanent revoke stays manager-gated.
- Change: Ask the owner (a real trade-off), together with Open decision 3.

### 48. Holiday ranges that priced a sale cannot be removed and their dates are frozen; removal now asks for confirmation

- Area: checkout-pricing · size S
- Approved design: components/admin/pricing-overrides/PricingOverridesSection.tsx:70 remove = mutators.deletePricingOverride(id), wired to the trash button at 166-170 with no confirmation dialog. Ranges are freely editable.
- Platform today: apps/pos/src/components/admin/pricing-overrides/PricingOverridesSection.tsx:55 holidaySaleCounts sets frozen dates, with the text at line 168 ('so its dates are fixed'). The AlertDialog at 228-244 asks 'Remove "{name}"?' with 'Keep it' / 'Remove holiday'. apps/api/src/routes/catalog.ts:687-704 HOLIDAY_HAS_SALES. This rests on schema choice, packages/db/src/schema/sales.ts:326 holiday_id ON DELETE RESTRICT, although sale also stores holiday_name (line 327), pricing_mode and its reason (sale.ts:514-517). Persistence did not require the block.
- Effect: Low. A manager who sets a holiday wrongly cannot correct its dates after the first sale under it. It also adds one dialog and one sentence to admin.
- Change: Ask the owner (a real trade-off). The approved design-faithful option is ON DELETE SET NULL with the stored name and mode kept on the sale, and no confirmation dialog.

### 49. Refunds need a manager's approval: reception is refused REFUND_APPROVAL_REQUIRED

- Area: tenders-refunds · size S
- Approved design: Anyone signed in can refund. TransactionDetail.tsx:230-248 (handleConfirmRefund) only stamps operator.name/id, and :667-674 shows 'Refund (฿N left)' to everyone. POS_BACKEND_LOGIC.md:351 says a refund is 'stamped with the operator', with no approval step. (Correction: :392 lists only discounts, comps and stock variance as removed gates and does not name refunds, so it is supporting rather than direct evidence.)
- Platform today: apps/api/src/services/refunds.ts:176 calls actor.assertCanApprove. routes/sales.ts:802-809 throws REFUND_APPROVAL_REQUIRED without pos:refund:approve (permissions.ts:164). Only branch_manager holds it (:367); reception has pos:refund:create alone (:304). SaleDetail.tsx:916 enables the button on refund:create, so reception sees Refund and is then refused. There is no co-sign or override.
- Effect: Reception, the role at the desk, cannot refund at all. Every refund waits for a manager to sign in on that till, a workflow the approved design did not have.
- Change: ask the owner (real trade-off): open decision 8 has never been ruled. Until it is, the approved design rule (refund on pos:refund:create) should apply, or a manager co-sign should be offered on the spot.

### 50. Card refunds go back in cash when partial or outside the void window, instead of back to the card

- Area: tenders-refunds · size L
- Approved design: lib/payments.ts:62-71 (refundModeForMethod): card and qr kinds 'reverse automatically through the gateway', and cash or other are handed back manually. RefundModal.tsx:259-271 tells staff 'Returns to the original card / QR automatically.'
- Platform today: packages/shared/src/refund.ts:169-177 (routeFor) sends a terminal tender back through the terminal only as a void of a whole, never-refunded, non-QR tender. Everything else becomes a cash slice. refunds.ts:334-339 also falls back to cash when a void cannot be queued. SaleDetail.tsx:929-940 drops the approved design's 'auto' hint for every non-cash sale. Gateway (2C2P) QR does refund through the gateway, matching the approved design. Digio has a terminal Refund command (A52/A53, vendor-protocols.md:433; PROJECT_CONTEXT.md:98 'Digio supports ... void, refund, settlement from POS'), but nothing on the platform implements it.
- Effect: A partial refund on a card sale, or any card refund after settlement, takes cash out of the drawer for money that was paid by card. That is a cash-control and reconciliation risk.
- Change: ask the owner (real trade-off): the question is already open and still . Where the hardware allows, the approved design rule should hold: a Digio A52 refund, and a gateway refund for QR. Cash should be the fallback only for the GHL and Thai-QR limits that are genuinely hardware.

### 51. Lines an earlier refund covered are hidden from 'By item', and the server refuses them

- Area: tenders-refunds · size S
- Approved design: TransactionDetail.tsx:150-166 builds lineOptions from every non-promo line at its full lineTotal on every open, and the amount is only clamped (RefundModal.tsx:95-96). mockApi.ts:2887-2891 ('Never re-restock a line an earlier refund already returned') shows the approved design expects a line to be covered twice.
- Platform today: refunds.ts:234-239 throws REFUND_LINE_ALREADY_REFUNDED. apps/pos/src/api/history.ts:641-643 and :671-673 (refundItemOptions) leave out sale lines an earlier refund covered.
- Effect: Low. After a partial refund the By-item list shrinks, and a line cannot be picked twice (for example, a second correction on the same line). Staff must switch to Amount.
- Change: ask the owner (real trade-off): the guard protects line-level ledger integrity, but it departs from the approved design's clamp-only rule.

### 52. A ฿0 ticket sale skips choosing a tender ('No payment needed' / 'Complete Sale')

- Area: tenders-refunds · size S
- Approved design: The ticket till always needs a method. StepPayment.tsx:105-112 keeps the button disabled with no method, and Till.tsx:1163 returns early without pendingPaymentMethod. Only the F&B station has a ฿0 path (FnbPayment.tsx:106 and :147, 'Complete Order').
- Platform today: apps/pos/src/components/till/StepPayment.tsx:100 and :109-122 show a 'No payment needed' card on the ticket till, with 'Complete Sale' at :182-184. paymentSubmitLabel also returns 'complete' when nothing is outstanding (PaymentTenderPanel.tsx:15).
- Effect: Low: a visible flow difference on the ticket till, and a ฿0 comp is no longer filed under a tender.
- Change: ask the owner (real trade-off), or limit the skip to booth-voucher sales and keep the approved design's tender pick for other ฿0 tickets.

### 53. /book no longer loads or saves a returning member's saved children or contact-channel preference (pending SCRUM-357)

- Area: arrival-gate, accounts-members-offline · size M
- Approved design: pages/Book.tsx:365-377 looks up the full member with getMemberByPhone and saves the channel to the member (`updateMember(found.id, { preferredChannel: channel })`, also :249). :481-486 opens the 'savedChildren' re-confirm stage when the member has saved children. :432 writes edits back with updateSavedChild. :540-550 saves supervised children booked online to the profile (updateSavedChild, or addSavedChild with 'Online booking'). The client brief says the same: POS_BACKEND_LOGIC.md:71 and :78 'Applies at reception AND booking site'; R-06.
- Platform today: apps/pos/src/pages/Book.tsx:560-578 (origin/main) uses publicApi.memberTier, which returns nickname and tier only, so `member.savedChildren` is always empty and the stage at :702-707 never opens. handleConfirmSlot and handleRemoveSaved write nothing (comment :656-660). The channel goes on the booking only (:381-388). The comment at :966-972 says the stage never opens.
- Effect: Returning families retype supervised children's details and allergies online, and nothing typed online, including the channel preference, reaches their profile. A rule set by the client brief and the approved design is replaced by a preference nobody has ruled on.
- Change: Ask the owner on SCRUM-357, but frame the default as porting the approved design flow behind a one-time SMS code (the B-compliant form), not leaving it out.

### 54. Redemption refuses a paid family if the tax set-up changed after they booked (BOOKING_TOTAL_DRIFT)

- Area: arrival-gate · size S
- Approved design: Confirm & Issue always builds and records the sale with buildSale and issues the bands for a paid, unredeemed booking. The only refusal is 'Already redeemed' (pages/Till.tsx:376-436). The approved design re-prices with buildSale at today's configuration rather than refusing.
- Platform today: apps/api/src/services/booking-redemption.ts:286-314 (origin/main) passes expectedTotalSatang. When commitSale reports SALE_TOTAL_MISMATCH it throws BOOKING_TOTAL_DRIFT: '... the park's tax set-up has changed since ... Nothing was issued - ask a manager.' The same refusal fires if the gross differs.
- Effect: A family that paid online can be refused entry after any VAT or service-charge change between booking and visit (up to 60 days), with no manager override available in the product.
- Change: Ask the owner. Propose filing the redemption sale at the paid total with the booking's frozen tax basis (no refusal), and flag the difference for review.

### 55. The /book visit-date window (today to 60 days ahead) is , enforced on the server

- Area: arrival-gate · size S
- Approved design: The approved design has no visit date: a booking is for the day it is made. /book has no date control, and createBooking scopes event passes to `today` (mockApi.ts:1093).
- Platform today: apps/pos/src/lib/visitDate.ts:14 sets VISIT_DATE_MAX_DAYS_AHEAD = 60. apps/api/src/services/booking-checkout.ts:530-542 refuses any visitDate outside today to today+60.
- Effect: A small new limit on how far ahead families can book.
- Change: Ask the owner to confirm the horizon, or make it a branch setting.

### 56. The gate now creates a member record for every walk-in parent with a phone; the approved design explicitly skipped walk-ins

- Area: checkin-supervision, accounts-members-offline · size S
- Approved design: pages/Till.tsx:1022-1027: 'Walk-ins without a member are skipped (nothing to key against)'. Saved children are written only `if (member)`. The approved design creates a member only on the tier-verification path in handleCustomerDone (Till.tsx:1143-1150), never at the supervision gate.
- Platform today: `if (!guardian && parentPhone && supervised.length > 0) guardian = await findOrCreateGateMember(parentPhone, superParentName.trim())`. Children are then written to that member and a visit is opened (apps/pos/src/pages/Till.tsx:2006-2047; helper at :2247).
- Effect: Medium. A default-tier member is created for every drop-off walk-in family, which changes member counts, CRM data and later lookup and tier behaviour . Real trade-off: it is what keeps the child's allergy record on file for the next visit.
- Change: Ask the owner (real trade-off). Until then, follow the approved design and skip walk-ins without a member.

### 57. A 'Take off the pickup list' (revoke) button was added to the authorised-pickup sheet; the approved design has no removal

- Area: checkin-supervision · size S
- Approved design: The pickup list can only be added to or edited (addGuardianToRegistration, editGuardian, addPickupFromChatPhoto; mockApi.ts:4588-4666). AuthorizedPickupSheet has no remove, revoke or delete control (grep finds none in components/shared/AuthorizedPickupSheet.tsx).
- Platform today: A new destructive button, 'Take off the pickup list' (apps/pos/src/components/shared/AuthorizedPickupSheet.tsx:199-201, 392-395), calls revokeGuardian (apps/api/src/services/release.ts:382-390). A revoked collector drops off the list (:147) and is refused at release (:324).
- Effect: Low to medium. A new visible control and a new refusal at pickup. It may well be wanted, but it is our addition.
- Change: Ask the owner (real trade-off). If he declines, hide the button and keep the column unused.

### 58. Board edits to a child's name, age, allergies or food notes now overwrite the member's saved child record

- Area: checkin-supervision · size S
- Approved design: updateCheckIn changes only the CheckIn record and its change log (mockApi.ts:5415-5450). The member's saved child is untouched. The approved design writes saved children only at the gate (Till.tsx:1022-1035).
- Platform today: The stay keeps its own copies of these fields (packages/db/src/schema/checkin.ts:371-375), so writing back is not a data-model necessity. Even so, editCheckin also patches crm.child (name, ageYears, allergies, foodRestrictions) whenever the stay is linked to a saved child, audited as child.update with source 'checkin_board' (apps/api/src/services/checkin.ts:1462-1500).
- Effect: Low to medium. A correction meant for today's stay changes the family's saved profile for later visits. The trade-off is that an allergy correction persists.
- Change: Ask the owner (real trade-off). Until then, follow the approved design and edit only the stay.

### 59. Reception can issue 'credit vouchers' that put spendable wallet value on a band with no payment (SCRUM-482 )

- Area: wallets · size S
- Approved design: No credit-loading voucher exists. Promo vouchers are percent, fixed or free_item discounts only (lib/promoVoucher.ts; BL §6.2 'PromoVoucher { type: percent|fixed|free_item }', and §6 'two DISTINCT concepts — do not conflate them'). Wallet credit comes only from ticket credit rules and paid prepaid food (lib/sale.ts grants; mockApi.ts:5044).
- Platform today: origin/main packages/db/src/schema/promo.ts:84-91 adds the voucher kind 'wallet_credit'. When the sale carrying it closes, consumeSaleVouchers calls loadWalletFromVoucher (services/vouchers.ts:2787-2789), which creates a wallet with a 'grant' entry, source 'promo_voucher' (services/wallet.ts:1088-1107). Issuing at the till needs only pos:print:voucher (routes/vouchers.ts:310, 336, 389), which is in the reception SELL bundle (packages/shared/src/permissions.ts:308).
- Effect: Any reception account can create spendable stored value with no money taken, bounded only by the definition's usage limit. It also mixes promo value into the wallet liability that BL and R-64 keep separate.
- Change: Ask the owner (SCRUM-482), and extend the question to whether a wallet_credit voucher kind should exist at all. Until there is a ruling, block issuing wallet_credit definitions at the till, or require a manager permission.

### 60. Staff role cannot count, move or receive stock, and reception cannot raise or place purchase orders or see costs

- Area: stock · size S
- Approved design: components/mobile/stock/MobileStock.tsx:32-44: 'All-staff stock operations module ... Does NOT include item/variant setup - that stays in the manager-only Admin Inventory section'. Its listed sub-surfaces include 'Purchase: supplier purchase orders (To order -> Ordered -> Received)'. No tab is gated. StockReports.tsx:301-602 shows cost figures to anyone. Rule R-76 (POS_RULES_RECONCILIATION.md:139) says 'Stock operations = all-staff mobile module; setup = manager-only in admin'.
- Platform today: packages/shared/src/permissions.ts (origin/main) ~401-427: reception has pos:stock:count, transfer and receive but no pos:stock:order. ~430: the staff role has only READ_COUNTER (pos:stock:read), so no count, transfer or receive. apps/api/src/routes/stock.ts:361-421 guards PO create, edit, remove and place with pos:stock:order. :110-116 seesCost hides unit cost from anyone without pos:stock:order, and apps/pos StockReports.tsx:390 and :590 show the Shrinkage loss and Value totals as '—'. Correction to the original finding: the main Reports route (:220) needs only pos:stock:read. Only the new cost-of-goods report (:245-248) needs analytics:read, and that report is not a approved design screen.
- Effect: Floor staff (role staff) cannot count or move stock in the all-staff module. Reception's one-tap Reorder from Alerts and the Purchase tab actions are refused. Reports show '—' instead of the loss and on-hand value.
- Change: Ask the owner (a real trade-off). Present R-76 and the approved design's all-staff Purchase tab against the manager-only recommendation, and add the cost visibility and staff-role questions to SCRUM-485 point 4.

### 61. Each place's first count is treated as its opening: nothing is flagged, it is left out of Discrepancies and Shrinkage, and the review has new wording

- Area: stock · size S
- Approved design: components/mobile/stock/StockTakeFlow.tsx:87-91 flags every row with |counted - expected| > 3. :125-145 writes a record for every counted row so 'the Discrepancies report has a full count history'. There is no opening concept.
- Platform today: apps/pos StockTakeFlow.tsx:57-61 reviewRows: `flagged: placeOpening !== true && ...`. New review text at :102 'Opening count for {locName}', :111 'Starting figures', :139 'Checking whether this is {locName}'s first count...' and :183. apps/api/src/services/stock.ts commitStockTake 2171-2313 decides the opening per place (:2217, :2240) with audit action 'stock.opening_count'. stockDiscrepancies (:3395-3397) and stockShrinkage (:3494) exclude opening lines through placeOpeningSql (:2378).
- Effect: The count screen has new words and flow. The variances of each place's first count never reach the Discrepancies or Shrinkage reports, which hides any loss already present at go-live.
- Change: Ask the owner (a real trade-off), as an addition to SCRUM-485 point 5: one branch-wide opening count against per-place openings, and whether openings should be excluded from the reports.

### 62. F&B tile no longer greys out when one flavour or size is out; the badge reads 'Low' instead of 'Out'

- Area: stock, fnb-shop · size S
- Approved design: components/fnb/MenuGrid.tsx:29-42 menuItemStockStatus is commented "Worst stock status ... ('out' beats 'low')" and returns 'out' as soon as any variant is out. :51-89: the card is then aria-disabled, at opacity-50, unclickable, with an 'Out' badge.
- Platform today: apps/pos/src/components/fnb/MenuGrid.tsx:29-44: 'out' ONLY when every size is out, 'low' when any size is low or out. The comment calls the approved design rule a bug. Only the out size is blocked in the picker.
- Effect: Visible change on the F&B grid. A Slushie with one flavour out is sellable and shows 'Low'. Probably better for trade, but it is a rule choice.
- Change: Ask the owner (a real trade-off). Keep the approved design rule until they rule.

### 63. approved design cascade order (sell point, then store room, then BOH) replaced by sell point, then BOH, then store room

- Area: stock · size S
- Approved design: store/catalogStore.ts:1258-1264 cascades over Object.keys(variant.stockByLocation) after the target. The defVarLoc seed (:520-526) inserts BULK, BOH, ROT, so after the sell point a sale takes from the store room (bulk) before BOH.
- Platform today: packages/shared/src/stock.ts:18-26 STOCK_CASCADE_TYPE_ORDER = ['back_of_house','bulk','rotation']. apps/api/src/services/stock.ts:314-325 branchLocations sorts in that order, and takeStockForSale walks it.
- Effect: Low. It only changes which back place a cascaded sale draws down.
- Change: Ask the owner (a real trade-off). Low priority, and it can go in the SCRUM-485 batch.

### 64. Shrinkage is defined differently from the production formula in the approved design's banner

- Area: stock · size S
- Approved design: components/mobile/stock/StockReports.tsx:288-292 banner: 'In production, calculate shrinkage as (opening stock + received) - (sales + closing stock) per period'. That nets all corrections, up and down.
- Platform today: apps/api/src/services/stock.ts:3468-3517 stockShrinkage counts count variances (opening lines excluded) plus ONLY negative 'adjust' movements (:3494-3495). Upward corrections are ignored.
- Effect: Low. Shrinkage is overstated whenever a manager corrects stock upward. One nuance: the approved design tells managers to use Adjust for receipts (InventoryPanel.tsx:261-262), and the banner formula would count those as 'received'. So a straight revert must not count adjust-receipts as negative shrinkage.
- Change: Ask the owner (a real trade-off), or align with the banner by netting both signs of correction adjustments. Do not invent a split by reason.

### 65. Paired customer display's saved-children review blocks new and removed children, offers ages up to 17 and changes the wording

- Area: accounts-members-offline · size M
- Approved design: components/shared/SavedChildrenReview.tsx is the customer-display step 8 (Till.tsx:1637-1649). The parent types into a blank slot ('New — we'll save this', :122), picks '+ A new child' (:203) or 'Remove from saved' (:214). The heading reads 'We saved their details from last time — check each one and confirm.' (:82). Ages stop at MAX_CHILD_AGE 12 (lib/childDob.ts:11).
- Platform today: In publicMode, apps/pos/src/components/shared/SavedChildrenReview.tsx changes the heading (:116). New slots are disabled (:171, :181) and labelled 'Choose a saved child or ask the team' (:160). The new-child option reads '+ A new child — ask the team' (:252), and remove becomes 'Ask the team to remove a child', which only calls for staff (:262-264). Ages up to 17 are offered and accepted (:127, :183; packages/shared/src/display-child-review.ts:11). The till's own picker still stops at 12 (apps/pos/src/lib/childDob.ts:11).
- Effect: With a real display paired, the parent cannot add or remove a child, which the approved flow lets them do. Staff must step in each time. The display offers ages 13-17 that the till never offers.
- Change: Ask the owner. The default is the approved design: pass new and removed children to the till as typed actions, as corrections already are, keep the approved design wording and cap the age at MAX_CHILD_AGE. Keep the allergy hiding (R-58).
