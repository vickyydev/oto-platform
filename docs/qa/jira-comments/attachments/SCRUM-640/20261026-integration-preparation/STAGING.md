# SCRUM-640 staging acceptance preparation

Read-only preparation, 26 October 2026. No staging discovery, authentication, browser, Render job or fixture action ran. The accompanying pure contract draft has no executor. Current code is the operator-switch lane, source commit `7af05a36b1bbd5463c4c5ebae0741542e9744924`; the separate JSON binds the actual observed branch HEAD and source-file hashes. The old OPERATOR_SWITCH_PREPARATION document describes the earlier unwired checkpoint; current routes/controller supersede that historical wiring description.

Final execution remains behind the planner's protected ask-context delivery, combined release/renumbering, exact final six-job CI and latest exact-source API/Console automatic deployments. Initial SCRUM-638 rates remain planner-owned. This preparation supplies no substitute for any gate and makes no assistant/provider acceptance claim.

The small pure contract is invariant calibration, not a complete response/plan validator. A later executor must first validate actual released route schemas and its reviewed concrete future plan, as the held638/639 tools do; there is no executable plan or network entry point here.

## Concrete matrix

| Step | Actual observation required | Writes allowed |
| --- | --- | --- |
| Postdeploy preflight | Source/CI/latest deployment/static/runtime hashes; exact existing ADMIN and RECEPTION; live A and a distinct existing live B; owned live branch IDs; actual active null-operator assignment carrying `platform:operator:switch` for ADMIN; Reception lacks it. Hash only the two actors' safe home-identity projections, employee rows, grants and app identities; record other-session count/fingerprint. | One separately reviewed read-only metadata job; no database writes |
| ADMIN home | Sign in once; `GET /me`, `/me/permissions`, `/me` agree on the same newly owned session, active unlocked home A, null override, revision r, unchanged account/employee. Verify actual global grant before opening the native picker. Native `/branches` shows Home operator and the selected A. | One native sign-in |
| ADMIN working B | Select B through the existing Operator combobox. Observe native PUT body `{operatorId:B,expectedRevision:r}`, UUID idempotency key and200. Then canonical me/permissions/me confirms same account/session, home A, effective/override B, revision r+1, branch/station null. Native `/branches` and `/branches/oto-app` contain only the preflight's B branch IDs. `GET /operators` still succeeds and `isPlatformAdmin` stays true. | One successful session PUT |
| ADMIN return A | Select A through the same native picker. PUT uses r+1 and a fresh key. Canonical readback confirms same home identity/session/grants, override null, effective A, revision r+2, branch/station null. Changing effective operator clears its seat; restoring an earlier seat is not claimed. | One successful session PUT |
| RECEPTION refusal | Separate fresh owned session, canonical home read. Picker count0. A direct exact PUT to the operator route returns403; canonical context, revision, home identity and grants remain unchanged. No successful switch audit exists for this actor/session. | One refused PUT; native refusal audit may be written |
| Cleanup | Independently attempt sign-out and original-cookie `/me` for both actors:200 `{ok:true}` then401. Close both browser contexts; settle native promises and all pending route callbacks. Postflight read-only metadata confirms both exact owned session rows revoked/override null and preserves all other sessions and home/employee/grant/app-identity projections. | Two native sign-outs; no sign-out-everywhere |
| Audit | Separate bounded read-only job checks the two accepted rows and original event ownership. Only checked safe IDs/revisions/timestamps/counts/hashes enter evidence. | SELECT only |

Seven logical mutating HTTP requests: two sign-ins, two accepted session selections, one refused Reception selection, two sign-outs. Other business, entity, employee, grant, app-identity, flag and fixture writes are zero. The happy proof expects one transport per selection. Any unexpected retry/500/timeout/redirect or unrecognized issuance fails the attempt and blocks further selections; it does not turn an absent row or a subsequent GET into acknowledgement. Native same-key retry behavior remains separately covered by local tests. Auth revocation still runs independently on every failure, including failed receipt persistence.

Use the existing seeded accounts only: ADMIN `01a0bbdc-8c64-7283-aa3b-2af7e79c525d`, RECEPTION `01a0bbdc-8c87-74ca-81c1-61489e34f834`, home A `01a0bbdc-8c41-7204-bd58-2b92bd7dda75`. B and its branch IDs must come from a fresh postdeploy census; no ID is invented here. Prefer an existing B with a live branch. If B is genuinely empty, compare the authoritative empty set and label the native empty directory honestly.

## Exact request boundary

Same Console origin and API proxy as the reviewed638/639 helper. Auth-only POST `/api/auth/sign-in` and `/api/auth/sign-out`; session-only PUT `/api/me/session/operator`. The latter permits exactly the armed actor/session/body/revision/native key and phase, never a body-selected account/session. Reception's separate refused PUT is explicitly armed. All other POST/PUT/PATCH/DELETE, beacon and WebSocket operations are refused before dispatch. No branch/station pick is needed.

GET allowlist: `/api/me`, `/api/me/permissions`, `/api/operators`, `/api/branches`, `/api/branches/oto-app`; exact existing shell `/api/ready`, `/api/ops/health` and `/api/ops/failures?windowHours=24&limit=50`; approved `/branches` document and actual source-bound public static assets. Unexpected reads fail closed with safe method/path hash/count diagnostics. Do not permit an entire `/api` prefix. Do not visit Overview, payments, occupants/check-in, AI, Inbox channels, devices/FWBooth1 or employee editors. Do not click Create, Edit, Reconcile, archive or branch-selection controls on the directory.

Reuse639's exact native raster/AST asset intake and637/639's contained receipt-write failure latch, first-cause retention, native wait-promise settlement and request draining. Source/runtime/static bytes are rechecked before auth and after cleanup. Suppress only the exact known font CSS separately; block unknown foreign resources. Known own private photo references are suppressed before fetching with exact URL/frame/resource guards. Never save original photos, cookies, credentials, private response bodies or browser storage state. Keep original cookies in RAM; unexpected Set-Cookie/sessionId changes remain unresolved, not silently adopted.

## Audit evidence and scope limits

`routes/audit.ts:226` shapes entries without `homeOperatorId`/`effectiveOperatorId`. Moreover a privileged GET may write `audit.read_sensitive` (`:263`). Do not expand that API or call it for this proof. A concrete later read-only native job should use the actual API image/source binding, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, parameterized own actor/session IDs and the actual observation window (bounded to ten minutes), and emit one anchored structurally validated metadata marker. A durable job intent/original job ID must precede polling; an unknown dispatch is not retried.

The audit query selects only `id, action, operator_id, home_operator_id, effective_operator_id, branch_id, actor_account_id, entity_type, entity_id, request_id, created_at` and the known `before/after` effective-operator/revision fields. Filter `action='session.operator_switch'`, `entity_type='session'`, exact ADMIN account and exact owned session ID, timestamps within the actual interval, `ORDER BY created_at,id LIMIT3`; require exactly two rows. In the same read-only snapshot, check the two exact owned session rows and safe identity/employee/grant/app-identity projections. Never emit arbitrary before/after JSON, account password/session-hash columns, contact fields or other-session IDs. Compare other sessions by count/fingerprint only.

Expected captured attribution is **A/A for A→B**, then **A/B for B→A**: the effective tag is captured at request creation, not recomputed after changing the session. Both events remain owned by A with branch null. Before/after revisions are r→r+1 and r+1→r+2. Postflight session rows are retained as revoked history with null overrides. This checks actual tags without changing event ownership or payloads.

The React `authorityEpoch` is private controller state, with no public API/DOM numeric readback. Staging can prove the me/permissions/me handshake, SID, revision, native disabled/pending state and final scoped directory. Label those observations precisely; existing local provider/callback/race pins cover internal epoch enforcement. No staging assertion may invent an exposed epoch.

OTO handoff is omitted from this minimal plan. If the coordinator later requires it, add a separate reviewed auth-only extension using an already linked home identity and original policies, with its own issuance/cleanup accounting. Never provision a B identity or reinterpret home as B. Local handoff/ABA, lock/temp, revocation and foreign-effective OTO refusal pins remain their own evidence. Protected assistant ask pinning and mid-ask attribution cannot be claimed until the planner delivery is integrated and tested.

## Four proposed postdeploy images

1. `SCRUM-640-01-home-operator.png`: actual native home directory and offered picker.
2. `SCRUM-640-02-working-operator.png`: actual B selection and B-only directory.
3. `SCRUM-640-03-reception-refused.png`: actual native restricted view/picker absence, with an explicitly labelled actual API403 fact.
4. `SCRUM-640-04-restored-session-and-audit.png`: labelled actual-staging result card only after confirmed A return, two exact audit rows and both200/401 cleanups; no simulated state.

Each caption names SCRUM-640, full final source SHA and actual time after the latest relevant deploy. Mask account phone/name/avatar and any private text without covering the picker, directory or caption. Inspect every actual PNG before attachment; no QR, token or secret appears. Helper/schema calibration and local images are never staging acceptance.
