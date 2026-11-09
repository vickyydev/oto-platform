# SCRUM-794 follow-up on staging: proof, 9 November 2026

Live build: commit `877d23c9` on oto-app-staging (the app reports `877d23c9f34e…`), live since 19:16 Bangkok.
The proof ran from 19:22 to 19:29 Bangkok. It signed in as the staging admin through the launcher (app role `global_admin`), using headless Chromium at 1440×900 on Bangkok time.
No SMS was sent and no setting was changed. Nothing was deployed or committed. Nobody signed in as the staff member, and her login and face were not touched.
No real name appears in the picture or in `receipt.json`. Every call is in `receipt.json` with its time, answer and ids.

## Part A: the real case at Central Floresta. Stopped at step 2, nothing written

**Step 1: the facts still hold.**

| | The original (Promotion) profile | The duplicate (Reception) profile |
|---|---|---|
| Status | Resigned, Left, last working day 31 Oct | Active, badge "Probation", Reception |
| Login | Yes (staff, switched off since she left) | None |
| Face | Enrolled (its own) | Enrolled, a different face (enrolled 5 Nov) |
| Contracts | 1: the old signed one (Sale Booth, from 2 Feb), still active | 2: the signed active Reception contract (start 3 Nov) and a finalized, unsent copy |
| Time records (clock events) | 210, including 3, 4 and 5 Nov | 7: on 5, 6, 7 and 9 Nov |
| Shifts in November | 0 | 10: 4–7 Nov and 9, 10, 12, 13, 14, 15 Nov |
| Pending "Unscheduled work" | 4: 11 Aug, 12 Aug, 3 Nov, 5 Nov | 0 |

Both profiles were clocked on 5 Nov. The app's checklist list names neither profile. No app route lists tasks by person, and the fold's own count of them was never reached.

**Step 2: the preview refuses.** It was expected to answer 200 with the counts. It answered:

> **409 still_referenced**: "This profile is still linked to the org chart, so nothing was folded."

The API and the Fold dialog give the same answer. In the dialog, the Fold button stays disabled and no box for typing FOLD appears (picture A2). So steps 3 to 5 were **not run**: no fold, no re-onboarding of the original, no read-backs. Both profiles are as they were.

**Why it refuses.** The org chart has a person entry for the duplicate. It has been in the live company chart since 7 Nov at 19:24. The fold now moves contracts, time records, shifts and the rest, but it does not move or remove org chart entries. When it deletes the emptied duplicate at the end, the database refuses because of that link, and the whole fold rolls back. The fold's own check (`tests/employee-fold.check.ts`) builds no org chart entry, so it never met this case. The refusal came at 19:22, before this proof first read the org chart at 19:24.

The Org Chart page adds an entry for every active employee who has none each time it is read, so most working duplicates will be in the org chart. **The fold needs one more step:** re-point the duplicate's org chart entries to the original, or drop them where the original already has one in that chart. A check that builds such an entry should come with it.

## Part B: ZZ TEST rows at Robinson Chalong. Passed

**B1: the leftover ZZ TEST leaver from the earlier proof** ("ZZ TEST 794 Leaver 20261109-1641"):

| Step | Result |
|---|---|
| Delete its draft contract (from the cancelled plan) | **204** (was 500) |
| Delete the profile | **204** |
| Read back | the profile, the draft and its app-only login are gone (404 / not found) |

**B2: offboard again**, on a new "ZZ TEST 794b Twice 20261109-1926" (Reception, no login):

| Step | Result |
|---|---|
| Offboard, last working day 12 Nov (3 days ahead) | **201**; status stays active, Leaving |
| Onboard Again from 14 Nov (5 days ahead) | **201**, planned, with a draft contract |
| Start it early | No route starts a plan early: the 03:00 batch does, or Onboard Again itself when the start is today. A start today must come after the last working day, so the plan was cancelled, the last day moved to 8 Nov, and Onboard Again was made from today. |
| Cancel plan | **200**, `contractDeleted: true` (the unsent draft goes with the plan) |
| Last working day moved to 8 Nov | **200**; resigned, Left |
| Onboard Again from today, 9 Nov | **201**, **started at once**; active, Reception; the first offboarding is now closed |
| **Offboard a second time**, last working day 19 Nov | **201**; Leaving, the new offboarding open |
| **A third offboarding while one is open** | **409** "Offboarding already exists for this employee" |

**Clean-up.** Both drafts are deleted (the cancel deleted one, the other answered 204). The profile delete was **refused**: "This employee is still linked to the org chart, so nothing was deleted. …". This proof caused that link itself: right after creating the profile, it read the org chart, and that read added the profile to it. So the profile's employment was ended today instead (last working day 9 Nov; 200). It reads resigned, and the 03:00 run moves it to Left. It has no login, contracts, shifts or plan. Both of its "Onboard again" movement rows kept their rows, with the contract link emptied.

## What this proof itself changed on staging

- To see what links the profiles, the proof read `GET /api/org-chart/nodes`. That route stores an entry for every active employee missing from the chart being read, so the reads **stored 118 org chart entries**:
  - 4 for the ZZ TEST profile
  - 3 for the duplicate (draft company chart, plus the Central Floresta branch charts)
  - 111 for other active employees: 5 in the draft company chart, 43 + 43 in the Central Floresta live and draft branch charts, and 10 + 10 in the Robinson Chalong charts. Those branch charts were empty before.
- An admin opening the Org Chart page on those charts would have made the same entries. They change nothing else, but they are links that block deleting or folding those employees. The app cannot undo them: its delete only marks an entry deleted, and the next read adds it again. Removing them needs a database step, which was not attempted.
- Part B rows: the earlier leaver is deleted. The B2 ZZ TEST profile stays on staging, ended today, as described above.

## Findings to act on

1. **The real case still cannot be folded.** The fold has to handle org chart entries (see "Why it refuses"). Once that ships, this proof can run again as written.
2. **The org chart link also blocks the plain employee delete** of any profile the Org Chart page has seen (B2 clean-up).
3. **Fixed and seen working on staging:**
   - A cancelled plan's draft deletes (204, was 500), and so does a profile whose plan was cancelled before the release.
   - Cancel plan deletes its own draft.
   - Movement rows keep their rows, with the contract link emptied.
   - A second offboarding after a re-onboarding is allowed (201), and a third while one is open is refused in words (409).

## Picture

- `A2-fold-dialog-still-referenced.png`: the Fold dialog on the duplicate (Reception) profile, with the original (Promotion) profile chosen. It shows the original's Login and Face tags and "Resigned", the refusal "This profile is still linked to the org chart, so nothing was folded.", and the disabled Fold button. The name and the search box are masked.

Every run signed out at the launcher (200).
