# SCRUM-707 staging proof: print templates for every branch

Run on 4 November 2026 between 07:36 and 07:39 Bangkok on live commit
690d44dbfa31d8a3c487dfb3def0be9dfa3e105c. oto-api-staging, oto-pos-web-staging,
oto-pos-staging and oto-console-staging all ran it; their deploys finished between 07:26 and 07:29.
The proof used the staging Console in a real browser, signed in as the staging admin account.
Only ZZ TEST branches were used.

| Step in the lane's proof plan | Result | Evidence |
|---|---|---|
| Before landing: ZZ TEST Print Bare opened on the old code, with no template rows | Done on the old code. It still had 0 rows after the deploy. | `../s707-before-bare-branch-old-code.png`, `staging-receipt.json` (`rowsBefore: 0`) |
| 1. Bare branch shows the "no saved print templates" note with "Create missing templates" | Pass | `s707-01-bare-branch-banner.png` |
| 2. Press it: six cards, note gone, a card opens and can be edited | Pass (receipt footer edited and saved) | `s707-02`, `s707-03`, `s707-04` |
| 3. ZZ TEST Print New created on Organisation > Branches has six cards at once, no note | Pass | `s707-06-new-branch-form.png`, `s707-07-new-branch-six-templates-at-once.png` |
| 4. Six `print_template.create` audit rows per ZZ branch, by the actor who pressed or created | Pass: 6 and 6, one per type, all by the signed-in admin | `s707-08`, `s707-09`, `staging-receipt.json` (`steps.audit`) |
| 5. Replay create-missing with a fresh key: `created` empty, rows unchanged | Pass: HTTP 200, `created: []`, rows identical | `staging-receipt.json` (`steps.bare.step5`) |
| 6. Edited footer kept | Pass, read in the editor after the replay and after a reload | `s707-05-footer-kept-after-second-run.png` |
| 7. Archive both ZZ branches | Done: both are archived and missing from the active list | `staging-receipt.json` (`cleanup`) |

Robinson Chalong (six templates) and Demo Branch 2 (none) were read only, and the
button was not pressed on either. Archiving a branch does not remove its OTO App
branch row. Each ZZ branch's app row stays linked to the archived branch, as
`packages/db/src/schema/otoapp.ts` intends.

Jira: the images are attached to SCRUM-707 and shown inside comment 13374
(`jira-publication.json`, wording in `jira-proof-comment.txt`). `jira.mjs walk`
moved the ticket to Deployed and linked 2 commits. A fresh read confirms Deployed.
The scripts are kept as readable copies in `scripts/`. They read sign-ins from
environment names only.
