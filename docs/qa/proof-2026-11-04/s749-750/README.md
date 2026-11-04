# SCRUM-749 and SCRUM-750 staging proof: checklist runs at new and archived branches, and a deleted checklist's photos

Run on 4 November 2026, 22:47-23:18 Bangkok, on the OTO App staging site live on
`fb48bc7b67dac764e5a1d7be2bcafd43b90726e1` (oto-app-staging live on it from 22:36,
still on that deploy after the run; its pre-deploy applied OTO App migration 0034;
main CI run 41854880805 green on that SHA). Real Edge browser at 1280 px, ZZ TEST
records only: no sale, payment, SMS or setting change, no park device, nothing
deployed or restarted by hand.

The signed-in person is a ZZ TEST login made for this run without SMS ("ZZ TEST
S749 ... admin all branches", an OTO App admin over every branch), signed in through
the launcher with a Console temporary password and a forced change to a random
password nobody keeps. Database read-backs ran as one-off jobs on oto-api-staging
(read-only transactions unless stated); storage read-backs ran as one-off jobs on
oto-app-staging with the app's own bucket settings. No secret, phone number or
signed link is recorded here.

## 1. Migration and read access (`step1-*.json`)

- `otoapp.__drizzle_migrations`: 34 rows, the newest is 0034.
- `otoapp.checklist_templates.branch_added_at`: jsonb, not null, default `'{}'`.
- `GET /api/studio/branches`: 14 branches `archived: true` (the two SCRUM-659 test
  branches among them, and every other archived ZZ TEST branch), 5 open branches
  `archived: false`.
- The Ops board was opened at All Branches. The oto-app-staging log has no
  `[PLATFORM_BRANCHES]` line from the deploy to 23:18 (a positive control on the same
  search finds 33 request lines), so the app can read the platform's branch table and
  the archive rule works on staging.

## 2. Pickers leave archived branches out (SCRUM-749)

| Screen | What it shows |
|---|---|
| `s749-03a-studio-create-picker-open-branches-only.png` | Studio > Checklists > Create: five open branches; "All Branches" ticks those five only |
| `s749-03b-ops-create-dialog-open-branches-only.png` | Ops > New checklist window: open branches only |
| `s749-03c-studio-tasks-picker-open-branches-only.png` | Studio > Tasks > Create: open branches only |
| `s749-02b-create-picker-archived-branch-absent.png` | The Create picker scrolled to its end after the S749 branch was archived: it is not there |
| `s749-02c-edit-still-shows-archived-branch.png` | Editing "ZZ TEST S749 named", which names the archived branch: the branch still shows, ticked, so it can be taken off |

## 3. A branch opened today (SCRUM-749, `step4-new-branch-runs.json`)

The branch "ZZ TEST S749 Open 4 Nov" was opened in the Console at 22:50; its OTO App
branch was made at once (`created_at` 15:50 UTC, the database and the app both in UTC
on staging). The Ops board at that branch shows exactly one run of the every-branch
checklist "ZZ TEST Wave1 Everyone": today's (4 Nov, 09:00, pending), nothing missed
(`s749-01-new-branch-board-today-only.png`). Read back: one run at that branch,
`period_start` 2026-11-03 17:00 UTC = 4 Nov in Bangkok. Earlier the same day, under
the old rule, the two SCRUM-659 branches got 23 runs each the first time the board
was opened.

## 4. After the branch is archived (SCRUM-749, `step5-archived-branch.json`)

The branch was archived in the Console, its one run deleted (run items first, in one
transaction that checked the branch and the run ids), and the Ops board reopened at
All Branches and at the branch itself: no run came back
(`s749-02-archived-branch-board-no-runs.png`; read back 0 runs at the branch).

## 5. The 46 leftover runs (SCRUM-749, `step2-count-46.json`, `step6-cleanup-46.json`)

- Before: 23 Wave1 runs at each SCRUM-659 branch (13 Oct to 4 Nov Bangkok, all
  made at 12:22 Bangkok today), 46 in all; still 46 after the board was reopened at All
  Branches and at "ZZ TEST 659 A" (`s749-04a-archived-659-branch-before-cleanup.png`).
  Before Bangkok midnight this count cannot move under either rule, since today's run
  already existed; the discriminating checks are the ones after the deletes.
- One transaction deleted exactly 46 runs and their 46 items (it asserted the
  checklist's name, that all three branches are ZZ TEST and archived, and the count
  before committing).
- The board was then opened at "ZZ TEST 659 A" and at All Branches: it stays empty
  (`s749-04b-archived-659-branch-after-cleanup-no-runs-return.png`), where the old
  rule would have filled in 23 runs again. Read back 0 runs at both branches and at
  the S749 branch.

## 6. Deleting a checklist removes its photos (SCRUM-750, `step7-delete-removes-files.json`)

| Step | Read back | Screen |
|---|---|---|
| "ZZ TEST S750 delete" made at Demo Branch 2 in Studio; a reference photo on its item and a header photo; "Save as a new checklist" made "ZZ TEST S750 copy"; a third photo added to the original only | three attachment rows on the original, two on the copy naming the same two files; each file HEAD 200 | `s750-01a-original-with-photos.png`, `s750-01b-list-original-and-copy.png` |
| The original deleted in Studio | its own file HEAD 404 and its earlier link answers NoSuchKey; the two shared files HEAD 200 and their rows remain on the copy | `s750-01c-list-after-original-deleted.png`, `s750-01d-copy-still-shows-shared-photo.png`, `s750-01e-original-only-file-gone-404.png` |
| The copy deleted in Studio | no attachment row names any of the three files, no run is left, each HEAD 404, a shared file's earlier link answers NoSuchKey | `s750-01f-list-no-s750-checklists.png`, `s750-01g-shared-file-gone-404-after-last-delete.png` |

Uploads went through the app's own server upload route, because the staging bucket
refuses a browser's direct upload (SCRUM-659 finding). The app log shows no
`S3 delete error` line from the deploy to 23:18 (`step7-log-search.json`).

## 7. The orphan file (SCRUM-750, `step8-orphan-file.json`)

No checklist, item or attachment row names
`checklists/e922bbe0-be07-487d-a5c8-5169e926d246/items/cdaaa54e-f4da-4328-b4ed-e3cdbe09ce07/`.
It held one PNG (10783 bytes, uploaded 12:17 Bangkok today); that object was deleted,
and the prefix and the whole `checklists/e922bbe0-.../` folder now list empty.

## Clean-up (`cleanup.json`)

"ZZ TEST S749 named" was deleted through Studio; no ZZ TEST S749 or S750 checklist,
run or attachment is left. The ZZ TEST S749 admin login is inactive with no grants,
no live session and no app link, and its OTO App user is switched off. The branch
"ZZ TEST S749 Open 4 Nov" stays archived (branches are never deleted). Its core
employee row stays, as for earlier ZZ TEST logins.

## Not proved here

- The optional share case in the proof plan (adding a new branch by "share" to an
  older checklist on named branches) was not run on staging: no checklist of this run
  was older than today. The test suite covers it (`tests/checklist-copies.check.ts`).

## Notes for the owner

- 276 more leftover "ZZ TEST Wave1 Everyone" runs, made by the same board opening at
  12:22 today, sit at 12 other archived ZZ TEST branches from earlier checks. They are
  not this run's records and were left in place; their recent ones still show on the
  Ops board at All Branches until they age out of its three-day window or are removed.
- The header branch switcher in the OTO App still lists archived branches (this change
  covered the Studio pickers named on the ticket). Choosing one shows an empty board.

## Jira

`jira-publication.json`: each ticket has the screenshots attached and one plain
comment that shows them; both walked Testing to Deployed, with commit links added;
nothing set to Done.
