# Round 8 scheduled-job recovery evidence - 13 October 2026

**WORKS for the four recorded retries and current job read-back.** The root operator sent sequential authenticated Console API requests to `/api/ops/runs/<recorded-run-id>/retry`. All four returned HTTP 200 with `outcome: ok`, followed by fresh Health reads with status and lastOutcome both `ok`. This records Console API operation; no Retry button click is claimed.

| Job | Recorded failed run retried | Successful run | Success time UTC |
| --- | --- | --- | --- |
| job:otoapp.attention | `01a13351-4f1f-78cf-a779-71c767a3db99` | `01a13406-9fca-768a-8fb8-6eefcee7e9fe` | 2026-10-13T06:50:11.786Z |
| job:otoapp.presence | `01a13351-4d01-7be1-8186-25a96114305a` | `01a13406-a495-7c8d-b3d7-0452b2a1ac74` | 2026-10-13T06:50:13.013Z |
| job:otoapp.midnight | `01a133cc-e5be-7a80-bc29-5c6c123d0cff` | `01a13406-a903-75f4-9bed-59c428295967` | 2026-10-13T06:50:14.147Z |
| job:otoapp.reconcile | `01a133cc-e5c0-7fa1-b996-ed1bec384b8b` | `01a13406-acb8-79a7-bca9-a466da4eeac0` | 2026-10-13T06:50:15.096Z |

The independent read-only job `job-db6t9m8m7kps73b9tbl0` succeeded and captured `ops_last` plus its current run at **2026-10-13 06:51:39.381 UTC / 13:51:39.381 Bangkok**. All five app jobs had `last_outcome = ok`, `run_outcome = ok`, `last_ok_at = last_finished_at`, zero failed park groups and zero unkeyed park groups.

- Attention and presence reported the configured park group's batch as `ran`, with no failed steps.
- Midnight and reconcile reported `done`: their successful-per-Bangkok-day guard recognized work already completed. The retries confirmed the guard and fresh successful job records; they did not rerun those daily batches.
- No-show was also current and successful, last success **06:42:08.613 UTC**, with a `ran` group. No manual no-show retry was part of this four-job sequence.

## Earlier failure-and-recovery record

The saved historical read-back confirms the presence test failure `OTOAPP_JOB_FORCED_FAILURE` at **8 October 15:14:14.676 UTC**, run `01a11c14-4c14-7049-af55-0352f4cea748`. Its recorded Retry succeeded at **15:14:43.330 UTC**, run `01a11c14-bc02-7351-8668-a3b3b8133e60`, with matching retry history at **15:14:43.336 UTC**.

It also confirms Attention's `OTOAPP_JOB_NOT_FOUND` result at **8 October 20:38:36.250 UTC**, run `01a11d3d-41da-7b5f-ab7b-c2019bba01a2`, followed by successful recorded Retry at **20:46:34.567 UTC**, run `01a11d44-8e47-7e3a-a5a6-d9fb84242893`.

## Screen and remaining boundaries

[r8-health-jobs-staging-20261013.png](../../jira-comments/attachments/SCRUM-193/r8-health-jobs-staging-20261013.png) was visually inspected before attachment. It shows the four target rows with green `ok` outcomes and 13 October 13:50 Bangkok last-run times, plus a later successful no-show tick. It also retains a separate historical `job:demo.fail` entry, so the image does not establish that every job or the whole deployment is healthy.

Sources: `r8-final-job-proof.json`, `r8-current-last-success-result.json`, `r8-health-history-result.json`, and the actual Console Health screenshot. The historical records establish the earlier failure/retry events; the current results establish today's successful read-back.

Parent cleanup subsequently completed; the [cleanup record](cleanup.md) states its exact preservation proof and later employee-row observation. These job results do not establish that the umbrella story is closed. 

The inspected labelled test-run card is [r8-job-recovery-staging-20261013.png](../../jira-comments/attachments/SCRUM-193/r8-job-recovery-staging-20261013.png).
