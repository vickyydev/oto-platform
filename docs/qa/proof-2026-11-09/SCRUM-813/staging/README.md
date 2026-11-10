# SCRUM-813 One deposit, read by the till wherever the BEO or the event entered it: staging proof

Same run as `SCRUM-818/staging` (10 November 2026, 14:23-14:31 Bangkok,
oto-app-staging and oto-api-staging live at
`608e3c0ba23e385a6ffd0eac34421196a57ca6a6`; migration 0045 applied by the
pre-deploy). The party is the ZZ TEST "ZZ TEST 818 party" at Central
Floresta. The till's read is the api's `GET /api/parties/:id` as the
administrator (through the launcher, branch Central Floresta).

| Check | Result | Picture |
|---|---|---|
| After the pasted AI Fill's approval (3,000 received on 9 Nov) | Pass: the api party reads `plan.settlement.depositSatang 300000`; the billing reads 3,000 paid on 2026-11-09; Party Details 3,000 / 2026-11-09; the event's Prepayment 3,000 / 2026-11-09 | — |
| The deposit changed in the BEO billing to 5,000 | `PUT /api/events/:id/beo/billing` `{ depositPaid: true, depositPaidAmount: 5000 }` 200 (the day stays 2026-11-09) | — |
| The till reads 5,000 | Pass: the api party reads `depositSatang 500000` | — |
| The event's Prepayment | Pass: `prepaymentAmount 5000`, `prepaymentDate 2026-11-09` | — |
| The BEO reads 5,000 | Pass: Party Details `prepaymentReceived 5000`; the editor's Deposit field 5,000, November 9th, 2026 | `813-st-01-beo-party-details-5000.png` |
| The Events page | Pass: the calendar's preview card reads "Deposit: ฿5,000 · Nov 9, 2026" | `813-st-02-events-calendar-card-5000.png` |

## Notes

- The billing module is not mounted in the editor today, so the change went
  through its own route (`PUT /api/events/:id/beo/billing`), as the module
  would send it.
- A birthday card on the Events page opens the BEO, not the event form, so
  the event's Prepayment is shown through `GET /api/admin/events/:id` and the
  calendar's preview card, not the form's field.
- Party Details shows "Outstanding -5,000฿" against its own older POS total of
  0฿ (see the note in `SCRUM-808/staging/README.md`).

Clean-up: see `SCRUM-818/staging/README.md` (the party's api read is 404 after
the delete; signed out 401).
