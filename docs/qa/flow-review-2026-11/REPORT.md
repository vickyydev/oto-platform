# Floor-flow input review — 2 November 2026

SCRUM-702. Read-only review of inputs required by the till, check-in board,
station setup, booth, kiosk and counter box. **Six new findings: three block
the affected operation, three degrade it, none are cosmetic.** The three
blocking findings have tickets SCRUM-703, SCRUM-704 and SCRUM-705.

These are source-verified findings, not incidents reproduced on staging.
No staging request, sale, payment, registration, pairing, setting, message or
hardware action was made. No product code, migration or test was changed.
Docker and local databases were not started. The only writes for this unit
are this report, its STATUS entry and commit, and the permitted Jira records.

Reviewed source: `95518ecfd844fd84a1f51888354b8231f728601b`, in
`C:/oto-lanes/codex-flow-review-20261102`, branch
`lane/codex-flow-review-20261102`. File and line references below bind to
[that source revision](https://github.com/vickyydev/oto-platform/tree/95518ecfd844fd84a1f51888354b8231f728601b).
Integration checked against main `9eb6fe18406dfd9dbe3ac264b263b8bff35cbff4`:
the intervening work adds the nanny roster lane, API fixture repairs and
progress notes. The production paths cited for B1/B2/B3/D1/D2/D3 are
unchanged apart from exporting the existing care-policy helper. The nanny
writers now exist in landed source; no staging acceptance of that lane is
claimed here.

## Summary

Each new finding is counted once, under its primary family. Cross-family
causes are described in the finding. Existing tickets and inventory entries
are excluded from these counts and listed separately below.

| Primary family | Blocks the affected operation | Degrades | Cosmetic | New findings |
|---|---:|---:|---:|---|
| 1. Seed-dependent inputs | 0 | 1 | 0 | D1: editable print templates for a new branch |
| 2. Inputs that expire without renewal | 0 | 1 | 0 | D2: check-in board photo URLs |
| 3. Simulator versus real devices | 0 | 0 | 0 | Existing SCRUM-700 and SCRUM-223 cover the missing physical readers/drivers |
| 4. Setup accepts an unusable selling configuration | 2 | 0 | 0 | B1: prefix; B2: terminal route and protocol |
| 5. Two sources of truth | 0 | 0 | 0 | Existing inventory entries and roster/access tickets; no additional blocking dependency established |
| 6. Consumer has no supported configuration producer | 1 | 0 | 0 | B3: gate controller and readers compete for one assignment slot |
| 7. Offline input or replay differs from online | 0 | 1 | 0 | D3: booked check-in consent acknowledgement is dropped |
| **Total** | **3** | **3** | **0** | **6** |

“Blocks” here is conditional and local to the named operation. B1 stops
sales on a till saved without its prefix. B2 stops the selected terminal
tender; cash or manual-card recording can remain alternatives. B3 prevents
constructing a complete gate lane through the supported setup. It does not
claim a physical gate has been deployed or tested. D3 loses an expected
record while allowing check-in, so it is classified as degrading data
reliability, not as blocking admission.

## New findings

The eight columns follow the brief. Evidence is a connected source trace
from the producer to the consumer, including the refusal or missing write.
No runtime or staging reproduction is implied by a file reference.

| Flow and finding | Input it needs | Who writes it in production | What the person sees when it is missing or expired | Can staff recover without an engineer? | Verified how | Severity | Proposed fix and tracking |
|---|---|---|---|---|---|---|---|
| **B1 — a till with no receipt prefix remains selectable** (family 4) | A valid station code prefix before creating a sale; it starts receipt numbers and signed band codes. | An administrator edits the station in Admin → Devices → Stations. Both the form and API allow a null prefix for a non-booth station; no selling-readiness check connects that save to the receipt requirement. | The station saves, but its first and subsequent sales fail with “This station has no code prefix, so it cannot number a receipt”. The refusal is before sale creation; no payment loss is claimed. | **Yes, administrator:** add a prefix in station setup. Reception cannot complete a sale at that station until it is supplied. | `apps/console/src/components/devices/StationDrawer.tsx:192-199`; `apps/api/src/routes/fleet.ts:181`; `apps/api/src/services/fleet.ts:348-369,553-602,669-729,1185-1197`; `apps/api/src/services/sale.ts:3474-3487`. The Console's ready predicate requires a prefix only for booths, whereas sale creation requires one for the till. | **Blocks sales at that incomplete till.** | Require a valid prefix before offering the station for trading; show unfinished setup clearly if drafts remain saveable. **[SCRUM-703](https://oto-suite-dev.atlassian.net/browse/SCRUM-703)**, Bug, `pos`. |
| **B2 — terminal routing can be saved without a usable destination** (family 4) | An active device assigned to the selected card/QR role, with a recognised `ghl_linkpos` or `digio_tlv` protocol. | An administrator adds/edits a terminal and assigns it to the station. Adding requires only a label. Protocol is optional free text. Station setup warns about an empty terminal assignment but still saves; the API checks device kind and box ownership, not payment protocol or route completeness. | Card or terminal-QR payment is later refused with `NO_TERMINAL_FOR_STATION`. A blank/unknown protocol makes an assigned terminal just as unusable as no terminal; the box also excludes it. This occurs with simulated devices too and is separate from the missing real serial driver. | **Yes, administrator:** assign the device and correct its protocol, or use the existing manual-card route. A cashier may offer another enabled tender. Real terminals still require SCRUM-223's physical driver work. | `apps/console/src/components/devices/StationDrawer.tsx:198,444-454`; `apps/console/src/components/devices/BoxDrawer.tsx:669-695,731-745`; `apps/api/src/services/fleet.ts:997-1030`; `apps/api/src/services/payments/terminal.ts:620-655`; `packages/box-agent/src/terminal/index.ts:119-125,301-306`. | **Blocks the selected terminal tender**, not all payments or all sales. | Validate route readiness against assignment and supported protocol before offering the tender, and provide a supported protocol picker. **[SCRUM-704](https://oto-suite-dev.atlassian.net/browse/SCRUM-704)**, Bug, `payments`. |
| **B3 — the gate needs a controller and readers, but setup can assign only one of them** (family 6; also 3/4) | A gate station's bundle must contain its `gate` controller and matching `gate_reader` devices together. | The administrator can register both kinds, but only the `gate` assignment role accepts either kind. There is one device per role in the form/API and the database. No other role accepts a reader. The bundle includes assignments only, not every device registered on the box. | A controller-only station cannot match a reader's call and answers the gate-not-ready refusal. Replacing it with a reader leaves no controller for passage credit; entry is still unavailable. Splitting these into separate stations does not join them into one lane. | **No supported staff recovery for the complete lane.** An engineer must correct the assignment model/API. Real serial, relay and installer gaps remain separately owned by SCRUM-223. | `packages/db/src/schema/fleet.ts:610-648`; `apps/api/src/routes/fleet.ts:187-193`; `apps/api/src/services/fleet.ts:280-290,1010-1030`; `apps/api/src/services/box.ts:1055-1114`; `packages/box-agent/src/gate/config.ts:147-182`; `packages/box-agent/src/gate/host.ts:465-503`. These constraints cannot express the input the gate consumer reads. | **Blocks entry through a lane configured by the supported setup.** Source proof only; no physical-gate execution claimed. | Add distinct controller/reader assignments and carry the complete lane in the bundle, validating its required parts. **[SCRUM-705](https://oto-suite-dev.atlassian.net/browse/SCRUM-705)**, Bug, `gate`. Fixing this alone does not complete SCRUM-223. |
| **D1 — a new branch has no editable print-template rows** (family 1; also 6) | One saved template row per editable print type for that branch. | The full demo seed writes them; branch cloning copies them. Production platform-sync and branch creation do not initialise them. The print API lists and patches existing rows, with no create operation. | Admin → Print templates returns an empty live list for an unseeded, uncloned branch, with no template to open or add. Printing can still use built-in defaults, so absence of these rows is not a printing blocker. | **Sometimes:** cloning before the branch has sales can supply rows. Once the branch has sales, the supported clone is refused; there is no supported way to create the missing rows individually. | `packages/db/src/seed/index.ts:1339,174-235,2000-2022`; `apps/api/src/routes/branches.ts:164-195`; `apps/api/src/routes/print.ts:117-160`; `apps/api/src/services/print.ts:106-130`; `apps/api/src/services/catalog-clone.ts:795`; `packages/admin-screens/src/lifted/components/admin/templates/TemplatesPanel.tsx:78-99,150-190`; `packages/print/src/templates/model.ts:222-242`. | **Degrades configuration.** Default receipts and bands still render. | Initialise editable defaults for new branches or provide an idempotent “create missing templates” operation. Proposed ticket title: **New branches have no editable print templates until cloned**. Planner to file after owner review. |
| **D2 — the check-in board never renews its signed photo links** (family 2) | A currently valid signed URL when the board or a later photo view needs to fetch the stored image. | The file API/storage adapter can issue fresh URLs. The board client caches each successful URL for the module's lifetime, without its expiry or invalidation on an expired image response. | URLs are signed for five minutes. A later request after expiry can fail while the board keeps the expired URL and its 30-second board refresh never asks for a replacement. An already loaded image may remain visible in browser memory; this is not a claim that every image vanishes at exactly five minutes. | **Yes:** a full page reload clears the module cache. Leaving and reopening the board need not do so. The release dialog has its own per-opening photo lookup, so this is not classified as blocking child release. | `apps/api/src/services/files.ts:126-129`; `apps/pos/src/api/checkin.ts:578-601`; `apps/pos/src/pages/DropOff.tsx:475-508`; compare the fresh per-opening map in `apps/pos/src/components/dropoff/CheckOutModal.tsx:166-222`. No browser cache/expiry experiment was run. | **Degrades photo availability** on a long-lived board. | Cache until shortly before expiry and renew on image-fetch failure, retaining the existing access logging. Proposed ticket title: **Renew signed child-photo links on the check-in board**. Planner to file after owner review. |
| **D3 — a booked child's offline check-in drops newly acknowledged consent** (family 7; also 5) | The guardian's acknowledgement must become a durable registration consent record when it was missing on arrival. | The booked-check-in dialog captures it and `DropOff` sends `consentAcknowledged`. Online `checkInBooked` validates and timestamps it. The offline client drops it when translating to `check_in_now`; neither that bridge schema nor its fact/replay carries the acknowledgement. | The box can report successful check-in and issue a band, while the registration still has no consent timestamp. Reconnect applies the child's check-in but does not repair the missing consent. This affects the missing-consent edge the dialog explicitly supports, not every booked child. | **No automatic recovery after that check-in.** Reconnecting alone does not write the lost acknowledgement; the child is already checked in, so the same booked-check-in action is no longer the normal recovery. Staff must arrange an explicit correction. | `apps/pos/src/components/dropoff/CheckInBookedModal.tsx:93-112`; `apps/pos/src/pages/DropOff.tsx:743-756`; `apps/pos/src/api/checkin.ts:726-763`; `apps/api/src/services/checkin.ts:1893-1917`; `packages/shared/src/checkin-offline.ts:185-215,281-297`; `packages/box-agent/src/checkin-desk.ts:1381-1519`; `apps/api/src/services/sync-checkin.ts:555-629`. The fact updates the stay, not the registration's consent. | **Degrades data reliability.** Check-in proceeds; it is not an admission blocker. | Carry the acknowledged consent and its event time through the bridge, durable overlay and replay in the check-in transaction, matching online validation. Proposed ticket title: **Keep guardian consent recorded during an offline booked check-in**. Planner to file after owner review. |

D3 is a **latent incomplete-record case**, not a demonstrated live incident.
Current ordinary registrations and supervised online bookings already require
consent (`apps/api/src/services/checkin.ts:564-590`,
`apps/api/src/services/booking-supervision.ts:70-78`). The mismatch matters for an older
or incomplete booked registration with a null consent timestamp, which the
online arrival flow explicitly supports. No affected production row was
verified. Its severity describes losing the acknowledgement in that case.

## Questions for the owner — current rules remain unchanged

1. **When should an incomplete station become usable?** B1/B2 establish
   broken operations, not a ruling to forbid saving draft setup. The current
   default permits the save, with terminal-assignment warnings. The owner can
   choose a draft/not-ready state or an earlier setup refusal; the required
   outcome is that staff see what is missing before attempting that operation.
2. **Are any additional offline operations needed on the floor?** Full split
   tender, gateway QR, gift/prize voucher validation, refunds/voids and some
   supervised/event-booking cases have explicit online-only refusals. Their
   current limits are approved defaults, not defects in this report. Expanding
   them needs an owner decision and the corresponding money/replay design.
3. **Should seed-only wallet policy become editable?** This is already in
   inventory-platform §1E/§5.1. Current code supplies a built-in policy when no
   row exists; no new sale blocker was established. Preserve that default
   until the existing configuration question is scheduled.

These are report questions only. No plan ruling, prototype rule, pricing,
age threshold, nanny ratio, photo requirement or offline bound was changed.

## Already known — references, not duplicate tickets

| Existing record | Scope retained from this review |
|---|---|
| **SCRUM-699 — nanny roster** | The seed's fourteen-day shift window and absent rota writer are the initiating example, already listed in both inventories. During this review the separate lane landed at main `9eb6fe18`: rota/manual writers now exist in `apps/api/src/services/nanny-duty.ts:548,629,906-925`, with routes in `apps/api/src/routes/nanny-duty.ts`. This changes the original seed-only diagnosis in source, not the six new findings. No staging acceptance, new nanny ticket or created shift is claimed by this unit. |
| **SCRUM-700 — physical box scanner** | The scanner router, HID burst parser, simulator and till-side keyboard fallback do not establish a real USB reader on the box. Registering a scanner does not create that reader. Existing ticket owns it, including device access/installation. |
| **SCRUM-685 — gateway QR** | The known Do Payment request/reply/RAW-QR shape work is a concurrent payment lane. This report does not retest a provider or claim its deployment. |
| **SCRUM-223 — real-device bring-up, paused** | Real GHL/Digio and gate serial links have no installed opener: `packages/box-agent/src/terminal/serial-channel.ts:176-188`, `packages/box-agent/src/runner/runtime.ts:893-966`, `packages/box-agent/src/agent.ts:3133-3142`. Also, the gate reads opener/relay settings that the strict public `DeviceSettingsSchema` cannot save (`packages/shared/src/device-settings.ts:175-195`, `packages/box-agent/src/gate/config.ts:154-181`). Installer serial permissions, relay tools and full counter TLS/DNS readiness remain within this existing bring-up scope. B3 records the separate assignment-model defect; resolving it does not certify hardware readiness. |
| **SCRUM-277 — orphan endpoints** | The historical list is not a current failure list. Files/photo uploads, station leases, shift-token revocation, reprints and simulator controls now have callers. The remaining tax-override/layout/export design choices are already recorded there and in the inventories. No duplicate blanket orphan ticket. |
| **SCRUM-513 — late sale after day close** | An offline replay arriving after an acknowledged day has no manager correction workflow. Existing ticket retained; no close or replay was performed. |
| **SCRUM-506 — card revocation propagation** | A box acts on its last revocation copy until refreshed; missing propagation expectation is already tracked. No credential was issued or revoked. |
| **Inventories — duplicate organisation/access and settings** | `inventory-platform.md` §2/§5 and `inventory-oto-app.md` §2/§4 already record branch edits on two sides, job roles versus access roles, departments, employee copies, wallet policy and booth-layout UI gaps. Some are now wired: departments have a mirror writer, teams/rules have Console writers, and the current Console has lifted configuration panels. The old “no screen” rows are not treated as current new defects. |
| **SCRUM-480, SCRUM-502 and SCRUM-503** | Storage provisioning and the known offline food-counter/version/test-toggle/wording follow-ups are not new missing producers. No storage setting was changed and no synthetic hardware proof was made. |

Jira deduplication used the helper's project search across **685 existing
issues**, including closed/deployed items, plus targeted text searches for
prefix/station, routing/terminal/protocol, gate/reader/role, print-template
creation, photo expiry and offline consent. Matching story descriptions were
read, particularly SCRUM-195/206/209/223/277 and the explicit known tickets.
Broad hardware stories were retained for their existing real-driver work;
the specific B3 assignment conflict was not recorded there as a defect.
Only the three blocking findings were filed. Degrading titles above remain
proposals for the planner.

## What was checked and found to have a producer or an explicit rule

“Found clean” here means the required producer and recovery path exist in
source, within the stated limits. It does not certify every workflow,
configuration, role, provider or physical device on staging.

| Gate or dependency checked | Producer / recovery found | Source or limit |
|---|---|---|
| Choose a branch and station; usable box ownership | Admin creates branches/boxes/stations; new station requires a box; assignment checks box and device kind. | `apps/api/src/routes/branches.ts:164-195`, `apps/api/src/services/fleet.ts:965-1063,1178-1197` under `apps/api/src`. Prefix and tender completeness are B1/B2. |
| Price a ticket/tier, holidays, tax and event drop-in prices | Current Admin catalogue/pricing/money panels call supported create/update APIs. Missing tax configuration refuses pricing; the Tax screen can supply it. Holiday expiry returns to the normal calendar price. | `apps/api/src/routes/catalog.ts`, `apps/api/src/services/event-writes.ts:872`, `packages/admin-screens/src/lifted/api/catalogBridge.ts:325-329`. No silent zero-price substitute was counted as a clean price. |
| Saved member, child, visit and discounted-tier proof | Member/child/visit writes and sale tier claims are real producers, including “Other” with a description. Expired proof has re-verification paths. | `apps/api/src/routes/members.ts`, `apps/api/src/routes/visits.ts`, `apps/api/src/routes/sale-tier.ts`; `apps/pos/src/lib/tierProof.ts`. No fixed proof-choice preference was filed as a defect. |
| Drop-off length, child identity, age, consent, confirmations and private photo | Till inputs, consent capture, registration and file uploads supply these; platform and box have care configuration writers/readers. | `apps/pos/src/pages/Till.tsx:2562-2608,3185-3189`; `components/till/SupervisionGate.tsx:154-184`; `apps/pos/src/api/checkin.ts:363-375`; `apps/api/src/services/checkin.ts:2122-2331`. Nannies are existing 699; booked offline consent is D3. |
| Nanny ratio | The soft maximum warns but deliberately does not disable an otherwise on-shift nanny. | `apps/pos/src/components/dropoff/AssignNannyModal.tsx:32-37,74-86`. An approved soft limit is not a blocker. |
| Booked check-in needing photo/consent | The modal has capture controls; the page uploads missing photos before check-in. | `apps/pos/src/components/dropoff/CheckInBookedModal.tsx:93-112,217-250`; `apps/pos/src/pages/DropOff.tsx:743-756`. Photos have a producer; the lost offline acknowledgement is D3. |
| Child collection, authorised collector and pickup photo | Release context, add-collector and photo upload paths exist. The modal makes fresh photo lookups each opening. | `apps/pos/src/components/dropoff/CheckOutModal.tsx:166-222,532,629`; `apps/api/src/services/release.ts`; `packages/box-agent/src/checkin-desk.ts:1735-1760`. Existing photo-enabled/offline fallback rules retained. |
| Payment-method list and “Other” methods | Production platform-sync supplies base tenders for an operator with none; Admin can create/update/enable methods. | `packages/db/src/seed/index.ts:206-213`; `seed/tenders.ts:117`; `apps/api/src/services/payment-methods.ts:226`. Not dependent on the demo seed alone. |
| Cash, manual card, terminal outcome and unknown-payment recovery | Cash handlers, manual approval/TID entry and inquiry/staff-confirmation paths exist. | `apps/api/src/services/payments/terminal.ts:630-631,1416-1537`; `apps/pos/src/components/till/PaymentTenderPanel.tsx:82-101`; `packages/box-agent/src/station-bridge.ts:4032-4090`. Real serial transport is not certified. |
| Receipt number after a fresh database/box restart | Receipt-series rows are created by allocation; the box persists and advances its own counters. | `apps/api/src/services/sale.ts:2731-2795`; `packages/box-agent/src/sale-queue.ts:243-286`; existing SCRUM-275. A missing prefix remains B1. |
| Receipt/band/kitchen/bar printer routing and retries | Assigned LAN printers use real TCP channels, ESC/POS/TSPL renderers and durable queues. A missing printer is explicitly skipped/noted; a stopped one is held/retried. | `packages/box-agent/src/printing/channel.ts`, `printing/index.ts:100-165`; `apps/api/src/services/sale-printing.ts:241-306`. USB/Bluetooth selections do not prove a physical adapter; those remain 223's readiness scope. Template defaults work; D1 concerns editability. |
| Cash drawer | Pulse rides the receipt printer; routing may deliberately disable it, and a pulse is after a recorded sale. | `packages/box-agent/src/printing/queue.ts:180-192,1247-1289`. Registering a drawer alone is not a separate USB drawer driver. No claim of a tested physical kick. |
| Display/kiosk/booth pairing codes after expiry | Admin can re-pair/reissue; expiry is explicitly reported rather than silently granting access. | `apps/api/src/services/display.ts:125-163,182-186,230-232`; `apps/api/src/services/fleet.ts:1628-1639,2358-2434`; `apps/api/src/services/box.ts:454`. No code values were read or printed. |
| Station lease expiry and page reload | The publisher claims a lease, renews every 15 seconds, and reclaims after a refusal; stable holder identity survives reload. | `apps/pos/src/lib/displaySession.ts:369-375,541-599`; `apps/api/src/routes/stations.ts:39-101`. Existing SCRUM-693 recovery remains in scope of that ticket. |
| Shift tokens, signing keys and a fresh offline sign-in | Online selection/token mint publishes the signing public key; the box verifies token/deny-list bounds and has a bounded fresh-sign-in path. Expired tokens/refused caches explain reconnect requirements. | `apps/api/src/services/staff-token.ts:73-115,199-242`; `apps/api/src/lib/signing-keys.ts:34-72`; `packages/box-agent/src/staff-token.ts:388-427,749`. Provisioning private keys is operational setup already named in the inventories, not a missing demo-row writer. |
| Wheel configuration, prizes, vouchers and duty after the demo date | Admin publishes versions; prize/type CRUD and campaign issuance exist. Duty has both rota sync and manual additions. An unpublished wheel reports blockers. | `apps/api/src/services/booth-admin.ts:397-532,914-958`; `apps/api/src/services/booth-duty.ts:629,859`; `apps/api/src/services/voucher-promotions.ts:539,751`. Operator layout catalogue without a screen is the existing inventory gap. |
| Voucher/booking claim windows and single-use | Platform issuance and paid booking checkout produce them; redemption verifies paid/valid/unredeemed status. Explicit offline refusals exist for unsupported cases. | `apps/pos/src/components/till/RedeemBookingModal.tsx:495-500`; `apps/api/src/services/booking-checkout.ts`, `apps/api/src/services/vouchers.ts`; `packages/box-agent/src/station-bridge.ts:4598-4638`. No live voucher/booking was consumed. |
| Wallet balance, expiry, cap and reactivation | Sale/replay writes wallet lots and keys. Missing policy has `DEFAULT_WALLET_POLICY`; managers have online reactivation with a reason. | `apps/api/src/services/wallet.ts:101-122,224,292,343,1015`; `packages/box-agent/src/station-bridge.ts:3235-3265`; inventory's policy-editor gap remains known. Same-day expiry and offline cap are approved rules. |
| Stock size, opening count and missing/stale offline stock | Stock setup is production-sync; opening quantities are entered through stock counts/adjustments, not invented by the seed. Stale/unknown offline stock refuses by name. | `packages/db/src/seed/index.ts:215-223`; `apps/api/src/services/stock.ts:2213-2237,2475,2824-2862`; `packages/box-agent/src/station-bridge.ts:2645-2675`. Existing stock rulings, including SCRUM-485, remain unchanged. |
| Staff/employee/department/branch sources | Employee and department mirror writers exist; branch creation mirrors to the app; suite links provision app identities. These are not wholly seed-only now. | `apps/api/src/services/otoapp-employee-sync.ts`, `apps/api/src/services/otoapp-department-sync.ts:142`, `apps/api/src/routes/branches.ts:177-195`, `apps/api/src/routes/app-identities.ts`. Existing two-way-edit/access-lifecycle questions are retained from the inventories. |
| Old orphan list: photos, leases, revoked shifts, reprints, simulators | Current POS/Console clients call these services. No “still no caller” claim was copied from the old ticket. | `apps/pos/src/api/checkin.ts:363-375`; `lib/displaySession.ts:541-599`; `packages/admin-screens/src` account/session ports; `apps/api/src/routes/booth.ts:263`; `apps/console/src/components/devices/SimulatorPanel.tsx`. Remaining orphan choices stay on 277. |
| Offline sales and replay | Durable sale facts carry receipt/band identities; intentional voucher/gateway/refund/split restrictions are explicit. Unknown electronic outcomes are held for resolution. Check-in replay was traced separately and exposed D3. | `packages/box-agent/src/station-bridge.ts`; `sale-queue.ts`; `apps/api/src/services/payments/offline.ts`; `apps/api/src/services/sync-checkin.ts:555-629`. Late-day and revocation-propagation issues remain 513/506. No convergence suite was executed. |

### Seed-table census

All `packages/db/src/seed/*.ts` were included in the insert census, including
the separately invoked demo-day, demo-booth, events, benefits, inbox and
legacy fixtures. There are **73 distinct directly inserted platform table
symbols**, plus **three OTO App tables written through raw SQL** in the
events fixture (`packages/db/src/seed/demo-events.ts:181,241,277,334`).
Each was searched for writers under `apps/api/src` and
`packages/box-agent/src`, allowing imported bare names rather than just the
seed's `s.table` alias. Raw-SQL, deployment-sync and clone/import paths were
followed where a direct API insert was absent. Absence of a literal
`insert(table)` is not itself a finding.

The following accounts for all 73 platform symbols and the three raw-SQL
tables. The writer column gives the
source home, not a claim that every write was executed.

| Seeded symbols | Production writer / disposition |
|---|---|
| `operator`, `branch`, `employee`, `account`, `roleAssignment` | Operator/branch/account/provisioning routes; employee mirror. |
| `department`, `role`, `rolePermission`, `appRegistry` | Department mirror; system-role/platform-sync and app-access-role provisioning; suite-registry sync. Inventory's old department/no-feed statement is superseded by the mirror writer. |
| `member`, `child`, `memberTierVerification` | Member routes, tier service and offline replay. |
| `tier`, `ticketPackage`, `branchHoliday`, `branchTaxConfig` | Catalogue routes and branch clone. |
| `productCategory`, `product`, `modifierGroup`, `modifierOption`, `productModifierGroup`, `discountDefinition`, `paymentMethod` | Menu/catalogue/payment-method services, workbook import and clone. |
| `box`, `device`, `station`, `stationDevice`, `stationStaff` | Fleet create/edit/assignment services. Completeness gaps B1/B2/B3, not absent CRUD. |
| `supervisionPolicy`, `confirmationItem`, `dropOffPricing` | Care configuration writers in `apps/api/src/services/checkin.ts`. |
| `nanny`, `nannyShift` | Seed-only at the initial reviewed source; already SCRUM-699. The integration recheck found its newly landed rota/manual writers in `apps/api/src/services/nanny-duty.ts`, as recorded above. No duplicate finding. |
| `walletPolicy` | Seed/migration only, but runtime supplies built-in defaults; known inventory editor gap, no new blocker. |
| `wallet`, `walletKey`, `walletEntry` | Wallet grant/spend/replay services. |
| `sale`, `saleLine`, `saleDiscount`, `paymentAttempt`, `paymentNotification`, `receiptSeries`, `refund` | Sale/payment/refund handlers and offline replay; receipt allocator creates the series. |
| `boothLayout`, `boothSettings`, `boothPrize`, `boothConfigVersion`, `boothDutyAssignment`, `spin`, `voucherPrint`, `voucher`, `voucherDefinition`, `voucherRedemption` | Booth admin/duty, campaign issuance, redemption and booth sync. Layout API without its own screen is already inventoried. |
| `benefitRoleTemplate`, `benefitProfile`, `benefitCredential`, `signingKey` | Benefit management/credential issuance; staff-token key publication. Private keys remain environment provisioning, never report content. |
| `stockLocation`, `stockItem`, `stockUnit`, `stockLevel`, `stockMovement`, `stockTake`, `stockTakeLine` | Stock setup sync and stock/count/adjustment/transfer operations. |
| `team`, `routingRule`, `template`, `channelAccount` | Production Inbox setup plus current routing/template writers and channel notice provisioning. Live channel accounts/provider credentials still require their documented setup. |
| `eventDropInPricing` | Event-pricing write service; events/rosters themselves come from the app seam, not these fixtures. |
| `printTemplate` | Full seed or clone only for row creation; ordinary print API patches existing rows. D1. |
| `dailySummary` | The production rollup writes it through the local alias `d` (`apps/api/src/services/analytics-rollup.ts:383-404`); not seed-only. Production legacy-data cutover remains SCRUM-222. |
| `otoapp.core_events`, `otoapp.camp_registrations`, `otoapp.event_attendees` (raw SQL) | OTO App event/camp/attendee routes and directory writers produce real records. These are the demo-event fixture's additional tables, not a second production event catalogue. See the app inventory §1f and `apps/api/src/services/booking-event-passes.ts`. |
| `auditLog` | Audit service called by production operations. |

### Boundaries and checks

- Read the prompt, AGENTS/current handover and STATUS, device inventory,
  quickstart, open register and both admin inventories before tracing the
  seed, till gates, box adapters and API setup consumers. The inventories are
  dated 21 October; their “no route” notes were checked against current source.
- Enumerated disabled/required/refusal/payment-readiness gates across all
  files in `apps/pos/src/components/till`, `components/dropoff`, `Till.tsx`
  and the 66 files in `apps/pos/src/lib`; followed the relevant API and box
  consumers. Busy buttons and ordinary user-entered fields are not findings.
- Compared Console-registerable device kinds with printer/terminal/scanner/
  gate consumers and the Pi runner/installer. Display, booth and kiosk
  browsers use device credentials, not physical printer/terminal adapters.
- Checked station/device/setup routes in `stations.ts`, `fleet.ts`, current
  `console*.ts`, `checkin.ts` and `booth.ts` and their service paths. There
  is no separate `apps/api/src/routes/devices.ts`; device writes live in `fleet.ts`.
- Source traces establish the six conditions above. No browser reproduction,
  full test battery, provider delivery, physical hardware readiness or
  staging deployment is asserted. Documentation validation is
  `git diff --check`, as required by this unit's brief.
- Jira creation read-backs and the final source/rebase/CI disposition belong
  to the SCRUM-702 completion comment. SCRUM-702 moves to **Testing** on push;
  only the planner moves it to Deployed after the owner has read the report.
