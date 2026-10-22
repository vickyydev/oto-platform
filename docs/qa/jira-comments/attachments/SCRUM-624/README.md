# SCRUM-624 Care and print acceptance

Jira is Deployed with acceptance comment 12509 and attachments 11974, 11975, 11976, 11977. The owner retains Done acceptance. Source `4dd7eb94b4af383c40cb512229b2ea1ad9283451` passed all six jobs in [CI 39852030074](https://github.com/vickyydev/oto-platform/actions/runs/39852030074) and is live automatically on API, Console and POS. Parent SCRUM-618 remains In Progress.

Admin now hosts the existing Care, Print templates and Staff benefits controls through narrow ports. POS wrappers and old addresses remain. The print host uses an explicit same-park station choice; changing that choice cancels older save-to-print continuations while retaining the draft. Q6, Q7 and Q8 record the scoped response-schema, benefit-target and POS test authorizations.

| Staging image | Native check | Captured UTC |
|---|---|---|
| [SCRUM-624-05-v2-care-pricing-desktop.png](SCRUM-624-05-v2-care-pricing-desktop.png) | native drop-off pricing controls | 2026-10-22T21:15:03.356Z |
| [SCRUM-624-06-v2-receipt-preview-desktop.png](SCRUM-624-06-v2-receipt-preview-desktop.png) | Reception Till 1 receipt PNG and read-only destination; no save or physical print | 2026-10-22T21:15:13.990Z |
| [SCRUM-624-07-v2-benefit-templates-desktop.png](SCRUM-624-07-v2-benefit-templates-desktop.png) | native role template controls; no staff or QR opened | 2026-10-22T21:15:19.179Z |
| [SCRUM-624-09-supervision-phone.png](SCRUM-624-09-supervision-phone.png) | native supervision age-band controls at 390px | 2026-10-22T21:23:48.244Z |

The accepted evidence combines the three desktop images from the incomplete V2 run with the completed focused phone recovery. The final audit verifies 33 pins and 11 recorded checks covering eight normalized areas. All four images are after the same exact-source deployments. Care, saved-template and benefit-template fingerprints remain equal across the runs; each demo session signs out with 200 and then /me returns 401. No business setting, station seat, physical print, benefit credential, payment or SMS was changed or sent. The receipt PNG uses the renderer fixture sample. The live nanny roster is excluded from the static Care comparison; cross-run preferences equality is not persisted, while each session enforces its own preferences equality and all preference writes are refused.

Local validation passes 153 built-browser cases, 1,433 POS tests, 104 shared-panel cases, 210 Console cases with three inherited todo, 10 API-type cases and 115 affected API review/inventory/guard cases with four inherited todo. All 16 compiler tasks, five builds, generated contracts and repository guards pass; full lint has zero errors and eight warnings. The local-results receipt preserves the original failed runs, corrected whole-file replacements and unchanged-input coverage, including 4,752 current API cases and Box 749. Fresh exact-source CI is recorded separately.

Both incomplete staging attempts remain immutable: the first refused the public browser icon before any image; V2 captured three native screens before its caption-placement guard refused the phone image. The icon regression and the actual native phone before/after measurement reproduce those helper faults. Recovery changes only the evidence scroll position, with the original bounds, caption and overflow checks retained. Save, refusal, retry identity and foreign-park behavior were tested locally; staging acceptance used read-only controls and previews. The parent P2 actual Till price/tender/tax round trip remains separate.
