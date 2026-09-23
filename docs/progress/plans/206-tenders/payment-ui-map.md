# SCRUM-206 / S2-10a — payment UI map: the prototype and the POS today

READ-ONLY survey. Nothing was edited, no git state changed, no server run.

**Which copy I read.** Every `apps/**` and `packages/**` citation is from
`git show HEAD:<path>` (HEAD = `adff73c`), because other agents are editing the
working tree. Where the working tree differs I say so explicitly and label it
"working tree". `imports/oto-pos/**` is read-only reference and is cited as the
file on disk.

---

## 0. POS files in flight (the plan must not land on these)

`git status --short apps/pos` moved between two reads minutes apart, so treat
this as a moving target and re-check before writing.

Second read (the later one):

```
 M apps/pos/src/api/menu.ts
 M apps/pos/src/components/admin/adminSections.tsx
 M apps/pos/src/components/mobile/MobileCartSheet.tsx
 M apps/pos/src/components/mobile/MobileTill.tsx
 M apps/pos/src/components/shared/SavedChildrenReview.tsx
 M apps/pos/src/pages/Book.tsx
 M apps/pos/src/pages/Till.tsx
?? apps/pos/src/api/members.ts
```

(The first read also listed these but not `MobileTill.tsx`; it did list
`apps/pos/src/components/admin/adminSections.tsx` and `apps/pos/src/pages/Book.tsx`.)

Where those edits actually sit, by hunk header — this is the part that matters,
because most of the apparent collisions are not collisions at all:

| File | In-flight hunks | Overlaps the S2-10a payment stage? |
|---|---|---|
| `apps/pos/src/pages/Till.tsx` | `@@ -21 +21`, `@@ -37,0 +38`, `@@ -1427 +1428,17`, `@@ -1429,5 +1446,17` | **No.** The payment machinery is lines 1889–2060 and 2336–2390 at HEAD. The in-flight hunks are the imports and the member/children area around 1427. Concurrent edits are mergeable but the file is hot — expect to rebase. |
| `apps/pos/src/components/mobile/MobileTill.tsx` | `@@ -711,2 +711,2`, `@@ -1849,0 +1850` | **Adjacent.** MobileTill's own tender path is 1245, 1336–1390, 1689–1705 at HEAD (see §2.6). Line 1850 is close to, but not inside, it. |
| `apps/pos/src/components/mobile/MobileCartSheet.tsx` | 6 hunks, lines 5–130 | Not payment; cart totals/props. |
| `apps/pos/src/components/admin/adminSections.tsx` | `localOnly` → `permission` for Add-ons / Modifiers / Merch / Discounts | **Yes, indirectly.** The "Discounts & Payments" nav entry is being re-commented right now and the new comment says *"the reasons and the payment methods beside them still reach no route, and the panel says so"*. S2-10a wiring payment methods will have to change that same entry again. Coordinate rather than race. |
| `apps/pos/src/api/menu.ts` | whole-file reflow (1725 lines changed) | No, but it is the file the catalogue write-through lives in — if payment methods end up on a catalogue route, this is where the client slice would go. |

Also in flight on the API side, in the exact file S2-10a edits:

- `apps/api/src/services/sale.ts` — SCRUM-333 is adding ~88 lines after HEAD:1496
  (`SaleTierClaimView`, `SaleReadView`) and touching `listSales` and
  `getSaleDetail`. `finaliseSale` (HEAD:2137) is untouched by it but shifts by
  ~89 lines in the tree. The Attempts-list read S2-10a needs is `getSaleDetail`,
  which *is* being edited. **Highest collision risk in the ticket.**
- `apps/api/src/routes/members.ts`, `apps/api/src/services/members.ts`,
  `apps/api/src/plugins/rate-limit.ts`, `packages/db/src/seed/menu.ts`,
  several api tests — unrelated to payments.

---

## 1. The prototype (`imports/oto-pos/artifacts/oto-till/src`)

### 1.1 The till's payment step

`components/till/StepPayment.tsx` — 116 lines, the whole thing.

- `StepPaymentProps` (`:8-14`): `total: number`, `selectedMethod: string | null`,
  `onSelectMethod(method: string)`, `onComplete()`, `onBack()`. **That is the
  entire payment contract in the prototype.** No amount entry, no tendered, no
  change, no terminal, no attempt.
- `KIND_STYLE` (`:17-49`): the accent/ring/hover/iconBg/iconColor per
  `PaymentMethodKind` — emerald cash, blue card, violet qr, slate other. Any new
  tender surface must reuse these four so the step stays one design.
- `getEnabledPaymentMethods()` drives the grid (`:52`); the grid is
  `repeat(clamp(methods.length,1,4), 1fr)` (`:65`).
- `isQrPending` (`:53`): `paymentMethodKind(selectedMethod) === 'qr'`, and it
  renders the violet note at `:94-99` — *"QR shown to customer. Confirm once the
  gateway reports the payment as received."* This is the prototype's entire QR
  story on the staff side: a sentence, and a human pressing the button.
- Footer (`:101-113`): Back (`w-32 h-16`) + "Confirm Payment Received"
  (`flex-1 h-16 text-xl`), disabled until a method is picked.

### 1.2 Where the till calls it

`pages/Till.tsx`:

- `:1515-1521` renders `<StepPayment>` at `step === 5`, wiring
  `pendingPaymentMethod` / `setPendingPaymentMethod` / `handleCompletePayment` /
  `handlePaymentBack`.
- `:1443` `else if (step === 5) customerStage = 'payment';` — the step number
  *is* the customer display's stage.
- `:1243-1254` `buildSale({... paymentMethod: pendingPaymentMethod })` then
  `recordSale(newSale)` at `:1255` — the prototype records the method token on
  the sale and nothing else about the money.
- `:1286-1291` `dispatchPrintJobs(ticketPrintJobs(station, {...}))` — receipt and
  bands fire immediately after the method is confirmed. **No drawer kick
  anywhere** (see §4.4).
- `:1304-1316` `CheckInPaymentInput` carries `paymentMethod: pendingPaymentMethod`
  into the drop-off check-in.
- `:1434` the live preview sale also carries `paymentMethod`.

### 1.3 The customer display

`components/till/CustomerDisplay.tsx`:

- `:70` `export type CustomerStage = 'identify' | 'welcome' | 'order' | 'input' | 'payment' | 'thankyou';`
- `:455-474` the `payment` stage. It branches on
  `sale.paymentMethod && paymentMethodKind(sale.paymentMethod) === 'qr'` (`:456`)
  and renders the violet "Scan to Pay" panel: `QrCodeIcon`, `t('till.payment.scanToPay')`,
  a white `rounded-3xl p-6` card holding `<QrCode seed={`promptpay-${sale.id}-${sale.total}`} className="w-64 h-64" />`
  (`:466`), the amount in `text-6xl font-black text-(--cd-violet)`,
  `t('till.payment.openBankingApp')`, and a spinner with
  `t('till.payment.waitingConfirmation')` (`:470-472`).
  **The seed is a placeholder matrix, not an EMVCo payload** — see §4 rule 11.
- `:488-491` the non-QR payment stage shows a "paying by {method}" pill via
  `t('common.payingBy', { method: paymentMethodLabel(sale.paymentMethod) })`.

`components/till/QrCode.tsx` is the seeded placeholder matrix renderer;
`components/shared/PromptPayCustomerScreen.tsx` is the same panel extracted for
the F&B / merch / party displays, and its own comment says so (`:9-13`): *"the
in-venue displays use a seeded placeholder, not a live EMVCo payload — the
public /book flow is the one that issues a genuinely scannable code."*

### 1.4 The payment-methods admin

`components/admin/payments/PaymentMethodsSection.tsx` — 200 lines.

- `KIND_OPTIONS` (`:10-15`): Cash / Card / EDC / QR / PromptPay / Other.
- `makeId(label, taken)` (`:20-33`): slug the label, run through
  `normalizePaymentMethod` so "Credit Card" can never mint the legacy
  `credit_card` token, then de-duplicate with `_2`, `_3`…
- `add()` (`:42-51`): new method gets `sortOrder = last.sortOrder + 1`, `enabled: true`.
- `remove()` (`:56-67`): `countTransactionsUsingPaymentMethod(m.id)` from
  `mockApi`, and if > 0 a `window.confirm` warning that reports will fall back to
  the raw token; the copy recommends disabling instead.
- `move(index, dir)` (`:69-77`): swaps the two `sortOrder` values.
- It is mounted from `components/admin/discounts/DiscountsScreen.tsx` — the
  "Discounts & Payments" admin screen, not a screen of its own.

`components/admin/devices/EdcTerminalFormDialog.tsx` is the only other terminal
UI in the prototype: a dialog with exactly two fields, `tid` and `label`, both
required (`:57-58`), id minted with `crypto.randomUUID()` (`:66`). Its purpose is
End-of-Day reconciliation, not routing a sale to a terminal.

### 1.5 Split tender — the only one that exists

`components/fnb/FnbPayment.tsx`. This is the prototype's *only* split-tender
screen and S2-10a's "split tenders" should port its shape.

- `:17-25` `FnbMethod = 'credit' | 'cash' | 'card' | 'promptpay'`,
  `FnbRemainder = 'cash' | 'card' | 'promptpay'`,
  `FnbPaymentResult { creditUsed, cash, card, promptpay }` — four buckets of THB.
- `:62-70` the buckets are filled by *kind* from the configured list:
  `methods.find(m => m.kind === 'cash' | 'card' | 'qr')`. `other`-kind methods are
  deliberately not offered (`:59-61`).
- `:72-76` `balance`, `creditUsed = Math.min(balance, total)`,
  `remainderDue = total - creditUsed`, `creditCoversAll`.
- `:78-84` `needsSplit = method === 'credit' && remainderDue > 0`;
  `remainderValid` guards against a remainder tender an admin has since disabled
  — *"so we never record an order against a hidden tender"*;
  `canConfirm = method !== null && (!needsSplit || remainderValid)`.
- `:86-102` `handleConfirm()` — the bucket arithmetic.
- `:107` `total === 0` skips tender selection entirely and records an all-zero
  payment ("Complete Order").

### 1.6 Every other payment surface in the prototype

| Surface | File | What it does with a tender |
|---|---|---|
| Booking site | `components/book/BookPayment.tsx:9,20,31` | `Method = 'card' \| 'promptpay'`; **the only real EMVCo payload** — `buildPromptPayPayload(getVenuePromptPayId(), total)` and a PNG download (`:54`). |
| Merch lane | `pages/MerchStation.tsx:12,185,269` | Imports and reuses `FnbPayment` wholesale with `creditLabel` overridden (`FnbPayment.tsx:37-43`); `MerchCustomerDisplay.tsx` is its display. |
| Parties | `components/mobile/parties/MobilePartyPayment.tsx:26-34,57,141,309` | Method grid from `getEnabledPaymentMethods()`, per-kind instruction copy, part payments against a balance. `PartySettlementCustomerScreen.tsx` is its display. |
| Add time | `components/history/AddTimeModal.tsx:13,20,41,66,152` | Its own method grid from `getEnabledPaymentMethods()` + `paymentMethodIcon`; records `AddTimeRecord.paymentMethod` (`types.ts:1281`). |
| Refunds | `components/history/RefundModal.tsx`, `mobile/history/MobileRefundFlow.tsx` | `refundModeForMethod` → auto for card/qr, manual otherwise. **Out of scope (S2-11).** |
| EOD | `components/eod/ReconTable.tsx:39`, `CashCountCard.tsx` | `EdcTerminal[]` per channel; cash by physical drawer count. **Out of scope (S2-15a).** |

---

## 2. The POS today (`apps/pos/src`, at HEAD)

### 2.1 `components/till/StepPayment.tsx` — the prototype plus four props

Same component, same `KIND_STYLE`, same copy. What S2-09a added:

- `:21` `notice?: ReactNode` — rendered at `:128`, between the QR note and the
  footer, so the sale-write failure panel keeps the approved layout's scroll and
  footer.
- `:23` `busy?: boolean` and `:25` `busyLabel?: string` — `:140`
  `{busy ? (busyLabel ?? 'Saving the sale…') : 'Confirm Payment Received'}`.
- `:40` `unpriced?: boolean` — `:86` prints `—` instead of `฿{total}`, and `:138`
  shuts Confirm with it (SCRUM-316).
- `:82` the root div gained `overflow-y-auto`.

**This is the component S2-10a extends.** The cash keypad, the terminal state and
the QR result all belong either inside it or behind the same `notice` slot.

### 2.2 `pages/Till.tsx` — the payment stage, at HEAD

The architecture S2-09a left behind, which S2-10a has to fill in:

- `:267` `const [pendingPaymentMethod, setPendingPaymentMethod] = useState<string | null>(null);`
- `:1957-1961` **entering step 5 writes the sale.** A `useEffect` on `step === 5`
  calls `recordSaleOnPlatform`, which commits the cart in `tendering` with no
  receipt number (`:1942-1953`). The comment at `:1928-1941` is the contract:
  *"PAY RECORDS THE SALE … the tender that completes allocates the number."*
- `:1889-1898` `handleCompletePayment()` — preflight, then `void completeSale(saleEpochRef.current)`.
- `:1971-2021` `completeSale(epoch)` — re-asserts the commit, then at `:2006-2012`:

  ```ts
  const closed = await saleWriter.finalise({
    method: pendingPaymentMethod,
    kind: paymentMethodKind(pendingPaymentMethod),
    amountSatang: recorded.totals.grossSatang,
    tenderedSatang: recorded.totals.grossSatang,   // ← S2-10a fills this in
    changeSatang: 0,                               // ← and this
  });
  ```
  with the comment at `:2003-2005`: *"One press, one method, and the amount due
  taken in full — all this screen knows. **S2-10a adds the cash keypad, the card
  terminal and the QR result onto this same call.**"*
- `:1919-1926` `noteSaleLeftBehind` — the epoch guard. Any async tender S2-10a
  adds (a terminal round trip, a QR wait) must keep honouring `saleEpochRef`, or
  an approval will print a band for the next family.
- `:2028-2037` `handleRetrySaleWrite` — retry is `recordSaleOnPlatform` before a
  method is chosen, `completeSale` after.
- `:2051-…` `finalizeSale(saleId, quoted)` — the local record, promo counters,
  wallets, bands, paper. Unchanged by the tender.
- `:2262-2268` `customerStage` derivation (`step === 5 → 'payment'`).
- `:2336-2390` the `<StepPayment>` render: `busy` from
  `saleWriter.state.kind === 'writing' | 'finalising'`, `busyLabel`
  `'Recording the payment…'` while finalising, `notice` = `<SaleWriteFailure>`,
  and `<SaleNotSavedNotice state={saleWriter.state} />` below.

### 2.3 `lib/saleWriter.ts` — the state machine the tender runs through

- `:55` `SaleFailureCause`; `:65-88` `SaleWriteState` (includes
  `stage: 'commit' | 'finalise'` on the failure arm).
- `:164-182` the `SaleWriter` interface: `commit`, `finalise(tender: SaleTenderPayload)`,
  `declareUnwritten(reason)`, `reset()`.
- `:334-390` `finalise` — refuses a second number when `held.status === 'finalised'`
  (`:347`), calls `finaliseSale(held.id, ids.actionId, tender)` (`:355`).
- `:48` the epoch note: `reset()` bumps it, an answer from a previous sale is dropped.

### 2.4 `api/sales.ts` — the wire shape, already named for this ticket

- `:260-282` `SaleTenderPayload`:
  ```ts
  { method: string;
    kind: 'cash' | 'card' | 'qr' | 'other';
    amountSatang: number;
    tenderedSatang: number;   // "Equal to the amount due until S2-10a asks."
    changeSatang: number; }   // "Zero until there is an entry for what came in."
  ```
  The doc comment at `:260-270` names S2-10a explicitly.
- `:293-296` `SaleFinaliseBody extends SaleTenderPayload { actionId: string; tender: SaleTenderPayload }`
  — the tender rides both flat and nested.
- `:380-394` `ApiSale` — `status: 'tendering' | 'paid' | 'finalised' | 'voided' | 'refunded'`,
  `receiptNumber`, `receiptSeries`, `receiptSeq`, `boxId`, `totals`.
  **No attempts field**: the Attempts list is a new shape.
- `:402-406` `SaleFinaliseResult { sale, replay }`.
- `:415` `saleIdempotencyKey(saleId) = 'sale:' + saleId`.
- `:424-425` `saleFinaliseIdempotencyKey(saleId, tender) = 'sale:{id}:finalise:{tenderSignature}'`
  and `:444-450` `tenderSignature` hashes `[method, kind, amountSatang, tenderedSatang, changeSatang]`.
  **Read `:428-443` before touching this.** The tender is in the key on purpose:
  a *different* tender is a new key and a new attempt, and the same tender
  retried through a dropped connection replays. Adding a terminal reference or a
  QR `invoiceNo` to the tender therefore changes the key — which is correct for a
  second attempt, and wrong if it makes an honest retry mint a new key.
- `:507-510` `salesApi.finalise(saleId, body)` → `POST /sales/:id/finalise`.

### 2.5 `components/till/CustomerDisplay.tsx` — the display S2-10a drives

- `:83` `CustomerStage` — unchanged from the prototype.
- `:534-602` the `payment` stage. `:557` `const unpriced = unpricedCartLines(sale.lines);`
  (SCRUM-316; the long comment at `:535-556` explains why it is a second lock).
- `:558-581` the QR branch — still
  `<QrCode seed={`promptpay-${sale.id}-${sale.total}`} … />` at `:568`.
  **This is the literal line S2-10a replaces** with the 2C2P `qrType RAW` EMVCo
  payload, keeping the surrounding panel untouched.
- `:570-572` the amount, `:583-601` the non-QR "please pay / paying by" panel.
- `:604+` `thankyou` — what "customer paid" has to flip the display to within 5 s.

### 2.6 The other POS tills that finalise

All four call the same writer, so all four inherit whatever S2-10a does:

- `components/mobile/MobileTill.tsx` — `:1245` `paymentMethodKind(method) === 'qr'`,
  `:1336-1390` commit + finalise, `:1689-1705` the StepPayment props.
  **In flight.**
- `pages/OrderStation.tsx` (F&B) — `:65-86` `tenderMethodOf` / `tenderKindOf`
  collapse the prototype's four buckets to one token, cash → card → promptpay →
  `wallet_credit`. `:707-714` the finalise call. The comment at `:66-75` is the
  honest statement of what split tenders cost today: *"the platform's finalise
  records ONE tender token, so the bucket that settled the balance is the one
  named."* **S2-10a's "split tenders" is exactly this debt.**
- `pages/MerchStation.tsx:322,354,360` — same pattern.
- `components/book/BookPayment.tsx` — the booking site, unchanged from the
  prototype, and the only place a real PromptPay payload is built today.

### 2.7 `components/admin/payments/PaymentMethodsSection.tsx` at HEAD

Identical to the prototype except:

- `:8` imports `NotSavedNotice`, `:82-87` renders it with
  `mutators={['upsertPaymentMethod', 'deletePaymentMethod']}` and
  `what="the tender list, its order and which methods are enabled"`.
- `store/CatalogStoreContext.tsx:270-272`:
  ```ts
  // No tender of any kind is recorded yet, so a method list has nowhere to go.
  upsertPaymentMethod: 'SCRUM-206',
  deletePaymentMethod: 'SCRUM-206',
  ```
  **This is the MOCK_MUTATOR_TICKETS entry the ticket asks about.** The map is at
  `:245-292`; `MockMutatorName` is `keyof typeof` it (`:293`) and `mockMutators`
  at `:296-321` `satisfies Record<MockMutatorName, unknown>`. Deleting the two
  `SCRUM-206` lines is a compile-enforced change: the mutators must move out of
  `mockMutators` into `wiredMutators` in the same edit, and every
  `NotSavedNotice` naming them stops compiling (`NotSavedNotice.tsx:40`).
- The tender list itself is seeded in `store/catalogStore.ts:786-790`
  (identical in prototype and POS):
  ```ts
  { id: 'cash',      label: 'Cash',      kind: 'cash', enabled: true, sortOrder: 0 },
  { id: 'card',      label: 'Card',      kind: 'card', enabled: true, sortOrder: 1 },
  { id: 'promptpay', label: 'PromptPay', kind: 'qr',   enabled: true, sortOrder: 2 },
  ```
  Read at `:1144-1145` (`getPaymentMethods`, global, sorted), written at
  `:1518-1521` through `commitGlobal` — payment methods are **operator-wide, not
  per branch** (`:71`: *"paymentMethods (same physical tenders everywhere)"*).
  A route for them has to match that scope.

### 2.8 `components/history/SaleDetail.tsx` — where the Attempts list goes

`:27-42`, verbatim:

> *"WHAT IT CANNOT SHOW, and does not pretend to: `GET /sales/:id` answers with
> the sale, its lines and its discounts, and no tender — how the money was taken
> lives on `pos.payment_attempt`, which that read does not join (S2-10a owns its
> shape). So there is no payment row here rather than a made-up one, and the
> actions that would change a real sale are disabled with the ticket that brings
> them."*

Layout note for the new card: `:43-56` — `layout='columns'` is the counter
(contents left, money right, each its own scroller) and `layout='stacked'` is the
handheld (SCRUM-320, one scroller for the page). The Attempts list has to work in
both.

---

## 3. Data shapes

### 3.1 The configured tender (prototype `types.ts:1854-1867`, POS identical)

```ts
type PaymentMethodKind = 'cash' | 'card' | 'qr' | 'other';
interface PaymentMethod { id: string; label: string; kind: PaymentMethodKind;
                          enabled: boolean; sortOrder: number; }
```
`id` is the token stored on transactions; `kind` drives icon, refund routing and
EOD channel mapping (`types.ts:1856-1858`).

### 3.2 `lib/payments.ts` (prototype and POS identical, 71 lines)

`normalizePaymentMethod` (`:12`, `credit_card` → `card`),
`getEnabledPaymentMethods` (`:17`), `findPaymentMethod` (`:24`),
`paymentMethodLabel` (`:33`), `paymentMethodKind` (`:41`, unknown → `other`),
`ICON_BY_KIND` (`:48-53`, Banknote/CreditCard/QrCode/Wallet),
`paymentMethodIcon` (`:56`), `refundModeForMethod` (`:65-71`, card|qr → `auto`).

### 3.3 EDC terminal (prototype `types.ts:1846-1852`)

`interface EdcTerminal { id: string; tid: string; label: string }` — that is all
the prototype knows about a terminal. No MID, no dialect, no serial port, no
station binding. Everything S2-10a needs beyond TID+label is new.

### 3.4 The sale's tender, on the wire

See §2.4. The one number the prototype never asked for — what the guest handed
over — is already a field (`tenderedSatang`) hard-coded equal to the amount due.

### 3.5 What the database already holds

`packages/db/src/schema/sales.ts:868-889` — `pos.payment_attempt`, and its own
comment says it is *"Still the Sprint 1 placeholder shape. **S2-10a owns its
columns**"*:

```ts
{ id, saleId → sale.id, method: text notNull,
  amountSatang: bigint default 0, status: text default 'recorded',
  payload: jsonb, ...timestamps }
index('payment_attempt_sale_idx').on(t.saleId)
```

So of the ticket's field list — provider, device, terminal_ref, TID, MID,
approval code, last4, invoice_no, tran_ref, payment_id, raw QR payload,
expires_at, staff_confirmed_by, offline flag, paid_at, box_seq — **none exist as
columns.** Today they would all land in `payload`. The `terminal_counter` table
does not exist, and `packages/payments-2c2p` does not exist (`packages/` holds
`box-agent`, `config`, `db`, `print`, `shared`, `telemetry`).

### 3.6 The finalise the platform already does

`apps/api/src/services/sale.ts` (HEAD; shifted ~+89 lines in the working tree):

- `:2068-2086` `TenderInput { method?, kind?, amountSatang?, tenderedSatang?,
  changeSatang?, reference? }` — `:2070-2072` *"Cash today … S2-10a brings the
  EDC and the QR onto this same call."* `reference` is *"a slip number, a QR
  reference"* — the seam for `terminal_ref` / `tranRef` without a migration.
- `:2104-2113` `changeFor(amount, tendered)` — **the change rule already exists**:
  an under-tender throws `badRequest` *"The cash taken is less than the amount
  being settled, so this would leave negative change"*.
- `:2137` `finaliseSale(tx, actor, saleId, input, now)` — one transaction:
  record the attempt, allocate the receipt, finalise. Its comment at `:2117-2136`
  is the constraint S2-10a inherits: *"a tender reaching `approved` and the sale
  reaching `finalised` are one atomic act"*, and a re-finalise replays rather
  than taking a second number.
- `:2195-2231` the attempt: `const tender = input.tender ?? {}` (`:2195`),
  `const method = tender.method ?? 'cash'` (`:2204`),
  `tx.insert(paymentAttempt)` (`:2206`) with `status: TENDER_APPROVED` (`:2211`).
  The `payload` jsonb already carries `kind`, `tenderedSatang`/`changeSatang`,
  `tillChangeSatang` when the till's arithmetic disagreed, `reference`,
  `takenByAccountId`, `actionId`.
- **Status vocabulary is already inconsistent and S2-10a has to settle it:**
  the column defaults to `'recorded'` (`schema/sales.ts:885`) while the only
  writer inserts `'approved'` (`sale.ts:1507 const TENDER_APPROVED = 'approved'`).
  The ticket's eleven-value status list replaces both.
- `:2236-2240` a sale still owing throws `SALE_NOT_PAID` — **this is what refuses
  a partial approval today**, and what split tenders have to work with: `owed` is
  recomputed from every *approved* attempt (`outstandingOf` `:1510-1523`, filter
  at `:1524`), so **the ledger already supports several attempts settling one
  sale**. Only the client sends one.
- `:2245-2250` no `station.codePrefix` → no receipt number. A terminal-approved
  sale on a station without a prefix would take money and fail to close.

### 3.7 Device / station routing that already exists

`packages/db/src/schema/fleet.ts`:
- `:474-484` `DEVICE_KINDS` includes `'terminal'` (`:480`) and `'cash_drawer'` (`:483`).
- `:610-621` `STATION_DEVICE_ROLES` includes `'card_terminal'` (`:617`),
  `'qr_terminal'` (`:618`) and `'cash_drawer'` (`:620`) — the comment at `:605-609`
  says these are *"the tender routing targets and the drawer"*.
- `:624-651` `station_device`, unique on `(stationId, role)` — one terminal per
  role per station. That is the station routing the ticket asks for; it exists.

`packages/shared/src/device-settings.ts`:
- `:49-53` `drawerKick?: boolean` on the ESC/POS section — *"the drawer is fired
  by the printer, not by the box (§7.3). A station with a `cash_drawer` device
  assigned and this left off is a drawer nothing will open."* **That is how the
  cash drawer kick is done** — through the receipt printer, not a device call.
- `:138-149` `SETTINGS_SECTION_FOR_KIND` deliberately omits `terminal`:
  *"a terminal's parameters come from the acquirer … neither of which we set."*
  The NEXGO/PAX dialect the ticket wants is therefore **not** a device-settings
  field today; it needs a home.

`packages/box-agent/src/` has `printing/{adapter,channel,queue,simulator}.ts`,
`scan.ts`, `scan-input.ts`, `booth*.ts`, `protocol.ts`, `contract.ts` — **no
terminal or payment module.** The terminal adapters and the simulator are new
files alongside `printing/`, and `printing/simulator.ts` is the pattern to copy.

Vendor fixtures for the adapters are present:
`imports/_vendor-docs/Digio-TLV-LinkPOS-Spec.html`,
`imports/_vendor-docs/GHL-API-Integration-POS-to-SmartEDC-V1.4-SCB-Jan2025.pdf`,
plus `docs/architecture/PAYMENT_GATEWAY.md`.

---

## 4. The prototype rules to port (cite these in the plan)

1. **The tender list is data, never hardcoded.** `lib/payments.ts:17`
   `getEnabledPaymentMethods` + `catalogStore.ts:1144` `getPaymentMethods`
   (global, sorted by `sortOrder`). Every new tender surface reads it; nothing
   may hardcode cash/card/QR. `StepPayment.tsx:65` even sizes its grid from it.
2. **Behaviour comes from `kind`, not from the token.**
   `lib/payments.ts:41 paymentMethodKind`, `:56 paymentMethodIcon`,
   `:65 refundModeForMethod`. `StepPayment.tsx:17-49 KIND_STYLE` and
   `CustomerDisplay.tsx:456` both branch on kind. S2-10a's cash keypad / terminal
   / QR panels must key off `kind` for the same reason.
3. **A legacy token still resolves.** `lib/payments.ts:12
   normalizePaymentMethod` (`credit_card` → `card`), and
   `PaymentMethodsSection.tsx:20 makeId` runs new ids through it so the legacy
   token can never be re-minted.
4. **Never record against a hidden tender.** `FnbPayment.tsx:82 remainderValid` —
   a remainder tender an admin has since disabled blocks Confirm
   (`:84 canConfirm`).
5. **Split = credit first, remainder in one bucket.**
   `FnbPayment.tsx:72-102` (`creditUsed = Math.min(balance,total)`,
   `remainderDue`, `needsSplit`, `handleConfirm`). Collapsed to one token today by
   `OrderStation.tsx:65-86 tenderMethodOf` / `tenderKindOf`.
6. **A ฿0 sale has no tender step.** `FnbPayment.tsx:107` (single "Complete
   Order", all-zero payment) and the platform's own
   `Till.tsx:1948 finalise: cart.quote.satang?.total === 0`.
7. **Deleting a tender in use is a warning, not a refusal.**
   `PaymentMethodsSection.tsx:56-67` — `countTransactionsUsingPaymentMethod`,
   `window.confirm`, and the copy that recommends disabling. Wiring this to a
   route means the count has to come from the ledger, and the refusal has to be
   the server's.
8. **Reorder is a swap of two `sortOrder`s.** `PaymentMethodsSection.tsx:69-77`.
9. **The display's QR panel is fixed furniture.** `CustomerDisplay.tsx:455-474` —
   icon, heading, white card, `w-64 h-64`, violet amount, spinner line. Swap the
   payload inside `<QrCode>`; change nothing around it.
10. **"Confirm once the gateway reports the payment as received"** —
    `StepPayment.tsx:94-99`. The prototype's QR confirmation is a human. Every
    automatic path S2-10a adds (webhook, inquiry) replaces this note, and the
    staff-confirmation dialog the ticket wants is this note grown a button.
11. **The EMVCo payload already exists and is correct.** `lib/promptpay.ts:39
    buildPromptPayPayload` — `field()` TLV helper (`:7`), `formatPhoneTarget`
    (`:15-24`, `+66…` and legacy `0…` both → `0066…`), `crc16` CCITT-FALSE
    (`:27-37`), AID `A000000677010111`, `01/12` dynamic, `53/764` THB,
    `54` amount to 2dp, `58/TH`, `6304`+CRC. 2C2P `qrType RAW` returns its own
    payload, so this becomes the PAX-offline / booking path rather than dead
    code — do not delete it.

### 4.4 Rules that do NOT exist in the prototype (new UI, per CLAUDE.md §7.2)

Searched and found nothing, so these are additions and belong in the progress
file's "UI additions":

- **Cash tendered / change entry.** `StepPaymentProps` has no such field
  (`StepPayment.tsx:8-14`). `components/till/NumberKeypad.tsx` and
  `components/shared/TouchKeypad.tsx` exist and are the design language to reuse.
- **Drawer kick.** No `drawer` reference in the prototype outside End-of-Day
  (`eod/CashCountCard.tsx:9`, `eod/EndOfDayTab.tsx:151-162`,
  `lib/endOfDay.ts:8`, `types.ts:2016-2021` — all cash-count, none a kick).
- **Terminal state on the till** — sent / approved / declined / inquiring /
  awaiting confirmation. Nothing. The prototype's card tender is one card in a
  grid.
- **Terminal / gateway simulator panels.** Nothing.
- **Attempts list on the sale detail.** Nothing
  (`SaleDetail.tsx:27-42` says so in as many words).
- **Manual card entry (approval code + TID).** Nothing.
- **Terminal dialect / TID / MID / serial config.** `EdcTerminalFormDialog.tsx`
  has TID and label only.

---

## 5. i18n

Keys that exist, with five locales each (`i18n/dictionary.ts`, prototype `:51-53`
and POS HEAD `:51-53`, identical):
`till.payment.scanToPay`, `till.payment.openBankingApp`,
`till.payment.waitingConfirmation`; `common.payingBy`, `common.pleasePay`,
`common.toStaff`. The F&B / merch / party mirrors are `:74-85`, `:103-112`,
`:132-136`.

Everything new on the **customer display** (an expiry countdown, "payment
received", a PAX-offline line) needs keys here in en/zh/th/ru/fr. Staff-side
strings in `StepPayment` are literals in the component and stay that way.

---

## 6. Shortest honest summary for the plan

- The **payment step is one component with five props and one button**
  (`StepPayment.tsx`), and S2-09a already threaded `notice` / `busy` / `unpriced`
  through it. Everything S2-10a adds hangs off that component and the
  `saleWriter.finalise` call at `Till.tsx:2006`.
- The **wire shape and the ledger transaction already exist and are already
  named for this ticket** (`api/sales.ts:260`, `services/sale.ts:2117`,
  `schema/sales.ts:868`). What is missing is columns, a counter table, adapters,
  a 2C2P package, and the UI in §4.4.
- **Station routing exists** (`fleet.ts:610-621` roles incl. `card_terminal`,
  `qr_terminal`, `cash_drawer`) and the **drawer is fired by the receipt
  printer** (`device-settings.ts:49-53`), not by a device call.
- **Four tills share the writer** (Till, MobileTill, OrderStation,
  MerchStation) — a change to the tender payload is a change to all four.
- **Avoid, or coordinate on:** `apps/api/src/services/sale.ts` (SCRUM-333 is in
  it now, including `getSaleDetail` which the Attempts list needs),
  `apps/pos/src/components/admin/adminSections.tsx` (its payment-methods comment
  is being rewritten this minute), `apps/pos/src/pages/Till.tsx` and
  `apps/pos/src/components/mobile/MobileTill.tsx` (edited, though not in the
  payment region).
