# Local rehearsal — phone once, one sale, the forms on the display

SCRUM-762, SCRUM-779 and SCRUM-764, rehearsed together on 5 November 2026 in
Microsoft Edge 156 (headless) against a local API on the embedded test database
(dropped after), a ZZ TEST virtual box run by the in-process edge agent, one ZZ
TEST till and a separate customer display paired to it in its own browser
context. Everything between the till and the display goes through the display
session. Staging was not touched and no SMS was sent. Source: `7b5280b2d`
(`receipt.json` holds the run).

Run from `apps/api`:
`pnpm exec tsx ../../docs/qa/proof-2026-11-05/s762-764/local/s762-764-local-rehearsal.mts`

## SCRUM-762 — the phone number once, at the start, required

| Screen | What it shows |
|---|---|
| `s762-00-harness-phone-first-no-skip.png` | The till's built-in split view: the customer half asks for the number, no Skip anywhere |
| `s762-01-display-phone-required-no-skip.png` | The separate display: the number with the safety line, Continue off until a number is typed, no Skip |
| `s762-02-till-membership-check-no-skip.png` | The till's Membership Check: the number is required, no walk-in skip |
| `s762-03-display-details-kept-phone-name-only.png` | After Pay, a walk-in whose Thai rate needs a profile: the number given at the start is shown, only the name is asked |
| `s762-04-kids-band-prints-the-number.png` | The kids band the platform prints for that sale, rendered on the park's band (25 mm, the 80 mm window): an adult stays, so it reads `Tel +66 81 207 6290`. The sale row holds `+66812076290`; the adult band carries no number |

The details screen's Done stays off until there is a number, and the station
refuses details sent without one: pinned in `apps/pos/test/s762-phone-once.test.ts`
and `packages/box-agent/test/station-session.test.ts` (that screen opens only
for an order that reached the till without the first step, which this run does
not stage).

## SCRUM-779 — one sale when a walk-in with a tier claim becomes a member

Walk-in, Thai rate by a document check, 2 Hours Play, Pay; the name typed on the
display after the sale was rung up.

| Screen | What it shows |
|---|---|
| `s779-01-payment-screen-one-sale-member-attached.png` | The payment screen with the Thai rate saved to the new member; the platform holds ONE sale for the order, already under that member, at the Thai rate |
| `s779-02-paid-one-sale.png` | Paid by cash: the same sale closed; no other sale for the order, none left unpaid |
| `s779-03-till-after-reload-nothing-left-unpaid.png` | The till reloaded: no "left unpaid" notice |

The narrower window — the member saved after the payment screen decided the
sale's ids but before its commit went out — is driven in
`apps/pos/test/s779-member-joins-sale.test.ts`.

## SCRUM-764 — the drop-off and nanny forms on the customer screen

A child with no adult on the sale, the number given at the start.

| Screen | What it shows |
|---|---|
| `s764-01-display-form-opens-on-children-step.png` | The form on the display from its first step, the child not yet named |
| `s764-02-till-gate-mirrors-the-child.png` | The till's gate after the family's step: the name and age they gave, the requirement worked out |
| `s764-03-display-care-step.png` | The care step: allergies and dietary notes typed by the family |
| `s764-04b-display-no-change-step-not-waiting.png` | A step that changes nothing on the till — the consent ticked before the name, Back, then Continue — and the form is still the family's to fill: the till moved it on to a new request |
| `s764-04c-without-a-new-request-the-form-waits.png` | The same steps in a separate run with the till's new request taken out (not landed): the form stops on "Please wait for the team to confirm this change." with every button off — the state the step above no longer reaches |
| `s764-04-display-agreements-kept-phone.png`, `s764-04a-display-agreements-number-from-the-start.png` | The agreements step: the guardian's name, the number from the start (not asked again), the consent and the confirmations ticked by the family |
| `s764-05-till-shows-the-family-ticks.png` | The till's card listing each agreement as ticked by the family |
| `s764-06-staff-copy-ticks-read-only.png` | Staff's private copy while the display has the form: the allergy the family typed, the photo taken by staff, and the consent shown "ticked by the family" — a press on it changes nothing |
| `s764-07-display-form-finished.png` | Done on the display once the staff checks are complete |
| `s764-08-registered-from-the-family-form.png` | Continue registers the child from the family's form (name, age, allergy, guardian); a nanny child then goes to the nanny assignment as before |

When a paired display cannot take the form (the till on the counter box lane,
or a price still being worked out), staff tick the agreements on their copy with
the family, as before the form moved to the display, and the till says so. That
rule is `staffTicksAgreements` in `apps/pos/src/lib/consentForm.ts`, pinned in
`apps/pos/test/s764-form-sync.test.ts`; this run does not stage the box lane.
