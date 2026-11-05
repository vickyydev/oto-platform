# SCRUM-762 / SCRUM-779 / SCRUM-764 — phone once, one sale, the forms on the display: staging proof

Run on 5 November 2026, 20:46-21:07 Bangkok (clean-up 21:07-21:09), on the live commit
`9dc7c2862f879605b3977d76419257cf526148e3` (main CI run 42033109493 green on that SHA, Till
end-to-end included). oto-api-staging, oto-pos-web-staging, oto-pos-staging and oto-console-staging
were live on that commit before and after the run (`live-before.json` read 20:44, `live-after.json`
read 21:09; the api's live deploy finished at 20:37, after its pre-deploy migrate applied 0104).
Nothing was deployed or restarted during the run and no setting was read or changed.

A real Edge browser (Playwright, `channel: msedge`, Edge 156, a simulated camera for the staff
photo and the pickup photo) in the Bangkok time zone: the till at 1600 wide and a SEPARATE customer
display paired to it in its own browser context at 1024 wide; the Console at 1500 wide. ZZ TEST
records only, cash only, no SMS (the board's WhatsApp panel is the till's simulated one). The park's
Pi, Till 1 (Pi), Till 2 (test), FWBooth1 and Reception Till 1 were not used; Reception Till 1's
simulated band and receipt printers on Virtual box 1 were shared with the test till for the run and
its own assignments were not changed.

## Set-up

- One till made for this run on Virtual box 1 at Central Floresta, "ZZ TEST SCRUM-762 till" (Z762),
  with the Virtual box 1 simulated Band Printer (kids), Band Printer (adults) and Receipt Printer 1;
  signed in as the staging reception account, Som (Reception). Archived afterwards, printers
  unassigned first.
- One customer display, "ZZ TEST SCRUM-762 display", paired by its pairing code (revoked afterwards;
  the display page's next pairing code expired by hand).
- One ZZ TEST member made for step 1c and step 4: "ZZ TEST 762 Mum" (+66 89 762 0001) with a saved
  child, ZZ TEST 762 Fon (6), whose saved allergy and dietary notes are marked "ZZ TEST saved note".
- Numbers used: +66 89 762 0002 (walk-in for 1d and the drop-off form), +66 89 779 0001 (779),
  +66 89 764 0001 (the nanny form). None was a member before the run.

## What a person sees

| Plan step | Result | Screenshot |
| --- | --- | --- |
| 1a. The paired display opens on "What's your phone number?" with the safety line; Continue off until a number is typed; no Skip | Pass | `s762-01a-display-phone-required-no-skip.png` |
| 1b. Display unpaired and the customer half hidden: Membership Check has no Skip, says the number is required, and offers "Show customer screen to enter the phone"; pressing it opens the customer half on the phone step | Pass | `s762-01b-till-no-display-offers-customer-screen-no-skip.png`, `s762-01c-till-customer-half-open-phone-first.png` |
| 1b. With the display paired: Membership Check, no Skip | Pass | `s762-01d-till-membership-check-display-paired-no-skip.png` |
| 1c. The member's number typed the Thai way (0897620001) on the display: the till recognises ZZ TEST 762 Mum (+66897620001) and lists her saved child; the display says "Welcome back" | Pass | `s762-02a-till-recognises-member-and-children-from-local-number.png`, `s762-02b-display-welcome-back-member.png` |
| 1d. An unknown ZZ TEST number: the till offers New member or Continue as walk-in; walk-in at Tourist, 1 Hour Play, 1 kid + 1 adult, cash, Z762-000001 ฿1,040 | Pass | `s762-03a-till-unknown-number-offer-walk-in.png`, `s762-03b-paid-cash-walk-in-kids-and-adult.png` |
| 1d. The kids band the simulated band printer drew reads "Tel +66 89 762 0002" (the number is on the sale: a walk-in has no member to take it from, so this also shows migration 0104's column is filled); the adult band has no number. Band codes hidden in the pictures | Pass | `s762-04a-kids-band-printed-tel-number.png`, `s762-04b-adult-band-printed-no-number.png` |
| 1d. History shows the sale (Walk-in, Tourist, paid cash) | Sale shown; **the number is not shown in History** (see Findings) | `s762-04c-history-sale-walk-in-paid.png` |
| 1e. The drop-off form for the same family shows the number from the start read-only, "We will use the number you gave at the start.", no phone field or keypad | Pass | `s764-04a-display-agreements-number-from-start-not-asked.png` |
| 2a-b. Walk-in, Thai by driving licence, 2 Hours Play, Pay; the display shows the kept number and asks only the nickname; the payment screen says "Thai rate saved to ZZ TEST 779 Khun Nok" | Pass | `s779-01-display-details-number-kept-name-asked.png`, `s779-02-payment-screen-thai-rate-saved-to-new-member.png` |
| 2c. Cash: exactly ONE sale for the order, Z762-000002 ฿870, under ZZ TEST 779 Khun Nok (+66897790001), Thai, paid; no second and no unpaid sale | Pass | `s779-03-paid-cash-one-sale.png`, `s779-04a-history-one-sale-under-new-member.png`, `s779-04b-history-sale-thai-rate-member-paid.png` |
| 2d. Till reloaded: no "left unpaid" notice (no tendering sale on the till) | Pass | `s779-05-till-reloaded-nothing-left-unpaid.png` |
| 2e. Console Activity: sale.create, member.create, member.tier_verify, sale.member_attach, sale.finalise for that order; the member_attach row names sale 01a1abff-5843-… and the new member | Pass | `s779-06a-console-activity-sale-member-attach-row.png`, `s779-06b-console-activity-row-opened-sale-and-member.png` |
| 3a. A child with no adult: the display opens the form on the children step, the child not yet named | Pass | `s764-01-display-form-opens-on-children-step.png` |
| 3b. Name and age 6 on the display ("Drop-off supervision needed — ฿225 one-time"); the till's gate mirrors ZZ TEST 764 Mai, 6 yrs, Drop-off required | Pass | `s764-02a-display-child-named-age-drop-off-fee.png`, `s764-02b-till-gate-mirrors-name-age-drop-off.png` |
| 3c. Care step: allergy and dietary note typed on the display reach the till's private copy | Pass | `s764-03-display-care-step-family-types-notes.png`, `s764-06b-till-staff-copy-family-typed-allergy-and-diet.png` |
| 3d. Agreements: guardian name, the number kept from the start, consent and the three confirmations ticked by the family | Pass | `s764-04a-…`, `s764-04b-display-agreements-ticked-by-family.png` |
| 3e. The till's card lists each agreement as ticked; on staff's private copy every tick is disabled "(ticked by the family)" and a press changes nothing | Pass | `s764-05-till-card-agreements-ticked-by-family.png`, `s764-06-till-staff-copy-family-notes-ticks-read-only.png` |
| 3f. Staff changed the dietary note on the till ("… (typed by staff)"); it shows on the display's care step | Pass | `s764-07-display-shows-detail-typed-by-staff.png` |
| 3g. "Ask the team": the form stays on the display ("The team is coming to help you."); the till says "The family asked for help: fill the form here with them. The agreement ticks stay theirs, on the display." | Pass | `s764-08a-display-asked-the-team-form-stays.png`, `s764-08b-till-header-family-asked-for-help.png` |
| 3h. Done on the display, Continue on the till: registration made from the family's form (ZZ TEST 764 Mai, 6, born 5 Jan 2020, allergy, dietary note, guardian ZZ TEST 764 Khun Ying, number +66897620002, consent and 3 confirmations, staff photo); paid cash Z762-000003 ฿915, left as booked; the board shows the child with the allergy | Pass | `s764-09a-display-form-done.png`, `s764-09b-till-registered-payment-screen.png`, `s764-09c-board-child-registered-from-family-form.png` |
| 3i. A child of 3: the display shows "A nanny will look after them — Required for this age — ฿330/hour"; the form carried to its agreements with the kept number; the till's gate marks "Nanny required" with the family's ticks | Pass up to the gate; **the step into the nanny assignment was not pressed** (see Not shown) | `s764-10a-display-nanny-requirement-and-hourly-rate-en.png`, `s764-10d-…`, `s764-10e-till-gate-nanny-required-family-ticks.png` |
| 3j. Display language Thai, then Russian: the form, the requirement and the rate change language | Pass (the park's three confirmation lines are configured text and stay English) | `s764-10b-display-nanny-form-in-thai.png`, `s764-10c-display-nanny-form-in-russian.png`, `s764-10d-display-nanny-agreements-in-russian-number-kept.png` |
| 4. A saved-profile child: the display's care step says "Saved on your profile — tell the team if anything has changed." and none of the saved notes; no allergy or dietary field | Pass | `s764-09-display-saved-child-care-step-no-notes.png` |

## Not shown on staging

- The nanny child's step into the nanny assignment (plan 3i, second half). No nanny is on shift on
  staging tonight (Aor, Bow, Jum and Pim all off shift), so that order could not be finished, and the
  gate's Continue writes a registration and a member that the till cannot take back. The order was
  backed out at the gate instead: no registration, member or sale was written for it (read back).
- The counter box lane (`staffTicksAgreements`: staff tick the agreements when the paired display
  cannot take the form, and the band number when the box runs the till). The counter box and the
  booth need the next box release; pinned in the lane's pos and box-agent tests.

## Findings

- History shows the walk-in sale as "Walk-in" with no number, and History's Find by phone finds only
  members' sales. The number is kept on the sale for the kids band only. The lane's plan said
  History would show it; the ticket does not ask for it.
- A number typed with the Thai leading 0 is shown as typed, "+660897620002", on the till's
  "New member?" offer and on the customer screen's details and form steps. The sale, the member,
  the registration and the band hold and print the normalised +66 number ("Stored as" on staff's
  copy reads +66897620002).
- Unrelated to these tickets: the Console Activity on staging fills with
  `app_identity.lifecycle_deactivation.failed` rows from the system (after: `{"error":"NOT_FOUND"}`)
  several times a minute.

## Clean-up (21:07-21:09, read back)

- ZZ TEST 764 Mai checked in from the board (no payment, one POST /checkin/check-in-booked) and
  checked out with a pickup photo to ZZ TEST 764 Khun Ying; no registration of this run is waiting.
- The three paid cash sales stay on record as paid (Z762-000001, -000002, -000003), as in earlier
  proofs. No unpaid sale was left.
- Members archived: ZZ TEST 762 Mum, ZZ TEST 779 Khun Nok, and ZZ TEST 764 Khun Ying (made by the
  drop-off gate from the parent's number); all four numbers look up to nobody afterwards.
- The display credential revoked (the till lists no display) and the display page's new pairing
  code expired; both sessions signed out (GET /me 401); the till's printers unassigned and the till
  archived; Reception Till 1 keeps its seven devices; Till 1 (Pi), Till 2 (test) and FWBooth1
  unchanged.
- `receipt.json` holds every step's read-back, the fixture, the created records and the clean-up.

## Jira

SCRUM-762 (comment 13513, 8 images), SCRUM-779 (comment 13514, 6 images) and SCRUM-764 (comment
13515, 11 images) each show the proof inside the comment (`jira-comment-*.txt`,
`jira-publication.json`); all three were walked to Deployed (commit links 4, 2 and 3 added) and
read back Deployed, never Done. The harness that drove the run is in `harness/` (setting names only,
never a value).
