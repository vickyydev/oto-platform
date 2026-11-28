# HR production release check, 28 November 2026

[SCRUM-1083 — Live HR app: the BEO fixes of 23 November and the payroll fixes reach production](https://oto-suite-dev.atlassian.net/browse/SCRUM-1083) is In Progress. This is the pre-deployment record. Production still runs the old build.

| Service | Render live revision |
| --- | --- |
| HR staging, proposed target | `6cd1569d7fbe759d3e602c5d50c00e9184ff2c6d` |
| HR production, rollback target | `8870cabab83484eb1ac3a94557fd7b3582ee3767` |
| Platform API production | `5b9bf5b9a3d0a8bac2e1ca25e1b7fa7a105fc123` |

## What the park gets

| Source commit | Staff-facing consequence in this HR release |
| --- | --- |
| `62d796edb` | The BEO includes open additional bills in the balance and can carry a different adult serving time on the same kitchen item. |
| `bf60a2f36` | The BEO billing section uses the till's collection figure and prompts the birthday team to check the till when the figure is unavailable. Other parts of this platform commit belong to other apps. |
| `b7e002e1a` | A deposit notification can open its Inbox conversation. A BEO edit protects billed items when the till cannot verify their status. |
| `8356e9345` | The birthday team gets a retry message when the till cannot verify a price or quantity change. |
| `276c694d3` | Adds regression coverage of the paid-item guard. This commit introduces no staff control. |
| `57cae3e5a` | Reception’s shared closing checklist completes once its required answers and evidence are saved. Already present in live HR. |
| `6817b1a37` | The open checklist refreshes evidence entered by a colleague. Already present in live HR. |
| `224aa3db1` | Payroll names the reason a run stopped and points the operator to the relevant correction. |
| `b946a44c5` | Payroll can start a run from the Attendance tab and gives a shorter explanation of who was left out. |
| `123edc36c` | Managers see one outstanding stuck-clock alert per employee. Stale markers are closed. Already present in live HR. |
| `c0cfef571` | HR can request a reading of an incentive clause, correct it, review the example and approve a dated payroll rule. |
| `aa24dfbab` | The reader recognises a decimal comma followed by three digits as a decimal. |
| `5b309dd3a` | Adds fixed checks for the park’s incentive clauses. The deployed database receives no test employees, rules or pay figures from these fixtures. |

## Database and way back

Migration `0060_beo_adult_serving_time.sql` contains a single `CREATE OR REPLACE VIEW otoapp_v.event_packages`. It keeps the existing output columns and adds adult serving information inside the kitchen JSON. Replacing a view takes a PostgreSQL lock on the view. It does not rewrite stored party rows.

Migration `0061_payroll_incentive_clause_readings.sql` creates one empty table, a primary key, two indexes, checks and foreign keys. The foreign keys refer to tenants, users and employees, so those existing relations can briefly participate in DDL locks. It adds no reading, rule, assignment or historical payroll result. The two migrations completed together in 0.560 seconds on the production-sized copy with a two-second lock timeout. Live traffic can change the wait.

A managed logical export of the production database completed on 28 November at 18:16 Bangkok. The downloaded archive is 43,060,942 bytes, SHA-256 `94d7861c93e454ccd99087e1e88706e5bbc6e5952ee0d43b1f14d131768c9a53`. Its local folder has an explicit Windows access rule for the operator’s account. The archive and scratch data stay under `C:/oto-data/work/livehr-rehearsal-20261128/private/`. Render also reports point-in-time recovery available. The rehearsal archive contains a PostgreSQL 16.16 directory-format dump. For the tested restore, initialise a private loopback database, create the empty `otoapp` and `otoapp_v` schemas, and run `pg_restore --exit-on-error --no-owner --no-privileges --schema=otoapp --schema=otoapp_v` against that scratch database with the directory-format export. The schema filter omits creation of the two schemas themselves. A fresh backup is required immediately before a live deployment.

| Count | Private export | Live read-only query |
| --- | ---: | ---: |
| Employees | 80 | 80 |
| Raw attendance punches | 12,589 | 12,592 at the later live check |
| Attendance entries | 216 | 216 |
| All events | 263 | — |
| Party events | 172 | 172 |
| BEO billing records | 169 | 169 |
| Kitchen plans | 170 | 170 |
| Package snapshots | 5 | — |
| Payroll runs | 0 | 0 |
| Migration ledger entries | 58 | — |
| Access events due to dispatch | 0 | 0 |

The live counts above come from two read-only probes. Job `job-dc5bnbkipgvc73bp6b7g` checked raw punches separately from attendance entries. Three more punches existed after the backup, before any deployment. It also counted 70 active HR users, with one missing both sign-in phone fields after blank and null handling. The private export independently gives the same two user counts.

The intended rollback redeploys `oto-app-production` at the exact previous revision in the table above. The five recent successful HR releases took approximately three to four minutes each. The previous build booted on the migrated copy in 8.85 seconds. Render deployment time also includes building and replacing the service.

## API, settings and automatic work

The merged HR runtime introduces no new platform HTTP endpoint. The paid-line check used to skip a till read for certain kitchen records. It now uses the existing `GET /otoapp/parties/:eventId/billing` when verifying an edit. Production job `job-dc5bkbnf3r2c73e982b0` opened a read-only transaction and queried one existing birthday. The current production platform returned HTTP 200 with a recognised billing state, its paid lines, additional bills and unassigned tab. The job made no party or payment change. The target reports an unavailable verification as HTTP 503 with a retry instruction. Existing BEO deposit and menu reads continue through the unchanged deposit-request and party-menu catalogue GET routes. Those two routes were checked in the production source and were not replayed as part of the billing probe. The Inbox change follows a launcher link only after a staff member opens a notification.

The clause reader uses the existing HR Anthropic integration. The production HR service has `ANTHROPIC_API_KEY`. The optional `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and `ANTHROPIC_FAST_MODEL` settings are absent. The code supplies defaults. The reader runs when an authorised person requests a reading. If its key is missing, the manual correction remains available and payroll’s month calculation does not invoke the model. No production clause was sent to an AI provider for this release check.

Both HR revisions start with the same Docker command, server entry, business-job scheduler and login-lifecycle dispatcher. Business timers are delegated to the platform. An existing dispatcher inspects the access queue at boot and every 30 seconds. The snapshot had five historical events and none pending. The production platform **already has night jobs enabled**, as the 21 November cutover records in `fb45e7edb`. The directory endpoint and park-job key are present today. This conflicts with the earlier assumption that all night jobs were held. The HR update adds no new timer or automatic guest/staff message. It adds no payment trigger. The production platform's default payment integration is configured for the gateway sandbox. The check sent no payment request.

## Rehearsal and live verification

Both server bundles were built locally from the exact revisions. Each used the HTML, scripts and styles from the matching deployed app. The scratch runner bound PostgreSQL and HTTP to loopback, used disposable credentials and blocked external server and browser connections. The last complete run restored the private export in 5.86 seconds. Both migrations completed in 0.560 seconds with a two-second lock timeout. The migration ledger advanced from 58 to 60.

All eleven business counts matched before the migration, after it and after running the old build on the migrated data. The copy contained 80 employees, 12,589 attendance punches, 216 attendance entries, 263 events including 172 parties, 169 BEO billing records, 170 kitchen plans and five package snapshots. The legacy payroll runs, month runs and run versions each contained zero rows.

On both builds a synthetic user signed in and opened a stored birthday's BEO, its Day-of panel and Payroll. Payroll correctly showed the setup prompt because the live copy contained no configured paying company. A registered synthetic tablet displayed the clock button. The target became healthy in 6.82 seconds and passed the last screen in 10.58 seconds. The rollback build became healthy in 8.85 seconds and passed the last screen in 13.07 seconds. At least 3,987 MiB remained available during the rehearsal. The private scratch database and app were shut down.

Before deployment, take another Render export and retain it privately as above. Allow three to four minutes for Render to redeploy the old build if rollback is necessary. The planned window is 22:30 Bangkok, subject to checking current park activity. The owner confirmed the staff browser and registered tablet will be unavailable tonight. Existing production schedules continue. Staff will see the corrected BEO and Day-of details, the payroll fixes and the contract clause reader.

The public HR status route returned HTTP 200 in both environments and omitted its Render commit. Tie release identity to Render's live deployment and verify its served assets or authenticated QA configuration. The current production entry script matched the rehearsed rollback build. Its SHA-256 is `f681fd0a998b955cab71c48c366fe45fb47db62dfe0014055df1c5622ea78a8f`. The target?s staging entry script is `4afb779512381a2e5142b8c63f7904d251c69de8d5f3a6027181d24713497e35`. The preflight also verified production public health and the read-only party billing API.

The old build logged successful signed-in reads on 28 November for the HR session at 18:39 Bangkok, a BEO at 18:04 and the Day-of timeline at 12:00. Payroll Setup had a successful signed-in read at 15:11 on 26 November. The public tablet branch route responded at 18:44 on 28 November. After release, check Render?s live revision, the served script, the database ledger and business counts, the billing bridge and any new protected staff requests. Report the private screens and physical clock as unwitnessed wherever they could not be opened. A failed compatibility check triggers rollback. Put masked production pictures on Jira only.

## Birthday team note, ready after the live release is verified

Birthday team, please open an existing party on the live HR app. Check its BEO and then open Day-of. The BEO now uses the till?s collection figure, includes open additional bills and shows a separate adult serving time when one has been set. If the till cannot verify a billed item, the screen asks you to retry.

Please send one ticket for each discrepancy. Tell us which screen you opened, what you expected and what you saw. We will answer each point as works, broken or not built. [Live HR app](https://app.otoplay.org/)
