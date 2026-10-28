# Admin Console audit and approved repair plan

**SCRUM-679 — audit complete; owner approved the full repair plan on 29 October 2026. Implementation is active.**

The developed Console loads on staging, but its error and changing-selection paths need repairs. This audit found nine failing diagnostic assertions, plus output-contract debt and several usability improvements. No product fix, business rule, migration, provider setting or staging business record was changed during the audit.

The audit ran on 28 October UTC, finishing after midnight on **29 October 2026 in Bangkok**. Source checkout: `5da2fe226a3fec8f4d9c725deba9428d040275b0`; its product bytes match deployed `adce7c4feac9f9989056e34ec42bc86f5c3da5a2`. Main CI `40716035735` has six successful jobs on that full SHA. API deployment `dep-dbh1itp5efls73b84gmg` and Console deployment `dep-dbh1itp5efls73b84hog` were verified live before and after observation.

## Payment controls that exist today

| Need | Where | Current capability |
| --- | --- | --- |
| Choose accepted payment methods | Catalogue & money → Tenders | Add and rename methods; select cash/card/QR/other; enable, disable, order and archive. Archiving preserves payment history. These settings apply across the operator. |
| Choose how one station takes money | Devices → station drawer → How money reaches it | Card terminal/manual; QR gateway/terminal/not taken; cash drawer/not taken. Also a per-station offline wallet cap; blank uses the platform default. Hardware routing was source-reviewed, not exercised against equipment. |
| Configure tax and service charges | Catalogue & money → Tax | Named rates and per-area tax/service rules, scoped to a park. The API also has category/product overrides; the ownership issue below concerns that API seam. |
| Discounts and prices | Catalogue & money | Discounts, voucher campaigns and event pricing. Manual discount reasons remain tab-local. Discount usage counts come from persisted finalised sales across the operator; the current tab-only banner is stale. |
| Review money | Reports → Money | Read-only sales, refunds/voids, cash differences, settlement, wallet liability and voucher/benefit cost; investigation needs its separate permission. |
| Count cash and close/reconcile a day | POS → End of Day | Existing POS operations. The Console does not add another payment or cash-close writer. |
| Import settlement evidence | Watch → Integrations | The documented fixture-format CSV import exists. It is not a general importer for arbitrary bank/provider files. No import ran during this audit. |
| Change gateway provider/credentials/timeouts | Deployment configuration | No Console credential editor. Secret values are never returned by this audit. |
| Emergency payment kill switches | Releases catalogue | **NOT BUILT/integrated:** QR disable, card disable and force-manual flags have `supported:false`; they do not currently control the till. These differ from working tender enable/disable and station routing. |

The most useful payment change is to make the existing doors easier to find and clearly label their authority and limits. Adding gateway administration or wiring emergency payment switches is a separate feature, not an error-message fix.

## What was checked

| Evidence | Result | Limit |
| --- | --- | --- |
| Every canonical internal Console address | **66/66** default views reached on native staging; 57 detail routes and nine area roots | Drawers and every possible user/park/input combination were not all exercised live. External Inbox, Radar, OTO App and POS doors are not counted as internal pages. |
| Native staging requests | **685 HTTP 200 responses**, 101 normalized method/path combinations, no browser script errors | Includes repeated bootstrap reads and seven pure fixture-preview POSTs. It is not 685 distinct endpoints or a complete mutation test. |
| Staging attempt integrity | Initial 64 complete views; seven preview requests across two pages blocked by the audit's write guard, then both pages passed a separately recorded follow-up | Original incomplete attempt is preserved. Source review confirmed the preview routes render samples without saving templates or sending a print job. |
| Existing Console-facing API suites | **675 passed across 47 whole files**, including all four route guards, 102 guard assertions | Selected relevant suites, not a fresh full API battery. |
| Existing payment/tax/settlement API suites | **53 passed across four whole files** | Private fixtures and captured adapters; no real payment, provider, cash close or terminal. |
| Existing frontend units | **490 Console + 120 shared-screen passes**; three inherited Console TODOs | Existing tests unchanged. |
| Existing built-browser flows | **327 passed** | Private embedded PostgreSQL and built Console/POS servers. |
| New diagnostics | **18 cases: nine passing controls and nine failing behavior assertions** | Three native API failures and six UI failures. UI faults used controlled responses in the real built page, not staging fault injection. |
| API source inventory | 109 literal route registrations across 26 core families; separate payment capability/contract matrix | Does not claim an exhaustive status/input cross-product for every route or every dynamic registration. |

There were **1,665 passing existing checks** across those API, unit and browser sets. Their success does not erase the new failing assertions. All original product and existing test bytes stayed unchanged. Temporary diagnostic tests were preserved outside the source tree, then removed. The first two UI diagnostic attempts contained test-harness selector/PNG-routing errors; those attempts are retained and are not counted as product findings. The final six-case run reached all intended assertions.

The live check was 16:54:16–17:00:12 UTC. Fourteen inspected, privacy-masked partial-viewport PNGs are committed under [SCRUM-679 evidence](jira-comments/attachments/SCRUM-679/). Both exact staging sessions were signed out (200), and their original cookies then received 401. No real payment, SMS, provider test, print job, device setting, channel mode or protected record was changed. Docker stayed off; private test resources were stopped. Read-audit/session records generated by normal reads are expected.

The OTO App's own code, dependencies and CI checks are unchanged from the verified source gate. Fresh platform staff tests use captured upstream responses. This is **not** a fresh full OTO App, Inbox or Radar application audit or hardware/payment certification.

## Confirmed behavior findings

| ID / priority | Observed result and impact | Proposed repair and acceptance |
| --- | --- | --- |
| PAY-01 / medium | Own-branch tax override accepts a foreign operator's **category**, returns 200 and persists its ID. No foreign-value disclosure was demonstrated. | Check reference ownership in the native transaction before inserting. Own category succeeds; foreign/missing category is refused consistently with no row. Add product parity and rollback controls before the repair. Product ownership is currently source-only, not an independently reproduced failure. |
| PAY-02 / medium | A nonexistent category returns 500 `INTERNAL` / “Internal server error” instead of an input/reference refusal. No row persists. | Same bounded reference check gives a useful 404 before the FK failure. Preserve sanitized handling of genuinely unexpected server errors. |
| API-01 / medium | An unknown API route returns Fastify's string `error`/`statusCode` body instead of the shared `{error:{code,message}}` envelope. The Console falls back to `UNKNOWN`. | Add a distinct stable route-not-found code and the existing envelope; retain `x-request-id`, avoid echoing query values, and keep missing-record 404 separate. Update compatible callers together. |
| UI-01 / medium | A delayed Booth A versions response replaces the history shown after selecting Booth B in the same park. | Bind replies to the selected booth/request and discard obsolete results. Test delayed success and failure, refresh, selection change and unmount. No selected-B history may contain A's versions. |
| UI-02 / medium | Native `BOOTH_NOT_FOUND` 404 is described as a feature/route not deployed, hiding the useful missing-record reason. | Fix status-only `isMissingRoute`; identify an absent route by a reliable code, preserve actual record refusal and offer reload/reselect. Verify compatibility with lifted-screen callers. |
| UI-03 / low | A shrinking voucher result at offset 50 with total 1 and no rows renders **“51–50 of 1”**. | Reset or clamp the page after a changed result; preserve filters and totals, show a valid empty/count range, and test the previous-page path. |
| UI-04 / medium | After selecting Park B, Park A's fleet remains visible under B while B's response is pending. | Clear or explicitly label retained data at the selection boundary and bind all boxes/stations/credentials replies to that park/request. Old rows and actions must not appear current for B. |
| UI-05 / medium | Failed first boxes read displays “No box at this branch yet” alongside a failure banner. | Keep unread/failed distinct from successfully empty. Show why the list is unavailable and a retry; only successful empty reads can invite creation as an empty-register state. |
| UI-06 / medium | Failed first stations read similarly displays “No stations yet.” | Same per-resource availability rule; preserve independently successful reads. |

Primary anchors: `apps/api/src/routes/catalog.ts:1035`, `apps/api/src/app.ts:310`, `apps/console/src/api/client.ts:31`, `apps/console/src/pages/Booths.tsx:253`, `apps/console/src/pages/Devices.tsx:526`, `apps/console/src/pages/Vouchers.tsx:309`. Exact native observations and source bindings are in the evidence reports. The Booth-history assertion/log is primary proof because its failing history is below the screenshot's partial viewport.

## Source-established gaps and candidates

These are separate from the nine reproduced behavior failures.

- **Twelve legacy ops JSON endpoints lack response schemas.** They cover alert acknowledgement, failures/runs, retry, quarantine/anomalies, replay/discard, test controls and demo-reset reads/writes. Existing guards pass through their legacy allowances; that is not output validation. Add lossless schemas and generated aliases without changing fields, scope, null/unknown states or behavior. Binary exports/previews remain explicit binary contracts. No malformed live output from these twelve routes was demonstrated.
- **Tender archive wording is stale.** The route description/older inventory says used tenders are refused; approved code and 24 passing tests archive them with confirmation and preserve history. Correct the text, not the behavior.
- **Permission guidance names a removed page.** `Panel.tsx:205` and `Booths.tsx:746` still direct staff to the Login Users panel. Point to People & access → Accounts / Roles & scopes without changing grants.
- **Discount usage guidance is stale.** `DiscountCodesSection.tsx:246` says usage is tab-only and the report is not built. `routes/menu.ts:779` counts distinct persisted finalised sales for the operator since the definition's creation; the mapper retains it, and the promo report separates cumulative usage from date/park-filtered value. Correct the banner to that actual basis. This was confirmed from source, not a new native runtime case; manual discount reasons remain separately tab-local. The earlier payment sub-report is superseded on this one wording point by the addendum.
- **Validation and correlation are underused in the UI.** The API supplies field details for 400 and a correlation header for every tested error. The common Console error object/panel does not generally turn those into field-level guidance or a copyable reference. This is source-backed improvement scope; it is not an allegation that every form loses its reason.
- **Activity export race, Related-row truncation, maintenance drawer race:** source review found a captured-key self-comparison in Activity export, an unpaged 200-row Related query followed by an “only row” claim, and an old maintenance completion able to close a replacement drawer under the same actor. These are **candidates requiring a bounded failing browser test before repair**, not confirmed native failures. Do not change behavior merely on this inspection.

Known prior deferrals stay separate: SCRUM-649 data tools; SCRUM-672 deployment-event CI wiring; SCRUM-673 OTO App schedule-audit impersonation attribution; SCRUM-674 three Support readers; SCRUM-675/Q27 Stage 2 dated cutover and unfreeze awaiting the legacy dump; the Inbox/Radar/OTO App view-as banners recorded on SCRUM-648. This audit does not reopen their approved scope or declare them delivered.

## Approved work

### A. Correct the reproduced data and state problems first

1. Repair PAY-01/PAY-02 together in the category/product reference seam. Keep tax rates/calculations and all payment rules unchanged.
2. Repair the six reproduced UI cases. Retain the existing pages and workflows. Confirm the three source-only race/truncation candidates with failing tests first; fix only those that reproduce, documenting any non-reproduction.
3. Correct used-tender archive documentation.

Acceptance: the preserved negative cases pass unchanged after repair, positive controls stay green, obsolete replies cannot replace the current selection, and failed reads never claim zero/empty. Backend tax and frontend state work can run in independent lanes; one integrator owns shared docs and landing.

### B. Give failures useful, safe explanations

Use a shared small error presenter across the existing Console/shared-screen seams, retaining domain-specific wording. Present the **action, reason and next step**, with an optional support reference. Do not expose stacks, SQL, submitted private values or provider credentials.

| Situation | Intended message behavior |
| --- | --- |
| Invalid field | Name the field and safe validation reason; retain the draft and focus the field. Example: “Enter a search value.” |
| Signed out or locked | Use the existing sign-in/unlock recovery; do not leave panels issuing repeated vague alerts. |
| Missing permission | Name the unavailable action in ordinary words and how to request access; keep technical permission details secondary. |
| Missing record | Say the item is no longer available in the selected context and offer reload/reselect. Never claim its feature is not deployed. |
| Conflict or changed context | Explain what changed, retain the draft where safe, and require a fresh read before resubmission. |
| Rate limit | Preserve the actual wait/retry information from the API. |
| Read outage | “Could not load [list]. Try again.” Retained data must be marked with its last successful read time and scope. |
| Confirmed save followed by failed refresh | State that the save succeeded and the list could not refresh; retry the read, not the write. |
| Unexpected server/network failure | Safe context and a copyable request reference where available. Do not invent a cause or advise repeating an uncertain payment/action. |

Add the distinct unknown-route envelope and all twelve lossless ops response schemas; regenerate contracts and update/prune the corresponding legacy allowances without weakening a guard. Coordinate error-code changes with both Console and lifted-screen clients. Add field/error/uncertain-outcome browser cases using private fixtures/captured adapters. Keep unexpected 500 diagnostics private.

Correct the removed Login Users destination and stale discount-usage banner. Explain platform-wide authority when that is the actual refusal, rather than merely repeating a permission the person already holds. Make shared unread text name its actual resource; an answered refusal must not be described as a request that never answered or always as a box problem.

### C. Improve discovery and filtering without redesigning the screens

- Add a **Payments** group to the existing Catalogue/Configuration landing links: **Set up** (Tenders, Tax, station routing), **Operate in POS**, **Reconcile**, **Investigate** (Money/Support). Label editable, read-only, deployment-only and unavailable capabilities. Preserve all ten navigation areas, canonical/old URLs and permission gates.
- Add **name search and enabled/kind filters to Tenders**, refining the loaded operator list. Show how many of the loaded methods match; preserve order/archive rules.
- Add **online/offline/unclaimed and text refinements to Devices** within the selected park, reusing its existing type tabs. Apply only after UI-04/05/06 are repaired.
- Add **search and owner-app grouping to Configuration** where the current index has multiple setting families; retain the existing park filter and native destination permissions.
- Offer **attention-only row views in Money** for unmatched/no-file settlement and cash differences/not-counted states. State that these refine the loaded date/park range; overview totals and differing report date bases remain unchanged.
- Keep existing useful filters in Vouchers, Activity, reports and Teams/routing. Repair pagination/truncation claims before adding more filters. No blanket new filter on every page and no new cross-app settings writer.

These approved display/discovery changes preserve the existing business rules. The final UI matrix binds each route to an explicitly labelled family summary; controls listed for a family are not claimed to exist on every page in it. Check the actual target component before adding a filter so the approved work avoids duplication. No gateway credentials editor, new payment operation, emergency-switch integration or generic wallet-policy writer is included.

### D. Verify and deliver each approved unit

Use fresh independent lanes, red-first regressions, current package compiler scripts, whole relevant suites, changed-file lint and generated-contract checks. Retain the four route guards. Broaden to the required release battery before landing, fetch/rebase and inspect the commit list, watch main CI by full SHA, verify automatic Render deployment, then capture post-deploy staging evidence and walk Jira only to Deployed. No test is weakened to pass. Migrations are not anticipated; any destructive need or changed original-app/payment behavior requires a separate ruling.

Proposed implementation tickets are **SCRUM-680 (tax ownership/refusals), SCRUM-681 (page state and pagination), SCRUM-682 (messages and API contracts), and SCRUM-683 (payment discovery and filters)**. The owner approved A–D on 29 October 2026. **680–683 are In Progress in independent lanes; landing remains sequential.** Root integrates and lands in that order, with each unit proven through deployment. Existing delivered feature tickets remain Deployed. Original audit evidence remains the unchanged pre-approval snapshot; the newest STATUS block carries live implementation progress.

## Evidence and reproducibility

[Evidence index](jira-comments/attachments/SCRUM-679/20261029-audit/README.md) binds the stage receipts, route/page matrices, native API observations, unit/browser results, payment report and hashes. External detailed logs and preserved diagnostic sources remain at `C:/oto-lanes/admin-audit-evidence/`; the fresh audit worktree is `C:/oto-lanes/admin-audit-20261028` on `lane/admin-audit-20261028`. The original shared checkout, planner's Inbox sources and old `C:/w` lanes were not edited.
