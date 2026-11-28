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

Migration `0061_payroll_incentive_clause_readings.sql` creates one empty table, a primary key, two indexes, checks and foreign keys. The foreign keys refer to tenants, users and employees, so those existing relations can briefly participate in DDL locks. It adds no reading, rule, assignment or historical payroll result. Exact migration time and lock behaviour on the production-sized copy still require the rehearsal.

A managed logical export of the production database completed on 28 November at 18:16 Bangkok. The downloaded archive is 43,060,942 bytes, SHA-256 `94d7861c93e454ccd99087e1e88706e5bbc6e5952ee0d43b1f14d131768c9a53`. Its local folder has an explicit Windows access rule for the operator’s account. The archive and scratch data stay under `C:/oto-data/work/livehr-rehearsal-20261128/private/`. Render also reports point-in-time recovery available. The rehearsal archive contains a PostgreSQL 16.16 directory-format dump. Restore its `otoapp` and `otoapp_v` schemas to a new empty, isolated PostgreSQL scratch database with `pg_restore --no-owner --no-privileges`. Never apply that rehearsal command against production. A fresh backup is required immediately before a live deployment.

| Count | Private export | Live read-only query |
| --- | ---: | ---: |
| Employees | 80 | 80 |
| Attendance entries | 216 | 216 |
| All events | 263 | — |
| Party events | 172 | 172 |
| BEO billing records | 169 | 169 |
| Kitchen plans | 170 | 170 |
| Package snapshots | 5 | — |
| Payroll runs | 0 | 0 |
| Migration ledger entries | 58 | — |
| Access events due to dispatch | 0 | 0 |

The intended rollback redeploys `oto-app-production` at the exact previous revision in the table above. The five recent successful HR releases took approximately three to four minutes each. This is deployment history. Booting the previous build against the migrated scratch database is required before relying on that rollback.

## API, settings and automatic work

The merged HR runtime introduces no new platform HTTP endpoint. The paid-line check used to skip a till read for certain kitchen records. It now uses the existing `GET /otoapp/parties/:eventId/billing` when verifying an edit. Production job `job-dc5bkbnf3r2c73e982b0` opened a read-only transaction and queried one existing birthday. The current production platform returned HTTP 200 with a recognised billing state, its paid lines, additional bills and unassigned tab. The job made no party or payment change. The target reports an unavailable verification as HTTP 503 with a retry instruction. Existing BEO deposit and menu reads continue through the unchanged deposit-request and party-menu catalogue GET routes. Those two routes were checked in the production source and were not replayed as part of the billing probe. The Inbox change follows a launcher link only after a staff member opens a notification.

The clause reader uses the existing HR Anthropic integration. The production HR service has `ANTHROPIC_API_KEY`. The optional `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and `ANTHROPIC_FAST_MODEL` settings are absent. The code supplies defaults. The reader runs when an authorised person requests a reading. If its key is missing, the manual correction remains available and payroll’s month calculation does not invoke the model. No production clause was sent to an AI provider for this release check.

Both HR revisions start with the same Docker command, server entry, business-job scheduler and login-lifecycle dispatcher. Business timers are delegated to the platform. An existing dispatcher inspects the access queue at boot and every 30 seconds. The snapshot had five historical events and none pending. The production platform **already has night jobs enabled**, as the 21 November cutover records in `fb45e7edb`. The directory endpoint and park-job key are present today. This conflicts with the earlier assumption that all night jobs were held. The HR update adds no new timer or automatic guest/staff message. It adds no payment trigger. The production platform's default payment integration is configured for the gateway sandbox. The check sent no payment request.

## Rehearsal and live verification

Both server bundles were built locally from the exact revisions. The HTML, scripts and styles served by the corresponding live staging and production apps were copied into their separate rehearsal directories. The scratch runner binds PostgreSQL and HTTP to loopback, generates disposable credentials, omits live integration settings, and blocks external server and browser connections. The browser will use a synthetic account and tablet on the copy.

The production-sized migration, the local page checks and booting the old HR build on the migrated data remain pending the laptop’s memory reserve. The public HR status route returned HTTP 200 in both environments, but neither exposed its Render commit in the public version/change fields. Tie a release to its Render live deployment and verify its served assets or authenticated QA configuration. Live verification also requires an authorised session to read BEO, Day-of and Payroll, and a registered tablet to check the clock. Never use the stored outdated production administrator password.
