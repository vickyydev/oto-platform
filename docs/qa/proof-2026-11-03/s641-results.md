# SCRUM-641 Fix report author, comment attachments and delete: staging proof

Verified 4 November 2026, 11:03 to 11:11 Bangkok (04:03 to 04:11 UTC), after the deploy; the logins were prepared from 10:57. OTO App source `057cd831b81297a4c4829bbf37f7a92003af2a6e`, main [CI 41765602534](https://github.com/vickyydev/oto-platform/actions/runs/41765602534) green on all six jobs, including the path-gated oto-app job. No product change was needed during the proof.

| Service | Live commit | Deploy | Live since |
|---|---|---|---|
| oto-app-staging | 057cd831b81297a4c4829bbf37f7a92003af2a6e | dep-dblagc0473hc73avn5jg | 2026-11-04T03:39:00Z (10:39 Bangkok) |
| oto-qa-worker-staging | 057cd831b81297a4c4829bbf37f7a92003af2a6e | rebuilt on its own, not deployed by hand | |

Migration 0033 is applied on staging: `fix_reports.archived_at`, `fix_reports.archived_by_user_id` and `fix_comments.media` are present (read-only check in [before.json](./s641/before.json)).

## Who signed in

Everything ran in a real browser (Microsoft Edge, Bangkok time zone), each person in their own browser session, signed in through the launcher and handed into the OTO App:

- a new ZZ TEST branch, `ZZ TEST SCRUM-641 mw1l5g6u`, opened through the Console;
- four new ZZ TEST logins: a reporter (staff at that branch), a manager at that branch, a manager at another branch (Central Floresta) and an admin;
- the existing ZZ TEST Fix Department login, `ZZ TEST Maintenance 656` (made for SCRUM-656), joined to a temporary ZZ TEST platform sign-in for this proof and put back afterwards.

No SMS was sent: the platform logins were made by a one-off job and each person signed in with a Console temporary password, changed at once to a random password nobody kept. The Fix Department setting itself was not changed. Details: [provision.json](./s641/provision.json).

## What a person sees (receipt [proof-mw1ler0l.json](./s641/proof-mw1ler0l.json))

1. **Reported by.** The reporter opens the report from My Reports: under the title it reads "Reported by ZZ TEST SCRUM-641 mw1l5g6u reporter · 04 Nov 2026, 11:03", matching the stored creation time in Bangkok time. `s641-01`
2. **Names and times in the thread.** The Fix Department member opens it on the Fix Board and sees the same line. Their comment "ZZ TEST comment one" shows "ZZ TEST Maintenance 656 (you)" with "04 Nov 2026, 11:03"; the manager sees the same row without "(you)". The "Report submitted by" row and every comment carry an absolute date and time. `s641-02a`, `s641-02b`, `s641-02c`
3. **Attachments.** The paperclip opens "Add photo or file" with "Camera" and "Choose from Gallery" (`s641-03a`). A photo and a PDF show as previews (`s641-03b`) and, once sent, as a thumbnail and a "PDF document" chip directly in the thread (`s641-03c`). The photo opens in the gallery (`s641-03d`); the PDF opens in the browser's PDF viewer, served as `application/pdf` (`s641-03e`). A photo with no words posts with no empty line (`s641-03f`). At phone width (390 px) the same dialog shows (`s641-03g`), and Camera opens the file input marked `capture="environment"`. A .docx is refused in words, "Can't add file", naming the allowed types (`s641-03h`). The reporter adds a photo comment from My Reports (`s641-03i`).
4. **Delete refusals.** At the end of the thread the reporter and the Fix Department member have no "Delete report" (`s641-04a`, `s641-04b`), where the manager has it (`s641-04d`); the server also refuses both with 403. The manager at Central Floresta opening the report's link gets "This report is not available", and the server answers 403 (`s641-04c`).
5. **Delete.** "Delete report" asks "Delete this report?" with "Use this for a report that is not needed or is a duplicate. It will disappear from the Fix Board and from everyone's lists." (`s641-05c`). Cancel keeps the report (`s641-05d`). Confirming shows "Report deleted"; the card leaves the board and Pending falls from 2 to 1 (`s641-05b`, `s641-05e`, `s641-05f`). The admin deletes a third report the same way (`s641-05g`).
6. **Deleted everywhere.** The deleted reports are gone from My Queue (`s641-06a`), My Reports (`s641-06b`) and the board, and from the three list reads. A link saved earlier with `?reportId=` shows "This report is not available" (`s641-06c`). The deleted report's comment attachment answered 200 before the delete and "Media not found" (404) after (`s641-06d`). The ZZ TEST supplier link made before the delete listed the report (`s641-05a`) and no longer does (`s641-06e`); its direct read answers 404.
7. **Stale screen.** With "ZZ TEST 641 stale" open on the manager's board, the admin deleted it in another browser. The manager's update was refused (404) and the screen turned to "This report is not available." with no status control, comment bar or delete (`s641-07`).
8. **Activity Logbook.** Exactly one "Fix Report Deleted" row per deleted report, each naming who deleted it and when (`s641-08`); the database read-back confirms one row per report, four in all.
9. **Supplier link.** The supplier sees the photo and the "PDF document" chip on the staff comment it can already read; the photo opens (`s641-09a`, `s641-09b`) and the PDF is served as `application/pdf`. Its own update is text only: there is no attach control, and an attachment sent along with a supplier comment is not kept.

The first run stopped at the .docx step on an over-strict check of the toast wording, after the refusal had shown correctly ([proof-mw1ld1ue.json](./s641/proof-mw1ld1ue.json)); the second run reused that run's report and comments and passed every step. `s641-03b` comes from the first run.

## What is not proven here

- The phone's camera app opening. A headless browser has no camera; what was seen is that the Camera button opens the input that asks the device for its rear camera.
- A deleted report stays in the database with `archived_at` and `archived_by_user_id` set, with its comments and files. There is no restore screen.

## Clean-up (receipt [cleanup.json](./s641/cleanup.json), read back by job `job-dblb0bt9el5s73cghu90`)

- All four ZZ TEST SCRUM-641 reports are deleted through the feature (the last one, "ZZ TEST 641 author", by the ZZ TEST manager); each has exactly one deletion row.
- Both ZZ TEST supplier links made for this proof are revoked ([supplier-links-read.json](./s641/supplier-links-read.json)).
- `ZZ TEST Maintenance 656` is back as it was: out of the Fix Department (which again has no employee members), access at Central Floresta only, switched off, and not linked to any platform sign-in.
- The five ZZ TEST SCRUM-641 platform logins are inactive with no access grants and no live sessions; their app logins are switched off.
- The ZZ TEST SCRUM-641 branch is archived, with no open Fix report on it.
- No setting, service, API, POS, box or park device was changed; no SMS and no payment.

## Jira

SCRUM-641 reads **Deployed** ([jira-deployed.json](./s641/jira-deployed.json)). Fourteen images are attached and shown inside one plain comment (13396) with how to retest on staging; the walk linked the six shipping commits.
