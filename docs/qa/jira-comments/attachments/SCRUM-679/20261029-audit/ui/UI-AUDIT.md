# SCRUM-679 frontend audit

Audit only; implementation awaits the owner's approval. Source is the fresh5da2fe22 audit checkpoint. No production implementation changed. This lane made no staging authentication or provider/business action.

## Coverage and observed checks

66canonical routes:57registered detail pages and9distinct area roots across10sections;113detail canonical/alias paths. The inventory hashes317Console/AdminScreens source files and indexes3117visible JSX text fragments. This is a complete route registration and machine-extracted message inventory, not a claim that every message fragment was semantically reviewed or every dynamic state fault-injected. The JSON inventories routes individually and links them to family-level controls/state summaries; those summaries do not assert that every listed capability belongs to each page. Payment/API deep-dives belong to the other audit lanes.

Existing controls: Console490pass/3existingTODO(48files), AdminScreens120pass(16files), and root's full327existing built-browser cases pass. Initial audit run had2genuine failures plus1ambiguous Refresh locator. Six-case v2 had4genuine failures plus2harness/mixed stops. After harness-only corrections, v3 reaches all6intended assertions and fails them on unchanged production bytes. The package returns nativeExitCode0 despite failed Playwright cases; the outer audit runner correctly exits1. All original receipts/logs remain unchanged.

## Confirmed native findings

| ID | Priority | Finding | Probe |
| --- | --- | --- | --- |
| UI-B1 | P2 | A previous booth history replaces the selected booth history | 1 |
| UI-B2 | P2 | Old park equipment remains under a newly selected park | 4 |
| UI-B3 | P2 | Failed equipment reads make false empty-register claims | 5, 6 |
| UI-B4 | P2 | Missing record404 is presented as an undeployed API | 2 |
| UI-B5 | P3 | A shrinking ledger produces an inverted range and misleading empty text | 3 |

### UI-B1: A previous booth history replaces the selected booth history

Hold A version refresh, select B, observe B history, release A. B history disappears after the old A result. Same actor/operator/park throughout; global authority protection does not cover booth selection.

Source: apps/console/src/pages/Booths.tsx:253, apps/console/src/pages/Booths.tsx:277.

Proposed correction for approval: Bind all booth/list/detail reads and post-write refreshes to a monotonic selected-target/request generation, retaining independent read errors. Preserve API authority and native presentation.

### UI-B2: Old park equipment remains under a newly selected park

Read park A fleet, select B while B read is held. The command bar selects Robinson Chalong while original Central fleet and station controls remain present. No equipment action was dispatched.

Source: apps/console/src/pages/Devices.tsx:146, apps/console/src/pages/Devices.tsx:526, apps/console/src/pages/Devices.tsx:537.

Proposed correction for approval: Clear or context-tag retained fleet rows immediately on park change and reject old park completions. Bind drawers/actions to their captured targets; do not change grants or fleet rules.

### UI-B3: Failed equipment reads make false empty-register claims

Refuse the first box read and, separately, the first station read with500. A real error banner coexists with “No box at this branch yet” / “No stations yet” and add-first guidance. Existing count-suppression controls do pass.

Source: apps/console/src/pages/Devices.tsx:270, apps/console/src/pages/Devices.tsx:347, apps/console/src/pages/Devices.tsx:558.

Proposed correction for approval: Keep per-list unread/failed/stale/empty states. Draw empty-register advice only after that list answers successfully, retaining other independently successful lists.

### UI-B4: Missing record404 is presented as an undeployed API

Return the native404 BOOTH_NOT_FOUND / “No booth with that id” for a selected draft. The native reason disappears; the page says its draft route is not deployed and cites SCRUM-200.

Source: apps/console/src/api/client.ts:31, apps/console/src/pages/Booths.tsx:249, apps/console/src/pages/Booths.tsx:600.

Proposed correction for approval: Distinguish a genuine missing-route fallback from structured resource404, preserving the server reason and an appropriate reread. Check other isMissingRoute consumers without broad policy changes.

### UI-B5: A shrinking ledger produces an inverted range and misleading empty text

Read50of51, request offset50, then receive valid total1/rows[]. The footer says “51–50 of1”; the page also says nothing matches although one record exists on an earlier page.

Source: apps/console/src/pages/Vouchers.tsx:309, apps/console/src/pages/Vouchers.tsx:328.

Proposed correction for approval: Use an honest empty-current-page state and navigable previous page or reset the stale offset. Bookings.tsx263 has the same range expression by static inspection; money-domain reconciliation is outside this UI audit.

## Source-only findings to reproduce before repair

- **UI-S1 Activity export cannot invalidate an old filtered response:** asked.key and key are captured from the same render, so asked.key !== key cannot detect later filter changes. The old file and its completion note can publish into the new selection. Source: apps/console/src/pages/Activity.tsx:760, apps/console/src/pages/Activity.tsx:768. Next: Hold export, change filters, release; assert no obsolete download/note, then propose a current owner/ref guard.
- **UI-S2 Related audit rows can overclaim completeness:** Related locally filters at most200 recent rows, discards nextCursor, then says “This was the only row for that request”. The main Request id filter does carry a page-only warning when narrowed; this drawer does not. Source: apps/console/src/pages/Activity.tsx:542, apps/console/src/pages/Activity.tsx:549, apps/console/src/pages/Activity.tsx:666. Next: Return200 unrelated recent rows with another page and an older related record; require bounded/incomplete wording or an approved true server request filter.
- **UI-S3 A late maintenance completion may close a replacement app drawer:** Close/Escape unmounts the old drawer while its request can continue. onDone checks page authority, then the parent unconditionally clears the currently open drawer. That authority remains current when a different app is opened in the same page. Source: apps/console/src/pages/SuiteControls.tsx:176, apps/console/src/pages/SuiteControls.tsx:202, apps/console/src/components/Drawer.tsx:28. Next: Mock one maintenance request, close A/open B, release A; require B draft and target remain. No staging maintenance action is needed.

## Exact wording and filter proposals

- **UI-M1 Permission advice directs staff to removed Login Users panel (BUG - wording/navigation):** "A manager can grant it from the Login Users panel.".  Point to current People & access → Accounts / Roles & scopes. Keep permission codes as secondary diagnostic information. Source: apps/console/src/components/Panel.tsx:205, apps/console/src/pages/Booths.tsx:746.
- **UI-M2 Direct platform-only refusal does not explain the missing scope (USABILITY PROPOSAL):** Section can refuse a non-platform account that already holds the named permission, then displays only that permission as what is needed. Explain the required platform-wide authority and current context, rather than imply the same held permission is absent. No permission change. Source: apps/console/src/App.tsx:132.
- **UI-M3 Generic unread/error text sometimes describes the wrong thing (USABILITY PROPOSAL):** ["Unknown error","That is a request that did not answer, not a fact about this box","Not deployed here yet — SCRUM-200."]. A403/404 is an answered refusal; shared Unreadable is used for non-box data too. Ticket numbers and old release explanations do not tell park staff what to do. Keep resource, cause, unchanged-state/uncertainty and next action explicit; retain technical code/request detail behind optional disclosure. Never replace an actual reason with a generic all-clear. Source: apps/console/src/components/Panel.tsx:116, packages/admin-screens/src/apps/UnlinkedOtoAppUsers.tsx:107, apps/console/src/pages/Booths.tsx:1164.
- **UI-M4 Discount usage banner appears to describe an older implementation (SOURCE MESSAGE CANDIDATE):** "Usage counts are this tab only — SCRUM-230.". Payment/API reviewer confirmed from source: usedCount counts distinct persisted finalised sale IDs for this operator/definition code since the definition was created. The generated response, mapper and Console panel retain it. It is cumulative across branches, not tab-local or the selected report range. This is a source-only wording finding; no new native counter test was run. Propose wording that describes this persisted cumulative usage basis, retaining genuinely local manual-discount reasons and the differently windowed usage/value report labels. Source: packages/admin-screens/src/lifted/components/admin/discounts/DiscountCodesSection.tsx:246, packages/admin-screens/src/lifted/api/menu.ts:708.

- **UI-P1 Activity (USABILITY / missing filter capability, not isolation failure):** Either clearly mark unsupported presets unavailable, or approve actual server category/request filtering. Label bounded Related results honestly. Keep the current explicit warnings until real filtering exists. Reason: A support person must know whether an empty result means no event or an incomplete search.
- **UI-P2 Date-bounded views (Validation proposal / API reviewer owns reversed-range reproduction):** Validate From≤To at the filter boundary, name the bad field, retain the previous selection and avoid a misleading no-match claim. Reason: An invalid period should not look like a day with no business or audit events.
- **UI-P3 Watch / Releases / device lists (Optional usability):** Offer explicit filters for unavailable reads, actionable failures, agent below minimum/unknown version, expired/near-expiry metadata and active versus historical rows, reusing native status categories. Reason: Find the items needing attention without scanning all healthy/history rows. Do not introduce new thresholds or redefine healthy.
- **UI-P4 People / catalogue / configuration (Optional usability):** Add search/sort only to genuinely long lists, show current result count and distinguish current-page empty from globally empty. Prefer names over raw IDs, retain stable ordering, and make clear/reset behavior consistent. Reason: The navigation has20 Catalogue entries and several full-list read surfaces; staff need to find a person/item/setting quickly without changing authority.
- **UI-P5 Shared forms and drawers (Optional accessibility/recovery work):** Audit a keyboard focus trap/return focus in the custom Drawer; announce dynamic errors consistently; associate field errors through described-by rather than changing accessible labels; show clear pending/confirmed/uncertain outcomes and why an action is disabled. Reason: A keyboard/phone user must understand and recover from a refusal without losing a draft. This proposal does not authorize a layout or business-rule redesign.

## Keep the accepted behavior distinct

- Q1 Sessions lists historical revoked entries under an inherited signed-in caption. It is an existing owner question; distinguish current/history only by approval.
- Q5 fractional ticket hours remain an existing UI/API-rule question, not a silent new allowance.
- Manual discount reasons and declared stock placeholders retain explicitly local/mock behavior; they are not falsely promised as persistent.
- Admin/Staff/Sign-in audit presets lack true server category filtering and explicitly warn; Related completeness is separately problematic.
- Unsupported payment/gate/booth/rollup switches remain non-actionable. Real provider adapters are not implied by local test controls.
- SCRUM-649 Data tools is NOT BUILT/owner-descoped/To Do;672 deployment history,673 schedule attribution,674 missing readers and675 dated cutover/unfreeze are named follow-ups. The Inbox/Radar/OTO App banner gap remains on648.

## Route inventory and family-level summaries

Every canonical route is listed in pages.json and ui-audit-matrix.json. The following summaries apply to the whole named family, not to every member page. Configuration has ownership links, not Analytics source/rerun actions. Devices has fleet controls, not Booth prize/publish controls. Exact capabilities must be read from the individual page; this table is not an authorization or per-page capability matrix.

| Family | Member routes | Family-level summary only |
| --- | --- | --- |
| family-01 | /reports/analytics, /organisation/configuration | Native summary date/park selection, source/preference/formula/queue/drift, read-only preview and audited source/rerun; owned settings index links |
| family-02 | /organisation/apps, /watch/releases | Native registry/maintenance; supported flags, exact preview/expiry/reason/confirmation/dual approval; release/agent pagination |
| family-03 | /watch/support | Native kind-aware lookup, action/sale trace, time-limited read-only view-as/history and dual-control paths |
| family-04 | /catalogue/inventory, /catalogue/members, /catalogue/tier-verifications, /reports/wallets | Existing native operations panels, stock/member searches and own-park selectors, wallet lookup/reactivation |
| family-05 | /channels/teams-routing, /channels/assistant-settings | Team/routing scope and archive filters, explicit owner/backup edits; operator caps/pacing/rates |
| family-06 | /reports/sales, /reports/profitability, /reports/discounts, /reports/tax-vat, /reports/wallet-promo, /reports/booths | Trading-day From/To, readable-park selection, native tables/summary cards, bounded CSV; deep-analysis Radar offer |
| family-07 | /reports/money | Read-only Money oversight navigation and safe trace discoverability |
| family-08 | /catalogue/care, /catalogue/print-templates, /catalogue/staff-benefits | Native drop-off/supervision, print templates and station target, role benefits/overrides/credential/history |
| family-09 | /catalogue/discounts, /catalogue/tenders, /catalogue/tax, /catalogue/voucher-campaigns, /catalogue/event-pricing, /catalogue/voucher-types | Native discount/tender/tax/type/campaign/event editors, archive, order, branch mint/export |
| family-10 | /catalogue/menu, /catalogue/categories, /catalogue/modifiers, /catalogue/merch | Native item/category/library/variant forms and search, workbook preview/import/export |
| family-11 | /catalogue/tickets, /catalogue/tiers, /catalogue/add-ons | Native forms, tier/default/proof/order, ticket/add-on prices and edit/remove offers |
| family-12 | /organisation/operators, /platform/operators, /organisation/holidays, /organisation/branches | Native operator/branch forms, rename, mapping/reconcile, pricing-calendar ranges and branch selection |
| family-13 | /platform/system-roles, /platform/alerts, /platform/jobs, /platform/environment, /platform/test-controls | Immutable role search; platform-only alert/job/environment reads and native staging-gated controls |
| family-14 | /people/access-review, /people/roles | Role/permission text search, reverse permission picker, holder lists, effective-diff confirmations; six access-review cards |
| family-15 | /people/departments, /people/employees | Server search, Refresh, read-only source/park/link facts; existing OTO App door |
| family-16 | /people/app-access, /people/accounts | Server name/phone search; Accounts actions, sessions/tokens, app linking/unlinked-user search |
| family-17 | /watch/health, /watch/integrations | Native refresh, fleet/job/readiness detail, provider categories, expiry metadata/history and gated local-adapter tests |
| family-18 | /watch/failures, /watch/activity | Audit filters/presets/change/raw/related/export; failure kind/window/cursor, run/quarantine and recipient/mute views |
| family-19 | /devices/booths, /devices | Park and panel filters; fleet drawers, pairing/commands; booth draft, prizes, publishing, settings, staff and history |
| family-20 | /reports/bookings, /catalogue/vouchers | Status/date/park filters; vouchers type/issuer/place; newest-first paging and voucher CSV |
| family-21 | /overview | Reach-filtered park selector, Refresh, source links, copied status summary |
| family-22 | /people, /organisation, /catalogue, /channels, /reports, /watch, /platform | Area landing: permission-filtered links to native pages; Channels includes fixed acting-user Inbox doors and Reports the gated Radar offer. |
| family-23 | /staff | Read-only park/day staff headlines and native OTO App source doors |

## Explicit items for the proposed approval plan

- Approve the native data-state repairs UI-B1–B5 with retained controls and no policy/layout changes.
- Require targeted synthetic reproductions for UI-S1–S3 before implementation; they are not staging-confirmed.
- Explicit wording/navigation items for approval: UI-M1 replace stale Login Users directions with current People/Accounts or Roles destinations; UI-M2 explain platform-wide scope refusal when the named permission is already held; UI-M3 make generic unread text resource-specific and distinguish answered refusal from unread transport, including non-box uses.
- UI-M4 remains source-only: the payment/API audit confirmed cumulative persisted usage across branches for this operator/definition. Approve correction of the stale this-tab/report-not-built wording without changing usage rules, report windows or genuinely local manual reasons.
- Approve optional filter/accessibility convenience separately from concrete bugs; retain exact reasons and uncertainty.
- Do not bundle known unbuilt follow-ups, permission policy changes, formulas, stock persistence, provider consumers or fiscal integration into a wording repair.

## Evidence and limits

See ui-audit-results.json for exact paths/lines, source hashes and classifications; ui-audit-matrix.json for route inventory and family-level state notes; native-message-catalogue.json for the full fragment index. Six inspected local images are in probe-v3/. UI01shows selectedB while its history is below the automatic viewport: the native assertion/log is the primary proof for that case. Other five screenshots visibly show the corresponding state defect. These are local controlled-response illustrations, not staging acceptance images. Root owns the independently completed66page/68observation staging walkthrough.

The temporary spec is archived exactly in browser-probes-v3.spec.ts.txt and removed; temporary-test-cleanup.json binds the removal. All317production frontend source bytes stayed unchanged. Own embeddedPG and browsers are closed; Docker stayed off. No source fixes, permissions, formulas, approved prototypes or external providers were changed.

Report correction: the prior three report files are preserved under report-before-family-label-correction/. This external-only correction changes summary labelling and makes the message-plan items explicit; it changes no findings, tests, evidence receipts or production source.
