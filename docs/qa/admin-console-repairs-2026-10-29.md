# Admin Console audit repairs — 29 October 2026

**Latest verification checkpoint:** Main014e70b093a23b7a273b2542ad7ca26cf217fee5 is six-job CI green (40740795999); its Inbox work is untouched. SCRUM-680 candidate165c75f956327984d72fc95710b9e34c81638ae7 is pushed only to lane/admin680-release-20261029 and running full CI40742848228. New-base workspace compilers (16 tasks), generated contracts,170 nearby API tests,10 seam checks and changed-file lint pass; original-base whole API shards remain active. No680 source is on main or staging. SCRUM-681 final original-base browser337/337, units497 plus three inherited TODOs, all three compilers and lint passed; its local commit48669dce is rebased over014e. The newer-base repeat passed336 but hit one Chromium ERR_NO_BUFFER_SPACE at Menu navigation before its assertion; this is preserved as a failed run and will be repeated, not called green. No test was weakened.682 API contracts are committed locally as8a5b83de over681, with445 native/guard checks; generated-call migration and the shared error presenter now build in separate682-api and682-ui lanes.683 payment discovery, Tenders/Configuration/Money filters passed six native browser cases and are locally committed as6107262d over681; Devices filters now build on that fixed state. Device status/search refine boxes and stations only, using native box status, with existing other device panels kept honest. All680-683 remain In Progress;679 remains Testing. Root owns docs/Jira/Git and release order680→681→682→683. Local memory pressure prompted a hold on new browser/database launches while owned heavy tests finish; source work and bounded pure checks continue. No owner/planner question is pending. Docker stays off; no real payment/SMS/provider/hardware change. After680 candidate/full gates, land/main CI/Render/staging proof, then repeat for681 and integrate682/683. Do not resume old C:/w lanes.

The owner approved all four parts of the [completed audit plan](admin-console-audit-2026-10-29.md). This record tracks implementation and verification separately from that immutable audit snapshot. Jira parent: SCRUM-679. No repair in this record is claimed live until its own deployment and staging evidence are recorded.

| Ticket | Approved change | Current evidence |
| --- | --- | --- |
| SCRUM-680 | Tax reference ownership, useful refusals and accurate tender archive wording | Local repair; full release gate in progress. Details below. |
| SCRUM-681 | Correct selected-park/booth state, failed-read states and pagination; repair reproduced timing cases | Nine browser defects reproduced and repaired; 336 existing/new browser cases passed. A further rapid A→B→A park-switch defect was then reproduced and is being repaired. Not live. |
| SCRUM-682 | Actionable safe errors, distinct missing endpoints and twelve lossless operations response contracts | API work has 21 focused checks passing after 16 failures/five native controls. Broader API gates and shared-screen integration remain. Not live. |
| SCRUM-683 | Existing payment destinations, Tenders/Devices/Configuration filters and Money attention views | Independent display work started. Devices follows the completed park-state repair. Not live. |

## SCRUM-680

The native tax-override route accepted references outside the working operator or selected park. It now checks the category's operator and the product's operator plus selected park before inserting in the existing transaction. Products with no park remain shared as before. Missing and foreign references both answer `404 NOT_FOUND`, with “Category not found” or “Product not found”; the response does not reveal another operator's records.

Adversarial testing also found that the existing global idempotency hook could return a cached success after the caller lost tax-management permission. This route now rechecks that same target permission before a cached answer. Malformed inputs retain the existing validation response, and the existing route permission declaration remains. This is a repair to this route; it makes no claim about every other route's replay timing.

The unchanged success shape now has an output schema. Used-tender documentation now describes the existing archive behavior and retained payment history. No migration, tax formula, payment rule, provider operation or generic permission/idempotency plugin was changed.

Local evidence in `C:/oto-lanes/admin680-evidence-20261029/`:

- The identical 16-case review file went from eight failures/eight passing controls to 16 passes. Coverage includes foreign, missing and sibling-park references; own/shared references; malformed inputs and rate bounds; body/header replay; permission revocation; audit rollback and retry; and the output contract.
- Eight whole nearby API files pass 170 checks, including the four required route guards. API-types has ten passes. Both package compiler scripts, generated-contract comparison and changed-file lint pass.
- `focused-handoff-v1.json` SHA-256: `3eb1d190c55657acfaf89bd5784110890ad9f979e6b5e8d1b20c1848a5a54e06`.
- `artifact-index-v1.json` SHA-256: `723f9ecd75fa8093a6643a391bcefcd40976d5ccca8d034000eb2ef521bbf399`.
- The three whole-API shards on the original base are still running. Release validation is separately running over the planner's newer main `014e70b093a23b7a273b2542ad7ca26cf217fee5`. Earlier-base passes will not be represented as checks of that newer source.

Staging acceptance is prepared but not executed: native Tax-page reads plus missing category/product refusals, a before/after override-content comparison and a labelled response card. Foreign-record, cached-permission and rollback faults stay local. No payment, provider or hardware action is required. Every captured frame must follow the exact green source deployment; it must be inspected and attached before Deployed.

## Coordination and limits

Root owns shared documentation, Git, Jira and release integration. Separate workers own 680 API, 681 page state, 682 API contracts and 683 non-overlapping display files. Landing order stays 680 → 681 → 682 → 683, with each preceding ticket Deployed before the next landing.

Q28 is withdrawn: the approved plan already requires compatible callers for the explicit missing-route code. The narrow POS predicate compatibility update is covered; no new ruling is pending. Other POS business behavior stays outside this work.

Docker stays off. Private embedded databases and captured adapters serve local tests. Existing descopes/follow-ups (649, 672–675 and the 648 app-banner gap) remain separate. The owner alone moves tickets to Done.
