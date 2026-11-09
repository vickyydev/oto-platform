# Staging proof: SCRUM-751, SCRUM-752, SCRUM-777 (OTO App)

**Date:** 9 November 2026, 14:00 to 14:10 Bangkok time.

**Where:** OTO App staging (https://oto-app-staging.onrender.com). The app itself reported commit `6fe36b12bf286214844299009e0e013e89742b87`, before the proof and again at the final read-back.

**Who:** the staging administrator, signed in at the launcher and handed into the OTO App with the `global_admin` role. The browser was headless Chromium at 1440x900 with the Bangkok timezone.

**Result:** all three tickets passed. Every record the proof created is gone. The only things left behind are three Schedule History entries and the usual side effect of opening Ops. Both are described under "What is left on staging".

## SCRUM-752: the Start Recording item is hidden and Report issue stays

The account menu (avatar, top right) was opened on three layouts: Ops, Today (Core) and Events.

On all three the menu lists exactly: Notifications, My Schedule, My Account, Vault, Dark Mode, Logout.

- There is no "Start Recording" item and no "Stop Recording" item.
- The menu element behind those items does not exist in the page at all.
- The floating "Report issue" button is visible at the bottom right of each layout, at x 1279, y 782 in a 1440x900 window.

This check wrote nothing.

## SCRUM-751: an overdue checklist can be continued from Today

1. **Created a test checklist** at Oto Play Park, Robinson Chalong, picked in the app's branch switch:
   - Name: "ZZ TEST 751 Overdue 20261109-1405"
   - Repeats daily, due 00:30, assigned to Everyone, with three items.
   - It was created through the app's own create route.
2. **Ticked 2 of 3 items in Ops.** The Ops board made today's run of the checklist, which was shown under Pending. The run was opened from the board and two items were ticked, so it moved to In Progress (2/3). Then it was left.
3. **Checked Today** for the same branch. The card is red because it was due at 00:30 and is overdue. Its status is In Progress, and it offers **Continue**, not View. Continue links to the same run that Ops opened.
4. **Finished the run from Today.** Pressing Continue opened that run. The third item was ticked, the run completed itself, and Today showed "Checklist completed!".
   - The card then left Today's list.
   - The app reports the checklist as completed for today, and the run reads 3/3, Completed.
5. **Cleaned up.** The checklist was deleted through the app's delete route, which removes its run and run items with it. Reading them back gives 404, and no "ZZ TEST 751" checklist exists anywhere.

This is the scenario as briefed: an overdue run, in progress, continued from Today. The variant where a newer *missed* run sits beside the open one cannot be set up through the app's screens. That variant is covered by the CI check `tests/checklist-overdue-today.check.ts`.

## SCRUM-777: "Undo this action" in Schedule History

Everything happened at Robinson Chalong in the far-future week of **1 to 7 March 2027**.

1. **The week was empty to start with:** no week plan, no shifts, no days off and no duty blocks.
2. **Applied a template** through the scheduling page's Apply Template dialog, on that week.
   - The branch has only one template. Its name is a staff member's first name, so the name is not recorded here.
   - The preview said it would add no shift rows to the branch. It added 5 shifts and 4 days off.
3. **Added one shift by hand** on 3 March, for a person the template does not schedule.
4. **Changed one of the template's shifts.** The 4 March shift was reassigned to another person.
   - It went to the same person as the hand-added shift, because only two people are eligible on that row on staging.
   - Steps 3 and 4 used the same routes the schedule grid calls, from the signed-in browser session. The grid itself shows real staff names, so it was not clicked or pictured.
5. **Used Schedule History.** The new template entry shows **"Undo this action" beside Restore**.
   - The older entry from 23 June 2026, written before change sets existed, shows **Restore only**.
   - Pressing Undo opened the confirmation, which read: *"Template Applied (Added Only)" on 9 Nov 2026 at 2:08 PM by [the signed-in admin]. Undo reverses only what this action did. Shifts added or changed by anyone since are kept. Restore puts the whole schedule back to how it was before this action.*
   - After confirming, the toast read: **"Action undone: 8 removed, 0 put back, 1 left as they are (1 changed since)."** The 8 are the 4 untouched template shifts and the 4 template days off.
   - A new **"Undid an action"** entry appeared at the top of History.
6. **Checked the week after the undo:**
   - Only the hand-added shift and the reassigned shift remain, and the reassigned shift still has its new person.
   - The other 4 template shifts are gone, and so are all 4 template days off.
7. **Cleaned up.**
   - The two remaining shifts were deleted.
   - The empty week plan that the apply had created was deleted, because the week had no plan before.
   - The week now reads exactly as it did at the start: no plan, no shifts, no breaks, no days off and no duty blocks. The branch still has its 20 shift rows.

## Pictures

All pictures are in this folder. Each is cropped to the element being proved. Inside a page, every text in the main area is made transparent. The account name, the avatar, the person on each History entry and the "Completed by" lines are painted over in grey. No staff name is visible in any picture.

| File | What it shows |
|---|---|
| `752-ops-account-menu.png` | Ops: the account menu open, with no Start/Stop Recording item |
| `752-ops-report-issue-button.png` | Ops: the Report issue button, bottom right |
| `752-core-account-menu.png` | Today (Core): the same menu, with no recording item |
| `752-core-report-issue-button.png` | Today (Core): Report issue, bottom right (the page was still loading its cards) |
| `752-events-account-menu.png` | Events: the same menu, with no recording item |
| `752-events-report-issue-button.png` | Events: Report issue, bottom right |
| `751-1-ops-run-2-of-3.png` | Ops: the ZZ TEST run, In Progress, 2/3 |
| `751-2-today-continue-on-overdue.png` | Today: the overdue (red, 00:30) ZZ TEST card with Continue |
| `751-3-today-toast-checklist-completed.png` | Today: "Checklist completed!" after finishing from Today |
| `751-4-run-completed.png` | The run reopened: 3/3, Completed |
| `777-1-history-undo-beside-restore.png` | History: Undo this action beside Restore on the new entry; Restore only on the June entry |
| `777-2-older-entry-restore-only.png` | The June 2026 entry (no change set): Restore only |
| `777-3-undo-toast-counts.png` | The undo toast with its counts |
| `777-4-history-after-undid-an-action.png` | History after the undo, with the new "Undid an action" entry on top |

## Everything created, and how it was removed

The exact ids, times and answers are in `receipt.json`.

| Created | Removed by | Read back |
|---|---|---|
| Checklist `f4736996-c3c5-4465-b6da-1aedb035f687` "ZZ TEST 751 Overdue 20261109-1405" | DELETE /api/checklists/templates/:id → 200 | 404 |
| Its run `57040331-5590-4cea-8a4c-11357065ed6a` and 3 run items | the same delete | 404 |
| Week plan `cca2aa0b-d10a-4666-9216-d3613a00af21` (1 to 7 March 2027) | DELETE /api/schedule/week/:id → 204 | the week has no plan |
| 5 template shifts and 4 template days off | the undo (4 shifts and 4 days off); the reassigned shift by DELETE /api/schedule/assignments/:id → 204 | 0 shifts, 0 days off |
| Hand-added shift `0224fdde-8ee1-41d1-bd2b-a9492bdb5fc9` | DELETE /api/schedule/assignments/:id → 204 | 0 shifts |
| Automatic breaks on those shifts | regenerated by the app after each shift change | 0 breaks |

Nothing else was written. There was no SMS, no setting change and no deploy. No real person's record was changed outside the March 2027 week, and nothing remains in that week.

## What is left on staging

- **Three Schedule History entries at Robinson Chalong**, all about the 1 to 7 March 2027 week:
  - "Template Applied (Added Only)"
  - "Undid an action"
  - "Week Cleared" (the deletion of the empty week plan)

  History is the app's own audit trail and cannot be cleared through the app. Pressing Undo on the "Week Cleared" entry would only bring back an empty week plan.
- **Today's pending checklist runs made by opening Ops.** Opening the Ops board makes the app write today's pending run for each recurring checklist of the branches it shows. Every Ops visit does this. The proof opened Ops at All Branches (for SCRUM-752) and at Robinson Chalong (for SCRUM-751).

## Sign-out

Every script signed out at the launcher (POST /api/auth/sign-out) when it finished, and every call answered 200. The final read-back did the same.

## Scripts

The scripts are kept outside the repository, in `C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/s751p/`:

- `p752.mjs`, `p751.mjs` and `p777.mjs` run the three proofs.
- `verify.mjs` does the final read-back.
- `receipt.mjs` builds `receipt.json`.
- `state.json` holds the raw log.
