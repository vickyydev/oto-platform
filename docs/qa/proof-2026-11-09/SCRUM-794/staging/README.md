# SCRUM-794 on staging — proof, 9 November 2026

Live build: commit `ff9b0597` on oto-app-staging and oto-api-staging (live since 16:28 Bangkok).
Signed in as the staging admin through the launcher (app role `global_admin`), headless Chromium 1440×900, Bangkok time.
No SMS was sent, no setting was changed, nothing was deployed or committed. No real name appears in any picture or in `receipt.json`.
Every call, with its time, answer and ids, is in `receipt.json`.

## Part A — the reported case at Central Floresta: stopped, nothing written

The two profiles were found as described in part: the **original (Promotion) profile** reads Resigned / Left, last working day 31 October, holds the login and an enrolled face; the **duplicate (Reception) profile** reads Probation (active) in Reception with no login.

But the duplicate is more than a rota placeholder, so part A was stopped before any write:

- It holds a **signed, active Reception contract** (made 31 Oct, start 3 Nov) and a finalized, unsent copy of it.
- It holds **7 time records**.
- It has **its own face enrolment** (a different face, enrolled 5 Nov at 12:21).
- The fold's own preview refuses it: *"This profile has 2 contracts and 7 time records. Its history is kept for the record, so it cannot be folded into another profile."* In the Fold dialog the Fold button stays disabled (picture A1).
- Folding the other way round (keep the duplicate) is refused too, because the original holds the login.

So the fold, then Onboard Again on the original and the read-backs (steps 3 to 6) were **not run**. Her profiles, login and face are untouched.

Other facts seen (read only):

- The duplicate carries her shifts: 4–7 Nov and 9, 10, 12, 13, 14, 15 Nov. The original has none in those weeks.
- The original has 4 pending "Unscheduled work" items: 11 Aug, 12 Aug, 3 Nov and 5 Nov.
- The original reads a start date of 3 Nov, a probation review marked done on 3 Nov, and position "Reception" in its contract defaults. Its only contract is the old signed one (Sale Booth, from 2 Feb).

**What this needs from the owner:** the fold as built cannot fix this profile. One way is to let the fold carry a duplicate's contracts, time records and face onto the original, with its own preview and confirmation. The other is to accept the duplicate as her profile and move the login onto it. The choice is the owner's.

## Part B — the forward flow on a ZZ TEST profile at Robinson Chalong: passed

| Step | What happened | Result |
|---|---|---|
| Create | "ZZ TEST 794 Leaver 20261109-1641", Reception, with an app-only login at example.invalid | 201; login active |
| Offboard, last day 14 Nov (5 days ahead) | | 201; status stays **active**, badge **Leaving**, the login **stays on** |
| Onboard Again with start 12 Nov (before the last day) | | **409** "The new start date must be after the last working day (2026-11-14)" |
| Onboard Again with start 16 Nov, into Management | | 201, not started; plan **planned**, contract **draft**; the card shows 16 Nov, Management, Draft (picture B2) |
| Management shift row needs the Manager job role | role given through the profile's roles route first | 200 |
| Shift in Management on 16 Nov (start date) | | **201 allowed** |
| Shift in Management on 15 Nov (between the two employments) | | **400 refused**, EMPLOYMENT_ENDED |
| The week of 16 Nov | lists the shift under the profile; the schedule list carries the planned employment (16 Nov, Management) | as expected |

### Clean-up

- The shift was deleted (204) and the plan cancelled (200).
- The profile **could not be deleted**. The delete answered 409 because the draft contract Onboard Again made counts as a contract. Deleting that draft answered **500**: the profile's change-history row for "Onboard again" points at the draft, and that link blocks the delete.
- So the ZZ TEST profile was switched off instead: the job role was removed, the last working day was moved to today (the status now reads resigned) and the app-only login was switched off.
- Read back: no shift and no plan left, the login is inactive, the profile reads resigned. The 03:00 run will move it to Left.
- The ZZ TEST profile and its unsent draft contract stay on staging.

## Findings to act on

1. **The real case cannot be folded** (part A above). This needs the owner's decision before anything is done to her profiles.
2. **A draft contract made by Onboard Again cannot be deleted.** Deleting it answers 500, because of the change-history row's link to the contract. The same happens after Cancel plan, whose message says the draft "stays on the profile". A profile that went through Onboard Again can never be deleted either.

## Pictures

- `A1-fold-dialog-refused.png` — the real case: the Fold dialog on the duplicate (Reception) profile, with the original (Promotion) profile chosen. It shows the original's Login and Face tags, the refusal and the disabled Fold button. Names and the search box are masked.
- `B1-zz-profile-leaving.png` — the ZZ TEST profile just after Offboard: Create Contract, Update Terms and **Onboard Again** side by side, and no Offboard button. The Leaving badge is cut off at the right edge; B2 shows it whole.
- `B2-zz-planned-employment-card.png` — the ZZ TEST profile after Onboard Again. The badge reads **Leaving**, and the "Onboard Again planned" card shows the start on 16 Nov 2026, Management, Robinson Chalong, the position ZZ TEST Manager, a **Draft** contract and Cancel plan.

Signed out at the launcher at the end (200).
