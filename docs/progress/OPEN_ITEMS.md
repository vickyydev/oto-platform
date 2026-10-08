# Open items register — defects, decisions, concerns and recommendations

*Written 9 October 2026 from a ground-truth sweep of every open sprint
ticket (each judged against the code, not the docs), the four plans'
question lists, and the review notes of every landed round. This is the
single place to read what is genuinely open, what the owner still has to
decide, and where the known soft spots are. Statuses and priorities on the
board were corrected from the same sweep on the same day (eight tickets
closed with evidence cards, fifteen priorities changed with reasons,
four new tickets SCRUM-512..515 spun off).*

## 1. The priority order (the owner's ruling, 9 October)

1. **Finish S2-17b** (SCRUM-191): rounds 1–4b are landed (4b awaiting its
   staging deploy); rounds 5–8 remain (attendance/operations, documents,
   finance + module walkthroughs, the restore rehearsal).
2. **Then the fix block**: every verified-open defect and small task below
   is worked BEFORE any new story starts. Section 2 is the worked order.
3. Only then the next story (S2-18 Radar, S2-19 Inbox, S2-22 data,
   S2-23 Console, S2-16 acceptance — and S2-24 bench when hardware time
   is scheduled; it sits paused at the bench freeze with its brief in
   AGENTS.md and docs/handover/CODEX_HANDOVER.md).

## 2. The fix block — verified-open items in suggested working order

Order within the block: money and safety first, then daily-work friction,
then hygiene. Pairings marked **together** share plumbing and should be one
lane. Everything here was verified open on 9 October with file-level
evidence (the sweep's full evidence lives in the tickets' comments).

### First: money, safety, security

| # | Ticket | Prio | The truth in one line |
|---|---|---|---|
| 1 | SCRUM-276 | High | Wages defect in the OTO App: the repayment recorder is never called, so an active salary advance is deducted again on every payroll run. Confirm on real data whether any active advance has a calculated run; then fix; the three-format tidy follows. |
| 2 | SCRUM-273 | High | Archived members: medical notes still readable, child edits still possible, and an archived phone number is blocked for ever (unconditional unique index). Two of four gaps already closed; the index migrations get harder with every row. |
| 3 | SCRUM-288 | High | Platform deactivation leaves the OTO App login active. Small transactional fix; safe today only because the flag is off on Render. |
| 4 | SCRUM-512 | High | New from the sweep: no screen can end a lost device's staff shift token, though the api routes exist. Small Console screen. |
| 5 | SCRUM-373 + SCRUM-375 | High | **Together.** Station promo codes are invisible to the till's own panel, so code-discounted orders misstate VAT and sales in till reports; 375 is the twin-hook merge in the same plumbing. |
| 6 | SCRUM-508 | High | The owner's Today screen reads zero parties while the party tab trades (count hard-coded zero in the rollup). Needs the analytics plan Q3 answer first — ask with the fix. |
| 7 | SCRUM-467 | High | The booth loses the red button after a while. Both candidate fixes are cheap (pin installer versions; reclaim visibility/focus) and can be built now. The booth is the owner's first priority. |
| 8 | SCRUM-390 | Medium | A late terminal progress report can overwrite references on a paid sale. |
| 9 | SCRUM-416 | Medium | A declined remainder after wallet credit was spent leaves a part-paid sale holding its voucher — the till CAN reach this, unlike the audit's assumption. |
| 10 | SCRUM-385 + SCRUM-386 + SCRUM-389 | Low | **Together.** The throttle corner: booth-credential attempts unthrottled on their own, the throttle table never swept, the box payment-result route without a per-address ceiling. One hardening lane. |

### Second: daily-work friction

| # | Ticket | Prio | The truth in one line |
|---|---|---|---|
| 11 | SCRUM-272 + SCRUM-293 | Medium | **Together, early.** Generate client types from the api description, then the seam walker over them. The hand-typed surface has doubled (~300 shapes); this class of break has bitten five times. Do before more screens are written. |
| 12 | SCRUM-371 | Medium | Phone till loses the sale when the inactivity lock fires during hand-to-customer. Needs the owner's keep-across-lock ruling (see section 3). |
| 13 | SCRUM-381 | Low | Station Setup test print records no print job, so the box's outcome is invisible in the Printing panel. |
| 14 | SCRUM-372 + the 352 scraps | Low | **Together.** Show the refusal where the button is (phone Pay button; the phone-F&B half noted on 352's Deployed ledger). |
| 15 | SCRUM-378 | Medium | A Console box can be created but never retired (updateBox exists, nothing calls it). |
| 16 | SCRUM-379 | Low | Merch panel reads the in-memory store, so low-stock notices can never show. |
| 17 | SCRUM-483 | Medium→small | Offline flip: re-run the wallet lookup for a held band when the lane moves to the box. Transient wrong message, no wrong money. |
| 18 | SCRUM-447 | Medium | A box re-registered with a new claim code keeps its old journal epoch. Fix before the second Pi goes live; fails closed meanwhile. |
| 19 | SCRUM-487 | Low | An offline sale set aside as old-era can be marked already-recorded even when newer. |
| 20 | SCRUM-404 | Medium | The box outbox is never pruned and its two scans are unindexed — Pi disk and scan cost grow for ever. |
| 21 | SCRUM-507 | Medium | The booking site cannot choose a park. |
| 22 | SCRUM-393 + SCRUM-357 | Low | **Together.** Booking identify seam smalls (the +66 stored-as hint; the family identified only through memberTier). |
| 23 | SCRUM-370 | Low | The quote refusal's "Fix this to charge" line contrast. |
| 24 | SCRUM-380 | Low | The clone warning triangle shade on light theme. |
| 25 | SCRUM-515 | Low | New: hide the demo wristbands grid on production tills. |
| 26 | SCRUM-514 | Low | New: two sales finalising together can overshoot a promo code's limit. |
| 27 | SCRUM-509 | Low | Phone bar overflow (the lock button is what gets cut off). Needs the collapse-order design choice first. |
| 28 | SCRUM-326 | Low | Booth result card overruns a 16:9 stage by 36px. |

### Third: hygiene and platform debt

| # | Ticket | Prio | The truth in one line |
|---|---|---|---|
| 29 | SCRUM-510 | Medium | Name the failing boot step when test setup falls over (four sightings; each costs a CI re-run). First half is small. |
| 30 | SCRUM-286 | Low | One lint-glob change + an e2e tsconfig to finish the till's PII-log rule. |
| 31 | SCRUM-294 | Low | Fractional money: the box/offline door remains; finish with the next sales-schema change. |
| 32 | SCRUM-415 | Low | One defensive alert at the gateway seam + test, then closable. |
| 33 | SCRUM-421 | Low | One shared rule each for code shapes/dates/scanner burst/voucher codes (the api still hard-codes its own). |
| 34 | SCRUM-274 | Medium | The OTO App's naive timestamps (210 columns, 44 with timezone). Needs the which-zone-were-legacy-rows-written-in decision first; one migration per table after. |
| 35 | SCRUM-277 | Medium | The delete-or-build list for uncalled endpoints (the security half became SCRUM-512; the tax-override tier is an owner call). |
| 36 | SCRUM-419 | Low | Pi operations smalls; pull "keep the running booth when a second is added" and "stranded facts on re-claim" forward if a second booth or Pi swap is imminent. |
| 37 | SCRUM-369 | Medium | Verify closed by the 8 Oct CI reshape (pos browser suites now run in CI); close with the run as evidence if so. |
| 38 | SCRUM-339 / SCRUM-340 | Low | Check-in smalls (duplicate family confirmation; drop-off lookup's prototype read) — judged in the late batch; see tickets. |
| 39 | SCRUM-368 | Medium | Free-item promo at the station takes nothing off — judged in the late batch; see ticket. |

### Blocked or waiting (not workable now)

- **SCRUM-426** — waits for the Radar voucher dump (legacy codes refused
  safely meanwhile). **SCRUM-428** — waits on the typed-vs-issued PIN
  ruling. **SCRUM-405** — waits on Q7; a no-code workaround exists.
  **SCRUM-434** — booth money-path question, with the booth decisions.
  **SCRUM-469** — held for the owner's go (lift Q7/SCRUM-469).
  **SCRUM-479-era demo data** — none left; closed.

## 3. Decisions waiting on the owner

**Ticket rulings** (each small to build once answered):

- **SCRUM-481** — refunding prepaid lunch money currently leaves the
  credit spendable: a real double-spend. Recommended rule: claw back the
  prepaid part, refuse the refund if already spent.
- **SCRUM-482** — who may issue credit vouchers, and what the promotions
  report shows.
- **SCRUM-485** — only the per-place-vs-branch-wide stock opening matters
  (costly to reverse later); the build already follows the other answers.
- **SCRUM-371** — may the phone till keep its sale across the inactivity
  lock? (Recommended: yes; it is a daily loss for a family that hesitates.)
- **SCRUM-428** — typed or issued booth PINs.
- **SCRUM-434** — how money reaches a new booth station.
- **SCRUM-277's remainder** — per uncalled endpoint group: build the
  screen or delete the routes (notably the branch tax-override tier).
- **SCRUM-497** — the standing analytics/till details list (register
  entries 44–65).

**Plan question lists** (each question carries its default; the app's or
as-built behaviour wins until answered):

- **The lift** — docs/progress/plans/otoapp-lift/PLAN.md section 11,
  Q1–Q37. The ones that bite soonest: Q22–Q27 (the night-work switch and
  its silent-keys state), Q28–Q31 (settings fallback, census exposures and
  their rounds), Q32–Q37 (Attention's flapping resolve, who sees which
  alerts, Data Admin's reach).
- **Benefits** — its plan's Q1–Q13 (incl. the Cyrillic lookalike fold).
- **Events** — its plan's Q1–Q14 (incl. Q12 cancelled events on the
  booking site).
- **Analytics** — its plan section 9, questions 1–17; Q3 (party-money
  timing) now blocks SCRUM-508.

## 4. Concerns and loopholes (keep these visible)

- **The OTO App is live software with real staff data.** The wages
  double-deduction (SCRUM-276) and naive timestamps (SCRUM-274) are live
  in the app the park already uses; treat app-side money/HR fixes with
  production care even on "staging" (oto_staging has been the live one).
- **Census exposures** (lift Q31, fixed rounds assigned): `leave_policies`
  (round 5), `people` and recalculate-probation (round 6), the
  form-builder translations routes incl. the publish door, and Data
  Admin's full reach (round 7). Until then these reach across park groups.
- **Q27 silent-keys state**: if the app is flipped to platform-run nights
  and the api holds no keys, every night is lost silently; only the
  written hand-over order and Health reading catch it today.
- **The closed-day freeze has no late-sale correction path** (SCRUM-513):
  a sale landing after its day closed sits outside any acknowledged day.
- **The benefits H7 claim leans on an unbuilt alert** (SCRUM-506): raise
  it the day staff cards go live in the park.
- **The app inherits 467 type errors**; a ratchet holds the count at
  every landing, but it is debt, not safety.
- **Attention's known flaps** (lift Q32/Q33): the six-hourly run resolves
  alerts it doesn't raise; open-shift alerts only evaluate on Refresh.
  Both are the app's own behaviour, kept deliberately.
- **Review-noted till behaviours awaiting their pass**: no fetch timeout
  on the POS client (a hung request has no exit) and an unmount drops a
  held order's ids — both noted at E4, shared with SCRUM-371's terrain.
- **The tab band scroll affordance** (on SCRUM-503's ledger): the last
  visible tab clips at the scroll edge with no hint, and the active tab
  isn't brought into view — design's own behaviour, awaiting a choice.

## 5. Recommendations

- **Run the fix block as area lanes**, not ticket-by-ticket: one lane per
  area from section 2 (money/security first), each through the usual
  build → independent review → land → staging evidence gate. Several are
  one-liners that batch well (23, 24, 25, 30).
- **Do 272+293 before any new screens** — every new hand-typed shape
  raises the cost of the generator switch.
- **Ask the section-3 rulings now**, in one owner sitting: most fixes
  behind them are small, and SCRUM-508's fix is blocked on Q3.
- **Confirm SCRUM-276 on real data first** (any active advance with a
  calculated payroll run?) — it decides whether a correction job is
  needed beside the fix.
- **CI next notches if 13 minutes still feels heavy** (SCRUM-511 card):
  a fourth api shard (~3 minutes off) or affected-only pushes with the
  full battery nightly. One-day changes, on the owner's word.
- **SCRUM-510's first half** (name the failing boot step) belongs in the
  first hygiene lane; it pays for itself at the next flake.
- **Check the staging SMS adapter** before building SCRUM-469's picker
  (its sub-point needs one real invite send to settle).

## 6. Method and where the evidence lives

Every judgment above came from reading the code on 9 October 2026 (the
standing rule: never answer "is it built?" from documents). The sweep ran
as seven parallel verification agents over 68 tickets plus a six-ticket
follow-up; each ticket's evidence (file:line, commits, tests) was posted
to the ticket itself the same day. The eight closures carry evidence
cards under docs/qa/jira-comments/attachments/sweep-2026-10-09/. The
running state of the build lives in docs/progress/STATUS.md (newest block
first); the per-story records in docs/progress/SPRINT_2_PROGRESS.md; the
plans and their question lists under docs/progress/plans/.
