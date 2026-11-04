# SCRUM-659 checklists across branches: staging proof

Verified 4 November 2026, 12:17 to 12:36 Bangkok (05:17 to 05:36 UTC), after the deploy; the test branches and logins were prepared from 12:09. OTO App source `b64d10ce0b85558e538eb58babd652dd500eb4d6`, main [CI 41773119559](https://github.com/vickyydev/oto-platform/actions/runs/41773119559) green on all six jobs, including the path-gated oto-app job with all 70 of its steps run. No product change was needed during the proof.

| Service | Live commit | Deploy | Live since |
|---|---|---|---|
| oto-app-staging | b64d10ce0b85558e538eb58babd652dd500eb4d6 | dep-dblbihg473hc73b0o1fg | 2026-11-04T04:51:40Z (11:51 Bangkok) |
| oto-api-staging, oto-console-staging, oto-launcher-staging | b64d10ce0b85558e538eb58babd652dd500eb4d6 | rebuilt on their own from the same commit, not deployed by hand | |

The change adds no migration; the app's latest stays 0033.

## Who signed in

Everything ran in a real browser (Microsoft Edge, Bangkok time zone), each person in their own browser session, signed in through the launcher and handed into the OTO App:

- two new ZZ TEST branches, `ZZ TEST 659 A mw1nq25m` and `ZZ TEST 659 B mw1nq25m`, opened through the Console (called A and B below);
- three new ZZ TEST logins: an OTO App admin (the app's admin role sees every branch), and two staff, one at A and one at B;
- the two staff as OTO App employees at their branches (`ZZ659A`, `ZZ659B`), made by the ZZ TEST admin in the app, so a checklist can name them.

No SMS was sent: the platform logins were made by a one-off job and each person signed in with a Console temporary password, changed at once to a random password nobody kept. Details: [provision.json](./s659/provision.json).

## What a person sees (receipts [step1.json](./s659/step1.json), [steps2-5.json](./s659/steps2-5.json), [steps6-7.json](./s659/steps6-7.json))

1. **Create, unchanged.** "ZZ TEST 659 Daily" made at A in Studio > Checklists: daily at 08:30, two items, named to ZZ659A (`s659-01a`). A reference image sits on item 1 and shows in the editor (`s659-01b`; how it got there is under "Found on staging"). Creating "ZZ TEST 659 Pair" with A and B ticked still made two independent checklists, one at each branch (`s659-01c`, `s659-01d`); the one at B was deleted through the screen (`s659-01e`).
2. **A normal edit.** Opening the Daily shows its own branch selected and "Save as a new checklist" unticked. The description was changed and saved: one update (version 1 to 2), and the list still shows one Daily (`s659-02a`, `s659-02b`).
3. **Save as a new checklist.** Ticked, the line under the box reads "Creates one new checklist for ZZ TEST 659 A mw1nq25m. The original stays exactly as it is, and its past runs stay with it." and the button reads "Save as New Checklist"; the media area says existing files copy across (`s659-03a`). Renamed "ZZ TEST 659 Copy" and saved: two rows, the toast "New checklist created. The original was not changed." (`s659-03b`). Reopened, the Daily keeps its name and the description from step 2, and its version did not move (`s659-03c`).
4. **Add a branch, separate copy.** Clicking B on the Daily shows "How should ZZ TEST 659 B mw1nq25m be added?" with "Make a separate copy for this branch" and "Share one checklist across both", neither picked, Save closed and "Choose how to add the new branch before saving." (`s659-04a`, the key screen). Choosing the copy shows "For the new copy. This checklist keeps who it is assigned to."; ZZ659B was named for the copy (`s659-04b`). Saved: "Made a separate copy for the new branch." A new Daily sits at B named to ZZ659B, and the original stays at A alone, still named to ZZ659A (`s659-05e` shows both). Opening the copy: the same two items, daily at 08:30, ZZ659B ticked, and the reference image on item 1 (`s659-04d`), which opens from its own link (`s659-04e`).
5. **Add a branch, share.** On the Pair, adding B and choosing "Share one checklist across both" (`s659-05a`) kept one checklist on both branches ("2 branches", `s659-05e`). Reopened in All Branches it reads "This is shared with ZZ TEST 659 A mw1nq25m and ZZ TEST 659 B mw1nq25m. Changes apply to both branches." (`s659-05b`); working in A it reads "This is shared with ZZ TEST 659 B mw1nq25m. Changes apply to both branches." (`s659-05f`). Ticking the box with only B left selected ("Creates one new checklist for ZZ TEST 659 B mw1nq25m.", `s659-05c`) split off "ZZ TEST 659 Pair split" at B, and the shared Pair kept its version and both branches (`s659-05d`, `s659-05e`).
6. **Runs.** The Ops checklist board, opened with all branches, made today's runs: the copy at B has exactly one run, at B; the original has one at A and none at B; the Copy and the Pair split one each at their branch; the shared Pair one at each of A and B ([runs-read.json](./s659/runs-read.json), a read-only database read). The board at B shows the copy, the Pair and the Pair split (`s659-06b`); at A the Daily, the Copy and the Pair (`s659-06c`).
7. **Staff at the copy's branch.** ZZ TEST staff at B sees "ZZ TEST 659 Daily 08:30 ZZ659B" in Today (`s659-07a`), opens the run with both items and "1 View media" on item 1 (`s659-07b`), and the reference image opens full size, 640 x 400 (`s659-07c`).
8. **Clean-up through the screen, and the shared file** ([cleanup.json](./s659/cleanup.json)). The Daily, its copy at B and the Copy each had their own attachment row on one stored image. Deleting the copy at B left the original's image opening (`s659-08a`). In the media case, a file on the Pair split was copied by "Save as a new checklist" to "ZZ TEST 659 Media copy"; removing it from the Media copy on the screen (`s659-08c`) left it on the Pair split, where it still loads (`s659-08d`); removing it there too removed the stored file, and its earlier signed link answers 404 NoSuchKey (`s659-08e`). Every ZZ TEST 659 checklist was then deleted through the screen (`s659-08f`).

## Found on staging (not part of this change)

- **Adding a photo or video to a checklist from the browser fails on staging.** The editor's upload sends the file straight to the staging file store, and the store refuses it ("blocked by CORS policy ... No 'Access-Control-Allow-Origin' header"); the screen shows "Network error during upload" (`s659-00`). This is the bucket CORS rule still listed as owner action 2 in docs/progress/OWNER_ACTIONS_AND_NEXT_BUILD.md, and it affects every checklist on staging. For this proof the image was put on the saved item through the app's own server upload route (`POST /api/checklist-media/upload`, which exists to avoid this), signed in as the same ZZ TEST admin; everything after that was done on the screen.
- **Deleting a whole checklist leaves its files in storage.** The delete route removes the checklist, its items and the rows naming its files, but never the stored files; that route is unchanged since the app came in. After the Daily, the last checklist naming the step 1 image, was deleted, that image still opened from an earlier signed link (`s659-08b`). One ZZ TEST PNG made by this proof stays in the staging bucket with no row naming it, under `checklists/e922bbe0-be07-487d-a5c8-5169e926d246/items/cdaaa54e-f4da-4328-b4ed-e3cdbe09ce07/`. Removing a file from a checklist does remove it with the last row (step 8).
- **A checklist on every branch back-fills missed runs at a new branch.** The run creator starts a checklist that has no branch from the day the checklist was made, at every branch the viewer can see, up to a year back, even for a branch opened today. Opening the board made 23 runs each at A and B for the existing "ZZ TEST Wave1 Everyone" checklist (`s659-06b`, `s659-06c` show the missed ones); they belong to that checklist, not to this proof, and stay with the archived branches, as at earlier archived ZZ TEST branches. That code is unchanged by this lane.

## Clean-up, read back (job `job-dblc8b0u01pc739q27rg`, read-only)

- No ZZ TEST 659 checklist, run or checklist attachment is left.
- The three ZZ TEST 659 platform logins are inactive with no access grants, no live sessions and no app link; their three OTO App users are switched off. The two staff were first unlinked and then switched off from the platform, which no longer reached their app users; the ZZ TEST admin was linked and switched on for a moment, switched the two staff users off in the app's user management, and was retired again.
- The two ZZ TEST employees were deleted in the app.
- Both ZZ TEST 659 branches are archived.
- Left, as above: one orphan ZZ TEST PNG in the staging bucket, and the 46 runs of the existing "ZZ TEST Wave1 Everyone" checklist at the two archived branches.

No setting, API, POS, box, park device, SMS or payment was touched.

## What is not proven here

- Adding a reference file in the editor in a browser on staging, for the reason above.
- A manager at the second branch of a shared checklist copying it to their own branch, and the plain save being refused for them: covered by `tests/checklist-copies.check.ts` and `tests/checklist-copies-ui.check.ts`, not driven on staging.
