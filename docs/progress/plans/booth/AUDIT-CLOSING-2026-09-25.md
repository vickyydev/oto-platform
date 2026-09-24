# The Lucky Wheel booth — closing audit (P6), 25 September 2026

For the owner and the engineers. A read-only audit of the booth path before the owner's bench test with a real Pi, printer and TV against staging.

- **Code audited.** `main` at `22862b4`. The booth work is four commits: `1de320c` (the Pi runtime and the booth page), `13a6e70` (the redemption api, migration 0021), `c4f8b4e` (the tills), `9673e39` (the Console, migration 0022). The three commits after `9673e39` change docs only, so the code is `9673e39`. The working tree's uncommitted files (`apps/pos/src/components/merch/MerchCustomerDisplay.tsx`, `render.yaml`, `services/`) are not booth code and were not audited.
- **How.** Five finders (security, money and one-time integrity, robustness, product truth, code quality) each wrote a file in this folder. Then an independent skeptic tried to refute every finding rated medium or worse. There are 33 skeptic verdicts in this folder, plus one empty stub (`p6/skeptic-till-moveTo-second-session.md`). Five defects that two lenses both reported (C1, C2, M2, M5, M6) were checked by two skeptics each. This file ranks what survived by the **skeptic's** severity, merges the findings two lenses both reported, and plans one fix round.
- **Markers.** **[V run]** proved by running something (a probe, a browser, a test). **[V read]** proved by reading the exact code path. **[I]** inferred.
- **Citations.** Code as `file:line` from the repository root. Evidence as `p6/<file>`, where `p6/` is `C:/Users/waqar/AppData/Local/Temp/claude/c--Users-waqar-OneDrive-Desktop-Projects-oto-pos/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/p6`. The finders' files are `p6/security.md`, `p6/integrity.md`, `p6/robustness.md`, `p6/product.md` and `p6/quality.md`; each skeptic's file is `p6/skeptic-*.md`.
- **Nothing was changed.** No repository file, no git write, nothing on staging, no Jira write. Every probe ran on a throwaway local database or on a private local stack. One of those stacks is still running as this is written: the product lens's, with database `p6_product`, the api on :27461, the Console on :27463, the POS on :27464 and the box's page on :27480. Stop it and drop the database once the fix round no longer needs it. No credential, PIN or secret is printed here.
- **Severity scale.** Critical: money lost, a voucher used twice or never, the booth or till dead, a credential exposed. High: a wrong outcome a person would meet in the bench test. Medium: a wrong outcome in an edge case, or a guide that misleads. Low: a comment, wording or cosmetic issue.

---

## 1. Verdict

1. **Not yet, but one fix round away.** The booth works end to end: set-up in the Console, the Pi claiming and running, sign-in by account or PIN, the draw, the slip, the offline queue, and the till's one-time redemption. That was seen with the box program on a bench machine and on staging; nothing has run on a real Pi yet (`docs/ops/PI_BOOTH.md:5`). But four defects would spoil the bench test or a live day, and a set of wrong screens and guide steps would mislead you on the way.
2. **Fix first (C1, critical).** A voucher can be lost for good. It happens when the voucher is on a sale that was rung up at Pay and then left: the till locks after two minutes, someone taps a header tab, or the page reloads. From then on that slip is refused everywhere with "pay or void that sale first", and no screen can pay or void the sale.
3. **Fix first (H2, high).** A booth saved with its "Code prefix" left empty, which is the form's default, is a dead booth. Every press says "Booth not ready — please call staff".
4. **Fix first if your printer is the silent kind (H1, high).** If the printer does not answer status queries over the network, every press shows "Booth not ready" and the wheel never turns, yet the slip still prints. Telling us the printer model settles whether this bites.
5. **Fix before any "Hand-over prize" goes on a wheel (C2, critical, latent).** A hand-over slip brought on its own can never be used up, so it can be shown again and again. None of the six launch prizes uses this type, so the bench test will not meet it.
6. **At the bench you would also meet wrong words, though no wrong outcomes (M1–M5):**
   - the Pi guide's first step needs a developer;
   - the Console says the Pi booth needs a paired screen, and that switched-off prizes are still drawn on the TV;
   - the TV says "connect to internet" until the booth's first publish;
   - the ticket till refuses the Kids Pizza voucher, and no guide says it is redeemed at the restaurant (F&B) till.
7. **Cheap to fix in the same round (M6, M9–M12, M14, M15):**
   - the slip's "Expires" date actually ends at the minute the prize was won;
   - a branch manager can set another park's staff PIN;
   - two people can share one PIN;
   - the booth's PIN lock can be raced;
   - a second screen at one till can void the first screen's sale while it is being paid;
   - the TV can stay white while Google Fonts does not answer;
   - a printer that stalls can hang the box.
8. **Tickets for after the bench:** the Pi measuring its own clock, the box's growing store, recovery from a damaged store, free products honoured at other parks, and promo codes priced by the platform (M7–M8 code, M13, M16–M18). The bench test will meet none of them.
9. **No finding shows a password or PIN in clear.** Three claims were refuted and are recorded in section 3 so nobody raises them again: the box forging vouchers, slow code guessing, and the shared password lock.
10. **After the round:** CI green; a staging proof of C1, C2, H1 and H2; the release file packed at that commit and sent to you; your answers to Q1–Q6 (section 6); then "ready" for the bench.

### Your bench steps, and what would go wrong today

Steps as written in `docs/progress/plans/booth/PLAN.md:56-69`.

| Step | What goes wrong today | Finding | After the fix round |
|---|---|---|---|
| Before step 1: get the release | `docs/ops/PI_BOOTH.md:27` says to build it with `pnpm` on a development machine. The only packed file on the build machine is from before the gates | M4 | We send you the file and its checksum |
| 1. Console → Booths, publish | The wheel preview draws switched-off prizes and says the TV does too | M2 | Fixed |
| 2. Add a box, claim | "Add the box" stays greyed out until a Slot is typed, and the guide does not mention the Slot | L46 | Guide corrected |
| 3. The printer | A 512-dot printer cuts the right 8 mm of the slip, and the Console cannot set the width | L30 | Guide workaround; ticket |
| 4. Create the booth on the Pi | An empty code prefix gives a dead booth. A new booth has no layout and no prizes, and the plan never publishes it. The Screens panel says the booth needs a paired screen | H2, M3, M1, L47 | Fixed; plan and guide corrected |
| 5. The TV: sign in, press | "Booth not set up, connect to internet" shows until the booth is published. With a silent printer, "Booth not ready" | M3, H1 | Fixed |
| 6. The till: type, pay, type again | If the payment screen is left for 2 minutes, or a tab is tapped, the voucher is lost. A ฿0 sale asks for a payment method. The pizza is refused at the ticket till | C1, L38, M5 | Fixed; guide |
| 7. Offline spin, plug back, redeem | Five retries before the sync lock that till for 10 minutes. Unplugging the Pi's own cable also cuts the printer | M8, L50 | Guide; ticket |

### What was checked and holds

These were attacked on purpose and held. They are not findings, and they need no re-audit unless the code changes.

**Money and one-time use** (`p6/integrity.md`, "What holds up")
- A voucher is used up by one guarded update, inside the transaction that closes the sale (`apps/api/src/services/vouchers.ts:1923-1946`). A second use loses, and its whole payment rolls back.
- A sale rung up with the voucher keeps it until it is paid or voided. Two tills racing, a lapsed hold against Pay, and a double Pay or double Confirm each end with exactly one winner.
- The value always comes from the voucher type on the platform. The till cannot describe its own voucher discount, and it cannot put two vouchers, or a voucher and a promo code, on one sale.

**Booth security** (`p6/security.md`, "Checked and found SOUND")
- The Pi's page server answers only its own machine, and refuses a foreign Host or a cross-origin write (`packages/box-agent/src/runner/kiosk-server.ts`).
- Box events are signed and checked. A code clash is quarantined, never reassigned.
- Pairing and claim codes are single-use, expire, are stored hashed and are throttled.
- No PIN or password reaches a log, an audit row or the replay store.
- The credential file is readable only by the box's own user, and the service is hardened.

**Robustness** (`p6/robustness.md`, "What was checked and held up")
- The page opens before any cloud call, and every cloud call gives up after 15 s.
- A press is recorded before the printer is touched. A slip is never printed twice by itself, not even after a restart.
- A moved, archived or revoked booth or box says so on the TV.
- `install.sh` runs cleanly twice, checks Node's checksum, and its units verify.

**What the owner was told works, seen working** (`p6/product.md`, "What works exactly as the owner was told")
- Claim, run, the picker, and sign-in by account or PIN, including offline.
- The session length, the slip's words, reprint, and offline spins that sync on return.
- Held, paid and "Already redeemed on … at … by …". "Invalid code" for a typo.

**Tests** (`p6/quality.md`, "What was run")
- The booth-touched suites pass: box-agent 312, booth page 12, shared 265, api 248.
- The migrations match the schema snapshot.
- The four commits add no `any`.

---

## 2. Confirmed findings, ranked by the skeptic's severity

**Ranking.** Findings are ordered by the skeptic's severity. Within a severity, the ones the bench test meets come first.

**Merges.** Where two lenses reported the same defect, it appears once, with both sources named:
- C1 is integrity F1 and product #1.
- C2 is integrity F2 and product #6.
- M2 is product #4 and quality F2.
- M5 is quality F1 and product #9.
- M6 is integrity F4 and product #7.

**Downgrades.** Four confirmed findings were downgraded to low by their skeptic. They are listed at the end of this section and filed with the lows in section 4.

### C1 — critical — A voucher on a sale rung up and then left can never be used; no screen can pay or void that sale

- **Sources:** `p6/integrity.md` F1 and `p6/product.md` #1.
- **Skeptics:** both upheld critical, in `p6/skeptic-till-rungup-pins-voucher.md` and `p6/skeptic-rungup-orphan-voucher.md`.
- **Where.**
  - `apps/pos/src/App.tsx:83` shows the lock screen *instead of* the router, so the till unmounts.
  - `apps/pos/src/auth/timings.ts:15` locks after 120 s. Nothing pauses that timer while a sale is open (`apps/pos/src/auth/OperatorContext.tsx:91, 348-362, 403-417`).
  - A 423 answer on any tab locks the session: `OperatorContext.tsx:436-443`.
  - The header tabs stay live links on the payment screen: `apps/pos/src/components/shared/StationHeader.tsx:171`.
  - The rung-up sale is kept only in memory: `apps/pos/src/lib/saleWriter.ts:232-293`.
  - Unmounting releases only a cart that was *not* rung up: `apps/pos/src/pages/Till.tsx:1175-1180`, and the same at `apps/pos/src/pages/OrderStation.tsx:799-805`.
  - `apps/pos/src/lib/tillVoucher.ts:297-338` shows the refusal and nothing else. The only automatic void is in `moveTo`, at `:364-389`.
  - The api keeps a sale rung up with the voucher at any age (`apps/api/src/services/vouchers.ts:845-893`). It names that sale to the till "so it can offer the void" (`:908-910`, `:929-940`), but no screen offers it.
  - In History every action is disabled: `apps/pos/src/components/history/SaleDetail.tsx:432-455` and `ledgerNotice.ts:12-14`. The Console has no sales page, and no job sweeps such sales.
- **Scenario.**
  1. Staff type the family's code, add a ticket and press Pay. The sale is now `tendering` and holds the voucher. No payment has been attempted.
  2. Then the till leaves the payment screen, by any of these:
     - two minutes pass untouched (the guest looks for cash, the owner goes to look at the TV);
     - staff press the padlock;
     - staff tap History, F&B or Today;
     - the page reloads or the tab closes.
  3. The till comes back empty. From then on, every till answers that slip with "This voucher is on a sale already rung up at Reception Till 1 — pay or void that sale first".
  4. No screen can do either. The restaurant till behaves the same way.
- **Proof.**
  - [V run] The product lens left 7 vouchers pinned on a local stack: by the idle lock, a reload, History→Tickets, and a closed tab (`p6/product.md` #1).
  - [V run] Both skeptics reproduced it independently, by padlock, 130–135 s idle, reload, and History→Tickets. Scripts are in `p6/skeptic-rungup/till.mjs` and `p6/skeptic-orphan/orphan.mjs`; screenshots are in the matching `shots/` folders. Each time, the refusal card offered only "Dismiss".
  - [V run] Through the api, the hold survives a sale backdated by one year (`p6/skeptic-rungup/rungup.probe.ts`). Only a hand-made `POST /sales/:id/void` frees it. After that the voucher can be held, paid and redeemed.
  - [V run] `GET /sales?status=tendering&stationId=…` lists the forgotten sale, so a fix can find it.
- **Fix (this round, lane A).**
  1. In `useTillVoucher.redeem`, handle a refusal of `HELD_ELSEWHERE` with `rungUp` and `details.saleId`, which the api sends only to the till that rang the sale up. Show that unpaid sale (time and amount) and offer **"Void that unpaid sale and use the voucher here"**, then `salesApi.voidSale(id, reason)` and hold the voucher again.
     - It must be a deliberate staff choice, never automatic. The api names the sale to any session at that station (`vouchers.ts:938`), and a cash sale has no payment attempt until Confirm. So `voidSale`'s guards (`apps/api/src/services/sale.ts:3133-3151`) would not stop the void of a sale another screen at the same till is taking cash for (see M12).
  2. In History, add a **Void** action for an unpaid sale that took no money, with a reason, under `pos:sale:void`. Seeded reception holds that permission (`p6/integrity.md`, "What holds up"); owner Q3 may restrict it to managers.
  - The api needs no change: the void route exists (`apps/api/src/routes/sales.ts:479-499`).
  - Left for a ticket (T7): keep the till mounted under the lock, warn before leaving the payment screen, and offer to resume after a reload.
- **What the owner would see:** at bench step 6, if the payment screen sits two minutes or he taps History before paying, that slip is refused for good with "pay or void that sale first", and nothing on screen can do either.

### C2 — critical (latent) — A "Hand-over prize" slip on its own can never be used up, so it can be shown again

- **Sources:** `p6/integrity.md` F2 and `p6/product.md` #6.
- **Skeptics:** they split. `p6/skeptic-handover.md` rated it critical. `p6/skeptic-handover-prize-till-2.md` rated it high, and said it becomes critical the day such a prize goes on a live wheel.
- **Why ranked critical here:**
  - the outcome is the rubric's "a voucher used twice or never";
  - the Console offers the type today with no warning.
- **Why latent:**
  - none of the six launch types is a hand-over prize (`docs/ops/BOOTH_SETUP.md:24-31`);
  - nothing seeded uses the kind;
  - so the bench test will not meet it unless the owner creates one.
- **Where.**
  - The Console offers the type as "A prize handed over as it is, with nothing to ring up; the sale records which voucher it carried" (`apps/console/src/components/booth/voucherTypes.ts:60-66`). `notSetUp()` gives it no warning (`:115-136`).
  - In the api, `manual` resolves to `hand_over` (`apps/api/src/services/vouchers.ts:575-576`). It prices as ฿0 with no line (`:1723-1728`).
  - Only a free item adds a voucher line (`apps/api/src/services/sale.ts:1308-1316`). An empty cart gets 400 "The cart is empty" (`sale.ts:1328`).
  - The ticket till's `canPay` needs a participant or a free item (`apps/pos/src/pages/Till.tsx:2544-2548`). The restaurant till's `isEmpty` does the same (`apps/pos/src/components/fnb/FnbCart.tsx:147, 465`).
  - The box mints a code for every prize (`packages/box-agent/src/booth.ts:1379`). An unworded slip sends the family to "OTO Reception" (`booth.ts:1751-1753`).
- **Scenario.**
  1. The owner creates "Mystery Gift" as a Hand-over prize and puts it on the wheel.
  2. A family brings only that slip. The card says "Hand over: Mystery Gift", Pay ฿0 stays disabled, and the api refuses the quote and the commit.
  3. Staff hand the gift over and press Cancel. The voucher stays `issued`.
  4. The same slip, or a photo of its QR, gets "Hand over: Mystery Gift" again at any till on any day. A hold left without Cancel lapses after 15 minutes (`vouchers.ts:103`).
- **Proof.**
  - [V run] `p6/probe/handover.probe.ts`, `p6/probe/handover-skeptic.probe.ts` and `p6/skeptic-handover2/handover2.probe.ts`, the slip on its own:
    - hold 200;
    - quote 400 and commit 400 "The cart is empty", with or without finalise;
    - release 200, status `issued`;
    - the next lookup 200 at the other till, and hold 200 again.
  - [V run] Controls:
    - beside one kid ticket, the same voucher is used up and the next lookup is 409 "Already redeemed";
    - a free-item voucher on its own closes at ฿0.
  - [V run] The api already closes a hand-over voucher at ฿0 beside an empty ticket line, so the api side of the fix is small.
  - [V read] The only test pairs it with a ticket: `apps/api/test/vouchers.test.ts:1210-1217`.
- **Fix (this round).**
  - **Lane B.** A cart whose only content is a held hand-over voucher prices, commits and closes at ฿0. Give it a ฿0 voucher line of its own, shaped like the free item's in `vouchers.ts:1670-1700` but with no product; or let it past the empty-cart check. Pick whichever the ledger accepts. The voucher is used up on Confirm.
  - **Lane A.** Let Pay (ticket till) and Charge (restaurant till) run for a held `hand_over` voucher on its own.
  - **Lane B wording.** The card says "Ring up to use it, then hand over" until the sale closes (`vouchers.ts:595-599`).
  - **Tests.** Add a slip-alone test in `vouchers.test.ts` and a twin of the free-item ฿0 close in `sales.test.ts`.
  - **Owner (Q2).** Settle whether the gift is handed over at the booth or the counter. `packages/db/src/schema/promo.ts:59-62` and `voucherTypes.ts:9, 102` say "at the booth", while the slip and the till say reception.
- **What the owner would see:** the day he creates a Hand-over prize, a family with only that slip either leaves with nothing, or leaves with the gift unrecorded and a slip that works again.

### H1 — high (depends on the printer) — A printer that does not answer status over the network turns every press into "Booth not ready", with no wheel, while the slip prints

- **Sources:** `p6/robustness.md` R1.
- **Skeptic:** high, conditional on the printer (`p6/skeptic-silent-printer-press.md`). One sub-claim was refuted (section 3).
- **Where.**
  - The press waits for the print before answering: `packages/box-agent/src/booth.ts:1572`.
  - The answer is remembered only after the print (`:1592`). The in-memory replay check comes first (`:1265`).
  - A second arrival of the same key is refused as `duplicate_press` (`:1485-1489`), which becomes a 409 (`packages/box-agent/src/booth-http.ts:94`).
  - `packages/box-agent/src/printing/adapter.ts:165-182` asks four status questions (`DLE EOT 1..4`) at 1 s each, before the job (`:272`) and again after it (`:308`). A silent printer therefore costs about 8 s.
  - The page aborts at 6 s (`apps/booth/src/booth/client.ts:116`) and retries once with the same key (`apps/booth/src/App.tsx:373-381`).
  - The page does not know `duplicate_press` (`apps/booth/src/booth/contract.ts:163-190`), so it shows `COPY.notReady` (`App.tsx:864-869`).
  - The code itself calls such printers an open question (`packages/box-agent/src/printing/queue.ts:16-22`; `adapter.ts:150-158`).
- **Scenario.**
  1. The owner's receipt printer has a network board that does not answer `DLE EOT`.
  2. A press records the spin and the voucher, then waits about 8 s on the printer.
  3. At 6 s the page gives up and retries. The retry is refused `duplicate_press`.
  4. The TV says "BOOTH NOT READY — PLEASE CALL STAFF" and the wheel never turns. The slip comes out anyway.
  - Every press repeats this.
  - A Reprint also takes more than 6 s, so the panel says "The reprint did not go through" while the slip prints.
  - Worse, such a printer that is out of paper is still reported "printed" after about 9 s with nothing taken [V run]. The TV then shows no code: "take your voucher", and no voucher comes out (`p6/skeptic-write-timeout.md`; `apps/booth/src/components/ResultModal.tsx:51-58`).
- **Proof.**
  - [V run] `p6/probes/spin-latency.ts`: a printer that answers takes 92–159 ms per press; a silent one takes 8162 ms. The page-shaped call aborted at 6013 ms, and the retry got 409 `duplicate_press` in 6 ms.
  - [V run] The skeptic drove the real built booth page in Chromium against a silent fake printer (`p6/probes/skeptic-silent-press-tv.ts`):
    - "STARTING…" was on screen at +1.5 s and +4.5 s;
    - the slip's bytes reached the printer at +4.2 s;
    - the call was aborted at 6.0 s and the retry got 409;
    - from 6.5 s the screen read "BOOTH NOT READY — PLEASE CALL STAFF" (`p6/shots/skeptic-silent-6500.png`);
    - the control run with an answering printer spun normally.
  - [V run] A printer that answers only queries 1–2 collides with the heartbeat's printer check once a minute.
  - [V read] Why no test caught it: the only silent-printer test uses a fake channel that answers at once (`apps/api/test/printing-box.test.ts:376-418`).
- **Fix (this round).**
  - **Lane E.** In `readEscposStatus` (`adapter.ts:165-182`), stop asking after the first unanswered query. A silent printer then costs about 1 s on each side instead of 4. Optionally, remember per device that it never answers.
  - **Lane D.**
    - Put the press's in-flight promise into the replay map *before* awaiting the print. A same-key retry then joins it instead of being refused.
    - Do the same for reprint.
    - Bound how long the press path waits for the print, so a press always answers well inside 6 s. When the bound is hit, the press answers `queued` and the TV shows the code and QR, as it already does when a printer fails; the slip still prints once the printer answers.
  - **Lane F.** Add `duplicate_press` to the codes the page knows, with its own line (for example "Your voucher is being printed — ask our staff if it does not come out"), never "Booth not ready".
  - **Considered and not chosen for this round:** answering before printing with a new `printing` state. It changes the frozen contract (`packages/shared/src/booth.ts:270-325`) and the TV's card.
  - **Owner (Q4).** Name the printer, and say whether it answers status over the network.
- **What the owner would see:** with a silent printer, every press shows "Booth not ready — please call staff" and no wheel, while a slip still comes out. With such a printer out of paper, the TV says to take a voucher that never printed.

### H2 — high — A booth station saved without a two-character code prefix is accepted, published and dead

- **Sources:** `p6/product.md` #2.
- **Skeptic:** high (`p6/skeptic-booth-code-prefix.md`).
- **Where.**
  - The Console field is optional, takes up to 6 characters, and its hint talks about band codes and receipt numbers (`apps/console/src/components/devices/StationDrawer.tsx:265-272`). An empty field is sent as null (`:117`).
  - The api takes 1–8 characters or null for any kind (`apps/api/src/routes/fleet.ts:171`) and stores it as sent (`apps/api/src/services/fleet.ts:1026, 1092`).
  - `publishBlockers` never looks at the prefix (`apps/api/src/services/booth-admin.ts:310-420`).
  - The box mints with `station.codePrefix ?? ''` (`packages/box-agent/src/booth.ts:1366, 1379`). `mintBoothCode` throws unless the prefix is exactly two of `[0-9A-Z]` (`packages/shared/src/booth-code.ts:273-279`).
  - The box answers that with a 500 (`booth-http.ts:268-277`), which the TV shows as "Booth not ready — please call staff" (`apps/booth/src/App.tsx:864-869`).
  - The TV's own hint for a new box does not mention the prefix (`apps/booth/src/copy.ts:236`).
- **Scenario.**
  1. The owner creates the Pi's booth in Devices → New station and leaves "Code prefix" empty, or types `PI1` or `BOOTH`.
  2. The booth publishes without complaint.
  3. Every press fails with "Booth not ready". Health stays green, and the `#debug` simulated press still answers 200.
- **Proof.**
  - [V run] `p6/skeptic-prefix/probe.mts`, with output in `p6/skeptic-prefix/probe-out.txt`:
    - with `B1`, the press answered 200;
    - after PATCHing the prefix to null, `PI1`, `BOOTH`, `b` or `B-1`, each PATCH answered 200 and every press answered 500;
    - with a null prefix, the draft had no blockers and the publish answered 200;
    - setting `B2` fixed it without a republish.
  - [V run] Product lens: the TV showed the notice, and the box logged "A booth code prefix is 2 letters or digits; got """.
  - [V read] `docs/ops/PI_BOOTH.md:52` does say "a two-character code prefix (e.g. `B2`)". That is the only safeguard.
- **Fix (this round).**
  - **Lane C.** For kind `booth`, require exactly two of `[0-9A-Z]` on create and on update. Validate the *resulting* kind and prefix together, so switching a till with prefix `T10` to kind booth is also refused. Add a publish blocker for a booth whose prefix is not valid.
  - **Lane G.** For a booth, make the field required and two characters long, with the hint "The first two characters of every voucher code".
  - **Lane D.** Refuse before the draw with `booth_not_ready` and a message that names the prefix, not a 500.
  - **Lane F.** Name the prefix in the TV's "No booth on this box yet" hint.
- **What the owner would see:** at bench step 4 or 5, if the prefix was left empty, every press shows "Booth not ready — please call staff", and nothing says why.

### M1 — medium — The Console tells the owner the Pi's booth refuses every press until a screen is paired

- **Sources:** `p6/product.md` #3.
- **Skeptic:** medium (`p6/skeptic-screens-panel-pi.md`).
- **Where.**
  - `apps/console/src/pages/Booths.tsx:574-596` shows the Screens panel for every booth.
  - `apps/console/src/components/booth/BoothScreensPanel.tsx:87-91` then says "Until one is, the television shows 'ask our staff' and the booth surface refuses every press — which is the point: an unpaired screen cannot mint a voucher".
  - A Pi needs no pairing (`packages/box-agent/src/runner/kiosk-server.ts:12-16`; `apps/booth/src/App.tsx:79, 105`).
  - The api already sends `box.inProcess` (`apps/api/src/services/booth.ts:361, 592`; `apps/console/src/components/booth/boothApi.ts:69`), but nothing in the Console reads it.
- **Scenario.**
  1. The owner opens the Pi's booth and reads that it cannot work.
  2. If he pairs a screen for it anyway, the paired staging page gets 401 `BOOTH_UNPAIRED` and loops back to "Pair this screen".
  3. The pairing also leaves a phantom "paired · last seen just now" row, because `last_seen_at` is written before the refusal (`apps/api/src/services/device-credential.ts:484-487`) [I].
- **Proof.**
  - [V run] The panel, rendered exactly as `Booths.tsx` passes it (`p6/skeptic-screens/render.mjs`), shows the sentence.
  - [V run] Two runner tests spin with no screen credential (`packages/box-agent/test/runner.test.ts:645, 672`).
  - [V run] The product lens pressed the Pi booth about 40 times with nothing paired.
  - Already listed among the twelve guide corrections (`docs/progress/SESSION_HANDOVER.md:185-186`), but not fixed.
- **Fix (lane G).** When `status.box.inProcess` is false, hide "Pair a screen" and say "This booth runs on its own box; its television needs no pairing."
- **What the owner would see:** on the page he uses at bench step 4, the Console says the Pi booth cannot mint a voucher, and his first press proves it wrong.

### M2 — medium — The Console's wheel preview draws switched-off prizes and says the TV does too; the TV does not

- **Sources:** `p6/product.md` #4 and `p6/quality.md` F2.
- **Skeptics:** medium, both (`p6/skeptic-wheel-preview-inactive.md`, `p6/skeptic-wheel-preview-switched-off-tv.md`).
- **Where.**
  - `apps/console/src/components/booth/WheelPreview.tsx:48` draws every prize (`const slices = prizes`).
  - The sentence "A prize switched off is dimmed here and still drawn on the television" is at `:141-146`. It is shown on every booth, whether any prize is off or not.
  - The comments at `:26-36` and `:46-47` are stale.
  - The TV draws only the prizes switched on: `apps/booth/src/App.tsx:328-340` and `apps/booth/src/booth/wheel-view.ts:28-35`, since `1de320c`.
  - The panel title "Slice order and colours, as the television draws them" (`Booths.tsx:492-493`) is then false.
  - `PrizeEditor.tsx:223` says the opposite of the preview.
- **Scenario.** The owner switches a prize off, as decision 4 allows. The page where he sets the odds draws an extra dimmed wedge, with every wedge a different width and position from the TV, and tells him the TV draws it too.
- **Proof.**
  - [V run] `p6/skeptic-wheel-preview/probe.ts` and `p6/skeptic-wheel-preview-tv/probe.mts`: with one prize off, the Console draws 7 wedges and the TV 6. The staging "Booth 2 (proof)" shape gives 3 wedges against 2.
  - [V run] `apps/booth/test/wheel-view.test.ts` passes 3 of 3.
  - It is disclosed at `docs/ops/PI_BOOTH.md:95` and in the twelve corrections, but not fixed.
- **Fix.**
  - **Lane G.** Build the wedges, the aria-label and the placeholder colour index from the switched-on prizes only; the list below the wheel may keep the switched-off rows. Remove the sentence and the stale comments. Reword `:149-150`, because the TV now draws an empty wheel and publishing refuses that state anyway.
  - **Lane H.** Delete `PI_BOOTH.md:95`.
- **What the owner would see:** the preview tells him his "never on the wheel" rule is broken, while the TV keeps it.

### M3 — medium — An online Pi whose booth has not been published yet says "Booth not set up, connect to internet"

- **Sources:** `p6/product.md` #5.
- **Skeptic:** medium (`p6/skeptic-booth-unpublished-notsetup.md`).
- **Where.**
  - `apps/booth/src/App.tsx:250-257` and `:223-224` go to the `unsynced` screen whenever `/booth/config` has no version.
  - That screen always shows `COPY.notSetUp` (`App.tsx:733-758`; `apps/booth/src/copy.ts:131-134`), whatever `status.online` says, beside a green online dot.
  - A new booth has no wheel until someone publishes it (`apps/api/src/services/fleet.ts:994-1048`; `booth-admin.ts:310-353`).
  - The bench list publishes at step 1 and creates the Pi's booth at step 4 (`docs/progress/plans/booth/PLAN.md:58-64`), so at step 5 the Pi's booth has never been published.
- **Scenario.**
  1. From creating the booth until 25–90 s after its first publish, the TV shows "connect to internet" in English and Thai, beside the green dot.
  2. Guests see it too. The owner is sent to check the network.
- **Proof.** [V run] On an isolated stack (`p6/skeptic-unpub/repro.log`; `p6/skeptic-unpub/shots/b-unpublished-online.png`):
  - `/booth/status` read `online:true, neverSynced:true`;
  - the message cleared 25.3 s after the publish.
- **Fix.**
  - **Lane F.** Choose the line by `status.online`:
    - offline: keep "connect to internet";
    - online with no wheel: the staff line "No wheel published for this booth yet — publish it in Console → Booths", and "please ask our staff" for guests.
  - **Lane H.** Fix the order of the bench steps in PLAN.md, and say in PI_BOOTH §5 what the TV shows until the first publish.
- **What the owner would see:** at bench step 5, the Pi says "connect to internet" while it is online, and keeps saying it until the booth is published.

### M4 — medium — The first step of the Pi guide needs a developer, and the only release file on the build machine is stale

- **Sources:** `p6/product.md` #12.
- **Skeptic:** medium (`p6/skeptic-pi-guide-tarball.md`).
- **Where.**
  - `docs/ops/PI_BOOTH.md:27` says: "Build the release on a development machine with `pnpm --filter @oto/box-agent pack:pi`". Doing that needs the private repository, Node, pnpm, git and a full workspace install (`packages/box-agent/scripts/build-runner.mjs:98-181`).
  - CI neither builds nor publishes the file: `.github/workflows/ci.yml` has no such step, and `packages/box-agent/package.json` has no `build` script.
  - `scripts/pi/install.sh:84-92` accepts only a local file.
- **Proof.**
  - [V run] `gh release list` and the Actions artifacts are both empty, and the repository is private.
  - [V run] The only packed file, `packages/box-agent/dist/oto-box-0.1.0-6cfbc5c+local.tgz`, was built at the plan commit before `1de320c` landed. Its `install.sh` differs from HEAD's in 38 lines (`p6/stale-tgz`).
- **Fix.**
  - **Lane H.** PI_BOOTH §3 should say "you receive `oto-box-<version>-<commit>.tgz` from us, with its SHA-256".
  - **Engineer.** Pack the release at the fix round's merged commit and send it. Do not send the stale file.
  - **Ticket T22.** CI runs `pack:pi`.
- **What the owner would see:** he cannot start the bench test without asking an engineer for the file. Handed the file already in `dist`, he would install a build from before the reviews.

### M5 — medium — BOOTH_SETUP.md says any product kind "works" at "the till"; the ticket till refuses a menu-item voucher, and no guide covers the counter

- **Sources:** `p6/quality.md` F1 (medium) and `p6/product.md` #9 (medium).
- **Skeptics:** they split. `p6/skeptic-booth-setup-menu-item.md` kept the restaurant-till point at medium, as a guide that misleads. `p6/skeptic-counter-guide-menu-item.md` rated the broader "no counter guide" point low, as a detour rather than a wrong outcome. Ranked here at medium for the guide sentence; the rest is folded in.
- **Where.**
  - `docs/ops/BOOTH_SETUP.md:13` says, of the pizza in F&B Menu, "Any of those kinds works: the till puts it on the sale and takes its price off".
  - The ticket till refuses a menu item: `apps/pos/src/pages/Till.tsx:144-147` and `apps/pos/src/lib/tillVoucher.ts:76, 113-115, 316-320`. Only the F&B tab takes it (`apps/pos/src/pages/OrderStation.tsx:171`).
  - An unworded type's slip says "Show this QR at OTO Reception to claim" (`packages/box-agent/src/booth.ts:1751-1753`).
  - Neither guide says "restaurant". `docs/ops` has no counter guide.
- **Scenario.**
  1. At bench step 6 the owner types the Kids Pizza code at the ticket till, which is where the POS opens. Kids Pizza is 14.5% of the seeded odds.
  2. He gets "Redeem this voucher at the restaurant till", which no guide explains.
  3. Also unexplained:
     - a THB voucher needs ticket lines before Pay works;
     - a 1+1 needs two kids tickets of the linked package;
     - a free product is exactly one product, so the park's "pizza and a juice" gives the pizza only (owner Q6).
- **Proof.**
  - [V read] The lines above.
  - [V run] Product lens: the ticket till refused, and the F&B tab took it as a ฿0 "Margherita Pizza" line.
  - P5 saw the same on staging (`docs/progress/SESSION_HANDOVER.md`: "Kids Pizza refused at the ticket till and redeemed at the restaurant till (T1-000020)").
- **Fix (lane H).**
  - In BOOTH_SETUP §1 and §2, say that an F&B Menu product is redeemed at the F&B (restaurant) till only, and give Kids Pizza a restaurant instruction.
  - Write a one-page counter guide, `docs/ops/COUNTER_VOUCHERS.md`, covering:
    - the Redeem voucher box;
    - tickets first for THB and 1+1;
    - the pizza on the F&B tab;
    - Pay, then Confirm;
    - the second scan;
    - offline slips and the 10-minute lock (M8);
    - the void offer after C1.
  - Change bench step 6 to redeem the pizza on the F&B tab.
- **What the owner would see:** the pizza voucher is refused at the till he was told to use, and nothing he has read says why.

### M6 — medium — The slip's "Expires <date>" ends at the minute the prize was won, so the slip is refused on the day it names

- **Sources:** `p6/integrity.md` F4 and `p6/product.md` #7.
- **Skeptics:** medium, both (`p6/skeptic-expiry-date.md`, `p6/skeptic-expiry-minute-of-win.md`).
- **Where.**
  - The box sets expiry to the moment won + N × 24 h (`packages/box-agent/src/booth.ts:1689-1695`).
  - Every surface shows a date only:
    - the slip (`booth.ts:1775-1778`; `packages/print/src/templates/booth.ts:142`);
    - the TV (`apps/booth/src/components/ResultModal.tsx:152-155`);
    - the till card, "valid until" (`apps/pos/src/components/till/RedeemVoucher.tsx:40`).
  - The api refuses once `expiresAt <= now`, at lookup and hold (`apps/api/src/services/vouchers.ts:810-825`) and at ring-up (`:1545-1557`). Staff have no override.
  - The platform's own rule for a named date is the whole day (`apps/api/src/services/members.ts:30-34`).
- **Scenario.**
  - A voucher won at 15:00 with 14 days prints "Expires 09 Oct 2026". At 16:00 on 9 October the till answers "Voucher expired on 9 Oct 2026".
  - Two slips printed with the same date get different answers at 11:00 that day.
- **Proof.** [V run] The box slip was rendered with `@oto/print` (`p6/skeptic-expiry-minute/box-slip.out`). The api was run with a set clock (`p6/skeptic-expiry-minute/api-probe.out`; `p6/skeptic-expiry/*.out`). Ring-up five seconds after the moment gave 409 EXPIRED.
- **Fix (this round, unless the owner answers Q1 otherwise).**
  - **Lane D.** Expire at the end of the printed date in the branch's time zone: the local day of the win + N days. The box already has the branch zone, so this works offline. Update `packages/box-agent/test/booth.test.ts:481-485`.
  - **Lane G.** Update the hint at `apps/console/src/components/booth/PrizeEditor.tsx:309`.
  - **Lane H.** Update `docs/ops/BOOTH_SETUP.md:39, 82`.
  - Slips already printed keep their old moment.
- **What the owner would see:** nothing on the bench. In the park, a family on the last printed day, later in the day than they won, is refused a voucher that the slip, the TV and the till all call valid.

### M7 — medium — "Honoured at every park" is false for a free product

- **Sources:** `p6/product.md` #8.
- **Skeptic:** medium. It is wider than reported, and the first proposed fix cannot work (`p6/skeptic-honoured-every-park.md`).
- **Where.**
  - `freeItemAtBranch` (`apps/api/src/services/vouchers.ts:474-491`) takes the linked product if this park sells it, and otherwise a row at this park with the same code (`:477`, where a missing code means no match).
  - Product codes are unique per operator (`packages/db/src/schema/catalog.ts:348-350`), so two parks can never both hold a live row with one code.
  - The POS admin creates products with no code (`apps/pos/src/api/menu.ts:501, 587, 656`).
  - The promise is made in `docs/ops/BOOTH_SETUP.md:16`, `apps/console/src/components/booth/VoucherTypeEditor.tsx:255`, `vouchers.ts:452-460` and `apps/api/src/services/voucher-definitions.ts:514-521`.
- **Scenario.** Bracelet Workshop is created in the POS admin at Central Floresta, as the guide says. At Robinson Chalong (T3) the voucher answers "This voucher's item is not sold at this branch — ask a manager". A free-product voucher is honoured at exactly one park at a time.
- **Proof.** [V run] `p6/skeptic-honour-probe.mts`, log `p6/skeptic-honour-probe.log`:
  - a product with no code works at T1 and gets 409 at T3;
  - the same name added at Chalong still gets 409;
  - the same code at Chalong is refused with `MENU_CODE_IN_USE`.
  - [V run] `vouchers.test.ts -t "any branch"` already asserts the refusal at T3.
- **Fix.**
  - **This round:** correct the wording only.
    - Lane H: `BOOTH_SETUP.md:16`.
    - Lane G: `VoucherTypeEditor.tsx:255`.
    - Lane B: the comments at `vouchers.ts:452-460` and `voucher-definitions.ts:514-521`.
    - The new wording: a free product is honoured at the park that sells the linked product.
  - **Ticket T5:** the owner chooses how (Q7): a fallback on kind and name at the redeeming park, a product linked per park, or codes unique per branch.
- **What the owner would see:** nothing at a one-park bench. Later, the Bracelet or Kids Pizza voucher is refused at the other park, although the guide says it is honoured there.

### M8 — medium — Retrying a slip printed offline counts as guessing: five tries in a minute lock that till's vouchers for 10 minutes and raise "Somebody may be guessing codes"

- **Sources:** `p6/product.md` #10.
- **Skeptic:** medium. The bench part is overstated, and one proposed fix is unsafe (`p6/skeptic-unsynced-retry-lock.md`).
- **Where.**
  - An unknown code with a correct check character counts as a miss (`apps/api/src/services/vouchers.ts:1033`).
  - Only the times of misses are stored, not the codes (`vouchers.ts:360-363`; `packages/db/src/schema/promo.ts:510-513`).
  - The fifth miss locks the till for 10 minutes and raises the alert (`vouchers.ts:371-413`). The lock is checked before the code is read (`:1006`), so a voucher that has since synced is refused too.
  - Nobody can unlock it. The only mention in the guides is `docs/ops/PI_BOOTH.md:100`.
- **Scenario.** After an outage, staff press Redeem again on "Code not found — the booth may not have synced yet" while the Pi reconnects. The fifth press inside a minute locks that till's vouchers for every family for 10 minutes, and Health says somebody may be guessing codes.
- **Proof.** [V run] `p6/skeptic-unsynced/unsynced.probe.ts`, log `run1.log`:
  - five presses gave 404, and the till locked;
  - after the sync, the sixth press answered 429 at that till and 200 at Counter 2;
  - one press every 10 s, while the sync landed at 45 s, still locked.
- **Fix.**
  - **This round, lane H:** a warning in PI_BOOTH §9 and in the counter guide: press Redeem once, and again only after the booth's offline dot has gone; another till still works.
  - **Ticket T6:** count a repeated code once per window. Store a hash of the code beside each miss time, which needs a small migration.
  - Do **not** exempt well-formed codes (section 3).
- **What the owner would see:** at bench step 7, only if he presses Redeem five times before the sync lands: the till refuses every voucher for 10 minutes, and Health raises a false guessing alert.

### M9 — medium — A branch manager can put anyone in the operator on his booth, and set or withdraw that person's PIN at every booth

- **Sources:** `p6/security.md` S5.
- **Skeptic:** medium. It reproduced the finding and found two more ways in (`p6/skeptic-booth-staff-pin-crossbranch.md`).
- **Where.**
  - `requireStaffAccount` checks the operator only (`apps/api/src/services/booth-admin.ts:1422-1438`).
  - `addBoothStaff` (`:1440`), `setBoothPin` (`:1542`) and `clearBoothPin` (`:1619`) add no branch or role check on the target.
  - `clearBoothPin` does not even require the person to be on the booth.
  - The routes guard only on the booth's branch (`apps/api/src/routes/booth.ts:762, 787, 826, 853`).
  - One live PIN per person (`packages/db/src/schema/platform.ts:181-183`), so a change applies at every booth.
  - The box accepts anyone on the booth's list (`packages/box-agent/src/booth.ts:1155-1172`).
- **Scenario.** Floresta's manager can do all of this:
  - add the owner, or Chalong's manager, to his own booth;
  - set their PINs;
  - sign in as them, so spins, reprints and "Printed by" carry their names;
  - replace or withdraw Chalong's manager's PIN at Chalong's booth;
  - pull that colleague's password hash onto a box he can reach (`apps/api/src/services/sync.ts:3522-3530`).

  Adding the owner goes through the ordinary Console: its picker offers the park's administrators. Adding a manager from the other park needs a hand-made api call.

  Every sibling gate refuses the same act:
  - a temporary password answers 403 `ROLE_NOT_DOMINATED` or `OUT_OF_BRANCH_SCOPE`;
  - a till's staff list answers 400 `STAFF_NOT_AT_BRANCH`.
- **Proof.**
  - [V run] `p6/sec-probes/pin.probe.ts`.
  - [V run] `p6/skeptic-pinx/pinx.probe.ts`, log `run2.log`, 12 of 12 tests: two booth boxes; the replaced PIN failed at Chalong's next pull; sign-in as the colleague worked. Audit rows name the Floresta manager.
- **Fix (lane C).**
  - `addBoothStaff`: require `atBranch(row.branchId)`, as `apps/api/src/services/fleet.ts:880-893` does, and refuse with `STAFF_NOT_AT_BRANCH`. Operator administrators still pass.
  - `setBoothPin` and `clearBoothPin`: the same branch check, plus `assertDominatesAccount` (`apps/api/src/services/access-control.ts`, used at `apps/api/src/routes/accounts.ts:462`) in the route, where the caller's permissions are known.
  - `clearBoothPin`: also require the person to be on this booth.
- **What the owner would see:** nothing at the bench, where he acts as the administrator. In the park, a manager at one park can act at a booth under another person's name, or lock a colleague at the other park out of his booth PIN.

### M10 — medium — Two people can hold the same PIN; the booth then signs in whoever it checks first

- **Sources:** `p6/product.md` #11.
- **Skeptic:** medium. The proposed fix is incomplete (`p6/skeptic-duplicate-pin.md`).
- **Where.**
  - `setBoothPin` hashes and stores the PIN without comparing it with anyone's (`apps/api/src/services/booth-admin.ts:1542-1600`).
  - `addBoothStaff` can create a clash with no PIN being set at all, because the PIN belongs to the person at every booth.
  - The box stops at the first match (`packages/box-agent/src/booth.ts:1160-1172`), in the cloud's unsorted list order (`apps/api/src/services/sync.ts:3533-3554`).
  - The shared contract itself says a PIN must not be used to find a person (`packages/shared/src/booth.ts:369-377`).
- **Scenario.** Reception is given the owner's digits. Whoever types them is signed in as "Khun Anan (Owner)". The slip, the spin, reprints and the till's "Printed by" all name the wrong person, and the second person can never sign in as themselves by PIN.
- **Proof.**
  - [V run] Product lens: PUT returned 200, and the sign-in went to the owner.
  - [V run] `p6/skeptic-duppin/duppin.test.ts`: the list order decides who is signed in.
- **Fix.**
  - **Lane D (this round).** On the box, check every candidate and refuse a PIN that matches two people. Log it without naming anyone, and do not count it toward the lock. The page shows its ordinary refusal; a distinct "that PIN is shared" message needs a shared-contract change (ticket T29). This also covers a clash that `addBoothStaff` creates, where there is no plaintext to compare.
  - **Lane G (this round).** The Set PIN form (`apps/console/src/components/booth/BoothStaffPanel.tsx:281-327`) says to choose digits nobody else on the person's booths uses.
  - **Not as the finders proposed.** Refusing a clashing PIN at `setBoothPin` tells whoever sets PINs that a colleague already uses those digits: a PIN oracle, found in synthesis [I]. If a set-time check is wanted, have the platform issue a random PIN that nobody else on the person's booths holds, shown once (ticket T29), or throttle and audit every refusal.
- **What the owner would see:** only if two people are given the same digits: slips and records carry the wrong name.

### M11 — medium — The booth's PIN lock does not hold against overlapping attempts

- **Sources:** `p6/security.md` S3.
- **Skeptic:** medium (`p6/skeptic-pin-throttle-concurrency.md`).
- **Where.**
  - `packages/box-agent/src/booth.ts:1125-1144` reads the throttle and checks the lock. The argon2 checks follow (`:1160-1174`).
  - The lock is then set from the count read before (`held.failures + 1`, at `:1177-1183`). The accurate count the store returns (`packages/box-agent/src/store-sql.ts:1289-1308`) is only logged.
  - The comment at `booth.ts:1168-1169` concedes that "nothing here serialises concurrent attempts".
- **Scenario.**
  - A script fires 60 PIN attempts at once, either on the Pi's loopback server or through staging's relay with a paired screen's credential. All 60 are checked, and a correct PIN inside the burst signs in.
  - About one burst gets through per 15-minute lock. A 4-digit PIN (`apps/api/src/routes/booth.ts:818`) becomes guessable.
- **Proof.**
  - [V run] `p6/sec-probes/throttle.probe.ts` and `p6/skeptic-throttle/race.probe.ts`: 12 attempts in sequence were locked after 6; 60 overlapping attempts were all checked.
  - [V read] The booth's own PIN pad sends one attempt at a time (`apps/booth/src/components/StaffSignIn.tsx:166, 173`). The loopback server needs a script on the Pi itself (`kiosk-server.ts:150-171`), which is why this is medium and not higher.
- **Fix (lane D).**
  - Handle sign-ins one at a time per station, with a promise chain in `booth.ts` that covers both the Pi and staging's in-process box.
  - Set the lock from the count the store returns.
  - Add a test with overlapping attempts.
- **What the owner would see:** nothing at the bench. It closes a gap that someone with a script could use to guess a PIN.

### M12 — medium — A second screen at the same till can void the first screen's sale while cash is being taken

- **Sources:** `p6/integrity.md` F5.
- **Skeptic:** medium, reproduced in the real POS (`p6/skeptic-moveTo-second-session.md`).
- **Where.**
  - The api names the rung-up sale to any session at that station (`apps/api/src/services/vouchers.ts:929-940`).
  - `voidSale` does not check who rang the sale up (`apps/api/src/services/sale.ts:3096-3151`).
  - `moveTo` voids whatever sale the refusal names (`apps/pos/src/lib/tillVoucher.ts:371-377`). It never checks the writer's own sales (`apps/pos/src/lib/saleWriter.ts:253, 272-273`).
- **Scenario.**
  1. Tab B holds the voucher. Tab A types the same code, which silently moves it, rings it up, and is taking cash.
  2. B's Pay is refused `VOUCHER_NOT_HELD`. B changes the order and presses Pay again.
  3. B's `moveTo` voids A's sale with the reason "Order changed at the till after Pay" and takes the voucher.
  4. A's "Confirm Payment Received" answers `SALE_CLOSED`, with the cash already in the drawer. A's screen also says the order "is saved on the platform, as unpaid", which is false.
- **Proof.**
  - [V run] Two tabs of one session at Reception Till 1 (`p6/skeptic-moveTo/two-tabs-v2.mjs`; `p6/shots/skm2-*.png`).
  - [V run] Control: without the order change, no void happens.
- **Fix (lane A).**
  - `moveTo` may void automatically only a sale in this writer's own committed or superseded set. Otherwise it shows the refusal, which after C1 carries the explicit void offer.
  - Naming the sale only to the session that rang it up would not cover two tabs of one session.
- **What the owner would see:** only with two screens on one till: a paid cash sale disappears under the cashier who took the money.

### M13 — medium (predates the booth) — The sale prices any discount the till describes, under any code

- **Sources:** `p6/integrity.md` F6.
- **Skeptic:** medium (`p6/skeptic-promos.md`).
- **Where.**
  - `apps/api/src/services/sale.ts:1337-1348` takes `promos[]` as sent.
  - The comment at `sale.ts:255-268` says the platform has no promo-code table, but `pos.discount_definition` exists (`packages/db/src/schema/catalog.ts:613`; `apps/api/src/routes/menu.ts:627-785`).
  - Only booth-shaped or held codes are refused (`apps/api/src/services/vouchers.ts:1483-1494`).
  - The till's check runs against its own copy of the codes, loaded at sign-in (`apps/pos/src/auth/OperatorContext.tsx:249-263`). Usage counts live in browser memory (`apps/pos/src/store/catalogStore.ts:1496-1510`).
- **Scenario.**
  - A reception session sends `promos: [{code:'NOSUCHCODE', type:'fixed', value:89000}]`, and the ticket is free.
  - Archived, switched-off, expired or other-park codes are all priced at the value sent.
  - A code the park withdrew during the day stays honoured on every till that has not reloaded. Usage limits are enforced nowhere.
- **Proof.** [V run] `p6/probe/promos.probe.ts` and `p6/probe/skeptic-promos.probe.ts`:
  - commit 200 at gross 0, and the sale finalises;
  - STAFF10 (10%) sent as 100% was filed under the park's own code.
- **Why medium:** the same role can already give a free ticket the proper way, with a reason recorded.
- **Fix: ticket T1.**
  - Price `promos[]` from `pos.discount_definition`: active, in its window, at its branch, with its stacking rule and usage limit.
  - Refuse unknown codes.
  - Replay a paid offline sale as recorded, and flag the difference.
  - Change `apps/api/test/vouchers.test.ts:1942-2015` and fix the stale comments.
- **What the owner would see:** nothing at the bench. It is a money-control gap at every till today, not only for booth vouchers.

### M14 — medium (the lower end) — While Google Fonts does not answer, a booth with a cold cache shows a white TV and a dead button

- **Sources:** `p6/robustness.md` R2.
- **Skeptic:** medium, but narrower than reported (`p6/skeptic-booth-font-block.md`).
- **Where.** A render-blocking Google stylesheet sits ahead of the page's script (`apps/booth/index.html:27-32`). The same face is already bundled as 'Booth Thai' (`apps/booth/src/kiosk.css:29-44`). `docs/ops/PI_BOOTH.md:58, 98` promise the TV is up "within seconds … with or without internet".
- **Scenario.**
  - The trigger is a Chromium cache with no copy of Google's stylesheet, or one more than 8 days old, while the network silently drops traffic to Google. Examples: a booth stored for over a week, a wiped profile, or a network that drops Google.
  - The TV stays white and the button does nothing: 21–30 s measured, about 2 minutes on Linux [I].
- **Proof.**
  - [V run] `p6/skeptic-font/cache-probe.mjs` (t1: 30.4 s; SYN drop: 21.5 s) and `p6/probes/font-block.mjs`.
  - Refuted part: a warm cache comes up in 126–143 ms (section 3).
- **Fix.**
  - **Lane F.** Delete `index.html:27-32` and correct the comment at `:20-25`. Two text styles (`apps/booth/src/kiosk.css:67, 932`) then draw Latin letters in the system font. If that look must stay, load Google's stylesheet from the page's script after it has mounted, so it can never block the page, and add no inline handler.
  - **Lane H.** Correct `PI_BOOTH.md:98`.
- **What the owner would see:** nothing at the bench, where the cache is warm. In the field, a white TV for up to two minutes after starting a booth that has been stored.

### M15 — medium — The printer write has no timeout: a printer that keeps the connection but stops taking data holds up printing and the heartbeat

- **Sources:** `p6/robustness.md` R3.
- **Skeptic:** medium, overstated in three ways (`p6/skeptic-write-timeout.md`).
- **Where.**
  - `writeMs` is declared and never used (`packages/box-agent/src/printing/channel.ts:30-37`).
  - `write()` settles only on the socket callback (`channel.ts:199-213`).
  - One lock per printer is shared by the job and the heartbeat's printer check (`packages/box-agent/src/printing/queue.ts:591-603, 979-998`).
  - The heartbeat waits for that check with no deadline (`packages/box-agent/src/agent.ts:1977, 1983`).
  - `/kiosk/health` always answers 200 (`packages/box-agent/src/runner/kiosk-server.ts:253-256`).
- **Scenario.**
  1. Something sends one job larger than about 80–110 KB: long terms, a test print of 2–3 copies, or a receipt of 40 or more lines.
  2. The printer has already stopped, without the status check catching it (a silent board), or stops in the first moment of the job.
  3. The write never completes. Every later press waits, then the TV says "Booth not ready". Heartbeats stop, and the Console shows the box offline after 180 s instead of "paper out".
  - It clears once the printer takes data again.
- **Proof.** [V run] Linux container measurements (`p6/wstall/harness.ts`):
  - the seeded 43 KB slip and the 68 KB test page are absorbed;
  - 136 KB and 174 KB jobs never settle, and neither does the heartbeat's printer check.
- **Fix (lane E).**
  - Apply a write deadline scaled to the job's size, and fail the job as partial. It must not be retried by itself.
  - Make the heartbeat's printer check skip a printer that is busy, and report its last known state.
- **What the owner would see:** nothing with the seeded slip. With long terms and a stalled printer, the booth hangs until the printer is fixed, and the Console calls the box offline.

### M16 — medium — A damaged box.sqlite leaves the booth dead: no message on the TV and no recovery step in the guide

- **Sources:** `p6/robustness.md` R4.
- **Skeptic:** medium. The problem is wider than reported, the way back is overstated, and the proposed fix is unsafe (`p6/skeptic-corrupt-store.md`).
- **Where.**
  - The store opens and prepares before the kiosk listens: `packages/box-agent/src/runner/runtime.ts:212-213`, and `agent.prepare()` at `:375`.
  - `oto-box run` then exits 1 (`packages/box-agent/src/runner/cli.ts:147-161`).
  - systemd restarts it every 3 s (`scripts/pi/oto-box.service:14-15, 24-25`), and the watchdog starts it again every minute (`scripts/pi/oto-box-watchdog.sh:10-15`).
  - `docs/ops/PI_BOOTH.md` §7 has no recovery step, although `:84` warns that under-powered Pis corrupt cards.
- **Scenario.** A card that loses writes it said were saved leaves `box.sqlite` unreadable. The service loops for ever, the TV shows Chromium's error page (sideways on a portrait TV), and the Console hears no heartbeat.
- **Proof.**
  - [V run] `p6/probes/corrupt-store.ts`, and `p6/skeptic-store/probe.ts` and `stack.ts`: exit 1 in about 160 ms, each time.
  - [V run] `sudo oto-box claim <new code> --force` does recover the box, with a new identity.
  - [V run] Nearby: other damaged pages keep `/kiosk/health` at 200 while every press is refused.
- **Fix.**
  - **This round, lane H:** a recovery step in §7. Name the symptom (Chromium's error page, and `oto-box status` saying "the store could not be read"). Give the recovery: `sudo oto-box claim <new code> --force`, with a new claim code. Warn that vouchers printed offline and not yet sent stay in the file set aside, so an engineer should rescue them.
  - **Ticket T3:** listen first and show "needs service"; salvage the outbox; take a new epoch from the cloud before any new fact.
  - A plain "move the file aside and start clean" would lose the next vouchers (section 3).
- **What the owner would see:** nothing on a healthy card. After a bad power cut on a poor card, a dead booth, with no words on screen and no step in the guide.

### M17 — medium — The Pi never measures its own clock

- **Sources:** `p6/robustness.md` R5.
- **Skeptic:** medium. Two consequences are overstated (`p6/skeptic-clock.md`).
- **Where.**
  - `clock()` is `Date.now() + clockSkewMs`, and only a test control changes it (`packages/box-agent/src/agent.ts:672, 2874-2880`).
  - The heartbeat ignores the offset in the answer (`agent.ts:2055-2083`).
  - Every event is stamped `trusted` with offset 0 (`packages/box-agent/src/store-sql.ts:482-494`).
  - The cloud's overrule never fires for a Pi (`apps/api/src/services/sync.ts:2571-2583`).
  - A heartbeat more than 15 minutes off is refused (`apps/api/src/services/box.ts:633-639`).
  - The comment at `booth.ts:276-281`, that a mall power cut trips the suspect flag, is wrong on Bookworm, which saves the clock every 60 s.
- **Scenario.**
  1. A power cut, with no RTC battery and a network that blocks time sync but allows HTTPS.
  2. The Pi comes back with a stale clock. Heartbeats are refused, so the Console shows the box offline and never names the clock.
  3. Spins are filed on the wrong trading day once the lag crosses 05:00.
  4. Slips print a stale issue time, with the expiry counted from it. Everything is filed as `trusted`.
- **Proof.** [V run] `p6/probe-clock/clock.probe.test.ts`, with the clock 12 h behind:
  - two heartbeats refused with 400;
  - spins not flagged;
  - events filed as trusted;
  - the box shown offline.
- **Refuted part:** "config never arrives" is wrong. The wheel, staff and commands still arrive, because they do not depend on the clock.
- **Fix: ticket T2.**
  - Adopt the answer's `clockOffsetMs`.
  - Send `serverTime` in the 400's details, or read the `Date` header.
  - Stamp events with the measured offset.
  - Flag spins made under a large skew.
  - **Lane H this round:** add the RTC battery to the §1 kit list.
- **What the owner would see:** nothing at the bench, which has time sync. At a mall that blocks it, after a power cut, a box shown offline and slips with the wrong times.

### M18 — medium — The box keeps every sent fact for ever, and two queries that run every 5 s read them all

- **Sources:** `p6/robustness.md` R7.
- **Skeptic:** medium (`p6/skeptic-outbox-growth.md`).
- **Where.**
  - Nothing deletes from `box_outbox` (grep).
  - `depth()` and `takeBatch` cannot use the partial index, because its condition does not match theirs: `packages/box-agent/src/store-sql.ts:720-732, 548-563` against `packages/box-agent/src/store-sqlite.ts:99-100`.
  - Three callers run on 5 s and 60 s timers.
  - `node:sqlite` is synchronous and shares its thread with the kiosk (`packages/box-agent/src/runner/runtime.ts:75-76`).
- **Scenario.** At 500 presses a day, the scans take about 0.13 s after 90 days on a fast desktop, and about 1 s after a year. A Pi is inferred to be 3–4× slower. Presses and the TV's status stall, heading towards the page's 6 s timeout.
- **Proof.**
  - [V run] `p6/skeptic-outbox-growth/probe.ts`: 45k rows take 43 ms, 135k take 128 ms, 550k take 952 ms.
  - [V run] Partial indexes whose conditions match exactly bring this to 0.01 ms.
  - Bounded retention was the design (`docs/architecture/design-review-2026-09-19/06-ops-scale-delivery.md:106`).
- **Fix: ticket T4.** Add partial indexes that match each query exactly, prune acknowledged rows after N days, and vacuum incrementally.
- **What the owner would see:** nothing at the bench. After months in the park, a slower and slower booth.

### Confirmed, then downgraded to low by the skeptic (details in section 4)

| Finding | Finder said | Skeptic | Why low | Section 4 |
|---|---|---|---|---|
| An idle keyboard at the booth reaches Reprint on an open 12-hour session, as often as it likes (`packages/box-agent/src/booth.ts:1876-1901`) | medium (`p6/security.md` S2) | low (`p6/skeptic-reprint-idle-keyboard.md`) | It is a trade-off the guide documents (`docs/ops/PI_BOOTH.md:65, 68`). It prints the same single-use code, marked "Reprint", and records it. It needs the staff keyboard. The red button cannot reach Reprint | L13 |
| Editing a voucher type's value reprices every printed, unredeemed slip (`apps/api/src/services/vouchers.ts:537-552`) | medium (`p6/integrity.md` F3) | low (`p6/skeptic-voucher-type-edit.md`) | Specified by decision 3 and disclosed (`VoucherTypeEditor.tsx:116, 203`; `BOOTH_SETUP.md:80`). What survives: a wrong schema comment, and no count-and-confirm | L10 |
| No counter guide for the bench (`docs/ops`) | medium (`p6/product.md` #9) | low (`p6/skeptic-counter-guide-menu-item.md`) | Every precondition is either enforced or explained on screen. The restaurant-till point is kept at medium in M5 | M5, L49 |
| The new till and TV code has no automated test in CI (`apps/pos/package.json:6-11`) | medium (`p6/quality.md` F3) | low (`p6/skeptic-pos-no-test-runner.md`) | No wrong outcome. The api tests the money and single-use rules. Already on SCRUM-369 and SCRUM-383. Note: the POS e2e set is red at HEAD (`apps/pos/e2e/smoke.spec.ts:67`) | L42 |

---

## 3. Refuted — do not raise these again

### 3.1 Findings refuted as defects

| Title (finder, where) | Why refuted |
|---|---|
| A box credential mints any voucher of any value; the cloud checks almost nothing on a booth voucher fact (`p6/security.md` S1; `apps/api/src/services/sync-booth.ts:573`) | **By design, and the threat needs a compromised box, which the owner excluded.** <br>• The cloud files a booth fact as a report of paper already printed (`sync-booth.ts:35-49`), and archived types stay honoured on purpose (`apps/api/src/services/vouchers.ts:533-535`). <br>• Codes minted on the box are settled policy (decision 2, `PLAN.md:12-14`). The probe forged facts by hand, using the virtual box's server-side credential. <br>• A real box issues vouchers only from the draw, using the published prize, cost, expiry and prefix (`packages/box-agent/src/booth.ts:1366-1417`). <br>• The proposed checks would quarantine slips a real booth printed: after an expiry edit, a prefix change, or archiving a running type ([V run] `p6/skeptic-forge/legit.probe.ts`, tests A–C). <br>Verdict: `p6/skeptic-voucher-issued-forge.md`. Optional low hardening: ticket T27. |
| Slow guessing never locks: one wrong code every 15 s (`p6/security.md` S4; `vouchers.ts:334`) | **This is the specified budget, not a defect.** <br>• "5 a minute → 10-minute lock" is the rule (`docs/progress/SPRINT_2_PLAN.md:1832-1834, 1855-1856`), pinned by `apps/api/test/vouchers.test.ts:1522`. <br>• Every code is at least 39 bits. At 4 guesses a minute that is about 1 hit per 506 days against a year of codes, and every redemption is attributed. <br>• No four-digit code can exist at HEAD. The legacy import's spec already requires a campaign/date window. <br>[V run] `p6/skeptic-pacing/pacing-http.probe.ts`: 480 misses at 15 s intervals gave 0 locks; at 14.999 s the lock came on the 6th. Verdict: `p6/skeptic-pacing-throttle.md`. The spec differences are carried to ticket T25. |
| Five wrong passwords at a booth lock that person out of the POS and Console for 5 minutes (`p6/security.md` S6; `apps/api/src/services/box-booth-staff.ts:80`) | **Intended "one password, one budget", and the fix would weaken it.** <br>• The rule is documented at `box-booth-staff.ts:31-36`, `apps/api/src/routes/box-booth-staff.ts:37` and `apps/api/src/env.ts:92-95`, and pinned by `apps/api/test/box-booth-staff.test.ts:236-251`. <br>• The public `POST /auth/sign-in` (`apps/api/src/routes/auth.ts:52-57`) already lets anyone on the internet do the same. <br>• A separate booth bucket would allow 25 guesses a window at one password instead of 5. <br>[V run] `p6/skeptic-lockout/lockout-skeptic.probe.ts`. Verdict: `p6/skeptic-booth-phone-lockout.md`. |

### 3.2 Parts of confirmed findings that were refuted

| Claim | Why refuted |
|---|---|
| H1: "a printer that does answer collides with the heartbeat probe too" | The probe holds the lock for milliseconds. A press during `probeAll` answered in 65 ms [V run]. Only a partly silent printer collides (`p6/skeptic-silent-printer-press.md`). |
| M14: "the 04:30 reboot, a power cut or a kiosk restart blanks the TV" | Chromium runs on a persistent profile (`scripts/pi/oto-kiosk.sh:23, 80`). Google serves the CSS with `max-age=86400, stale-while-revalidate=604800`. A warm restart with Google black-holed came up in 126–143 ms [V run]. The first probe used `page.route`, which turns the cache off (`p6/skeptic-booth-font-block.md`). |
| M15: "the stall lasts for good; only a restart or the 04:30 reboot clears it" | It clears when the printer takes data again (10.05 s after the paper came back) [V run]. A restart would not fix a stopped printer (`p6/skeptic-write-timeout.md`). |
| M15: "the bench's seeded slip triggers it" | The 43 KB slip and the 68 KB test page fit the kernel buffer even when the printer takes nothing [V run]. |
| M16: "no way back on the Pi" | `sudo oto-box claim <new code> --force` recovers the box, with a new identity [V run] (`p6/skeptic-corrupt-store.md`). |
| M17: "config changes that ride the heartbeat's answer never arrive" | The cache pull, the config and the command poll do not depend on the clock. The wheel, staff, PINs and `config_apply` all arrive [V run] (`p6/skeptic-clock.md`). |
| M17: "every press refused with 'all spins gone'" | Only when a daily spin cap is set. It is null by default (`apps/api/src/services/booth-admin.ts:117`; `packages/box-agent/src/booth.ts:1279`). |
| M17: "`After=time-sync.target` does not wait for a sync" | True, and deliberate: the booth must play offline (`scripts/pi/oto-box.service:6-9`). |
| Reprint (L13): "the guide contradicts itself on the keyboard (`PI_BOOTH.md:12` against `:68`)" | Line 12 lists the keyboard as being for staff, line 68 is the rule, and line 65 documents the digit → Tab → Enter path. |
| Voucher-type edit (L10): "hidden; only one header line mentions it; the guide misleads" | It is disclosed at `VoucherTypeEditor.tsx:116` and `:203`, and in `docs/ops/BOOTH_SETUP.md:80`. It is owner decision 3. The trigger cited, BOOTH_SETUP step 2, changes no value. |
| M5: "'Take a till first' can come up in the bench flow" | The POS opens no selling screen without a station (`apps/pos/src/App.tsx:104-106`). |
| M8: "bench step 7 invites exactly these retries" | Step 7 plugs the internet back first (`PLAN.md:68`). The lock needs five presses inside a minute before the sync lands. |
| M1: "the paired staging page shows 'Booth not ready'" | It gets 401 `BOOTH_UNPAIRED` and loops back to "Pair this screen" (`apps/api/test/booth-pairing.test.ts:454-469`). The outcome is the same: no wheel. |
| M2: "colours no longer match" | A prize with its own colour matches on both. The real differences are the extra wedge, the wedge width and the positions. |

### 3.3 Proposed fixes that were rejected — do not implement them

| Proposed fix | Why rejected |
|---|---|
| M16: "move a damaged `box.sqlite` aside and start clean" | A fresh store under the same credential restarts its journal at (epoch 1, seq 1). The cloud quarantines or drops the new facts at addresses it already holds (`apps/api/src/services/sync.ts:1980-2016, 2024-2043, 2851-2864`) [I], so new vouchers would never reach the till. A clean start first needs a new epoch or a new identity, and the old outbox rows rescued. |
| M8: "do not count a well-formed code with a known booth prefix as a miss" | Anyone who knows the format sends only well-formed codes: the prefix is printed on every slip and the check character is a public standard. That exemption would switch the limit off. Count distinct codes instead. |
| M7: "give every product a stable code when it is created" | Product codes are unique per operator (`packages/db/src/schema/catalog.ts:348-350`). Two parks can never hold the same code at once (`MENU_CODE_IN_USE`, [V run]). |
| M12: "name the rung-up sale only to the session that rang it up" | It does not cover two tabs of one session, which is how it was reproduced. The fix belongs in the till: void only its own sales. |
| L10: "copy the value onto the voucher when issued" or "refuse value edits while slips are out" | Either would break BOOTH_SETUP step 2. Slips printed before a free-item type got its first product link would stay "not set up" for ever. |
| S6: "a separate bucket for booth passwords" | It weakens the per-password budget from 5 guesses a window to 25. |
| M10: "check duplicate PINs only in `setBoothPin`" | Incomplete. `addBoothStaff` can create the clash with no plaintext to compare, so the box must also refuse an ambiguous PIN. |
| M10: "refuse a clashing PIN when it is set" (the finders' main proposal) | It creates a PIN oracle: whoever sets PINs learns that a colleague already uses the digits tried. Use the box-side refusal, and platform-issued PINs if a set-time check is wanted (T29). |
| C1: "make the void of the forgotten sale automatic" | It could void a sale that another screen at the same till is taking cash for. It must be a deliberate staff choice. |

---

## 4. Low findings, grouped by file

- Each finding gives where it is, the scenario (the input or state, then the wrong outcome), the proof and the fix. The source file in this folder is in brackets.
- The four confirmed findings the skeptics downgraded are marked **(downgraded)**.
- None of these blocks the bench. A few are cheap enough to ride along in the fix round, and section 5 names those. The rest go to the tickets in section 5.6.

### `apps/api/src/services/vouchers.ts`

- **L1 — A 1+1 voucher aimed at a line a manual discount already reduced gives half a kid.**
  - **Where:** `vouchers.ts:1703-1718`. The voucher aims at the first line with a kid, and manual discounts come off first.
  - **Scenario:** two lines of one kid each on 2 Hours Play, with 50% manual off line 1. The voucher takes ฿445 while line 2's kid pays the full ฿890.
  - **Proof:** [V run] `p6/probe/integrity.probe.ts` E (`p6/integrity.md` F9).
  - **Fix:** aim at the line with the most kid value left (ticket T17).
- **L2 — A staff manual discount rides beside a voucher.** This is a reading of decision 7 the owner has not confirmed.
  - **Where:** `vouchers.ts:1423-1428`.
  - **Scenario:** 50% manual and a ฿150 voucher on one sale are both applied.
  - **Proof:** [V run] `p6/probe/keys.probe.ts` K (`p6/integrity.md` F11).
  - **Fix:** owner Q8.
- **L3 — The till card says "Hand over, no charge" at the scan, before anything is used up.**
  - **Where:** `vouchers.ts:595` (`describeEffect`).
  - **Scenario:** staff hand the item over at the scan, then press Cancel. The voucher is free again.
  - **Proof:** [V read] (`p6/integrity.md` F14).
  - **Fix:** "Ring up to use it, then hand over" until the sale closes. This rides in lane B with C2.
- **L4 — The booth-code shape is restated in four places, and the api's copy hard-codes the lengths.**
  - **Where:**
    - `vouchers.ts:168` (`{2}` and `{9}` written out) and `:196-198`;
    - `packages/box-agent/src/scan.ts:356-361`;
    - `packages/box-agent/src/agent.ts:475-476`;
    - `apps/pos/src/lib/tillVoucher.ts:99-103`;
    - the handler name `'voucher'`, restated at `apps/pos/src/lib/scanChannel.ts:110`;
    - a third copy of the alphabet at `packages/shared/src/booth.ts:423`.
  - **Scenario:** a later change to the code length leaves the api and the till reading the old shape, without warning.
  - **Proof:** [V read] (`p6/quality.md` F4).
  - **Fix:** ticket T21.

### `apps/api/src/services/sale.ts`, `sale-tier.ts`, `payments/*`

- **L5 — A part-paid sale holds its voucher and cannot be voided.** Only an api caller can reach this today.
  - **Where:** `sale.ts:3133-3143` (`SALE_HAS_PAYMENT`).
  - **Scenario:** ฿100 cash on a ฿740 sale, then the guest leaves. The voucher stays held elsewhere until refunds exist.
  - **Proof:** [V run] `p6/probe/integrity.probe.ts` H (`p6/integrity.md` F10).
  - **Fix:** ticket T16, with SCRUM-208.
- **L6 — A void leaves the document check spent.**
  - **Where:** `sale.ts:3159-3170`; `sale-tier.ts:421-430`; `apps/pos/src/lib/tillVoucher.ts:376`.
  - **Scenario:** an expat walk-in has a voucher and presses Pay, then the order is changed. The automatic void makes the corrected sale fail with `TIER_CLAIM_SPENT`.
  - **Proof:** [V read] (`p6/integrity.md` F12).
  - **Fix:** ticket T17.
- **L7 — A tender still in flight is not counted.** This predates the booth, and the tills cannot reach it today.
  - **Where:** `payments/attempt.ts:267-279`; `payments/gateway.ts:772-779`; `payments/terminal.ts:897-910`.
  - **Scenario:** cash closes the sale while a card or QR payment is still running. The late approval settles on the closed sale, and nothing alerts anyone.
  - **Proof:** [V read] (`p6/integrity.md` F15).
  - **Fix:** ticket T15, before split tenders or the terminal land.

### `apps/api/src/services/sync-booth.ts`, `sync.ts`

- **L8 — A `booth.voucher_printed` fact can file a print record against another branch's voucher, "requested by" a manager who never touched it.**
  - **Where:** `sync-booth.ts:671-720`. The voucher is found by code across the whole operator.
  - **Scenario:** the HKT box files a "reprint" of a Chalong voucher. The booth report's print funnel is corrupted.
  - **Proof:** [V run] `p6/sec-probes/forge.probe.ts` (`p6/security.md` S7).
  - **Fix:** ticket T13.
- **L9 — A booth-only Pi receives the member register (with medical notes) and every branch-staff and administrator password hash, none of which it uses.**
  - **Where:** `sync.ts:3316` (every scope by default) and `:3471-3552`.
  - **Proof:** [V run] `p6/sec-probes/scope.probe.ts`: 6 members, 3 of 3 staff hashes (`p6/security.md` S8).
  - The owner has accepted member data on boxes.
  - **Fix:** ticket T12.

### `apps/api/src/services/voucher-definitions.ts`, `packages/db/src/schema/promo.ts`, Console voucher editor

- **L10 (downgraded) — Editing a voucher type's value reprices every printed, unredeemed slip.**
  - **Where:** `vouchers.ts:537-552`; `voucher-definitions.ts:654-724`; `apps/console/src/components/booth/VoucherTypeEditor.tsx:212-215`.
  - **Scenario:** "150 THB Voucher" is edited to 50. Slips already printed now redeem at ฿50, and the till card shows both "150 THB Voucher" and "50 THB off".
  - **Proof:** [V run] `p6/probe/skeptic-valueedit.probe.ts`. An edit made during a sale is refused `SALE_TOTAL_MISMATCH`, so nothing is charged wrongly without notice.
  - It is disclosed (`VoucherTypeEditor.tsx:116, 203`; `docs/ops/BOOTH_SETUP.md:80`), and it follows decision 3.
  - **Fix:** correct the comment at `promo.ts:26-32`, which says the value is copied at issue (the comment rides in lane B). Show the count of unredeemed vouchers and ask for confirmation on a value or kind change: ticket T9. Do not freeze the value unless the owner chooses that in Q11, and then only as section 3.3 allows.

### `packages/db/migrations/0021_voucher_redemption.sql` and its test

- **L11 — `TRUNCATE` empties the append-only ledger.**
  - **Where:** `0021_voucher_redemption.sql:72-73` (row triggers only); `packages/db/test/migration-0021.test.ts:203` claims it "cannot be edited or pruned, by anybody".
  - **Proof:** [V run] `p6/probe/integrity.probe.ts` D: `DELETE` is refused, while `TRUNCATE` by the api's own role took the ledger from 7 rows to 0 (`p6/integrity.md` F7).
  - **Fix:** ticket T11 (a statement-level `BEFORE TRUNCATE` trigger; an api role that does not own the table).
- **L12 — "applied again" in the migration test only proves the journal skips the migration, and neither migration has a written undo.**
  - **Where:** `migration-0021.test.ts:349-364`.
  - **Proof:** [V read] (`p6/quality.md` F12).
  - **Fix:** ticket T23.

### `packages/box-agent/src/booth.ts`

- **L13 (downgraded) — An idle keyboard at the booth reaches Reprint on an open session, any number of times.**
  - **Where:** `booth.ts:1876-1901` checks only for a live session. The session lasts up to 24 h and never ends on idle (`:1001-1021`).
  - **How:** a digit opens the signed-in panel (`apps/booth/src/App.tsx:630-642`), Tab reaches Reprint, and Enter presses it. The focus returns afterwards (`apps/booth/src/components/StaffSignIn.tsx:296-301, 404-408`).
  - **Scenario:** staff walk away signed in. Someone at the staff keyboard reprints the last slip, three times over.
  - **Proof:** [V run] `p6/skeptic-reprint/keyboard-reprint.mjs`.
  - **Why low:**
    - it is the same single-use code, marked "Reprint", and every copy is recorded;
    - the red button cannot reach it, and neither can a keypad with no Tab key;
    - it is documented (`docs/ops/PI_BOOTH.md:65, 68`).
  - **Fix:** owner Q9; ticket T10.
- **L14 — The reprint record names the account signed in, while the comment and the api's text say "the person who asked".**
  - **Where:** `booth.ts:1906-1919`; `apps/api/src/routes/booth.ts:271`.
  - **Proof:** [V read] (`p6/skeptic-reprint-idle-keyboard.md`).
  - **Fix:** correct the wording. The comment rides in lane D; the api text in lane C.
- **L15 — A duplicate code is quarantined, but the second slip redeems as the first voucher. Booth prefixes are unique per branch only.**
  - **Where:** `booth.ts:1368-1379` mints once with no local check; `apps/api/src/services/sync-booth.ts:518-571`; `packages/db/src/schema/fleet.ts:407-409`.
  - **Scenario:** about 3 clashes a decade per booth. Whichever family comes first gets the first voucher's prize. A "B1" booth at each park shares one code space.
  - **Proof:** [V read] (`p6/integrity.md` F13).
  - **Fix:** ticket T14.
- **L16 — The number beside the TV's offline dot is the outbox depth, about three per press, not the number of vouchers.**
  - **Where:** `booth.ts:2132-2149`.
  - **Scenario:** two offline spins show "6".
  - **Proof:** [V run] (`p6/product.md` #19). It is also one of the twelve corrections.
  - **Fix:** correct the guide this round (lane H). Count only vouchers: ticket T19.
- **L17 — One voucher date is printed four different ways.**
  - **Where:**
    - the slip: `booth.ts:1952-1967`, whose comment promises "21 Sep 2026" while Node 22 prints "Sept";
    - the TV: `apps/booth/src/components/ResultModal.tsx:177-186` and `StaffSignIn.tsx:598-602`, with no branch time zone;
    - the till: `apps/pos/src/lib/tillVoucher.ts:194-213`;
    - the api: `apps/api/src/services/vouchers.ts:116-134`, plus a third month table at `packages/shared/src/promo.ts:74`.
  - **Scenario:** the slip says "25 Sept 2026" and "09 Oct 2026", while the till says "25 Sep 2026" and "9 Oct 2026". A paired screen in another time zone can be a day off. No test pins the real slip string.
  - **Also:** the TV's Thai is marked "not reviewed by a Thai speaker" (`apps/booth/src/copy.ts:15-17`), and the guide does not say so.
  - **Proof:** [V run] (`p6/quality.md` F5; `p6/product.md` #23).
  - **Fix:** ticket T21. Add a guide line about the Thai (lane H).
- **L18 — The booth's corner shows the printer as "unknown" until the first voucher, although the heartbeat checks the printer every minute.**
  - **Where:** `booth.ts:2122-2135`.
  - **Proof:** [V read] (`p6/robustness.md` R15).
  - **Fix:** ticket T19.

### `packages/box-agent/src/agent.ts`

- **L19 — The Pi never reports its CPU temperature.**
  - **Where:** `agent.ts:1995` (`tempC: null`).
  - **Scenario:** the Console reads "not reported" for ever, even for an overheating Pi with no cooler running the animation all day.
  - **Proof:** [V read] (`p6/robustness.md` R15; `p6/product.md` #21).
  - **Fix:** ticket T19.
- **L20 — A test and a comment name a till display that no code reaches, and there are three different "voucher offline" sentences.**
  - **Where:** `packages/box-agent/test/offline-sale-voucher.test.ts:34`; `agent.ts:424-429`. `agent.sales()` has no caller outside tests (`:1884-1900`). The three sentences are at `agent.ts:429`, `apps/api/src/services/vouchers.ts:112` and `apps/pos/src/lib/tillVoucher.ts:48`.
  - **Proof:** [V read] (`p6/quality.md` F11).
  - **Fix:** ticket T23.

### `packages/box-agent/src/runner/*`, `credentials.ts`

- **L21 — Re-claiming the Pi as a new box strands the old box's unsent vouchers without a word.**
  - **Where:** `runtime.ts:334-340`; `store-sql.ts:555-563` only takes rows of the current box.
  - **Scenario:** at the counter, those codes read "not synced yet" for ever.
  - **Proof:** [V read] (`p6/robustness.md` R12).
  - **Fix:** ticket T19.
- **L22 — Adding a second booth station to a running box takes the running booth off the TV until someone picks one.**
  - **Where:** `runtime.ts:301-311`.
  - **Proof:** [V run] (`p6/product.md` #22). The guide says only "asks … once" (`PI_BOOTH.md:52`).
  - **Fix:** ticket T19, plus a guide line (lane H).
- **L23 — `credential.json` is written in place, with no temp-then-rename and no fsync.**
  - **Where:** `credentials.ts:101-106`, against `home.ts:20-21`.
  - **Scenario:** a power cut seconds after a claim spends the claim code.
  - **Proof:** [V read]; the trigger is [I] (`p6/robustness.md` R11).
  - **Fix:** ticket T18.
- **L24 — `oto-box claim <CODE>` puts the claim code in the shell history and in `ps`.**
  - **Where:** `cli.ts:112-137`.
  - **Proof:** [I] (`p6/security.md` S9). The code is single-use and short-lived.
  - **Fix:** ticket T18.
- **L25 — `oto-box status` shows "api (not set)" before a claim, although the config names the api.**
  - **Where:** `cli.ts:185`.
  - **Proof:** [V run] container run (`p6/robustness.md` R9).
  - **Fix:** ticket T18.

### `scripts/pi/install.sh`

- **L26 — SSH password login stays on by default.**
  - **Where:** `install.sh:40` (`SSH_KEYS_ONLY=0`) and `:254-262`.
  - **Proof:** [V read] (`p6/security.md` S9).
  - **Fix:** ticket T18.
- **L27 — The first install prints "previous release kept at /opt/oto-box/current".**
  - **Where:** `install.sh:167-170`.
  - **Proof:** [V run] Debian Bookworm container (`p6/release`; `p6/robustness.md` R8).
  - **Fix:** ticket T18.
- **L28 — A 32-bit OS on a Pi 5 passes the 64-bit check.**
  - **Where:** `install.sh:67` uses `uname -m`, which reports the 64-bit kernel.
  - **Scenario:** the install then dies with the misleading "Node … did not install" (`:135`).
  - **Proof:** [V read]; the kernel and userland mismatch is [I] (`p6/robustness.md` R10).
  - **Fix:** ticket T18.
- **L29 — The installer does not make the journal persistent**, so the 04:30 reboot may erase the day's logs.
  - **Proof:** [I] (`p6/robustness.md` R15).
  - **Fix:** ticket T18. At the bench, check with `journalctl --list-boots`.

### Printer paper width: `packages/shared/src/device-settings.ts`, Console printer form, guide

- **L30 — A 512-dot printer cuts the right 8 mm of every slip, and the Console cannot set the width.**
  - **Where:**
    - the setting exists at `device-settings.ts:45` and is read at `packages/box-agent/src/printing/queue.ts:307-340`;
    - no Console form sets it (`apps/console/src/components/devices/BoxDrawer.tsx:555-580`);
    - the cut: `packages/print/src/templates/booth.ts:39-45` and `packages/print/test/templates.test.ts:323-357`;
    - the guide asks for the width at `PI_BOOTH.md:13` but never links it to the printer override at `:78`.
  - **Proof:** [V read] (`p6/robustness.md` R13; `p6/product.md` #18).
  - **Fix:** this round, the guide says to use the §7 override for a 512-dot printer (lane H). Ticket T20 adds the setting to the Console.

### `apps/booth` (the TV page)

- **L31 — With the booth picker on screen, the red button still spins the booth that was running: a slip prints and no card is shown.**
  - **Where:** `App.tsx:451-468` checks only the phase; the listener is at `:496-508`; the picker screens are at `:672-697`; the picker opens from `StaffSignIn.tsx:436-447`.
  - **Proof:** [V run] `p6/probes/picker-press.mjs` (`p6/robustness.md` R6).
  - **Fix:** ignore presses while the picker is open. A rider in lane F.
- **L32 — The panel says "Enter your PIN, or scan your badge", but badge sign-in is not built.** A badge always fails and counts toward the lockout.
  - **Where:** `copy.ts:176`; `StaffSignIn.tsx:504`; the box holds no badge hashes (`packages/box-agent/src/booth.ts:1114-1116`).
  - **Proof:** [V run] (`p6/product.md` #14).
  - **Fix:** "Enter your PIN" until SCRUM-218. A rider in lane F.
- **L33 — A fast-typed PIN of 6–8 digits is read as a badge.**
  - **Where:** `StaffSignIn.tsx:170` (`length >= 6 && meanGap < 60 ms`). PINs can now be 4–8 digits (`apps/api/src/routes/booth.ts:818`).
  - **Proof:** [V read] (`p6/quality.md` F15).
  - **Fix:** treat an entry as a badge only above 8 digits. A rider in lane F.
- **L34 — The kiosk does not hide the pointer.** With the recommended keyboard-and-touchpad, the pointer sits on the wheel.
  - **Where:** `apps/booth/src/kiosk.css`, which has no `cursor: none`.
  - **Proof:** [V read] (`p6/robustness.md` R15).
  - **Fix:** ticket T19.
- **L35 — The page's built-in fake box behaves differently from the real one.**
  - **Where:** `apps/booth/src/booth/fake.ts`:
    - `:308`: 14 days where the box says "No expiry";
    - `:377`: a badge is accepted;
    - `:407-416`: a fixed 12 h session;
    - `:418-427`: dead code.
  - **Proof:** [V read] (`p6/quality.md` F14).
  - **Fix:** ticket T23.
- **L36 (note, the owner is deciding) — One sign-in per booth.** A shift change without signing out leaves the first person's name on the next person's slips.
  - **Where:** `StaffSignIn.tsx:410-466`; `packages/box-agent/src/booth.ts:1005-1034`.
  - **Proof:** [V run] (`p6/product.md`, "NOTE ONLY").
  - **Fix:** Q13; no fix is proposed.

### `apps/pos` (the tills)

- **L37 — After a `VOUCHER_NOT_HELD` refusal at Pay, the same cart keeps getting the stored refusal.**
  - **Where:** `apps/pos/src/lib/saleWriter.ts:262-266` (same cart, same sale id); `apps/pos/src/api/sales.ts:487`; `apps/api/src/plugins/idempotency.ts` stores 4xx answers.
  - **Scenario:** a hold lapses and is taken, then scanned again with 200. Pay then answers the stored 409 until the cart changes.
  - **Proof:** [V run] `p6/probe/keys.probe.ts` J (`p6/integrity.md` F8).
  - **Fix:** mint a new sale id after that refusal. A rider in lane A.
- **L38 — A ฿0 voucher sale asks staff to choose a payment method, and the customer display says "Please pay ฿0 to our staff".**
  - **Where:** `apps/pos/src/components/till/StepPayment.tsx:137` (Confirm is disabled until a method is chosen).
  - **Proof:** [V run] (`p6/product.md` #13).
  - **Fix:** skip the method at ฿0 and name the prize on the display. A rider in lane A, needed for C2 too.
- **L39 — The till's scan poll has no timeout, and a gap of more than 10 s drops scans without trace.**
  - **Where:** `apps/pos/src/lib/scanChannel.ts:232, 254`.
  - **Proof:** [V read] (`p6/robustness.md` R14). A typed code is not affected.
  - **Fix:** ticket T24.
- **L40 — The USB-scanner reader re-implements the box's, and its "same numbers" claim is false.**
  - **Where:** `apps/pos/src/lib/scannerBurst.ts:14-15, 59` (64 characters, no 500 ms close) against `packages/box-agent/src/scan-input.ts:141-143` (128 characters).
  - **Proof:** [V read] (`p6/quality.md` F6).
  - **Fix:** ticket T21.
- **L41 — Contracts are restated, and nothing ties the copies together.**
  - **Where:**
    - the till: `apps/pos/src/api/vouchers.ts:26-60` and `tillVoucher.ts:55-62`;
    - the Console: `apps/console/src/components/booth/voucherTypes.ts:28-125, 171`;
    - the slip preview: `VoucherTypeEditor.tsx:615-647` against `packages/print/src/templates/booth.ts:111-142`;
    - the two tills' voucher wiring: `apps/pos/src/pages/Till.tsx:1024-1124` against `apps/pos/src/pages/OrderStation.tsx:689-764`, despite `tillVoucher.ts:42-44`.
  - **Proof:** [V read] (`p6/quality.md` F16).
  - **Fix:** ticket T21.
- **L42 (downgraded) — The new till and TV code has no automated test in CI.**
  - **Where:**
    - `apps/pos/package.json:6-11` has no test script;
    - `apps/pos/e2e` never runs in CI, and is red at HEAD: `apps/pos/e2e/smoke.spec.ts:67` now matches two password fields since `apps/pos/src/components/auth/LockScreen.tsx:258-270`;
    - the real booth page is never loaded in a test (`packages/box-agent/test/runner.test.ts:359-360` serves a stub).
  - **Proof:** [V run] `p6/skeptic-pos-no-test-runner.md`.
  - **Fix:** fold into SCRUM-369 and SCRUM-383 (ticket T8).

### `apps/console`

- **L43 — The prize editor says switching a prize off makes "every other prize's chance rise to fill the gap".** In fact publish refuses until the switched-on prizes add up to exactly 100%.
  - **Where:** `apps/console/src/components/booth/PrizeEditor.tsx:223`; `apps/api/src/services/booth-admin.ts:356-361`.
  - **Proof:** [V read] (`p6/product.md` #15).
  - **Fix:** "re-balance the others to 100% before publishing". A rider in lane G.
- **L44 — The Console ships as one 583 kB chunk, above Vite's own warning.** `9673e39` added 39 kB of it.
  - **Where:** `apps/console/vite.config.ts:24-27`.
  - **Proof:** [V run] (`p6/quality.md` F8).
  - **Fix:** ticket T22.
- **L45 — The Console's browser tests run against the dev server, never the built bundle, and the comment still says "four cases" where there are nine.**
  - **Where:** `apps/console/playwright.config.ts:64, 116`.
  - **Proof:** [V read] (`p6/quality.md` F9).
  - **Fix:** ticket T22.

### `docs/ops/PI_BOOTH.md`, `docs/ops/BOOTH_SETUP.md`, `docs/progress/plans/booth/PLAN.md`

- **L46 — §4 says "Name it, role Booth", but "Add the box" stays greyed out until a Slot is typed.**
  - **Where:** `PI_BOOTH.md:42`; `apps/console/src/pages/Devices.tsx:674`.
  - **Proof:** [V read] (`p6/product.md` #16). It is also in the twelve corrections.
  - **Fix:** lane H.
- **L47 — A new booth starts with no layout and no prizes, and neither guide says so.**
  - **Where:** `PI_BOOTH.md:54`; `apps/api/src/services/booth-admin.ts:106-120, 317-321`.
  - **Scenario:** the first publish is refused: "This booth has no wheel design".
  - **Proof:** [V run] (`p6/product.md` #17). It is also in the twelve corrections.
  - **Fix:** lane H.
- **L48 — "This box is no longer allowed here" is explained as the credential being "revoked or replaced in the Console, or taken out of service".** No Console control does any of that for a claimed box.
  - **Where:** `PI_BOOTH.md:62`; `apps/console/src/components/devices/BoxDrawer.tsx:136-138`.
  - **Proof:** [V read] (`p6/product.md` #20).
  - **Fix:** lane H.
- **L49 (downgraded, the part not in M5) — No counter guide.** The THB, 1+1 and one-product rules are explained in the Console and on the till card, so this is a detour, not a wrong outcome (`p6/skeptic-counter-guide-menu-item.md`).
  - **Fix:** the counter guide in lane H (M5).
- **L50 — Operations notes for the bench.**
  - **Where:** `PLAN.md:68`; `PI_BOOTH.md:69`.
  - **The notes:**
    - "Pull the Pi's internet" should mean cutting the router's uplink; unplugging the Pi's own cable also takes away the network printer;
    - a reboot with the TV switched off is untested [I];
    - a slip owed after a paper-out prints up to about 20 minutes later, or after the next boot, into what may be an empty tray.
  - **Proof:** [V read] for the cable and the late slip; [I] for the reboot (`p6/robustness.md` R15).
  - **Fix:** lane H.

### Lint, build, CI and tests

- **L51 — `apps/pos` is still not linted, the react-hooks rule runs nowhere, and the rule against personal data in logs skips `.tsx` files.**
  - **Where:** `eslint.config.mjs:11-12, 68`.
  - **Proof:** [V run]: 101 errors, 41 disable comments for a rule that is not loaded, and none on the booth commits' own lines (`p6/quality.md` F7).
  - **Fix:** ticket T22.
- **L52 — CI never builds the Pi release bundle, and never checks `scripts/pi`.**
  - **Where:** `packages/box-agent/package.json:21-24`; `.github/workflows/ci.yml`.
  - **Proof:** [V run] (`p6/quality.md` F10).
  - **Fix:** ticket T22.
- **L53 — Some tests depend on timing, or wait a fixed time before checking that something did not happen.**
  - **Where:** `packages/box-agent/test/runner.test.ts:736, 519, 860, 897, 902`; `packages/box-agent/test/transport.test.ts:86`; `packages/shared/test/booth-code.test.ts:185`.
  - **Proof:** [V read]; the flakiness is [I] (`p6/quality.md` F13).
  - **Fix:** ticket T23.

---

## 5. Fix plan

### 5.1 One fix round now: what goes in

The round takes everything critical and high, every medium that is cheap, the twelve guide corrections P5 already listed (`docs/progress/SESSION_HANDOVER.md:178-194`), and the low "riders" whose files a lane already owns. For the expensive mediums, the round carries only their guide or wording part; the code becomes a ticket.

| Finding | What the round does | Lanes |
|---|---|---|
| C1 | The refusal card offers "Void that unpaid sale and use the voucher here" as a deliberate choice. History gains a Void for unpaid sales that took no money. Optional guard for History: only sales rung up more than 15 minutes ago, so a live cash payment on another screen is never voided | A |
| C2 | A hand-over slip on its own prices, commits and closes at ฿0. Pay and Charge run for it. The card says "Ring up to use it, then hand over" | B, A |
| H1 | A silent printer costs about 1 s on each side, not 4. A same-key retry joins the press in flight. The page knows `duplicate_press` | E, D, F |
| H2 | A booth needs a two-character prefix in the api and the Console. Publish is blocked without one. The box refuses by name, not with a 500. The TV's hint names the prefix | C, G, D, F |
| M1 | The Screens panel is hidden, and the text reworded, for a booth on its own box | G |
| M2 | The preview draws only switched-on prizes. The false sentences go, and so does `PI_BOOTH.md:95` | G, H |
| M3 | The TV picks the unpublished line by online or offline. The bench order and PI_BOOTH §5 are corrected | F, H |
| M4 | The guide says the release comes from us. The engineer packs it at the merged commit and sends it with its SHA-256 | H, engineer |
| M5 | Menu items are redeemed at the F&B till; the new counter guide; bench step 6 corrected | H |
| M6 | Expiry at the end of the printed date in the branch's time zone, unless Q1 says otherwise. The Console hint and the guide follow | D, G, H |
| M7 | Wording only (guide, Console hint, api comments). The code is T5 | H, G, B |
| M8 | A guide warning. The code is T6 | H |
| M9 | Booth staff and PIN routes check the person's branch and role, and withdrawing needs the person on the booth | C |
| M10 | The box refuses a PIN that matches two people. The Console hint. No refusal when a PIN is set (it would be an oracle) | D, G |
| M11 | Sign-ins run one at a time per station, and the lock is taken from the count the store returns | D |
| M12 | `moveTo` voids only a sale this screen rang up | A |
| M14 | The Google stylesheet is removed, or loaded from script after the page mounts | F, H |
| M15 | A write deadline scaled to the job's size. The heartbeat's printer check skips a busy printer | E |
| M16 | A recovery step in PI_BOOTH §7. The code is T3 | H |
| M17 | The RTC battery goes on the kit list. The code is T2 | H |
| P5's twelve corrections | Slot, Layout, "Who may use it", "network" against "LAN", the override against the Console printer row, the offline count, the Screens panel, the "kids pizza" name and the "'HKT Central' has no record" banner, look-alike duplicates in the pickers, "Receipt Printer 2", the preview sentence, trading day against calendar day | H (G for the Console text) |
| Riders (low) | L3, the L10 comment, L14, L16 (guide), L17 (Thai note), L22 (guide line), L30 (guide), L31, L32, L33, L37, L38, L43, L46, L47, L48, L50 | as owned below |

**Tickets, not this round:**
- the code for M7, M8, M16, M17 and M18;
- M13;
- what remains of C1 (T7);
- every low that is not a rider.

### 5.2 Lanes and file ownership (disjoint)

Each lane owns only the files listed, and no two lanes share a file. A lane that finds it needs a file outside its list stops and asks rather than editing.

These files belong to **no lane** in this round:
- `packages/shared/**`
- `packages/print/**`
- `packages/box-agent/src/agent.ts`
- `packages/box-agent/src/store-sql.ts`
- `packages/box-agent/src/store-sqlite.ts`
- `packages/box-agent/src/runner/**`
- `scripts/pi/**`
- `apps/api/src/services/sync*.ts`
- every migration

**Lane A: the tills** (C1, C2 till half, M12, riders L37 and L38)
- Files:
  - `apps/pos/src/lib/tillVoucher.ts`
  - `apps/pos/src/lib/saleWriter.ts`
  - `apps/pos/src/api/sales.ts`
  - `apps/pos/src/api/vouchers.ts`
  - `apps/pos/src/components/till/RedeemVoucher.tsx`
  - `apps/pos/src/components/till/StepPayment.tsx`
  - `apps/pos/src/components/till/CustomerDisplay.tsx`
  - `apps/pos/src/components/till/OrderSummary.tsx`
  - `apps/pos/src/pages/Till.tsx`
  - `apps/pos/src/pages/OrderStation.tsx`
  - `apps/pos/src/components/fnb/FnbCart.tsx`
  - `apps/pos/src/components/fnb/FnbConfirmation.tsx`
  - `apps/pos/src/components/history/SaleDetail.tsx`
  - `apps/pos/src/components/history/ledgerNotice.ts`
  - `apps/pos/e2e/**`: a voucher spec, and the locator at `smoke.spec.ts:67`
- Proof: `apps/pos` has no unit-test runner (SCRUM-383), so prove it in a browser on a local stack:
  - leave the payment screen four ways, then use the void offer;
  - the two-tab reproduction of M12, where A's sale must survive;
  - a hand-over slip on its own at both tills;
  - a ฿0 sale with no payment method.

**Lane B: api vouchers and sales** (C2 api half, L3, M7 comments, L10 comment)
- Files:
  - `apps/api/src/services/vouchers.ts`
  - `apps/api/src/services/sale.ts`
  - `apps/api/src/services/voucher-definitions.ts` (comments only)
  - `packages/db/src/schema/promo.ts` (comments only; no schema change, no migration)
  - `apps/api/test/vouchers.test.ts`
  - `apps/api/test/sales.test.ts`
- Tests:
  - a hand-over slip on its own closes at ฿0 and is used once, and the next lookup answers 409 "Already redeemed";
  - a hand-over voucher beside a ticket is unchanged;
  - a free item on its own is unchanged.

**Lane C: api booth set-up and stations** (H2 api half, M9, L14 api text)
- Files:
  - `apps/api/src/services/booth-admin.ts`
  - `apps/api/src/routes/booth.ts`
  - `apps/api/src/services/fleet.ts`
  - `apps/api/src/routes/fleet.ts`
  - `apps/api/test/booth-admin.test.ts`
  - `apps/api/test/booth-setup-publish.test.ts`
  - `apps/api/test/fleet-api.test.ts`
- Tests:
  - a booth is refused with null, `PI1`, `b` or `B-1` as its prefix, on create and on update;
  - a till with prefix `T10` switched to kind booth is refused;
  - the publish blocker;
  - adding someone from another park answers `STAFF_NOT_AT_BRANCH`;
  - setting or withdrawing the PIN of someone at another park or above the caller answers 403;
  - withdrawing the PIN of someone not on the booth is refused.
- Before deploying: read staging's booth stations' prefixes. Every live booth must already have two characters, or the new blocker will stop its next publish.

**Lane D: the box's booth** (H1 box half, H2 named refusal, M6, M10 box half, M11, L14 comment)
- Files:
  - `packages/box-agent/src/booth.ts`
  - `packages/box-agent/src/booth-http.ts`
  - `packages/box-agent/test/booth.test.ts`
  - `packages/box-agent/test/booth-staff-session.test.ts`
- Tests:
  - a same-key retry during a slow print gets the same answer;
  - a bad prefix answers `booth_not_ready` before anything is written;
  - expiry falls at the end of the printed date in the branch's zone (update `booth.test.ts:481-485`);
  - overlapping wrong PINs lock after the allowance;
  - a right PIN inside a burst after the lock is refused;
  - an ambiguous PIN signs nobody in and is not counted.

**Lane E: the box's printing** (H1 printer half, M15)
- Files:
  - `packages/box-agent/src/printing/adapter.ts`
  - `packages/box-agent/src/printing/channel.ts`
  - `packages/box-agent/src/printing/queue.ts`
  - `packages/box-agent/test/print-queue.test.ts`, plus a new channel test file if needed
- Tests, with the real channel timings and a fake TCP printer:
  - a status-silent printer's job takes about 2 s, not 8;
  - a printer that stops reading fails the job as partial within the deadline;
  - `probeAll` returns while a job is stuck.

**Lane F: the booth page** (H1 `duplicate_press`, H2 hint, M3, M14, riders L31–L33)
- Files:
  - `apps/booth/index.html`
  - `apps/booth/src/App.tsx`
  - `apps/booth/src/copy.ts`
  - `apps/booth/src/booth/contract.ts`
  - `apps/booth/src/components/StaffSignIn.tsx`
  - `apps/booth/test/**`
- Tests:
  - node tests for the notice mapping: `duplicate_press`, and the unsynced line online and offline;
  - the picker gate;
  - one browser check of the built page against the runner.

**Lane G: the Console** (H2 field, M1, M2, M6 hint, M7 hint, M10 hint, L43; C2 wording after Q2)
- Files:
  - `apps/console/src/components/devices/StationDrawer.tsx`
  - `apps/console/src/components/booth/BoothScreensPanel.tsx`
  - `apps/console/src/components/booth/WheelPreview.tsx`
  - `apps/console/src/components/booth/PrizeEditor.tsx`
  - `apps/console/src/components/booth/VoucherTypeEditor.tsx`
  - `apps/console/src/components/booth/voucherTypes.ts`
  - `apps/console/src/components/booth/BoothStaffPanel.tsx`
  - `apps/console/src/pages/Booths.tsx`
  - `apps/console/e2e/booth-setup.spec.ts`
- Tests, extending `booth-setup.spec.ts`:
  - a booth station refuses an empty prefix;
  - the Screens panel reads right for a booth whose box is not in-process;
  - a switched-off prize draws no wedge.

**Lane H: the guides** (M2–M8 and M14 guide parts, M16, M17 kit list, P5's twelve corrections; riders L16, L17, L22, L30, L46–L48, L50)
- Files:
  - `docs/ops/PI_BOOTH.md`
  - `docs/ops/BOOTH_SETUP.md`
  - `docs/ops/COUNTER_VOUCHERS.md` (new)
  - `docs/progress/plans/booth/PLAN.md` (the bench steps only)
- The gate checks every sentence against the code as merged in this round.

### 5.3 Contracts between lanes

1. **C2.** B makes a cart holding only a hand-over voucher price, commit and close at ฿0. A enables Pay and Charge when `voucher.held.view.effect.type === 'hand_over'`. The voucher view's shape does not change.
2. **H1.** D answers `duplicate_press` (409) only when it has no record of the press in flight, for example after a restart. F shows that as "your voucher is on its way — ask our staff if it does not print", never as "Booth not ready". E's change is invisible to D and F.
3. **H2.** C refuses an invalid booth prefix with a 400 whose message names the rule, and G shows the api's message. D refuses with the existing `booth_not_ready` and a message naming the prefix. F needs no new code.
4. **M6.** D changes the moment a voucher expires. G and H change only words. Nothing else reads the rule, because the api compares against whatever moment the box sent.
5. **M10.** D refuses an ambiguous PIN like a wrong one, without counting it. G adds the hint. The api does not change.
6. **C1 and M12.** A uses the api as it is: `details.saleId`, `GET /sales?status=tendering&stationId=…` and `POST /sales/:id/void`.

### 5.4 After the round

1. One gate that tries to refute the round, then CI.
2. A staging proof, on the P5 set-up (the proof box and a fake printer):
   - **C1:** Pay, then the padlock, then type the slip again. Expect the void offer, then the voucher on a new sale, paid, then "Already redeemed".
   - **C2:** create a Hand-over type, redeem its slip on its own and see it close at ฿0, see a second scan refused, then archive the type.
   - **H1:** with a status-silent fake printer, the wheel turns within 6 s and the slip prints.
   - **H2:** Devices → New station, kind Booth, with no prefix, is refused.
3. Pack the release at the merged commit, send it with its SHA-256, and record the Jira status and comments as the protocol requires.
4. Then "ready" to the owner.

### 5.5 Staging housekeeping before the bench (no code)

- Archive P5's "Proof box", its printer row and "Booth 2 (proof)" (`docs/progress/SESSION_HANDOVER.md`, P5 notes).
- The owner resets som's booth PIN, which P5 minted. It must not be the local-development value in the seed file (`packages/db/src/seed/index.ts:1551, 1580`; the value is not repeated here).
- Once the History void has landed, void any unpaid sale on staging that still holds a voucher. None is known [U].
- Clear the Health warning left by P5's six wrong codes.

### 5.6 Tickets

| # | Title | One line | Priority |
|---|---|---|---|
| T1 | Price promo codes from the park's discount definitions (M13) | Use `pos.discount_definition`'s value, window, branch, stacking and usage count; refuse unknown codes; replay paid offline sales as recorded and flag them; correct the stale comments | High |
| T2 | The Pi measures its own clock (M17) | Adopt the heartbeat answer's offset, send `serverTime` with the skew refusal, stamp events with the measured offset, flag spins made under a large skew, name the clock in Health | High |
| T3 | Recover a damaged box store safely (M16) | Listen before opening the store and show "needs service"; rescue the unsent outbox; take a new epoch or identity before any new fact; report page damage on `/kiosk/health` | Medium |
| T4 | Prune the box outbox and index its two scans (M18) | Partial indexes that match `depth()` and `takeBatch` exactly; prune acknowledged rows after N days and press counters after 2 trading days; vacuum incrementally | Medium |
| T5 | Free-product vouchers at every park (M7) | Once Q7 is answered: fall back to kind and name at the redeeming park, or link one product per park, or make codes unique per branch | Medium |
| T6 | A retried unsynced slip counts as one miss (M8) | Store a hash of the code beside each miss time (small migration) and count distinct codes in the window | Medium |
| T7 | The till keeps its sale through a lock or reload (C1, what remains) | A lock screen over the till, not in place of it; a warning before leaving the payment screen; find and resume or void this station's unpaid sale after a reload | Medium |
| T8 | Tests for the till and the booth page in CI (L42) | Widen SCRUM-369 and SCRUM-383: a POS unit runner, the POS e2e in CI with `smoke.spec.ts:67` fixed, a voucher case, a smoke test of the booth page against the runner | Medium |
| T9 | Confirm before changing what a voucher type is worth (L10) | Show the number of unredeemed vouchers and ask for confirmation on a value or kind change; point to "New voucher type" | Low |
| T10 | Reprint hardening (L13) | Once Q9 is answered: ask for the PIN again, or allow reprints only within N minutes of the win | Low |
| T11 | Make the ledger's append-only rule complete (L11) | A statement-level `BEFORE TRUNCATE` trigger; run the api as a role that does not own the table | Low |
| T12 | A booth-only box receives booth data only (L9) | Base the cache scopes on the box's role: booth, deny-list and the booth staff's own PIN hashes | Low |
| T13 | Check print facts against the booth (L8) | The voucher must be this booth's, and the requester on its staff list | Low |
| T14 | Codes the box minted, and prefixes unique per operator (L15) | The box keeps its own codes and draws again on a repeat; booth prefixes become unique per operator | Low |
| T15 | Count a payment still in flight (L7) | Refuse a new tender while one is in flight; alert when money settles on a closed sale. Needed before split tenders or the terminal | Low |
| T16 | Release a part-paid sale's voucher (L5) | With refunds (SCRUM-208): a manager release that records the money owed back | Low |
| T17 | Pricing edges (L1, L6) | Aim the 1+1 at the line with the most kid value left; a void of a sale that took no money gives the document check back | Low |
| T18 | Polish the Pi installer and CLI (L23–L29) | Atomic credential write; claim code read from a prompt, not the command line; keys-only SSH once a key exists; the 64-bit userland check; `status` falls back to the configured api; the first-install message; a persistent journal | Low |
| T19 | Pi operations (L16, L18, L19, L21, L22, L34) | CPU temperature; hidden pointer; printer health from the heartbeat; a count of vouchers, not records; report stranded facts on re-claim; keep the running booth when a second is added; bounded retries for late slips | Low |
| T20 | Paper width in the Console (L30) | A 576/512 choice on the receipt printer, saved to `settings.escpos.dotsPerLine` | Low |
| T21 | One shared rule each for code shapes, dates, the scanner burst and voucher contracts (L4, L17, L40, L41) | Shared helpers and zod schemas used by the api, box, till, TV and Console; one date formatter that takes the branch zone | Low |
| T22 | Lint, build and CI (L44, L45, L51, L52; M4's CI part) | CI packs the Pi release and checks `scripts/pi`; lint `apps/pos` with react-hooks; split the Console bundle; run the Console e2e against the built bundle | Medium (the pack step), Low (the rest) |
| T23 | Test hygiene (L12, L20, L35, L53) | Remove the timing races; honest test names; undo SQL for migrations 0021 and 0022; make the booth fake behave like the box | Low |
| T24 | The till's scan poll (L39) | A timeout on each poll; decide "away" from visibility, not from a failed poll | Low |
| T25 | Voucher miss budget per person as well as per till, and misses recorded (section 3.1) | The spec's per-staff budget and not-found records | Low |
| T26 | Legacy four-digit codes (section 3.1) | When the Radar dump arrives: the campaign/date window or manager confirmation the spec requires (SCRUM-207, legacy part) | With the import |
| T27 | Optional: a booth fact's voucher type must be on that booth's published wheel (section 3.1) | Quarantine a fact whose type never appeared in a published version of that booth | Low |
| T28 | Several staff at one booth (L36) | The owner is deciding; nothing to raise yet | — |
| T29 | Booth PINs issued by the platform (M10) | A random PIN nobody else on the person's booths holds, shown once, and a "shared PIN" message at the booth | Low |

---

## 6. Questions only the owner can answer

Q1 to Q6 shape this fix round. Q7 to Q13 shape the tickets.

**Q1. When does a voucher expire?** (M6)
- A — at the end of the date printed on the slip. **Recommended.** It matches what the slip, the TV and the till show, and how the platform treats a document's expiry date.
- B — at the minute of the win. The slip, the TV and the till would then have to show the time.

**Q2. Where is a "Hand-over prize" given out and recorded?** (C2)
- A — at reception, recorded as a ฿0 sale. **Recommended**, and it is what the fix builds.
- B — at the booth. That needs a redeem step at the booth, which is not built.

The words on the slip and in the Console follow your answer.

**Q3. Who may void an unpaid sale that took no money?** (C1)
- A — any cashier with the till's void permission, giving a reason. This is how the permission stands today.
- B — managers only.

**Q4. Your receipt printer.** (H1, L30)
- Which model is it?
- Does it answer status queries over the network? We can test this before the bench.
- Is it 576 or 512 dots per line?

**Q5. How do you want the release file?** (M4)
- A — we send it to you with its checksum. **Recommended.**
- B — a download page. That needs hosting, because the repository is private.

**Q6. What does Kids Pizza give?** (M5)
- A — the pizza only. This is how it is built.
- B — the pizza and a juice of the guest's choice. That needs a "Kids Pizza set" product in the F&B menu.

**Q7. How is a free product honoured at the other park?** (M7)
- A — only at the park that sells it. This is how it is built; the guides will be corrected.
- B — by the same product name at the redeeming park.
- C — one product linked for each park.

**Q8. What does "cannot be combined with other offers" cover?** (L2)
- May a staff manual discount sit beside a voucher? Today it can.
- Are member tier prices allowed beside a voucher? Decision 7 left this to confirm.

**Q9. Will a keyboard or number pad stay at the booth?** (L13)
If yes, choose one:
- A — reprint asks for the PIN again;
- B — reprint is allowed only within N minutes of the win;
- C — as now, with the keyboard kept with staff.

A number pad without a Tab key cannot reach Reprint at all.

**Q10. At the mall** (M17)
- Is the Pi's RTC battery fitted?
- Does the network allow time sync (NTP, UDP port 123)?

**Q11. Should a change to what a voucher type is worth apply to slips already printed?** (L10)
- A — yes, at once. This is how it is built, and it is documented.
- B — no; a printed slip keeps the value it was printed with. This works for amount and percentage types only: a free product or 1+1 printed before its link was set must still pick up the link later (section 3.3).

**Q12. Retried offline slips at the counter** (M8)
- Should a code tried again count only once a minute? **Recommended.**
- Is the 10-minute lock after five *different* wrong codes still right?

**Q13. Several staff at one booth.** (L36) This is already with you; nothing has been started.
