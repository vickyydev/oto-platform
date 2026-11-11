# SCRUM-851 staging check — 11 November 2026

OTO App staging, deploy `dep-dbq9odbl550s73fev8i0`, live 16:50:41Z at
`930c4e82c930d71186aec891578d18483ed61a66` (`deploy-wait.json`); the signed-in
app reported that version before and after. Receipt `receipt.json`, script
`proof.mjs`. The document is the synthetic one-page PDF of the SCRUM-785
proof, uploaded as "ZZ TEST SCRUM-851 …".

| Step | Result | Values |
| --- | --- | --- |
| Upload the ZZ TEST PDF on the knowledge screen | Pass | 201, indexed |
| Press Generate SOP (the normal path) | Pass | 201 in 5.7 s, status draft, 4 steps, "SOP created successfully" |
| Draft opens in the SOP editor | Pass | 4 step cards |
| Clean-up | Pass | SOP deleted 204, read 404; PDF deleted 204, read 404; app and launcher sign-out 200, read 401 |

## The refusal is not shown here

It cannot be produced on staging without breaking a setting. Its proof is the
check `apps/oto-app/tests/s851-sop-refusal.check.ts`, and that check has not
run through in CI: in run 43061998617 (main at `d21a9dc39`) the `oto-app` job
fails at "The SOP from a document refusal checks" with `relation "tenants"
does not exist` at the check's first insert (`ci-oto-app-job-lines.txt`). The
step sits before "The otoapp schema, as the platform makes it" and the
migration step, so its database has no tables yet; every later step of the job
is skipped. In the same job the three SCRUM-851 lines of
`s785-model-sampling.check.ts` passed (the helper still rejects, what the log
takes, the route's text). Not fixed here.

For that reason the ticket's status is left at In Progress: pictures and one
comment are on it (`jira-proof.json`).

## Pictures (each opened before use)

`851-1-sop-created.png` (the "SOP Created" notice, user menu covered),
`851-2-sop-draft-steps.png` (the draft in the editor). No name, initials or
photo of a person is in frame.
