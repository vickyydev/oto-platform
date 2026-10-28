# Super Admin Console — platform inventory of admin, configuration and analytics controls

Date: 2026-10-21. Read-only study; no code changed, nothing committed. Input for planning S2-23 (SCRUM-221).

## Sources and how to read this

The facts come from reading the code, not from the plan documents:
- seven read-only sweeps: the console screens, the api routes (two halves), the POS `/admin` area, the launcher/inbox/booth/radar/OTO App sweep, the multi-tenancy model, and the accounts/roles/hand-off/platform-sync inventory
- direct reads of `packages/shared/src/permissions.ts`, `packages/db/src/seed/index.ts` (`platformSync`), `seed/inbox.ts`, the schema index and the decision documents

Nothing was run, so "wired" means the code calls the API, not that it was seen working on staging.

**Path conventions**
- File paths are relative to the repository root.
- API paths include their mount prefix (`apps/api/src/app.ts:430-550`).

**Permission conventions**
- "op" means a guard with no `target`. It is checked at the caller's operator and at the branch their session sits on. A branch-scoped grant at that branch therefore passes, even for an operator-wide setting.
- Almost every write also writes `core.audit_log` and `core.idempotency_key`. The tables below leave those two out.

**Role holders**
- PA/OA is `platform_admin` and `operator_admin`, which both hold every permission.
- BM is `branch_manager`, R is `reception`, S is `staff`.

---

## 1. Control table

### 1A. Identity and access

| App · screen | Control (plain words) | API | Permission (holders) | Writes | Elsewhere / duplicate |
|---|---|---|---|---|---|
| POS `/admin?panel=login-users` (`LoginUsersPanel.tsx`) | Search staff sign-in accounts | `GET /accounts?q=` | `admin:account:read` (PA/OA, BM); list cut to the caller's branches | — | Console has **no** account screen |
| same | Invite a staff account: name, phone, one role (picker hard-coded to reception/staff/branch_manager/operator_admin), branch scope; SMS setup code | `POST /accounts` | `admin:account:create` + scope-owned + role dominance | `core.account`, `core.employee`, `core.role_assignment`, `core.verification_code` | **DUPLICATE**: OTO App `/users` also creates people and can create the platform account (`POST /api/users/:id/suite-sign-in` → `POST /admin/apps/oto_app/suite-sign-ins`) |
| same | Activate / deactivate; change phone. Deactivating ends sessions and switches off the linked OTO App user | `PATCH /accounts/:id` | `admin:account:update` + branch scope + dominance + last-admin guard | `account`, `session`, `staff_token`, `otoapp.users`, `otoapp.session` | OTO App deactivates its own users separately; reactivating on the platform does **not** reactivate the OTO App user |
| same | Temporary password (forces a change, ends sessions) | `POST /accounts/:id/temp-password` | `admin:account:update` | `account`, `session`, `staff_token` | OTO App `/users` has its own reset-password |
| same | Effective permissions drawer; grant a role at a scope; remove a grant | `GET /accounts/:id/permissions`, `POST /accounts/:id/role-assignments`, `DELETE …/role-assignments/:aid` | `admin:role:read`, `admin:role:assign` (PA/OA, BM) + dominance + not-last-operator-admin | `core.role_assignment` (DELETE is a hard delete) | **DUPLICATE**: OTO App `/permissions` ("Access": modules, access level, branch scope), `users.role` and module overrides form a second RBAC |
| same | Sessions and shift tokens; end one token; sign out everywhere | `GET /accounts/:id/sessions`, `GET /accounts/:id/staff-tokens`, `DELETE /staff-tokens/:jti`, `GET /staff-tokens/settings`, `POST /accounts/:id/sessions/revoke` | `admin:account:read` / `admin:account:update` | `session`, `staff_token` | Launcher `/account`: own sessions and sign-out everywhere (same routes) |
| same | Recent access denials | `GET /audit?action=access.denied&limit=10` | `admin:audit:read` | — | Console `/activity` (full audit) |
| POS `LoginUsers` → Apps dialog (`AccountAppsDialog.tsx`) | Link an account to an app identity (email, name, OTO App role, external id) or create the OTO App user; set OTO App branch coverage; unlink | `GET /admin/apps/users/:accountId`, `POST /admin/apps/:app/users`, `PUT /admin/apps/oto_app/users/:id/branches`, `DELETE /admin/apps/:app/users/:id` | `admin:role:read` / `admin:role:assign` + caller holds `app:<app>:access` (+ `admin:account:create` if it creates the account) | `core.app_identity`, `role`/`role_permission` (`app_access_<app>` role made on demand), `role_assignment`, `otoapp.users`, `otoapp.user_branch_access` | OTO App `/users` "provision suite sign-in" does the reverse direction |
| POS `LoginUsers` → `UnlinkedOtoAppUsers.tsx` | List OTO App users with no suite sign-in; link one | `GET /admin/apps/oto_app/unlinked-users` | `admin:account:read`; link needs `admin:role:assign` | — | — |
| OTO App server (machine) | OTO App admin gives an app user a suite sign-in with a temporary password | `POST /admin/apps/oto_app/suite-sign-ins` | service credential `otoapp-provision` (`OTOAPP_PROVISION_KEYS`) | `employee`, `account`, `app_identity`, roles, `otoapp.users` | — |
| POS `/admin?panel=operators` (`OperatorsPanel.tsx`) | Create operator; archive; assign an operator administrator (name + phone → invite with `operator_admin` at operator scope) | `GET/POST /operators`, `PATCH /operators/:id`, `POST /operators/:id/administrators` | `platformWide: true` (a null-scope operator assignment). The nav gates on `admin:operator:read`, which every `operator_admin` holds, so they see the panel and get a 403 | `core.operator`, `employee`, `account`, `role_assignment`, `verification_code` | **DUPLICATE**: OTO App `/operators` manages its own tenants (`otoapp.operators`, `tenant_id`) |
| POS `/admin?panel=branches` (`BranchesPanel.tsx`) | Create a branch (name, code, timezone, country), mirrored into `otoapp.branches`; switch here; **no rename/retire UI** | `POST /branches`, `PUT /me/session/branch` (`PATCH /branches/:id` exists but has no screen) | `admin:branch:create` (**no target**: a grant at the seated branch suffices), `admin:branch:update` @id | `core.branch`, `otoapp.branches` | **DUPLICATE**: OTO App `/branches` (create/edit/delete, logo, QR, kiosk code) |
| same | Clone the catalogue from another branch (preview by entity, then clone; refused once the branch has sales) | `GET /branches/:id/clone-preview?from=`, `POST /branches/:id/clone` | `catalog:package:read` / `catalog:package:create` @id + read on the source | `ticket_package`, `branch_holiday`, `branch_tax_config`, `product`, `modifier_*`, `discount_definition`, `tax_override`, `print_template`, `stock_location` | — |
| Console `/branches` (`pages/Branches.tsx`) | Branch ↔ OTO App mapping (Mapped / App-only / Not mapped); **Reconcile with the OTO App** | `GET /branches/oto-app`, `POST /branches/oto-app/reconcile` | `admin:branch:read`; reconcile needs `admin:branch:update` at operator-wide reach | `otoapp.branches` | — |
| — (no screen) | Departments | **no routes** | — | `core.department`, seed only: per branch reception/restaurant/floor/nanny; operator-wide `birthdays & events`, `marketing` | **DUPLICATE**: OTO App `/departments` (CRUD, assign employees). No join between the two lists; Inbox teams hang off `core.department` |
| — (no screen) | Employees | **no CRUD routes**; created as a side effect of invites/provisioning; copied in by `job:otoapp.employee_sync` (every 900 s); self-edit through `PATCH /me` (refused for `source='otoapp'`) | — | `core.employee` | OTO App `/employees` is the **master** (C13) |
| — (no screen) | Roles / bundles editor | **no routes**: roles are resolved by name; system roles come only from code via platform-sync | — | `core.role`, `core.role_permission` | OTO App `/roles` is job titles, not RBAC |
| Launcher `/account` | Own profile (read-only), own sessions, recent hand-off rejections, sign out everywhere | `GET /accounts/:id/sessions`, `GET /audit?action=auth.handoff_rejected…`, `POST /accounts/:id/sessions/revoke` | `admin:account:read`, `admin:audit:read`, `admin:account:update` (otherwise hidden) | `session` | POS LoginUsers |
| Launcher, POS, Console, Inbox sign-in panels | Sign in, first-time setup, password reset, change password, lock/unlock, hand-off | `/auth/*` | public (rate-limited) or session | `session`, `verification_code`, `credential`, `handoff_token`, `auth_throttle` | Each app re-implements the panels; the OTO App's own password login is off unless `OTOAPP_LEGACY_LOGIN=true` |

### 1B. Fleet: boxes, stations, devices, pairing

| App · screen | Control | API | Permission | Writes | Elsewhere / duplicate |
|---|---|---|---|---|---|
| Console `/devices` → Add a box | Register a box (name, slot, role) and mint its claim code; reissue the code | `POST /branches/:id/boxes`, `POST /boxes/:id/claim-code` | `admin:box:register` (PA/OA only) | `core.box` | — |
| Console `/devices` → BoxDrawer | Edit/disable/re-enable/archive a box | `PATCH /boxes/:id`, `DELETE /boxes/:id` | `admin:box:update` / `admin:box:archive` | `box`, `device_credential` | — |
| same | Devices on a box: add (kind, label, transport, address, model, protocol); edit (+TID, MID, paper width); archive | `POST /boxes/:boxId/devices`, `PATCH /devices/:id`, `DELETE /devices/:id` | `admin:device:create/update/archive` | `core.device` | POS `/admin?panel=devices` is a **mock** form (label, type, IP, EDC TID) that saves nothing |
| same | Remote commands: re-pull config, collect logs, clear cache, restart, go offline/online, reset store (typed name, refused while the outbox is not empty), test print | `POST /boxes/:id/commands {kind}`, `POST /stations/:id/test-print` | `admin:box:command` (PA/OA, BM) | `edge.box_command`, `print_job` | POS Print Templates test print (same permission) |
| same | Simulators: printer fault, scanner scan, button press, kiosk faults | `POST /boxes/:id/commands {simulate}`, `POST /boxes/:id/simulate`, `POST /stations/:id/kiosk/simulate` | `admin:box:command` | `box_command` | — |
| Console `/devices` → Stations | New/edit station in steps: box; name, kind, code prefix, capabilities; device per role; money routing (cards/QR/cash, offline wallet cap); who may use it; archive | `POST /branches/:id/stations`, `PATCH /stations/:id`, `DELETE /stations/:id` | `admin:station:create/update/archive` | `core.station`, `station_device`, `station_staff` | **DUPLICATE**: POS `/station-setup` wizard and settings (same routes and permissions). Station Setup is the owner-facing home per the POS code comments |
| Console `/devices` → Paired screens | Pair display / kiosk / screen (code shown once); snapshot; send test intent; revoke | `POST /stations/:id/displays/claim`, `POST /stations/:id/kiosks/claim`, `POST /stations/:id/credentials`, `GET /credentials/:id/display-snapshot`, `POST /stations/:id/displays/:displayId/test-intent`, `POST /credentials/:id/revoke` | `admin:device:pair` / `admin:device:revoke` / `admin:station:read` (scope-aware on the client) | `device_credential`, `display_pairing_request`, `display_response_snapshot` | Booth screens pair from Console `/booths`; OTO App tablets pair in the OTO App (owner point 116: keep separate) |
| Console `/devices` → Card terminals | Terminal simulator outcomes (approve, decline, approve less, timeout…) | `POST /payments/terminal-simulator` | dynamic `admin:box:command` | in-memory only | — |
| POS till station picker | Pick a station at shift start (mints a shift token) | `GET /me/stations`, `PUT /me/session/station` | session + a grant at the branch + station staff list | `session`, `staff_token`, `signing_key` | — |

### 1C. Lucky Wheel booths and vouchers

| App · screen | Control | API | Permission | Writes | Elsewhere / duplicate |
|---|---|---|---|---|---|
| Console `/booths` → The wheel | Add/edit/archive/restore/reorder prizes (EN/TH name, slice label, weight, on wheel, voucher type, cost, order, daily cap, expiry, colours) | `POST/PATCH/DELETE /booths/:id/prizes[/:prizeId]`, `…/restore`, `PUT /booths/:id/prize-order` | `admin:booth:manage` (PA/OA) | `booth.booth_prize` | — |
| Console `/booths` → Booth settings | Layout, spins per day, spin duration, **staff session length**, button key, who may spin | `PATCH /booths/:id/settings` | `admin:booth:manage` | `booth.booth_settings` | The booth app reads only; nothing is set there |
| Console `/booths` → Voucher slip | Slip wording, layout, labels (EN/TH), logo/staff/terms toggles, live preview | `PATCH /booths/:id/settings`, `POST /booths/:id/voucher-preview.png` | `admin:booth:manage` | `booth_settings` | Till receipts/bands are in POS Print Templates (the Console links there) |
| Console `/booths` → Publish | Publish the draft with a "what changed" note | `POST /booths/:id/publish` | `admin:booth:publish` (PA/OA) | `booth_config_version`, `edge.box_command` | — |
| Console `/booths` → Booth staff | Who may sign in at the booth; issue/remove PIN (optional end date) | `PUT/DELETE /booths/:id/staff/:accountId[/pin]` | `admin:booth:staff_assign` (PA/OA, BM) | `booth_staff_assignment`, `core.credential` | — |
| Console `/booths` → Today's staff | Sync the duty roster from the OTO App rota; add/remove duty; matching rule | `POST /booths/:id/duty/sync`, `POST/DELETE /booths/:id/duty[/:id]`, `PATCH /booths/:id/duty/rule` | `admin:booth:staff_assign` | `booth_duty_assignment`, `booth_duty_sync`, `booth_settings` | Roster master is the OTO App schedule |
| Console `/booths` → Screens | Pair / unpair a booth screen | `POST /booths/:id/pairing-codes`, `POST /booths/:id/screens/:credentialId/revoke` | `admin:booth:manage` | `device_credential` | Console `/devices` paired screens |
| — (API only) | Wheel designs (operator-wide) | `GET/POST/PATCH /booth-layouts` | `admin:booth:read/manage` (**no target**) | `booth.booth_layout` | — |
| Console `/voucher-types` (`VoucherTypeEditor.tsx`) | Create/edit/archive/restore a voucher type: EN/TH name, value kind (amount, %, free product, free ticket 1+1, hand-over prize), per-park product, slip texts, code mode, legacy QR, validity, switched on, reference code | `POST/PATCH/DELETE /voucher-definitions[/:id]`, `…/restore`, `PUT /voucher-definitions/:id/park-products/:branchId` | `admin:booth:manage` (op; park-products has **no branch target**) | `promo.voucher_definition`, `voucher_product_link` | **SPLIT**: POS `/admin?panel=voucher-promotions` edits the same definitions' redemption rules (comes off, usage limits, validity) but cannot create one ("the delivered voucher Console/till split") |
| POS `/admin?panel=voucher-promotions` | Edit redemption rules per voucher type; mint campaign codes (≤5000); download the codes CSV | `PATCH /voucher-definitions/:id`, `GET/POST /voucher-campaigns`, `GET /voucher-campaigns/:id/codes` | read `admin:booth:read`; writes `admin:booth:manage` (codes CSV: op, **no branch target**) | `voucher_definition`, `voucher_campaign`, `voucher` | see above |
| Radar → Campaigns tab | Radar's own campaigns (name, promo code, expiry, cap, status), poster QR | Radar `/api/campaigns*` | `app:radar:access` only | Radar tables | **Overlaps** platform voucher campaigns; separate store |

### 1D. Catalogue, pricing and money settings (POS `/admin`)

All of these hydrate through `api/catalogBridge.ts`. A branch with no platform `apiId` silently stores locally only (`catalogBridge.ts:247`).

| Screen (`?panel=`) | Control | API | Permission | Writes | Elsewhere / duplicate |
|---|---|---|---|---|---|
| `tickets` | Ticket packages: name, duration, kid price weekday/weekend for the default tier and per-tier rules, adult rule, credit give-back, gate access, free items; add/edit/delete | `POST/PATCH/DELETE /branches/:b/ticket-packages[/:id]` | `catalog:package:create/update` @branch (PA/OA, BM) | `pos.ticket_package` | S2-23 plans read-only with a link out |
| `pricing` → Customer tiers | Add, rename, make default, requires proof, reorder, remove | `POST /tiers`, `PATCH /tiers/:code`, `DELETE /tiers/:code` | `catalog:package:create/update` (**op**: BM can change operator-wide tiers) | `crm.tier` (written inline in `routes/catalog.ts`) | — |
| `pricing` → Holidays | Name, start, end; dates locked once sales were priced by the range; delete refused then | `GET/POST/PATCH/DELETE /branches/:b/holidays[/:id]` | `catalog:holiday:manage` @branch | `pos.branch_holiday` | **PLANNED DUPLICATE**: S2-23 `/org` also edits holidays |
| `pricing` → Drop-off and nanny pricing | One-time fee, nanny hourly, overstay (weekday/weekend), full-day hours, nanny ratio cap, prepaid-food policy | `GET /checkin/config`, `PUT /checkin/config/pricing?branchId=` | `catalog:package:update` @branch (permission broader than its name) | `pos.drop_off_pricing`, `supervision_policy` | S2-23 `/config` plans to edit these too |
| `discounts` → Discount codes | Code, label, type, free item, value, validity, uses, per-customer limit, active, stackable, "applies to", QR download | `POST/PATCH/DELETE /menu/discounts[/:id]` | `catalog:menu:manage` (op) | `pos.discount_definition` | Usage counts are tab-local |
| `discounts` → Manual-discount reasons | Add, reorder, remove | **none (mock)** | — | — | SCRUM-230 |
| `discounts` → Payment methods | Add (label, kind), rename, enable/disable, reorder, archive (including used methods, with confirmation; recorded payments keep their code) | `POST /payment-methods`, `PATCH …/:code`, `POST …/:code/move`, `DELETE …/:code` | `catalog:menu:manage` (op) | `pos.payment_method` | platform-sync lays cash/card/PromptPay for a park with none |
| `tax` | Global rates; per area (F&B, bar, tickets, add-ons, merch): mode, rate, service %, tax on service, secondary rate; discount before/after tax | `PUT /branches/:b/tax-config` | `catalog:tax:manage` @branch | `pos.branch_tax_config` | S2-23 plans read-only; **no tax-override editor** (API has create only: `POST /branches/:b/tax-overrides`) |
| `addons`, `menu`, `merch` | Items: name, category, prep station, tax category, weekday/weekend price, cost, modifiers, sizes/SKU, active; **Track stock toggle is mock** | `POST/PATCH/DELETE /branches/:b/menu/products[/:id]`, `/menu/modifier-groups*` | `catalog:menu:manage` @branch (scope gap: the item's own branch is not compared) | `product`, `product_modifier_group`, `modifier_*`, `stock_item` | — |
| `menu` → Export/Import | Workbook export; import preview then commit | `GET /branches/:b/menu/export.xlsx`, `POST …/menu/import/preview|commit` | `catalog:menu:manage` / `catalog:menu:import` (PA/OA, BM) | `product_category`, `product`, `product_modifier_group` | — |
| `categories` | Category, parent, prep station, tax category; reorder; delete (reassigns items) | `POST/PATCH/DELETE /menu/categories[/:id]` | `catalog:menu:manage` (op) | `pos.product_category` | — |
| `modifiers` | Shared modifier groups and options | `/menu/modifier-groups*` | `catalog:menu:manage` (op) | `modifier_group`, `modifier_option` | — |

### 1E. Operations settings

| App · screen | Control | API | Permission | Writes | Elsewhere / duplicate |
|---|---|---|---|---|---|
| POS `?panel=inventory` | Stock items (variants, packs, cost, reorder settings, pars, photo, linked sellable); per-variant adjust; stock places (add, edit, retire, sell point) | `/branches/:b/stock/{items,adjustments,locations,…}` | **no client permission** (`localOnly` flag is stale); server `pos:stock:adjust` @branch | `stock_item`, `stock_unit`, `stock_location`, `stock_level`, `stock_movement`, `stock_attention` | POS `/stock` mobile module (transfer, receive, count, purchase orders) |
| POS `?panel=supervision` | Age bands and requirement; consent checklist; sibling waiver | `PUT /checkin/config/policy`, `PUT /checkin/config/confirmations` | **no client permission** (`localOnly` stale); server `catalog:package:update` @branch | `pos.supervision_policy`, `pos.confirmation_item` | S2-23 `/config` plans to edit "supervision policy, confirmations and drop-off pricing" |
| POS `?panel=events` | Walk-up prices: camp day, event day, party guest | `PUT /branches/:b/event-drop-in-pricing` | `admin:event_pricing:manage` @branch (PA/OA, BM) | `pos.event_drop_in_pricing` | Events themselves are mastered by the OTO App (C10); OTO App `/events/settings` |
| POS `?panel=templates` | Print templates (receipt, kids/adult band, kitchen, bar, credit voucher): logo/header/footer, content toggles; preview; test print | `GET /branches/:b/print-templates`, `PATCH /print-templates/:id`, `POST …/preview.png`, `POST …/test-print` | `admin:branch:update` (template edit); test print `admin:box:command` | `pos.print_template`, `print_job` | S2-23 `/config` plans to edit print templates; booth slip lives in Console `/booths` |
| POS `?panel=devices` | Devices and EDC terminals | **none (mock)** | `localOnly` | — | Real fleet is Console `/devices` |
| POS `?panel=staff-benefits` | Role templates (owner/manager/staff) with effective date; per-person benefit role and override; issue/revoke/print QR; application log | `/benefits/templates*`, `/benefits/profiles*`, `/benefits/credentials*`, `GET /benefits/applications` | read `admin:benefit:read` (PA/OA, BM); edit `admin:benefit:manage` (op; PA/OA); QR `admin:benefit:credential_issue` | `promo.benefit_role_template`, `benefit_profile`, `benefit_credential`, `core.signing_key` | Keyed on `core.employee`, whose master is the OTO App |
| POS `?panel=wallets` | Look up a wallet; reactivate expired credit with a reason | `GET /wallets/lookup`, `POST /wallets/:id/reactivate` | `pos:wallet:read`; `pos:wallet:reactivate` (PA/OA, BM) | wallet ledger | — |
| POS `?panel=members` and `tier-verifications` | Member CRUD, children, tier change with proof, revoke verified tier; tier-proof list | `/members*`, `POST/DELETE /members/:id/tier-verification`, `GET /members/tier-verifications` | `pos:member:update`; revoke `pos:member:tier_downgrade`; list `pos:member:list` | `crm.member`, `crm.child`, `crm.member_tier_verification` | — |
| — (no screen, no write route) | Wallet policy | `GET /wallets/policy` (read only) | `pos:wallet:read` | `pos.wallet_policy` (seed only) | S2-23 lists "wallet cap" as a `/config` setting |
| — (no screen, no write route) | Nanny roster | read inside check-in config | — | `pos.nanny`, `pos.nanny_shift` (seed only; "fed from the staff rota later") | Duplicates the OTO App schedule concept |

### 1F. Running the platform (ops)

| App · screen | Control | API | Permission | Writes | Elsewhere |
|---|---|---|---|---|---|
| Console `/health` | Acknowledge an alert | `POST /ops/alerts/:alertId/acknowledge` | `admin:ops:manage` (PA/OA; BM does not hold it) | `core.alert` | — |
| Console `/health` | Test controls (staging only): demo scenarios, force jobs incl. `otoapp.employee_sync`, faults | `GET /ops/test-controls`, `POST /ops/test-controls/:key` | `platformWide` + `OPS_TEST_CONTROLS` (client shows them on `admin:ops:manage`) | many | — |
| Console `/failures` → Problems | Retry a run (job or OTO App write-back) | `POST /ops/runs/:runId/retry` | `admin:ops:manage` | `ops_run` + whatever the job writes | — |
| Console `/failures` → Quarantine | Replay / discard (with a note) quarantined sync events, singly or all | `POST /ops/quarantine/:id/replay`, `POST /ops/quarantine/:id/discard` | `admin:ops:manage` at the box's branch | `edge.sync_quarantine` + domain tables | — |
| POS `?panel=operators` | Demo reset (typed phrase, staging only) | `GET/POST /ops/demo-reset` | `platformWide` + `OPS_TEST_CONTROLS` | many | — |
| Console `/integrations` | 2C2P gateway simulator: customer paid, decline, expire, late, suppress callback | `GET/POST /webhooks/2c2p/simulator` | server `admin:ops:manage` (no target); **no client check** | `payment_attempt`, `payment_notification`, booking/sale | — |
| Console `/integrations` | 2C2P settlement CSV import | `POST /branches/:id/settlements/2c2p-import` | `pos:payment:settle` @branch (PA/OA, BM) | `settlement_batch`, `settlement_line`, `ops_run` | POS EOD Settlement panel runs terminal settlement (`POST …/settlements/terminal-runs`, same permission) |
| — (API only) | Per-branch analytics data source (own POS / legacy) | `PUT /analytics/sources/:branchId` | `admin:branch:update` @branch | `analytics.branch_source_switch` | **No screen anywhere on the platform.** The owner wants it in the OTO App's admin AND the Console |

### 1G. Inbox and assistants

| App · screen | Control | API | Permission | Writes | Elsewhere |
|---|---|---|---|---|---|
| Inbox `?settings=templates` | Templates per key × language × channel × park; Meta approval state; provider name; offered in composer; archive; birthday brochure upload | `GET /inbox/templates/manage`, `POST /inbox/templates`, `PATCH …/:id`, `POST …/:id/archive`, `PUT …/:id/brochure` | `inbox:template:manage` (inbox_manager, inbox_admin, PA/OA), checked at the template's branch | `inbox.template`, `file_object` | — |
| Inbox `?settings=assistant` → Channels | Assistant mode per number: off / shadow / live (live asks to confirm) | `GET /inbox/ai/channel-accounts`, `PATCH /inbox/channel-accounts/:id/ai-mode` | `inbox:ai:manage` (inbox_admin, PA/OA) | `inbox.channel_account` | — |
| Inbox `?settings=assistant` → Knowledge base | Draft, edit, approve, archive entries (topic, key, language, park, Q/A) | `/inbox/kb*` | `inbox:kb:manage` | `inbox.kb_entry` | — |
| Inbox `?settings=assistant` → Examples | Review proposed corrections: edit, approve (de-identified), reject, delete | `/inbox/ai/examples*` | `inbox:kb:manage` at operator-wide reach | `inbox.ai_example` | Proposals come from threads (`inbox:conversation:reply`) |
| Inbox simulator | Play demo, inject an inbound message, push receipts | `POST /inbox/simulator/*` | `inbox:channel:manage` + `INBOX_SIMULATOR=on` | inbox tables | — |
| — (API only, never called by any client) | PDPA erase a contact | `POST /inbox/contacts/:id/erase` | `inbox:contact:erase` at operator scope only (PA/OA) | contact, messages, files (DELETE)… | S2-23 `/data` plans the suite-wide erasure flow |
| — (no screen, no route) | Teams, routing rules, channel connection/webhook setup, SLA policy, assistant tone/global switch | — | `inbox:routing:manage` and `inbox:channel:manage` are declared; **no route uses `inbox:routing:manage`** | `inbox.team`, `inbox.routing_rule`, `inbox.sla_policy` (laid by platform-sync; never editable) | — |
| Launcher assistant dock | Ask the internal assistant; feedback | `/assistant/asks*` | `assistant:ask:use` (every staff bundle + inbox roles) | `assistant.ask`, `tool_call` | — |
| — (API only) | Review others' asks | `GET /assistant/review/asks`, `GET /assistant/asks/:id` | `assistant:log:review` operator-wide (PA/OA) | audit row on read | **No reviewer screen** |

### 1H. Launcher, booth app, Radar and the OTO App

| App | Admin/config surface | Gate |
|---|---|---|
| Launcher | **None.** The tiles come from code (`suite/apps.ts` `SUITE_APPS`): pos, console, oto_app, radar, booth (also needs `admin:booth:read`), inbox, each shown on `app:<key>:access` held at any scope. URLs come from `VITE_*_URL`; a tile with no URL goes to `/soon/:key`. | permissions |
| Booth app | **None.** It reads the published config (eligibility, button key, daily spin cap, staff session minutes, spin duration, slip). It has device-side claim, booth pick and pairing, and staff PIN/account sign-in. The `#debug` overlay is read-only plus a "run 200 draws" odds check. | device credential + booth staff list |
| Radar | Revenue planner: monthly target per branch, saved scenario (`/api/planner/*`); calendar day notes; Campaigns tab (CRUD); staff-birthday write routes exist but are unused. Stored in Radar's own `branch_settings`/`calendar_notes`, keyed by Radar's own slugs (floresta/chalong), not platform branch ids. | `app:radar:access` only, no finer roles |
| OTO App | `/users` (+ suite sign-in), `/operators`, `/branches`, `/departments`, `/roles` (job titles), `/locations`, `/permissions` (modules, access level, branch scope), Vault (`/settings/access`, reveal at `/access`, which needs sign-in only), `/settings/permissions-debug`, `/settings` (AI model, signatory, prod sync), supplier tokens, `/employees`, contracts, templates, policies, public holidays, scheduling, org chart, advisors, `/payroll/*`, `/setup`, `/studio/*`, `/events/settings`, `/ops`, `/data/*` (raw data editor) | its own `users.role` (6 values) + module access policy; **no platform permission strings** |

### 1I. Till settings that are not configurable

| Setting | Today |
|---|---|
| Lock timeout | Hard-coded: `INACTIVITY_TIMEOUT_MS = 120_000`, warning `15_000` (`apps/pos/src/auth/timings.ts:15-16`) |
| Theme | Memory only; the menu says it does not survive a reload |
| Customer-display show/hide | Memory only |
| Customer-display language | localStorage only |
| Station choice | localStorage |
| Branch | `PUT /me/session/branch` (session) |

### Platform-sync defaults

`platformSync` (`packages/db/src/seed/index.ts:169`) runs on every api deploy as the Render pre-deploy `pnpm db:migrate && pnpm db:platform-sync`. Its direction is code → `core.*`.

1. **System roles** (`platform_admin`, `operator_admin`, `branch_manager`, `reception`, `staff`, with `operator_id` null and `is_system`) are upserted. Their `role_permission` rows are made to **exactly** match `ROLE_BUNDLES`, and extras are deleted. A system role cannot be tailored by any admin.
2. **Tenders:** cash / card / PromptPay are written only for a park with **no** payment methods.
3. **Stock setup** (places, items, sizes, packs, links) is laid for a branch with none. No opening quantity is set.
4. **Inbox**, insert-if-absent per operator:
   - the roles `inbox_agent`, `inbox_manager` and `inbox_admin`, whose permissions are laid only at creation, plus named late grants
   - the departments `birthdays & events` and `marketing`, plus `reception` for each branch
   - the teams Birthdays & Events, Reception · <branch> and Marketing
   - a blank routing rule per team
   - the templates and their translations
   - console notice channel accounts for WhatsApp, LINE and Telegram
   An operator's later edits are never overwritten.
5. **Not done:** the OTO App, accounts, employees, `app_identity`, and the `core.branch` ↔ `otoapp.branches` reconcile (that runs only in the full demo seed).
6. **Separate seams:**
   - `job:otoapp.employee_sync` copies OTO App employees into `core.employee` every 900 s.
   - `app_access_<app>` roles are created on demand by `ensureAppAccessRole`.
   - The full seed also always creates a "Second Operator" with its own `operator_admin` (SCRUM-289). `SEED_PROFILE=production` runs platform-sync only.

---

## 2. Duplicates: one concept, more than one home

| Concept | Where it lives today | Authoritative | Notes |
|---|---|---|---|
| **People / logins** | Platform: `core.account` via POS LoginUsers. OTO App: `otoapp.users` via `/users`, which can also mint the platform account. Seam: `core.app_identity` + `otoapp.users.platform_user_id` | Each app keeps its admin (OWNER_DIRECTION 2026-09-20). The platform account is the sign-on identity; the seam is the only cross-app write | Deactivation cascades platform → OTO App, but reactivation does not. Owner points 98/99 (leavers, auto-create suite account) are open |
| **Roles / permissions** | Platform scoped RBAC (system roles from code, `app_access_<app>` roles, inbox roles). OTO App: `users.role` (6 values), `/permissions` module policy, module overrides, job-role table. Benefit roles owner/manager/staff | Platform for suite and app entry; OTO App for its modules | Three unmapped role vocabularies. **No role editor anywhere on the platform** |
| **Operators / tenants** | `core.operator` (POS Operators panel, platform-wide only) and `otoapp.operators` / `tenant_id` (OTO App `/operators`) | Not decided | Creating an operator on the platform creates nothing in the OTO App |
| **Branches** | `core.branch` (POS Branches: create only; Console: map/reconcile) and `otoapp.branches` (OTO App `/branches`: full CRUD, logo, QR, kiosk code). Linked by `core_branch_id`. Radar has its own slugs | features/console.md: the OTO App until cutover, then the platform. Today a platform create/rename writes both | Platform has no rename/retire UI although `PATCH /branches/:id` exists |
| **Departments** | `core.department` (seed only, no routes; scopes inbox teams) and `otoapp.departments` (OTO App CRUD) | Not decided | **No join**. Inbox teams cannot follow an OTO App department change |
| **Employees** | `core.employee` (side effects of invites; copied from the OTO App every 15 min) and `otoapp.employees` | OTO App (C13) | Platform copies are read-only for `source='otoapp'` |
| **Stations** | Console `/devices` stations wizard and POS `/station-setup` | Same API; both live | Two UIs for one record |
| **Devices** | Console `/devices` (real); POS `?panel=devices` (mock); OTO App kiosk tablets (own list) | Console for platform devices; OTO App tablets separate (point 116) | Remove or relabel the POS mock |
| **Voucher definitions** | Console `/voucher-types` (create/edit/archive, wording, value) and POS Voucher Promotions (redemption rules, campaigns). Radar Campaigns is its own promo store | The delivered "Console/till split" (owner confirmations) | Radar campaigns are a third, unconnected list |
| **Audit view** | Console `/activity` (full); POS LoginUsers "recent denials"; Launcher `/account` rejections | Console | Same `GET /audit` |
| **Sessions / sign-out everywhere** | POS LoginUsers; Launcher `/account` | Platform | Same routes |
| **Holidays** | POS `?panel=pricing` (platform); OTO App public holidays (HR); S2-23 `/org` plans a third editor | POS for pricing holidays | Different meanings: pricing vs HR leave |
| **Supervision / drop-off / print templates / wallet cap** | POS `/admin` (wallet cap: nowhere); S2-23 `/config` plans the Console as editor | POS today | Planned duplicate; contradicts "domain settings stay with their app" |
| **Analytics data source** | API only (`PUT /analytics/sources/:branchId`) | Owner: "from the OTO App's admin and from the Console" | Neither screen exists |
| **Erasure** | Inbox contact erase (API only); S2-23 plans a suite-wide `erasure_request` | — | — |
| **Settlement** | POS EOD (terminal run, export); Console `/integrations` (2C2P import) | — | Split by tender, not a conflict |

---

## 3. Analytics and overview surfaces

| App · screen | What it shows | API | Permission |
|---|---|---|---|
| Console `/health` | Services (estate-wide only), boxes, open alerts, scheduled jobs, analytics rollup freshness (Radar line on `app:radar:access`), booths, kiosks; polled every 30 s | `GET /ready` (public), `GET /ops/health`, `GET /ops/kiosks`, `GET /branches/:id/boxes`, `GET /boxes/:id/devices` | `admin:health:read` (PA/OA, BM); estate vs park view decided by the server's `reach` |
| Console sidebar | Failure count badge | `GET /ops/failures?windowHours=24` | `admin:health:read` |
| Console `/failures` | Grouped failed runs by kind and window; run history; quarantine; anomalies | `GET /ops/failures`, `/ops/runs`, `/ops/quarantine`, `/ops/anomalies` | `admin:health:read` |
| Console `/integrations` | Provider states, missing variable names, variables to provision, console build vars | `GET /ops/integrations` | `admin:health:read` |
| Console `/activity` | Audit search: presets, actor/branch/outcome/date filters, changes/raw/related drawer; masked unless sensitive | `GET /audit` | `admin:audit:read` (+ `admin:audit:read_sensitive` writes an audit row) |
| Console `/booth-report` | Booth summary tiles, by booth/prize/staff; CSV | `GET /analytics/booths`, `/analytics/booths/export` | `analytics:read` |
| Console `/booths` | Booth status, spins per day, version history, duty | `GET /booths/:id/status`, `/spins`, `/versions`, `/duty` | `admin:booth:read` |
| Console `/devices` | Box command history, heartbeats, box log, station refusals, print jobs, simulator printouts | `GET /boxes/:id/{commands,heartbeats,log,station-events,print-jobs}`, `/devices/:id/printouts` | `admin:box:read`, `pos:print:read`, `admin:device:read` |
| Console `/bookings` | Online booking ledger and redemptions | `GET /bookings/ledger` | `pos:booking:read` |
| Console `/vouchers` | Voucher ledger, totals by type, CSV | `GET /vouchers`, `/vouchers/export` | `admin:booth:read` |
| POS Today / Performance | Revenue, guests, parties, drop-off kids, revenue split, ticket mix; all-branches when more than one is readable | `GET /analytics/summary`, `GET /checkin/today` | `pos:cash:read` or `analytics:read` per branch |
| POS Today / End of Day | Expected vs actual per channel, counted cash, vouchers, stranded occupants, close/reprint; settlement | `GET /branches/:b/end-of-day`, `/settlements`, `/settlements/export`, `/cash-movements` | `pos:cash:read` (every counter role); close `pos:cash:day_close` (incl. `staff`) |
| POS `/admin` Reporting | Sales, Profitability, Wallet & Promo, Discounts & Comps, Tax & VAT (+ receipts export), Benefits; CSV | `GET /analytics/reports/{sales,profitability,discounts,discounts/transactions,tax/vat,tax/receipts,benefits,benefits/transactions}`, `/wallets/report`, `/vouchers/promotions/report` | `analytics:read` per branch (PA/OA, BM) |
| POS `/history` | Day's sales; lookup by band/phone; sale detail | `GET /sales`, `/sales/lookup`, `/sales/:id` | `pos:sale:read` |
| POS `/stock` → Reports | Discrepancies, usage, shrinkage, purchases, value; alerts | `GET /branches/:b/stock/reports`, `/stock/attention`, `/stock/movements` | `pos:stock:read` (cost needs `pos:stock:order`) |
| POS header | Occupancy (5 s), pricing mode, printer health (30 s), station link (20 s) | `GET /branches/:b/occupancy`, `/pricing-mode`, `/stations/:id/printers`, `/me/station/link` | `pos:checkin:read`, `catalog:package:read`, `pos:print:read`, session |
| POS `?panel=tier-verifications` | Tier proof list (200 newest) | `GET /members/tier-verifications` | `pos:member:list` server-side (client gates `pos:member:read`) |
| Inbox dashboard | New today, unanswered, active, handled today, average first response, mix by category | `GET /inbox/dashboard` | `inbox:dashboard:read` |
| Radar dashboard | Revenue, AOV, guests, categories, ticket sources, heatmap, performance, discounts, survey; calendar; trends AI; campaign stats; spin report | Radar `/api/figures/*`, `/api/campaigns/stats|timeseries`, `/api/spin-wheel/report`, `/api/visitor-survey/summary` | `app:radar:access` |
| OTO App | `/dashboard`, `/attention`, `/timekeeping-review`, `/activity-logbook`, `/staff-movements`, `/analytics` (Xero) | OTO App `/api/*` | OTO App roles |
| API only, no screen | Cost of goods; wallet credit-day line; assistant review log; benefit applications report; `GET /docs/json` (OpenAPI) | `/branches/:b/stock/reports/cost-of-goods`, `/wallets/credit-day`, `/assistant/review/asks`, `/analytics/reports/benefits*`, `/docs/json` | `analytics:read`, `pos:wallet:read`, `assistant:log:review`, `admin:health:read` |
| Public | Liveness and readiness | `GET /health`, `GET /ready` | public |

---

## 4. Prior decisions (quoted)

**OWNER_DIRECTION.md, 2026-09-19:**

> "End state: one central database, one launcher page showing all OTO apps, apps sharing data, one admin dashboard with analytics of everything."

**OWNER_DIRECTION.md, 2026-09-19 (later):**

> "a **fifth, built by us: a super admin** that oversees and controls everything: all apps' analytics report to it; activity logs (which staff did what); user control and permissions; POS station setup. Exact contents to be decided later; it must be in the plan from the start."

> "The wheel game is a web page with a button and hard-coded prizes; it must become controlled from the admin side."

**OWNER_DIRECTION.md, order of work:**

> "The POS keeps its own admin; the OTO App keeps its own admin controls. Both in this sprint."

> "**Launcher**: the first screen is a styled, OTO-Park-themed landing page listing the apps (POS, OTO App, Radar, Lucky Wheel, Console, Inbox) with 'coming soon' placeholders where an app is not ready; it is also where the central login is tested."

**OWNER_DIRECTION.md, 2026-09-20:**

> "**Data-source switch is an admin control.** An administrator — from the OTO App's admin and from the Console — chooses per branch whether the analytics shown are the current POS (Pisell/Papaya) or the new OTO POS."

> "**Super admin (Console) is the owner's own control surface.** The POS keeps its admin for POS operations and the OTO App keeps its admin for internal operations; the Console is deliberately an addition *for the owner*, so that future control is easy. We design it ourselves: think through every control worth having across all apps, plan it properly, describe it fully in the Jira ticket, and build it in this sprint."

**SPRINT_2_PLAN.md, S2-23 (SCRUM-221; register: "To Do — standing backlog, not started"), lines 3503–4030:**

> "the Console is deliberately **not** a third copy of either. It is the layer above them … S2-03 built Console v1 (`apps/console` + `packages/admin-ui` …) with Activity, Failures, Health and Integrations; S2-04 added Devices and S2-07b added Booths. This ticket completes the surface: eleven further pages, the `console:*` permission vocabulary, a platform-owned app registry and feature-flag store, support tools …, data and release controls, and the danger rules for everything that can hurt."

> "The rule that keeps it honest: **the Console never writes another app's tables directly.** … where a setting belongs to another app, the Console shows it read-only, labelled 'owned by <app>', with a deep link."

> Excludes: "moving the Sprint 1 POS admin panels into the Console — the POS keeps its own admin by the owner's decision, so Open decision 2's 'move in Sprint 3' half lapses with Sprint 3 and the Console links to those panels instead; editing OTO App HR data, Radar formulas or POS catalogue and prices from the Console (read-only with links out) …"

S2-23 also specifies:
- the pages: Overview, Org, People, Apps, Activity, Failures, Health, Devices, Integrations, Analytics, Config, Money, Support, Data, Releases
- eight new `core` tables: `app_registry`, `feature_flag`, `impersonation_session`, `setting_registry`, `retention_policy`, `erasure_request`, `alert_recipient`, `deploy_event`
- about 35 `console:*` permissions
- a `support` role
- dual control, kill switches with expiry, and audited impersonation

**SPRINT_2_PLAN.md, Open decision 2:**

> "**Console v1 as a separate deployable now.** Default: yes — `apps/console` hosts Devices, Activity, Failures, Health, Integrations, Booths; Sprint 1 panels stay in the POS `/admin` and move in Sprint 3."

**SPRINT_2_PLAN.md, Open decision 33:**

> "Default: no purge of any audit row this sprint; the retention job (S2-03) is configured per category later, with financial and release categories never below five years."

**PLATFORM_PLAN.md §9:**

> "Domain settings stay with their app: catalogue, prices and tiers in the POS back office; HR settings in OTO App; formulas and targets in Radar. The accounts, roles and audit screens built in Sprint 1 move from the POS admin to the Console."

**docs/features/console.md, open questions:**

> "Exact list of module and feature switches the client wants per person. Who besides the owner gets Console access, and whether any action needs a second approver (e.g. granting Console access, revoking a box). Alert channels and who receives which alert."

**intake-2026-09-19/02-oto-app-frontend.md:**

> "Do not port `/users`, `/operators`, `/permissions`, permissions-debug, the enable-login wizard or `/data`; move them to the super-admin console. Move `/analytics` to Radar."

This is an early intake recommendation. The live OTO App still carries all of those pages.

**OWNER_CONFIRMATIONS_2026-10-13:**
- Point 116 (OTO App kiosk tablets): "Keeping separate device management remains the accepted default."
- Point 99: "Should app password controls point to the launcher, and should creating an app user also create a suite account? **Today:** Existing controls remain; administrators use Console Link for suite sign-in."
- Point 152: alert recipients outside opening hours are unconfirmed; the default is "Console Failures, without a confirmed external recipient".

---

## 5. Gaps noticed

### 5.1 In the data model or API, but no screen

- **Departments:** `core.department` has no route and no screen, yet it is the scope Inbox teams hang on.
- **Employees:** `core.employee` has no CRUD; it is changed only by side effects and the copy job.
- **Roles:** no role or bundle editor, no `/roles` route. Custom operator roles cannot be made except `app_access_<app>`.
- **Record scope:** declared in `ScopeType` but cannot be granted (`assertScopeOwned` always throws).
- **Branch rename/retire, opening hours, `business_day_start`:** `PATCH /branches/:id` exists with no screen.
- **Analytics data source per branch:** `PUT /analytics/sources/:branchId` has no screen. The owner asked for it in the OTO App admin and the Console.
- **Wallet policy:** `pos.wallet_policy` has a GET only, with no write route at all.
- **Nanny roster:** `pos.nanny`, `pos.nanny_shift` are seed only, with no route and no feed.
- **Inbox:**
  - Teams and routing rules: `inbox.team`, `inbox.routing_rule` have no route. `inbox:routing:manage` is declared and used by none.
  - `inbox.sla_policy` is referenced nowhere in the api.
  - Channel connection has no setup.
  - PDPA erasure (`POST /inbox/contacts/:id/erase`) is never called by any client.
- **Tax overrides:** create-only API and no editor.
- **Booth layouts:** `/booth-layouts` routes with no screen seen.
- **Assistant review log:** `GET /assistant/review/asks` has no screen.
- **Cost of goods and the wallet credit-day line:** API exists; the POS client helpers are dead code.
- **Booth-layout and voucher-campaign code exports:** operator-wide with no branch target.

### 5.2 Screens with no permission, or the wrong one

- **POS `/admin`:** Inventory and Supervision are flagged `localOnly` with no permission but now write through the API. Anyone past the admin front door sees them; only the server guards them.
- **POS `/admin` mock panels:** Devices and Discount reasons save nothing. The "Track stock" toggles on Add-ons, Menu and Merch are also mock.
- **Client `can()` ignores scope** in the POS (`held.has`), Launcher and Console (except a few scope-aware Devices checks). A branch grant lights controls up for every branch.
- **POS Operators panel:** gated on `admin:operator:read`, which every `operator_admin` holds, while the routes are `platformWide`. Operator admins see a panel that always 403s, and the code comment "No operator role holds this" is wrong. `admin:operator:create/read/update` guard no route.
- **Console:**
  - `/activity`, `/booth-report`, `/bookings`, `/vouchers` and `/integrations` have no in-screen checks beyond the route permission.
  - The 2C2P gateway simulator has **no client check** at all.
- **Inbox:** the Templates picker and attachment open have no client gate (server-checked).
- **OTO App Vault reader** (`/access`, reveal a stored secret): signed-in only, no role.

### 5.3 Guard and scope gaps on the API (from the route sweeps)

- **No target, so checked at the session's branch** (a branch manager passes for operator-wide data):
  - `/tiers`, `/payment-methods`, `/menu/categories`, `/menu/modifier-groups`, `/menu/discounts`
  - `/voucher-definitions*` (incl. `PUT …/park-products/:branchId`, which ignores the URL branch)
  - `GET /voucher-campaigns/:id/codes`
  - `/booth-layouts`
  - `/benefits/*`
  - `POST /branches`: a grant at the seated branch can create a branch for the whole operator
- **Menu item scope:** `PATCH/DELETE /branches/:b/menu/products/:id` never compares the item's own branch with the path, so an item at another branch can be edited.
- **Permissions that guard more than their names:**
  - `catalog:package:update` also guards the supervision policy, consent checklist and drop-off/nanny pricing.
  - `admin:branch:update` also guards print templates and the analytics source switch.
  - `pos:cash:day_close` is in `staff`.
- **`/admin/apps/*` and file account-owner paths:** use the dominance check but not `assertAccountInScope` (the SCRUM-266 gap).
- **`/ops` retry and acknowledge:** reach rows with `operator_id IS NULL`, so an operator-wide `admin:ops:manage` holder can act on platform-wide alerts and jobs.
- **Signed-in only, no permission:**
  - `POST /me/staff-token` mints for the seated station without re-checking the grant.
  - `POST /stations/:id/scan|button` at your own station.
- **Public simulator payment:** `POST /webhooks/2c2p/hosted/:attemptId` is public; anyone with an attempt id can mark a booking paid or failed where the simulator runs.
- **`role_assignment` inconsistency:** `archived_at` exists but DELETE hard-deletes and the resolver ignores `archived_at`.
- **Stale permissions comment:** "platform_admin … bypasses operator scoping … that flag lives on the role row". No flag exists. Platform-wide is a null-scope operator assignment, and in practice it unlocks only `/operators`, the test controls and granting platform-wide scope. A platform admin cannot act inside a second operator.

### 5.4 Planned (S2-23) but not built

- **Permissions and roles:** no `console:*` permission exists, and there is no `support` role.
- **Tables:** none of the eight planned `core` tables exists.
- **Shared UI package:** `packages/admin-ui`, which S2-23 says Console v1 is built on, does not exist; the console has its own components.
- **Console pages:**
  - Built: Health, Failures, Activity, Booths, Booth report, Devices, Branches (mapping only), Bookings, Vouchers, Voucher types, Integrations.
  - Missing: Overview, Org, People, Apps (registry), Analytics/sources, Config, Money, Support, Data, Releases.
- **Launcher tiles** are a code constant (`SUITE_APPS`), not the planned `app_registry`. There is no maintenance mode and no feature flags or kill switches anywhere.

### 5.5 Document conflicts to settle before planning

1. **Accounts, roles and audit screens:** "move to the Console" (PLATFORM_PLAN §9, features/console.md, the OTO App intake) against "the POS keeps its admin; the Console links out" (S2-23 Excludes, OWNER_DIRECTION 2026-09-20). Today they are in POS `/admin` only. The Console tells users to "grant it from the Login Users panel" but never links there; only the sidebar's general "Catalogue, tax and accounts" link goes to POS `/admin`.
2. **Holidays and supervision/print/wallet settings:** S2-23 plans `/org` and `/config` to *edit* them, while catalogue, tax and prices stay read-only. That creates a second editor, against "domain settings stay with their app".
3. **The OTO App's tenancy, branch, department and RBAC admin** runs in parallel with the platform's. No decision names one master for operators or departments.
