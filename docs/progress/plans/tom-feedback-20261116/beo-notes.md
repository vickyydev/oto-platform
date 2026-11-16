# BEO approved feedback implementation notes

16 November 2026. Isolated lane: C:/oto-lanes/tom-beo-approved-20261116, base398478b5d6faba98bdc3586bacb77c8f58aa8af3. No main push, deployment or shared status write by this lane. Root owns Jira/release/evidence.

## Implemented source, verification in progress

- SCRUM-988: reuse broad delivered extraction. Saved structured review state and current prices are shown alongside proposed/source fields. Under the BEO write lock, an outdated version refuses the entire approval. Existing manual menu/bar/entertainment rows not named in the proposal are retained. Unknown shows remain unresolved Other requests, never price-zero free products.
- SCRUM-989: reusable BEO-only products stay branch/operator scoped and absent from general selling menus. Kitchen/Bar modify-item pickers include them, with station/category/selling-price display. New custom bar creation reuses the existing idempotent product route. Existing PARTY bar lines remain held/unbilled; only new typed chargeApproved provenance is billed. Provisional forward app0052 adds that boolean to the existing view; applied0050/0051 remain immutable.
- SCRUM-990: new persistent additional bills reference the same party and original main settlement. Existing party charges/payments link by FK. New extras join an open bill; payment closes it; a later extra creates a distinct bill. Targeted payments use their own bill balance, allow the final satang, reserve pending tenders and cannot switch bills on replay. No original sale/receipt/deposit mutation. Historical unassigned ledger remains separate.
- Newly approved BEO Add/Save and explicit till kitchen additions carry source-line/quantity/price provenance, durable pending status and idempotent reconciliation after the app write. Only positive quantity deltas beyond the current main-settlement baseline are billed. Engine gross is read by exact cartLineId/componentKey, including existing VAT/service. Decreases/repricing already billed source lines require a separate adjustment. Included/free additions remain plan-only.
- SCRUM-991: parent menu page shows sanitized saved BEO kids/adult/bar custom and extra item price/quantity snapshots, with unknown prices unresolved and included/free explicit. Catalogue-choice information is separate; no internal cost is returned. Confirmation records menu choices only, not agreement to extra charges.

## Schema and ownership

Platform provisional0127 creates party_additional_bill and adds nullable FKs on existing party_charge/party_payment. Deposit owns0126; Inbox owns0128. Platform snapshot chain must be regenerated after integration, preserving SQL equivalence. App0052 is a view-only replacement and schema-equivalent snapshot. Source spans API party billing/kitchen/settlement, shared party contracts, POS party UI, app BEO review/menu/save/public menu/directory kitchen blocks. No Inbox booking/draft gateway or usePaymentStage changes.

## Evidence so far

First app compiler found one introduced undefined-variable diagnostic (414/413); corrected. First API/POS compilers printed zero diagnostics, but source continued during early work, so they are diagnostic feedback, not frozen final gates. The first full four-file API run passed68/68, including the new exact-satang/overpayment/retry/source-delta/VAT7%+service10% controls; source was still being completed, so a frozen affected repeat remains. Full logs are external C:/oto-lanes/tom-beo-*.log and will be summarized with final hashes/results.

## Explicit limits and next work

No staging/native/provider/fiscal-receipt/physical-printer acceptance is claimed. Additional bills reuse the existing party payment ledger; this work does not build a new tax receipt or refund UI. Actual taken-status/reversal facts are read; unsupported additional-bill refund workflows are not claimed. Original retained-deposit/refund910 behavior must pass its existing files unchanged. Other945/966/968 holds remain held.

Finish regression-driven fixes; run full app ratchet, API/POS whole compiler scripts, touched lint, full relevant API/POS/app files and build. Produce explicit source commit list for root review. No work is ready for deployment until these final local gates are recorded.


## Final local source checkpoint - 17 November 2026

Product source: 06c372d45c26bfe9e3581bea73d543f73bcb3a99, based on 18043d99cf1af00a81a8463e67aefc9c4975bfca. All required local gates are complete. The companion beo-manifest.json pins the complete source/test/schema/journal/contract input list, each raw SHA256, all ordered source commits, exact commands, final receipts and retained failed/diagnostic logs. Root owns landing, named deployment, staging proof and Jira status. No main push or deployment was made by this lane.

Latest complete API files cover 49 settlement, 14 kitchen edit, 6 catalogue and 4 pure review tests across the named receipts. POS latest complete files cover 30 kitchen edit, 6 payment components, 12 outbound-body and 39 routed-tender tests across the named receipts. Whole API and all three POS compiler configurations print zero diagnostics; generated API contracts match. Both production builds pass. App runtime files pass extraction14, till kitchen13 and deposit UI11, plus the pure helper checks. App0052 is applied by isolated setup, then its migrator is run twice as a no-op. Combined platform0127 verifies exactly against its regenerated snapshot; schema/control files pass28.

The app type ratchet remains413/413 in54files. Per-file/code counts, increased[], reduced[] and newFiles[] are in the accounting receipt. Existing diagnostics in touched billing/editor/AI/BEO files remain2/4/1/48. All touched workspace TS/TSX lint passes with zero output. Forced app lint retains68 inherited errors and introduces no diagnostics against the exact same baseline files and rules; this is not a claim that the inherited app is lint-clean.

Money/source review closures: coded till additions accept only the current scoped catalogue price and correct kitchen/bar station; forged/free overrides refuse. Unknown typed requests keep price absent and stay unresolved. Prior paid or unpaid additional-bill source quantities are excluded from a later main settlement after a main refund, with full current-plan baseline preserved for later positive deltas. Changed source name/code/area/price or insufficient quantity refuses for resolution. The locked plan read drives both charged cart and saved baseline; a deterministic waiting-lock test refuses an outdated preview. Original bills and receipts stay unchanged.

POS Save explicitly confirms staff-agreed newly priced additions and their known selling-price subtotal before tax/service. Missing prices are unresolved, cancellation sends nothing, and retries retain the same line IDs. Desktop/mobile selection and frozen payment targets cover the final satang, retry and reopened/changed party. Customer review excludes original package add-ons from the selected bill. The neutral paid-deposit/no-writeback wording follow-up is included under SCRUM-987; real pending, failed and synced states retain their own copy.

Platform0127 SQL is byte-identical to the provisional SQL (sha256 c3ffdb7f285cff18f1ecc95e2f49709f5c7a683b6ea8f4847e4bc8179c95ca09). Its snapshot now follows landed0126 d4055bea-5674-49a3-be1e-ff1392a9aec4; journal127 sorts after126. Applied migrations were not edited. App0052 only adds strict charge_approved provenance to the0051 view; historical unmarked bar items remain held.

No new product work remains in this lane. Root should integrate these ordered source commits plus this final documentation checkpoint, compare manifest raw hashes, then coordinate the app/API/both-till rollout. No new fiscal receipt, additional-bill refund workflow or physical/provider acceptance is claimed. Other945/966/968 holds remain held.

### Ordered source commits

- e0602cb232a69f3f8273bdab7d226666733c7f93 feat(beo): link reviewed party additions and separate bills
- dc3f4fe70bcf3c2f6a3166c46761f71a19a19f17 fix(beo): retain pending billing when eligible sources change
- 0712ef654faf56933097cc7318b829bf779cc640 fix(pos): refresh additional bill selection before payment
- c53ebc47707995cb50899672ad703c51d4d75e92 test(beo): reuse the existing parent selection fixture
- 66b0f0efccc04c59005a9eaeb4729eee28972ee9 fix(beo): preserve unresolved billing across later saves
- 45f0a12009090856b645eba2e0fe40cd6e06ee99 fix(pos): collect linked party bills on mobile
- 370485ab8951acecde980fc4e2c9770652bf420b fix(beo): preserve separate bill obligations across settlement cycles
- cc980cae34f4349adbff50ceb390ed1eb9225006 test(beo): bind pending additions and bill targets to their sources
- 127467dbc620290c8dd25285e0be781c97698d4f fix(beo): settle from the plan read under the party lock
- a9d65fea70706600ef450748e5eb85e509e330bb fix(pos): confirm newly priced party additions on save
- cf4f9c4bd56a2fc6a095e872cac2cb3b7231dd9f fix(pos): isolate linked bill customer review totals
- 293d48b09d63863ebc4a1b7cafda47e516d03cba test(pos): reconcile the selected bill customer total
- 06c372d45c26bfe9e3581bea73d543f73bcb3a99 fix(beo): keep paid deposit fallback wording neutral


## Reviewed follow-up checkpoint - 17 November 2026

Source frozen at dc6e8fdeba8e95cea2335b722ca45351018394c1. Follow-up manifest: `beo-followup-manifest.json` records16 changed source/test inputs,18 unchanged context inputs and41 complete local evidence/harness files with raw SHA256 and canonical Git blob hashes. All changed input differences normalize exactly from CRLF to the committed LF blob. The original88-input release manifest remains unchanged.

Ordered follow-up commits (root has already integrated the first three under its own landing SHAs):

- f1206bf1d117ce0a27fcc53f31dabeb0a1809be0 - unknown-show choice says unresolved request, never free.
- ded280065ac31b0e21213d4b7f6c89c130db4440 - unknown show's requested time and notes remain in Other requests; requested-time UI does not promise an Act or timeline entry.
- 93eb98aa3394c7cacd90eb1637a379b082bce3af - D1 structured paid claims are informational, cannot write/raise/lower/redate received money, and have read-only claim amount/date with no Received toggle. Requested-only amounts remain separate. Existing actual gateway and legacy receipt provenance/history are preserved even for crafted paid999 against gateway1. Other approved fields still save. The old manual-save fixture now orders its edit against the persisted revision rather than the host clock.
- ab145fe4347311e42f3ade699121819df9ad631d - legacy/free-text and structured Load into Editor fallback never populate receipt fields; Fetch from chat cannot offer/apply/mark them. Source audit leaves only actual readback, manual edit and gateway hydration setters. Legacy unknown extras reuse included:false,price:0,source:additional without billing authorization; parent price is null/unresolved. Explicit included/free, SET and genuine priced lines remain. Direct manual Billing behavior is unchanged.
- dc6e8fdeba8e95cea2335b722ca45351018394c1 - under the existing party lock, billing callback writes kids/adults to both menu projections from one computed result, retaining each object's other metadata. Changed/new eligible sources keep the overall result pending. Catalogue fixtures fetch the current expectedState for intentional fresh approvals; stale409 pins remain in the fill file, and unknown shows create neither free selections nor acts.

Final verification receipts (all whole files; Docker off, embedded PostgreSQL closed):

- `tom-beo-d1-db-first.log`: structured D1 actualDB7 passed, plus the earlier fill14; same receipt retains the later manual timestamp fixture409.
- `tom-beo-d1-ui-first.log`: real structured review5 passed, including no Received control and read-only claim amount/date.
- `tom-beo-reliability-db-final.log`: manual Billing/Save7, fill15 and catalogue22 passed after timestamp/mirror repair.
- `tom-beo-reliability-db-legacy-final.log`: fill15, catalogue22 and Fetch16 passed on the expanded final legacy/Fetch source, including actual Save to parent unresolved-price projection, both mirror arrays/metadata and delayed source changes.
- `tom-beo-reliability-prefill-ui-repaired.log`: real editor14 passed, including legacy and structured fallback preserving stored2000 against claimed3000/date, and actual Save payloads preserving unknown versus explicit free/SET/priced lines. `tom-beo-reliability-fetch-ui-final.log`: Fetch dialog12 passed.
- `tom-beo-reliability-ratchet-final.log`: whole app compiler413/413 errors across54 files; complete accounting JSON has no increased diagnostics or new files. The touched editor retains4 inherited errors. This is a passing ratchet, not zero app errors.
- `tom-beo-reliability-lint-final.log`, `lint-full.json` and `lint-delta.json`: forced16-file lint7 inherited errors to7, no introduced diagnostics; all7 remain in the editor,15 other touched files have zero errors.
- `tom-beo-reliability-build-final.log`: app production build passed. Existing build and jsdom accessibility warnings remain visible in complete logs.

Commands: the retained `tom-beo-reliability-*-run.mts` harnesses run each listed app test sequentially against createTestDatabase({otoapp:true}) and stop/drop it in finally; jsdom files run with tests/tsconfig.jsx.json. Final compiler/build commands are `npm run check:ratchet` and `npm run build` from apps/oto-app; forced touched lint and whole diagnostic accounting scripts are hashed in the manifest. Original failed UI source-mark expectation and first lint import/const diagnostics remain retained, alongside their repaired receipts. No applied migration or API contract changed in this follow-up.

Root owns final integration, deployment and Jira. No new live proof is claimed here. Final988 native/API retest and exact owned-party cleanup are separately assigned only after root's final app/API LIVE signal. That proof has zero new AI or payment budget and must preserve the original receipt and two paid additional bills, use a fresh current expectedState/minimal approval, and never replay the prior extraction's stale quantity2 body over the current quantity4 plan. The other agent owns993 runtime proof. No fixture mutations have been performed by this follow-up lane.


## Final live988 retest and retained-party cleanup - 17 November 2026

WORKS on exact app/API source0bc4be94abdbf982c3a06146062e96f0bb7b28fb: app deployment dep-dbtkmkuc6qcc73c0pvl0 and API dep-dbtkmljl550s73disbng were independently LIVE both before and after this proof. No further product change, model call, payment call, station creation or counter reactivation was made.

The actual authenticated app approval used a fresh current-state hash and a minimal body: no menu lines or old quantity2 body. Crafted paid999 was informational (`chat_claim`, not written); the original received deposit stayed100satang. Unknown show's requested15:00 and explicit test notes remained unresolved in Other requests, with the prior requests retained and no known show selection or Act created. The same stale body then refused409. Current saved food quantity stayed4 and no third bill appeared.

The original gateway/receipt projection hash before and after was eded2628cfa5e99159e8c0ee340e12a942e0a3862dda884dbdb985795d1c1f61. The original paid main receipt fingerprint stayed15eb8986d4087797dd79f4f1d702bb816ffb588cec848e29ce9ebfddc6b426bf after the approval and again after cleanup; both linked bills stayed1001satang charged/paid each. Exactly five original approved simulator receipts and total1694205satang remained unchanged.

Native repaired-review evidence is explicitly a reconstructed extraction-derived UI-only fixture: saved unknown-show/time facts plus a crafted payment999 control, intercepted once without a model call or an approval click. It is not a raw original extraction response replay or a new extraction. The actual finalLIVE app shows Requested time15:00, unresolved-request wording without an Act promise, read-only claimed amount/date and no Received control. Both local screenshots and the committed native screenshot/test-run card were visually inspected. Live API200/409 and database receipts are separate proof.

Exact own party59358f42-0407-4d51-b545-d33a4c84a8d7 and linked simulator thread were archived; the two exact BEO-only products were archived/inactive. The used parent link returns404 after supported token rotation; its selection/history remains, and the replacement token was never shared or recorded. Actual app/platform sign-out made both old cookies401. Independent read-only census job-dbtl1jbl550s73djpcd0 verified party/thread archived, queued messages0, active own products0, own new active session0 and own device queues0. Financial history remains. No real staff or other fixtures were changed.

Two early app-service helper jobs failed before any session/write; the runtime omits the dev-only tsx package. No product failure is inferred. The successful replacement read used the already-working API image with actual app schema metadata for128 columns across the same six tables, the exact protected-event/stable-hash algorithm, and locally verified timestamp conversions. The real locked approval accepted this computed expectedState; no guard was bypassed. Helper source/mapping hashes and all safe failed/successful receipts remain pinned in `docs/qa/jira-comments/attachments/SCRUM-988/988-final-staging-proof.json` and the local work-beo-988-retest-20261116184734 checkpoint.

Final live proof images and safe manifest are under `docs/qa/jira-comments/attachments/SCRUM-988/`. Root owns Jira publication, status and owner acceptance. This lane has no active browser, test, build or database process and performs no further staging work.
