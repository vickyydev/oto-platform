# Ticket register — 2026-09-23

_Every SCRUM issue Jira shows as updated on 2026-09-23, read from Jira at the end
of the day. Statuses are Jira's own, queried tonight, not what any note remembers.
Commit shas are verified against the repository. Times come from git and Jira._

**The board tonight:** 200 issues touched — **134 Deployed, 61 To Do, 5 In
Progress** (SCRUM-191, 202, 204, 206, 360), **none in Testing**. Ninety-six were
created today; sixty-eight of those were fixed, evidenced on staging and Deployed
the same day.

**How to read "what proved it".** A *fix* sha is the commit that changed the
behaviour; an *evidence* sha is the commit that put that ticket's staging cards
into `docs/qa/jira-comments/attachments/<KEY>/`, and its message names the staging
commit the cards were taken at. File names are the cards themselves (the
`staging-*` ones; a ticket usually has build-time cards beside them). Rows marked
"board pass at 10:13–10:43" were already Deployed before today — the morning pass
moved them under their epic and relabelled them and changed nothing else.

**One disagreement with the handover's own log.** The 16:45 banner records
**SCRUM-360 closed Done, not reproducible**. Jira has SCRUM-360 **In Progress**
(last updated 16:47). It was never walked, and the helper's ladder
(`To Do → In Progress → Testing → Deployed`) has no *Done* step. The finding is
settled and SCRUM-371 carries the decision it turned into; the ticket still needs
closing by hand.

## Every issue updated today

| Key | Type | Summary | Status (Jira, tonight) | Priority | What proved it | Raised today |
|---|---|---|---|---|---|---|
| SCRUM-185 | Story | S2-01 — Platform foundation hardening and first Render deploy | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-186 | Subtask | S2-01a — Security and lock-model fixes | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-187 | Subtask | S2-01b — Transactions, schema move and idempotency | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-188 | Subtask | S2-01c — Render deploy of API + POS | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-189 | Story | S2-02 — Suite launcher: OTO-styled landing page, centralised sign-in with signed hand-off, app tiles with "coming soon" shells | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-190 | Story | S2-03 — Observability and Console v1: telemetry package, request and operation logging, ops_run failure record, audit extensions, health endpoints, job runner and watchdog, Activity / Failures / Health / Integrations pages | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-191 | Story | S2-17 — OTO App on the platform: schema and sign-on first, then the full lift, then the contract features | In Progress | Medium | parent of S2-17; 192 and 268 Deployed beneath it; stays In Progress |  |
| SCRUM-192 | Subtask | S2-17a — `otoapp` schema on the central database, hand-off sign-on, user provisioning from the platform (pulled forward before CP1) | Deployed | Medium | evidence `9a72d81` · staging-launcher-192-handoff.png |  |
| SCRUM-195 | Story | S2-04 — Stations, boxes and devices: Console Devices area, box registration and heartbeat, cloud virtual box, station pick after sign-in, station setup wizard | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-196 | Story | S2-05 — Box agent sync core: station session document with lease fencing, cache bundles, durable outbox and sync ledger with epochs and dedupe, offline toggle | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-197 | Story | S2-06 — Box edge essentials: print pipeline and printer simulator with templates, scanning service and scanner simulator, signed staff token with offline unlock, PWA shell, simulator control panel | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-198 | Story | S2-07 — Lucky Wheel booth | Deployed | Medium | evidence `b9438cd` · staging-198-booth-live.png, staging-198-console-status.png, staging-198-spun.png |  |
| SCRUM-199 | Subtask | S2-07a — Booth game, spins, vouchers, printing, offline operation, heartbeat and alerts | Deployed | Medium | fix `451c7b3` · evidence `b9438cd`, `56a5201` · staging-199-ccw.png, staging-199-landscape-rotated.png, staging-199-pair-prompt-rotated.png |  |
| SCRUM-200 | Subtask | S2-07b — Booth admin control panel: prizes, layouts, publish and version pickup, voucher definitions, marketing channels, staff PIN | Deployed | Medium | fix `388b7c8` · evidence `1a7ed92`, `56a5201` · staging-apply-config-done.png, staging-booth-list.png, staging-booth-status-after-apply.png |  |
| SCRUM-201 | Story | S2-08 — Customer display as a separate device: /display route, pairing by code, redacted station-session view, display intents, harness kept | To Do | Medium | standing backlog — not started |  |
| SCRUM-202 | Story | S2-09 — Checkout and sales ledger | In Progress | Medium | parent of SCRUM-203/204 and the gap-register subtasks; stays In Progress while 204 is open |  |
| SCRUM-203 | Subtask | S2-09a — Ticket cart, pricing/tax engine, sale and sale_line facts, ฿0 finalise, member tier change | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-204 | Subtask | S2-09b — F&B and shop carts, catalogue admin panels, member-API migrations, product barcode | In Progress | Medium | three halves evidenced today — `96523cd` (at `849bc17`) and `5d32f16` (at `097b73b`); fixes `fa3785a`, `849bc17`, `2740291`, `bbf1792`. Ticket stays In Progress |  |
| SCRUM-205 | Story | S2-10 — Payments and redemption | To Do | Medium | standing backlog — not started |  |
| SCRUM-206 | Subtask | S2-10a — Tenders: cash, EDC terminal simulators in the NEXGO and PAX dialects with inquiry-on-no-response, real 2C2P sandbox QR with PAX QR offline fallback, manual recording, payment methods admin | In Progress | Medium | slices A `3317360`, E `8ee9a5d`, B `a232059`+`b616191`, C1 `51fd025`, C2 `83ffc36`, D `24e608d`, G `d435db4`; staging evidence `53c84fc`, `6f687ae`, `5deb2a3`, `9b28f87`. Slice F not started; no end-to-end evidence yet |  |
| SCRUM-208 | Story | S2-11 — Sale printing and signed bands, History tab with refunds, voids and reprints | To Do | Medium | standing backlog — not started |  |
| SCRUM-209 | Story | S2-12 — Arrival: online booking checkout via the 2C2P Redirect API sandbox, signed booking QR, redemption at the till issuing bands, GE-X2/HX-X1 gate simulator with its QR reader, anti-passback and live occupancy | To Do | Medium | standing backlog — not started |  |
| SCRUM-210 | Story | S2-13 — Child check-in and supervision: supervision gate and consent at the till, drop-off and nanny lines, check-in board with timers, authorised pickups, offline check-in and offline release with collector photo | To Do | Medium | standing backlog — not started |  |
| SCRUM-211 | Story | S2-14 — Wallets and stock | To Do | Medium | standing backlog — not started |  |
| SCRUM-214 | Story | S2-15 — Day close and reporting | To Do | Medium | standing backlog — not started |  |
| SCRUM-217 | Story | S2-20 — Events, parties and camps wired to the OTO App, and the self-service kiosk | To Do | Medium | standing backlog — not started |  |
| SCRUM-218 | Story | S2-21 — Staff benefits: HR-linked profiles and benefit application at checkout | To Do | Medium | standing backlog — not started |  |
| SCRUM-219 | Story | S2-18 — Radar live on the platform: `radar` schema, sign-on, per-branch source preference, seeded legacy figures, OTO POS analytics from the rollup | To Do | Medium | standing backlog — not started |  |
| SCRUM-220 | Story | S2-19 — Unified Inbox: the approved design working end to end on the `inbox` schema, with channel adapters ready for a real account | To Do | Medium | standing backlog — not started |  |
| SCRUM-221 | Story | S2-23 — Console: the owner's super-admin control surface across the whole suite | To Do | Medium | standing backlog — not started |  |
| SCRUM-222 | Story | S2-22 — The park's own data: production restore into the central database, platform seeding from it, Radar on real figures, cutover rehearsal | To Do | Medium | standing backlog — not started |  |
| SCRUM-223 | Story | S2-24 — Branch box image and on-site readiness: the bring-up runbook and the switch from simulator to real device | To Do | Medium | standing backlog — not started |  |
| SCRUM-224 | Story | S2-16 — Sprint 2 acceptance run, load and soak checks, Render staging refresh, sprint-2 tag, SPRINT_2_REPORT.md and Jira evidence per story | To Do | Medium | standing backlog — not started |  |
| SCRUM-225 | Subtask | A member's tier change is thrown away when you press Save | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-226 | Subtask | The order panel shows the child price on the Adults row | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-227 | Subtask | A discount verified before the visitor gives their details is lost | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-228 | Subtask | Adding a customer tier saves nothing, and a tier with no price sells at ฿0 | Deployed | Medium | evidence `1a7ed92`, `56a5201` |  |
| SCRUM-229 | Subtask | The till prices in the browser, on the browser's clock | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-230 | Subtask | Add-ons and discount codes are still invented data | Deployed | Medium | evidence `6c87ac0` |  |
| SCRUM-231 | Subtask | Member and child details reception cannot see or change | Deployed | Medium | fix `8bcbd0f` · evidence `a468987` · staging-231-api-record.png, staging-231-child-editor.png, staging-231-member-form.png |  |
| SCRUM-232 | Subtask | The database cannot hold the menu the park actually runs | Deployed | Medium | fix `d26e21c` · evidence `6c87ac0` |  |
| SCRUM-233 | Subtask | A child added at the supervision gate is never saved | Deployed | Medium | fix `3d0cfb6` · evidence `96523cd` · staging-233-after-reload.png, staging-233-event-pass.png, staging-233-rows.png |  |
| SCRUM-234 | Subtask | A booking made online cannot be found at the counter | Deployed | Medium | evidence `1a7ed92` |  |
| SCRUM-235 | Bug | A temporary password locks the person out of the till | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-236 | Bug | Eleven admin screens save nothing and say nothing | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-237 | Bug | The POS admin area is gated on a single client-side switch | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-238 | Task | Live counter screens still read invented lists | Deployed | Medium | fix `a21d12d` · evidence `b68d432`, `1a7ed92` · staging-238-history-detail.png, staging-238-history-list.png |  |
| SCRUM-239 | Task | A role can be taken away from someone but never given back | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-240 | Task | There is no way to create a branch | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-241 | Task | Take a verified tier back off a member (revoke), from admin and at the counter | Deployed | Medium | fix `dd54c79` · evidence `9bcf46e`, `1a7ed92` · staging-241-after-revoke.png, staging-241-both-rows.png, staging-241-revoke-dialog.png |  |
| SCRUM-242 | Bug | OTO App kiosk: anyone with the URL can clock a named staff member in or out with only a phone number — no login, no rate limit | Deployed | Highest | evidence `56a5201` |  |
| SCRUM-243 | Bug | OTO App kiosk: timeclock PINs are an unsalted global lookup — guessable in minutes and recoverable wholesale — with no login and no rate limit | Deployed | Highest | evidence `56a5201` |  |
| SCRUM-244 | Bug | Booth: anyone with the URL can spin the Lucky Wheel and mint vouchers on this deployment | Deployed | High | fix `451c7b3` · evidence `b9438cd` · staging-244-anonymous-refused.png, staging-244-console-code.png, staging-244-paired-wheel.png |  |
| SCRUM-245 | Bug | Login Users still hands a park invitee control of the whole platform (deployed POS bundle sends a null scope) | Deployed | High | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-246 | Bug | Reception can download the entire member register, including children's allergies and medical notes | Deployed | High | evidence `56a5201` |  |
| SCRUM-247 | Bug | OTO App kiosk: a device's id alone mints a 30-day session — the device secret is never checked | Deployed | High | evidence `56a5201` |  |
| SCRUM-248 | Bug | Catalogue price and holiday edits skip the branch-ownership check (a cross-park / cross-branch write) | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-249 | Bug | Branch-scoped managers can read the whole operator's accounts, audit log and other branches | Deployed | Medium | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-250 | Bug | A visit can be recorded against a branch — and a date — the caller isn't scoped to | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-251 | Bug | Sign-in and account-setup reveal which phone numbers are staff, and are not throttled when they do | Deployed | Medium | evidence `9a72d81`, `a468987` · staging-251-four-classes.png, staging-251-throttle.png, staging-launcher-251-signin.png |  |
| SCRUM-252 | Bug | Public booking catalogue leaks internal ids and full row shape beyond what the booking flow needs | Deployed | Low | fix `6ea6220` · evidence `4aae87c` · staging-252-keys.png |  |
| SCRUM-253 | Bug | Archiving an operator or a branch stops almost nothing — sign-in, trading and new grants continue | Deployed | Low | fix `b7d7b67` · evidence `d69b047` · staging-253-archived.png |  |
| SCRUM-254 | Bug | The full API description and route body-schemas are readable without signing in | Deployed | Low | fix `6ea6220` · evidence `4aae87c` · staging-254-gated.png |  |
| SCRUM-255 | Bug | Three latent authorization gaps to close before the routes that would trigger them land | Deployed | Low | fix `b7d7b67` · evidence `d69b047` · staging-255-refused.png |  |
| SCRUM-256 | Task | The admin console has no automated test runner, so the booth's odds and money arithmetic is unchecked | To Do | Medium | standing backlog — not started |  |
| SCRUM-257 | Bug | Booth: a "spins per day" limit can be set and nothing enforces it | Deployed | Medium | fix `69af2fb` · evidence `a18ee84` · staging-257-box-running-v2.png, staging-257-tile-cap.png, staging-257-version-2.png |  |
| SCRUM-258 | Bug | Removing a holiday from the pricing calendar will fail once that day has sales on it | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-259 | Bug | OTO App kiosk: clocking in by employee id needs no credential and no limit | Deployed | Highest | evidence `56a5201` |  |
| SCRUM-260 | Bug | OTO App kiosk: a credential from one park clocks in a person from another | Deployed | High | evidence `56a5201` |  |
| SCRUM-261 | Bug | OTO App kiosk: anyone can upload an image with no credential and no limit | To Do | Medium | standing backlog — not started |  |
| SCRUM-262 | Bug | OTO App kiosk: failed-attempt logging is unthrottled | To Do | Low | standing backlog — not started |  |
| SCRUM-263 | Bug | Signing in puts every member of staff on the first branch, so one park’s manager cannot use the system at all | Deployed | High | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-264 | Bug | Reception at one park can take the other park’s till and hold its lease | Deployed | Highest | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-265 | Bug | The equipment health page shows every park’s boxes and printers to a manager of one park | Deployed | High | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-266 | Bug | A manager at one park can take over a colleague’s account at the other park, if that colleague has no role yet | Deployed | High | Deployed earlier in Sprint 2; today it was touched by the board pass at 10:13–10:43 only |  |
| SCRUM-267 | Bug | The booth list hands one operator another operator’s booths | Deployed | Medium | evidence `56a5201` |  |
| SCRUM-268 | Subtask | Nothing maps a platform branch to an OTO App branch, and a person provisioned from the platform lands in no branch at all | Deployed | Medium | fix `6e7d557` · evidence `b68d432`, `56a5201` · staging-268-api-mapping.png, staging-268-branches-page.png, staging-268-manager-view.png |  |
| SCRUM-269 | Bug | The till rings up every sale over the internet, so a park with the link down cannot sell at all | To Do | Medium | standing backlog — not started |  |
| SCRUM-270 | Task | The till cannot name a sale or a member before saving it, which is what offline selling needs | To Do | Medium | standing backlog — not started |  |
| SCRUM-271 | Task | The till still keeps a second, older money calculator alongside the exact one | To Do | Medium | standing backlog — not started |  |
| SCRUM-272 | Task | Every screen re-types by hand what the server sends, so a change breaks it silently | To Do | Medium | standing backlog — not started |  |
| SCRUM-273 | Bug | Archiving a member stops almost nothing, and that phone number can then never be used again | To Do | Medium | standing backlog — not started |  |
| SCRUM-274 | Task | The staff app stores times with no timezone, and the platform writes into those columns | To Do | Medium | standing backlog — not started |  |
| SCRUM-275 | Bug | A box forgets its staff list on every deploy, never refreshes it, and would start receipt numbers at zero | Deployed | Medium | evidence `547ced5` · staging-275-booth-in-step.png, staging-275-cache-rows.png, staging-275-devices-cache.png |  |
| SCRUM-276 | Task | The staff app holds pay in three different formats, and salary advances divide in floating point | To Do | Medium | standing backlog — not started |  |
| SCRUM-277 | Task | Twenty-seven built endpoints have no screen calling them, including photo storage and ending a shift | To Do | Medium | standing backlog — not started |  |
| SCRUM-278 | Task | The Lucky Wheel screen has no deployment, so its live code path has never run anywhere | Deployed | Medium | evidence `b9438cd` · staging-278-booth-status.png, staging-278-live-path.png, staging-278-live-wheel.png |  |
| SCRUM-279 | Task | Two different id generators exist for the same format | To Do | Medium | standing backlog — not started |  |
| SCRUM-280 | Bug | A manager at one park can list and end a shift credential on the other park's till | Deployed | Medium | evidence `1a7ed92` · staging-transcript.txt |  |
| SCRUM-281 | Bug | An administrator of one operator can acknowledge another operator's alerts | Deployed | Medium | evidence `1a7ed92` · staging-transcript.txt |  |
| SCRUM-282 | Bug | Ending someone’s shift and moving a session between parks leave no record at all | Deployed | Medium | evidence `1a7ed92` · staging-transcript.txt |  |
| SCRUM-283 | Bug | One audit entry is written outside its own transaction, so it survives the failure it describes | Deployed | Medium | evidence `1a7ed92` |  |
| SCRUM-284 | Bug | Ten sign-in, password and shift actions are not all-or-nothing, so a crash can lock someone out | Deployed | Medium | evidence `1a7ed92` |  |
| SCRUM-285 | Bug | The offline switch does not actually cut the till off, so an offline demo proves nothing | To Do | Medium | standing backlog — not started |  |
| SCRUM-286 | Task | The till app is excluded from the rule that forbids writing phone numbers and medical notes to logs | To Do | Medium | standing backlog — not started |  |
| SCRUM-287 | Bug | A visitor's phone number is stored on the session exactly as typed, with no record and no expiry | To Do | Medium | standing backlog — not started |  |
| SCRUM-288 | Bug | Deactivating somebody on the platform does not deactivate them in the staff app | To Do | Medium | standing backlog — not started |  |
| SCRUM-289 | Task | Make the test database hold two operators by default, so cross-park leaks fail the build | Deployed | Medium | evidence `1a7ed92` |  |
| SCRUM-290 | Task | Make every endpoint that acts on one record declare whose record it is | Deployed | Medium | evidence `1a7ed92` |  |
| SCRUM-291 | Task | Check every saving endpoint is all-or-nothing, recorded, and safe to press twice | Deployed | Medium | evidence `1a7ed92` |  |
| SCRUM-292 | Task | Check the database shape itself: ownership column, timezone, archiving, phone format | Deployed | Medium | evidence `6c87ac0` |  |
| SCRUM-293 | Task | Check every screen call matches a real endpoint, and generate the types instead of re-typing them | To Do | Medium | standing backlog — not started |  |
| SCRUM-294 | Task | Refuse fractional money at the door | To Do | Medium | standing backlog — not started |  |
| SCRUM-295 | Task | Write the offline capability list and make the offline switch enforce it | To Do | Medium | standing backlog — not started |  |
| SCRUM-296 | Bug | Three account-setup and hand-off writes are not all-or-nothing, and a naive fix would weaken them | Deployed | Medium | evidence `1a7ed92` | yes |
| SCRUM-297 | Bug | The sales list skips the branch check when a session holds no branch | Deployed | Medium | evidence `1a7ed92` | yes |
| SCRUM-298 | Bug | Endpoints with no signed-in person are not idempotent: sign-in, the booth, and public booking | Deployed | Medium | fix `23edaf8` · evidence `a468987` · staging-298-one-booking.png | yes |
| SCRUM-299 | Bug | On the Failures and Anomalies pages, "scoped to your park" and "nothing here" look identical | Deployed | Low | evidence `1a7ed92`, `56a5201` · staging-failures-anan.png, staging-failures-dao.png, staging-quarantine-anan.png | yes |
| SCRUM-300 | Bug | Three cross-park refusals tell a manager the wrong reason | Deployed | Low | evidence `1a7ed92`, `56a5201` | yes |
| SCRUM-301 | Bug | The Health page shows a branch manager deployment failures she cannot act on | Deployed | Low | evidence `1a7ed92`, `56a5201` · staging-health-anan-full.png, staging-health-dao.png | yes |
| SCRUM-302 | Task | Wire the schema-shape test into CI once the menu lockfile lands | Deployed | Medium | evidence `6c87ac0` | yes |
| SCRUM-303 | Task | Put screenshots on the eight tenancy tickets before they can be Deployed | Deployed | Medium | created 00:24 today, walked To Do → In Progress → Testing → Deployed by 02:02 in the overnight run | yes |
| SCRUM-304 | Task | Give booking redemption its own table instead of the booking payload | Deployed | Low | fix `c6338d6` · evidence `4aae87c` · staging-304-row.png, staging-304-second-claim.png | yes |
| SCRUM-305 | Task | A box holding cached bookings does not learn a redemption happened | Deployed | Medium | fix `d1d0bd7` · evidence `2319ef4` · staging-305-delta.png, staging-305-redeemed.png, staging-305-till-summary.png | yes |
| SCRUM-306 | Task | Redeeming a booking borrows the voucher permission; give it its own | Deployed | Low | fix `28d2e65` · evidence `96523cd` · staging-306-bundle-and-audit.png, staging-306-redeemed.png | yes |
| SCRUM-307 | Bug | No Expat or Thai sale can be completed: the platform prices every discounted tier as Tourist | Deployed | Highest | evidence `1a7ed92` | yes |
| SCRUM-308 | Bug | The header pricing chip uses the calendar date while sales use the trading day | Deployed | Medium | evidence `1a7ed92` | yes |
| SCRUM-309 | Bug | A holiday that has priced a sale can be neither removed nor renamed | Deployed | Low | fix `cc686cc` · evidence `a18ee84` · staging-309-api-priced-sales.png, staging-309-branch-chalong.png, staging-309-dates-frozen.png | yes |
| SCRUM-310 | Bug | The phone till still cannot complete an Expat or Thai walk-in sale | Deployed | High | evidence `9bcf46e`, `1a7ed92` · staging-310-confirmation.png, staging-310-expat-prices.png, staging-310-sale-record.png | yes |
| SCRUM-311 | Bug | A tier claim is not single-use and the sale does not name it | Deployed | Medium | fix `a872d9d` · evidence `5a8042f`, `547ced5` · staging-311-claim-spent.png, staging-311-confirmation.png, staging-311-refusal-live.png | yes |
| SCRUM-312 | Bug | The visitor display prints ฿0 for a drop-off line at an unpriced tier | Deployed | Low | fix `dd54c79` · evidence `9bcf46e`, `1a7ed92` · staging-312-split-unpriced.png | yes |
| SCRUM-313 | Bug | Cancelling a sale while the document check is being recorded lands the tier on the next sale | Deployed | Medium | evidence `1a7ed92` | yes |
| SCRUM-314 | Bug | A box whose local cache went bad while online cannot repair it from an ordinary pull | Deployed | Low | evidence `1a7ed92` | yes |
| SCRUM-315 | Bug | The member tier-verification route still takes the document kind as free text | Deployed | Low | evidence `a468987` · staging-315-kind-enum.png | yes |
| SCRUM-316 | Bug | The staff order panel and the payment stage still print ฿0 beside an unpriced line | Deployed | Low | fix `a872d9d` · evidence `5a8042f` · staging-316-priced.png, staging-316-staff-dashes.png | yes |
| SCRUM-317 | Bug | GET /members hands a revoked member back with a proofType of "revoked" | Deployed | Low | evidence `a468987` · staging-317-register-null.png | yes |
| SCRUM-318 | Bug | "Operator-wide administrator" is decided by a role name, not a permission | Deployed | Low | evidence `bd8b0a8` · staging-318-app-seats.png, staging-318-bundles.png, staging-318-console.png | yes |
| SCRUM-319 | Bug | The OTO App branch table has no unique constraint on core_branch_id | Deployed | Low | evidence `bd8b0a8` · staging-319-branch-rows.png, staging-319-unique.png | yes |
| SCRUM-320 | Bug | The handheld History screen still shows the prototype sample transactions | Deployed | Medium | fix `482912e` · evidence `a468987` · staging-320-detail.png, staging-320-list.png | yes |
| SCRUM-321 | Bug | The admin Members dialog silently sets a messaging channel the member never chose | Deployed | Medium | fix `8bcbd0f` · evidence `a468987` · staging-321-none-lit.png, staging-321-unchanged.png | yes |
| SCRUM-322 | Bug | A selling box pulls its whole cache bundle every minute, because the receipt mark moves the etag | Deployed | Medium | fix `d1d0bd7` · evidence `2319ef4` · staging-322-cache-rows-before-after.png | yes |
| SCRUM-323 | Bug | The Console box drawer does not say when the box last applied its cache | Deployed | Low | fix `d1d0bd7` · evidence `2319ef4` · staging-323-drawer-line.png | yes |
| SCRUM-324 | Epic | S2 Defects — found and fixed during Sprint 2 | To Do | Medium | the defect epic itself — the parent of every Sprint 2 bug; not a work item | yes |
| SCRUM-325 | Bug | A status refusal at sign-in answers faster than a wrong password, which is still a way to tell accounts apart | Deployed | Low | fix `b458650` · evidence `4a1cc90` · staging-325-sample.png | yes |
| SCRUM-326 | Bug | The booth's code-and-QR result card runs past a 16:9 stage by 36 logical pixels | To Do | Low | raised today — not started | yes |
| SCRUM-327 | Bug | The station pairing-code route does not declare that its answer is a secret | Deployed | Low | fix `b7d7b67` · evidence `d69b047` · staging-327-store.png | yes |
| SCRUM-328 | Bug | The Console's "Go online" cannot reach a box it put offline | Deployed | Medium | fix `e977b49` · evidence `4a1cc90` · staging-328-back-online.png, staging-328-commands.png | yes |
| SCRUM-329 | Bug | The phone till's sticky cart sheet prints its total unguarded and never shows a refused document check | Deployed | Low | fix `3ba0840` · evidence `5d32f16` · staging-329-sheet-refusal.png, staging-329-sheet-unpriced.png | yes |
| SCRUM-330 | Bug | Who counts as staff at every branch is still decided by a role name in the staff-scope SQL | Deployed | Medium | fix `deaf34d` · evidence `2a9dd25` · staging-330-staff-lists.png, staging-330-staff-picker.png, staging-330-why.png | yes |
| SCRUM-331 | Bug | A box re-registers in a storm around every deploy, and throws its whole offline cache away each time | Deployed | Medium | fix `adff73c` · evidence `d69b047` · staging-331-rollover.png | yes |
| SCRUM-332 | Bug | Every staging deploy re-ran the full demo seed, putting seeded ticket prices and the tax rule back to their fixture values | Deployed | High | the staging pre-deploy command was corrected from the full demo seed to migrate + platform-sync (a Render service setting, not a repo commit) · evidence `4aae87c` · staging-332-predeploy.png | yes |
| SCRUM-333 | Bug | A sale read back from the API does not name the tier document check it was priced on | Deployed | Low | fix `bb8be9a` · evidence `4a1cc90` · staging-333-drawer.png, staging-333-read.png | yes |
| SCRUM-334 | Bug | The staff panel shows Subtotal ฿0 beside a non-zero Total when a drop-off child is added before a play length is chosen | Deployed | Medium | fix `bb8be9a` · evidence `4a1cc90` · staging-334-dashes.png, staging-334-priced.png | yes |
| SCRUM-335 | Bug | A 21st online booking in a minute is answered with a 500, not "wait a minute" | Deployed | Medium | fix `7b746f1` · evidence `b2388c0` · staging-335-429.png | yes |
| SCRUM-336 | Bug | Booth settings still tells a manager that "spins per day" is not read | Deployed | Low | fix `1875f56` · evidence `4aae87c` · staging-336-hint.png | yes |
| SCRUM-337 | Bug | "Remove from saved" on the till claims to delete a child but nothing is deleted | Deployed | Medium | fix `803428b` · evidence `ee2d7a6` · staging-337-after-reload.png, staging-337-record.png, staging-337-removed.png | yes |
| SCRUM-338 | Bug | The saved-children review still says the details are "held in memory only" — on the till they are saved now | Deployed | Low | fix `803428b` · evidence `ee2d7a6` · staging-338-note.png | yes |
| SCRUM-339 | Task | A family confirmed at the membership check and again at the supervision gate gets two draft visits | To Do | Low | raised today — not started | yes |
| SCRUM-340 | Task | The drop-off registration lookup on the till still reads the prototype's in-memory check-in store | To Do | Low | raised today — not started | yes |
| SCRUM-341 | Task | The F&B menu item and category forms still save to the browser tab only | Deployed | Medium | fix `2731962` · evidence `4698326` · staging-341-after-reload.png, staging-341-form-saved.png, staging-341-form.png | yes |
| SCRUM-342 | Bug | After the platform refuses an F&B order the Charge button stays enabled | Deployed | Low | fix `604ef31` · evidence `5d32f16` · staging-342-charge-enabled.png, staging-342-refusal.png | yes |
| SCRUM-343 | Task | F&B and shop sales are recorded with sales channel "till", though the ledger has fnb and shop channels | Deployed | Low | fix `6e5926d` · evidence `ee2d7a6` · staging-343-channels.png | yes |
| SCRUM-344 | Task | Promotion scopes do not reach F&B and shop lines — a food-scoped code finds no base and an add-on-scoped code would reach food | Deployed | Medium | fix `6e5926d` · evidence `ee2d7a6` · staging-344-scopes.png | yes |
| SCRUM-345 | Task | Product and discount codes are unique per operator, so a coded item cannot be cloned into a second branch — decide whether a branch may carry the same code as another | To Do | Medium | raised today — not started | yes |
| SCRUM-346 | Bug | The Discounts panel's code rows are styled for a dark screen, so on the light back office they sit on grey blocks with washed-out badges | Deployed | Low | fix `097b73b` · evidence `5d32f16` · staging-346-discounts.png | yes |
| SCRUM-347 | Bug | Setup and password-reset codes are stored as a plain SHA-256 of a six-digit number, so anyone who can read the table can recover a live code | Deployed | Medium | fix `10b1242` · evidence `ee2d7a6` · staging-347-hash-shape.png | yes |
| SCRUM-348 | Bug | The unlock route skips the password check when the session's account is missing, so its timing differs — the same shape SCRUM-325 closed on sign-in | Deployed | Low | fix `4155ab9` · evidence `ee2d7a6` · staging-348-unlock.png | yes |
| SCRUM-349 | Bug | The phone till's cart sheet prices itself locally instead of showing the platform's quote | Deployed | Low | fix `9e7d7f9` · evidence `e7b913f` · staging-349-review.png, staging-349-sheet.png | yes |
| SCRUM-350 | Bug | The customer display shows "1 Hour Play ฿0 … Total ฿690" for a drop-off child with no play length chosen | Deployed | Medium | fix `40c69bb` · evidence `e7b913f` · staging-350-355-display-no-length.png, staging-350-355-length-chosen.png | yes |
| SCRUM-351 | Task | The quote hook drops the error status, so the F&B station tells a platform fault from a refusal by its message text | Deployed | Low | fix `237ca54` · evidence `e7b913f` · staging-351-station.png | yes |
| SCRUM-352 | Bug | The mobile F&B sheet and the shop station still allow Charge while the platform's latest quote is a refusal | Deployed | Low | fix `c3c0aa9` · evidence `ec21582` · staging-352-recovered.png, staging-352-refusal.png | yes |
| SCRUM-353 | Bug | Behind Cloudflare and Render the api trusts one proxy hop too few, so one caller's requests split across two rate-limit buckets | Deployed | Medium | fix `2845135` · evidence `0e5e2c6` · staging-353-measurement.png | yes |
| SCRUM-354 | Bug | Back-office sweep: dark-surface row, field and notice classes on the light admin across ten panels | Deployed | Low | fix `beacb6d` · evidence `e7b913f` · staging-354-member-dialog.png, staging-354-supervision.png, staging-354-templates.png | yes |
| SCRUM-355 | Bug | The visitor's screen titles a drop-off child's line "1 Hour Play" before any play length is chosen | Deployed | Low | fix `2ce3543` · evidence `e7b913f` · staging-350-355-display-no-length.png, staging-350-355-length-chosen.png | yes |
| SCRUM-356 | Bug | A new visit still accepts an archived child's id | Deployed | Low | fix `2da33da` · evidence `ee2d7a6` · staging-356-refused.png | yes |
| SCRUM-357 | Bug | The booking site's saved-children step is unreachable — the public member lookup answers a nickname and tier only | To Do | Low | raised today — not started | yes |
| SCRUM-358 | Bug | The Console's Test print button cannot queue a print — it names the station, not the printer | Deployed | Medium | fix `4f4188a` · evidence `ec21582` · staging-358-command.png, staging-358-picker.png, staging-358-succeeded.png | yes |
| SCRUM-359 | Bug | The F&B station's "refused" and "priced on this till" notes are washed out on the light theme | Deployed | Low | fix `7faf1d0` · evidence `ec21582` · staging-359-notes.png | yes |
| SCRUM-360 | Bug | To reproduce: the phone till's hand-to-customer overlay appears to reset the whole sale after a few seconds | Done | Medium | driven for 45 s on staging with the network captured and nothing moved (360-01…360-09 cards); the sale is lost to the 120 s inactivity lock, which is SCRUM-371. Banner says closed Done; Jira still reads In Progress | yes |
| SCRUM-361 | Bug | A box replaying a queued visit writes visit_child rows for any child id — no guardian or archived check on the offline path | Deployed | Medium | fix `ce8a9d9` · evidence `979626f` · staging-361-box-registered.png, staging-361-box-unclaimed.png, staging-361-nothing-written.png | yes |
| SCRUM-362 | Task | The F&B and shop stations have no promo code entry, so no code reaches those lanes | Deployed | Medium | fix `f212a5d` · evidence `88337ef` · staging-362-fnb-applied.png, staging-362-fnb-before.png, staging-362-fnb-cleared.png | yes |
| SCRUM-363 | Bug | Back-office sweep, second pass: the Merch and Branches panels' notices, accent text and error text still use dark-surface shades | Deployed | Low | fix `a0d8cab`, `88749d7` · evidence `979626f`, `ec21582` · staging-363-branches-clone-preview.png, staging-363-branches-duplicate-id.png, staging-363-discount-validation.png | yes |
| SCRUM-364 | Bug | A test print queued from the Console never appears in the Printing queue — the command route records no print job | Deployed | Low | fix `bce63ad` · evidence `8455b48` · staging-364-command-history.png, staging-364-printing-before.png, staging-364-printing-panel.png | yes |
| SCRUM-365 | Task | The Console has no automated test harness — nothing in CI drives it | Deployed | Medium | fix `7f3b00d` · evidence `32648ff` · ci-365-first-linux-run.png | yes |
| SCRUM-366 | Bug | The phone till shows nothing when the platform refuses its quote — Pay stays enabled with only the generic "priced on this till" note | Deployed | Medium | fix `3368e82` · evidence `dcb9ef2` · staging-366-answered.png, staging-366-recovered.png, staging-366-refusal-review.png | yes |
| SCRUM-367 | Bug | Callers are keyed by Cloudflare's edge address, not their own — the edge and the platform's balancer must be trusted by address | Deployed | High | fix `cb977c7` · evidence `816d30d` · staging-367-measured.png | yes |
| SCRUM-368 | Task | A free-item promo code entered on the F&B or shop station takes nothing off | To Do | Medium | raised today — not started | yes |
| SCRUM-369 | Task | The till's own browser checks never run in CI | To Do | Medium | raised today — not started | yes |
| SCRUM-370 | Bug | The refusal note's "Fix this to charge" line is too faint on the light theme | To Do | Low | raised today — not started | yes |
| SCRUM-371 | Task | The phone till loses the sale when the inactivity lock fires during the hand-to-customer screen | To Do | Medium | raised today — not started | yes |
| SCRUM-372 | Task | The phone's Pay button carries no reason, and a refusal that lands on the payment step draws no note | To Do | Low | raised today — not started | yes |
| SCRUM-373 | Bug | A promo code used at the F&B or shop station is invisible to the till's own reports and receipt | To Do | Medium | raised today — not started | yes |
| SCRUM-374 | Bug | A promo code's usage limit is never enforced by the platform, and the stations never count a use | To Do | Medium | raised today — not started | yes |
| SCRUM-375 | Task | Fold the station promo quote hook into the shared item quote hook | To Do | Low | raised today — not started | yes |
| SCRUM-376 | Bug | Every till shares one throttle bucket: through the POS site's /api rewrite the platform sees Render's egress address, not the till's | Deployed | High | fix `9b86938` · evidence `af1e41c` · staging-376-measured.png | yes |
| SCRUM-377 | Bug | Console: the "Add a box" dialog is painted over by the Stations panel, so its buttons cannot be pressed | Deployed | High | fix `4e67aab` · evidence `58df0e9`, `979626f` · staging-361-add-box-dialog.png, staging-377-add-box-dialog.png, staging-377-pair-dialog.png | yes |
| SCRUM-378 | Task | Console: a box can be created but never retired — no disable or archive control on Devices | To Do | Medium | raised today — not started | yes |
| SCRUM-379 | Bug | The back office's Merch panel can never show its low-stock notice or stock badges | To Do | Low | raised today — not started | yes |
| SCRUM-380 | Bug | The branch clone warning's triangle icon is a shade too light on the light theme | To Do | Low | raised today — not started | yes |
| SCRUM-381 | Bug | The till's Station Setup test print records no print job, so the box's outcome is refused and the Printing queue never lists it | To Do | Medium | raised today — not started | yes |
| SCRUM-382 | Bug | A sale can still be recorded against a disabled or archived tender | To Do | Medium | raised today — not started | yes |
| SCRUM-383 | Task | The till has no unit-test runner | To Do | Low | raised today — not started | yes |
| SCRUM-384 | Bug | A fresh or rebuilt environment's till cannot take money: the deploy writes no payment methods | Deployed | High | fix `c61289d` · evidence `3d1c4ef` · staging-384-sync.png | yes |
| SCRUM-385 | Bug | A wrong booth screen credential is never throttled on its own | To Do | Medium | raised today — not started | yes |
| SCRUM-386 | Task | The throttle table is never swept, and a caller can grow it one row per invented id | To Do | Medium | raised today — not started | yes |
| SCRUM-387 | Task | Only the outermost transaction under an idempotency key may write the stored answer | To Do | Medium | raised today — not started | yes |
| SCRUM-388 | Bug | Two presses of Card while the first is at the terminal open two full tenders on one sale | To Do | High | raised today — not started | yes |
| SCRUM-389 | Task | The box's payment result route carries no per-address ceiling | To Do | Low | raised today — not started | yes |
| SCRUM-390 | Bug | A late progress report from the terminal can overwrite the references on an attempt already settled | To Do | Medium | raised today — not started | yes |
| SCRUM-391 | Bug | A station routed to the payment gateway for QR still sends the tender to its card terminal | To Do | Medium | raised today — not started | yes |

## Open defects and gaps in the recommended order

This is a **recommendation for the owner, not a decision**. The owner has said no
new tickets are to be picked up; the next order is the owner's to confirm.
Priorities are Jira's.

**1 — The D↔C2 seam, then the QR path driven on staging.**

- **SCRUM-391** (Bug, Medium) — a station routed to the payment gateway for QR
  still sends the tender to its card terminal: `payment_routing.qr` has no reader
  and `openQrAttempt` has no caller outside its own test, so the saved setting
  does nothing. The plan gave this seam to Slice F and nobody wired it. Route a
  `qr` tender to the gateway when the station says gateway, then drive the whole
  path on staging — open, paid by the signed notification, receipt; a decline; an
  amount mismatch parked; a suppressed webhook picked up by the poller.

**2 — Reserve in-flight tenders, before Slice F touches the payment stage.**

- **SCRUM-388** (Bug, **High**) — two presses of Card while the first is still at
  the terminal open two full tenders on one sale. Raised by C2's gate.

**3 — Refuse a tender that is no longer offered.**

- **SCRUM-382** (Bug, Medium) — a sale can still be recorded against a disabled or
  archived tender: `tenderMethodOf` falls back to the declared kind and the till's
  grid is the only enforcement. Two tests pin the current behaviour. It lands in
  `services/payments/attempt.ts`, which Slice B owns, and carries two small
  fold-ins from B's staging pass: the replayed answer returns an internal
  `drawerKick` object the live answer strips, and every cash tender kicks the
  drawer, part payments included (deliberate — cash goes in the drawer each time —
  but it should be a decision when the box handler lands).

**4 — Slice F: the POS payment stage.**

- **SCRUM-206** (Subtask, Medium, In Progress) — the payment stage on all four
  tills: the cash keypad, the card states, the QR on the customer display, manual
  entry and split tenders. Then SCRUM-206's own end-to-end Deployed evidence: a
  guest paying, on staging, from the till. Nothing before that closes the ticket.

**5 — Then, in order.** (SCRUM-384 has no sibling item; nothing follows it.)

*Console, boxes and printing*

- **SCRUM-378** (Task, Medium) — a box can be created but never retired; there is
  no disable or archive control on Devices.
- **SCRUM-381** (Bug, Medium) — the till's own Station Setup test print records no
  print job, so the box's outcome is refused and the Printing queue never lists
  it. The Console half of this was SCRUM-364; the bare command route is the trap.
- **SCRUM-385** (Bug, Medium) — a wrong booth screen credential is never throttled
  on its own.
- **SCRUM-386** (Task, Medium) — the throttle table is never swept, and a caller
  can grow it one row per invented box id.
- **SCRUM-387** (Task, Medium) — only the outermost transaction under an
  idempotency key may write the stored answer; `services/print.ts` still carries
  the dormant class.
- **SCRUM-389** (Task, Low) — the box's payment result route carries no
  per-address ceiling.
- **SCRUM-390** (Bug, Medium) — a late progress report from the terminal can
  overwrite the references on an attempt that is already settled.

*Promotions*

- **SCRUM-373** (Bug, Medium) — a promo code used at the F&B or shop station is
  invisible to the till's own reports and receipt, though the ledger has it.
- **SCRUM-374** (Bug, Medium) — a code's usage limit is enforced nowhere on the
  platform, and the stations count nothing.
- **SCRUM-375** (Task, Low) — fold the station promo quote hook into the shared
  item quote hook.
- **SCRUM-368** (Task, Medium) — a free-item code takes nothing off on the F&B and
  shop lanes; only the ticket till adds the free item as a line for the markdown
  to land on. Waits on SCRUM-203's id question.

*The till and the light theme*

- **SCRUM-370** (Bug, Low) — the refusal note's "Fix this to charge" line measures
  3.86:1 on the light theme.
- **SCRUM-372** (Task, Low) — the phone's Pay button carries no reason, and a
  refusal that lands on the payment step draws no note. Lands with Slice F.
- **SCRUM-379** (Bug, Low) — the back office's Merch panel can never show its
  low-stock notice or stock badges: they are dead reads.
- **SCRUM-380** (Bug, Low) — the branch clone warning's triangle is a shade too
  light.

*Testing*

- **SCRUM-369** (Task, Medium) — the till's own browser checks never run in CI.
- **SCRUM-383** (Task, Low) — the till has no unit-test runner at all.

**Open but not in the order above** — each of these is a decision as much as a
defect, and each is listed under "Owner decisions outstanding" below:
**SCRUM-360** (In Progress), **371**, **345**, **326**, **357**, and the two
older gaps **339** (a family confirmed twice gets two draft visits, Low) and
**340** (the drop-off registration lookup still reads the prototype's in-memory
store, Low).

Beyond today's list, **34 older tickets** remain open in the standing backlog —
the architecture and conformance gaps (269–277, 279, 285–288, 293–295), the OTO
App kiosk remainder (261, 262), the booth's test runner (256) and the Sprint 2
stories not yet started (201, 205, 208–224). They are rows in the table above.

## Owner decisions outstanding

Four decisions were taken inside the tenders plan without the owner, each already
carried on the ticket as a recommendation: **O-3** the per-terminal counter is a
`box_counter` scope rather than a table; **O-4(a)** the cash drawer opens by its
own command now and folds into receipt printing later; **O-5** yes, a sale may sit
part-paid; **O-7** the server refuses the deletion of a tender that has been used
and offers disable instead.

These are still the owner's:

| # | Decision | Why it is waiting |
|---|---|---|
| **O-1** | The 2C2P sandbox: which portal the park holds, and its sandbox credentials | Blocks only the real-QR half of SCRUM-206. The gateway simulator carries the acceptance, and the public demo pair can prove the wire format without an account. Credentials go into `.env`, never the repository. |
| **O-2** | Does the offline half stay inside SCRUM-206? | Slice G was built inside the ticket today (`d435db4`), so the question is no longer whether to build it but whether to accept it there or split it out as "S2-10c — offline sales replay". |
| **O-6** | The vendor questions | GHL Thailand: the serial parity, the `pos_ref_no` length (the document says 20, 12 and 32 in three tables), whether a **card** can be recalled at all — if not, the audited staff-confirmation dialog is permanent rather than a fallback — and what a still-unpaid QR returns to a query. Digio: whether A4 is WeChat or Alipay, whether a PromptPay QR can be voided, and the TID and MID for the park's two PAX terminals, which are not on file. |
| **SCRUM-371** | Does the sale survive the inactivity lock? | The 120 s lock unmounts the phone till and the sale is gone. This is what SCRUM-360 turned out to be. Recommendation on the ticket: keep the sale across a lock. |
| **SCRUM-254** | What the API description should show now that it needs a sign-in | Two questions left on the ticket after the route was closed. |
| **SCRUM-306** | Does a read-only member of staff need a grant of its own? | Redemption now has its own permission pair; the read-only case was left open. |
| **SCRUM-327** | Should a retried pairing mint a new code? | The route now declares its answer a secret; the retry behaviour was not decided. |
| **SCRUM-345** | May a branch carry the same product or discount code as another branch? | Codes are unique per operator today, so a coded item cannot be cloned into a second branch. |
| **SCRUM-326** | The booth's result card on a true 16:9 stage | It runs past the stage by 36 logical pixels. Cosmetic, but it is the screen guests look at. |
| **SCRUM-357** | The booking site's saved-children step | Unreachable — the public member lookup answers a nickname and tier only. Exposing more is a privacy decision, not a bug fix. |
| **SCRUM-268** | The "HKT Central" row that exists only in the OTO App | The platform's branch is now the record and the app's row follows it; this orphan row still has to be decided on. |
| — | The deploy-bot | Its `render.yaml` entry creates a **paid** service the moment the blueprint is synced. It has never been run live. |

## Addendum — 2026-09-24 (morning)

Statuses read from Jira at 04:35 on the 24th; times are Jira's and git's.

| Key | Type | Summary | Status | Priority | What proved it | Raised on the 24th |
|---|---|---|---|---|---|---|
| SCRUM-204 | Subtask | S2-09b — F&B and shop carts, catalogue admin panels, member-API migrations, product barcode | Testing | Medium | members half `f5e5572` (+`3fff2d8`); sizes half `4cad79e`; staging pass 03:52–04:21 at `4cad79e` — `staging-204-sizes.png`, `staging-204-members.png`: the sizes, the picker, the sale record and the four member screens hold; a scan never reaches the shop screen (SCRUM-392). Stays in Testing on 392 |  |
| SCRUM-202 | Story | S2-09 — Checkout and sales ledger | In Progress | Medium | 203 Deployed; 204 in Testing on SCRUM-392; the two staging cards attached here too (04:29) |  |
| SCRUM-392 | Bug | The shop screen never hears a scan on staging: the POS site’s /api rewrite holds the station channel’s live stream back | Testing | High | raised 04:28; fixed `003dac7` (05:59; gate MERGE — 1,327 api tests, two plants, the local browser proof `392-poll-fallback.png`, `392-plant.png`); staging pass running | yes |
| SCRUM-393 | Bug | Booking site: the "Stored as" hint under the phone field shows +660811111111 when a leading 0 is typed after +66 | To Do | Low | raised 04:29 — not started | yes |
