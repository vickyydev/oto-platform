# SCRUM-643 / proposed planner Q24 — narrow integration scope

Pickup preparation, 26 October 2026. Source inspected: `C:/w/admin-operator-switch`, `f681806046dfcc767542b68681b6f3306889ec4c`. P4 is now Deployed; SCRUM-643 is In Progress. Q24 is posted for the planner; this proposal is not a ruling.

## Already approved; no new behavior ruling needed

PLAN §14/P5-1 and adopted S2-23 specify `/apps`, `/releases`, `core.app_registry`, `core.feature_flag`, `core.deploy_event`, maintenance messages and `APP_IN_MAINTENANCE` at handoff exchange. They already specify platform-admin-only maintenance/kill switches, typed confirmation, mandatory reason, target-app audit, blast-radius preview, expiry, alert/banner and dual control. Kill-switch expiry defaults to 60 minutes, maximum `KILL_SWITCH_MAX_TTL_MIN` (default 1440); second approval is by another platform admin within 10 minutes. Do not ask those defaults again.

Owned independent work can use new Console pages/adapters/tests, additive shared permissions/words/bundles, new Console API child routes/services and one expand-only migration numbered on main at landing. Use existing strict Zod/generated DTOs, current effective-context authority, native components, preValidation before cached replay, transactional audit and all four route guards. No table, endpoint or resolver name needs planner selection. Existing `apps/api/src/routes/release.ts` and `services/release.ts` handle child pickup and must remain separate.

## Proposed Q24: approve only the following additional wiring

| Boundary | Exact existing files / narrow purpose |
|---|---|
| Launcher reader | `apps/launcher/src/suite/apps.ts`, `api/platform.ts`, `pages/Landing.tsx`, `components/AppTile.tsx`, and existing `test/shell.test.ts`: read the actor-visible registry, retain static icon/key identity and existing app/second-permission gates, order/render maintenance state/message, refuse a stale maintenance tile action. Preserve all existing paths. No assistant popup/link changes. |
| Maintenance / new app sign-in | `apps/api/src/services/handoff.ts` plus its native handoff tests: check the exact app's effective maintenance at mint and exchange, including a token minted before maintenance. Retain existing live-session/grant/operator/seat/origin checks and rejection audit. This does not disable platform sign-in, sign-out or unrelated apps. No public claim/JWT widening. |
| Env and expiry job | `apps/api/src/env.ts`, `services/jobs.ts`, `.env.example`, `test/ops-jobs.test.ts`: the approved TTL/default and dual-control action configuration; typed expiry sweep through existing schedule/ops/alert facilities. An expired value must resolve to its safe fallback immediately; a delayed sweep must not overwrite a later edit. No real alert destination or send in QA. |
| Catalogue seed | `packages/db/src/seed/index.ts` calling a small owned seed helper: establish the six existing suite keys/required permissions and typed supported flag catalogue. Replays preserve saved maintenance/flag choices; no demo/account/grant rewrite beyond the explicitly added system permission bundles. |
| Required audit support | `packages/db/src/schema/platform.ts`, `apps/api/src/services/audit.ts`, and native audit tests: additive nullable `target_app`/`reason`/`origin` support used by 643 without changing current event-owner scope, trusted home/effective attribution, before/after payloads or existing callers. Include this in 643's one migration, coordinate with P5-2 rather than duplicating its later schema addition. |
| Deploy history producer | Add a narrow validated ingest/read seam for `core.deploy_event`; any actual deploy-step/CI wiring must be explicitly assigned after identifying its exact file. Render credentials remain server-only/read-only. No deploy action, invented successful event or fallback from a missing event to “deployed.” |

New API children can register from owned `apps/api/src/routes/console.ts` without editing `app.ts`. A launcher read must retain its own app-access authority; it must not require a Console-management permission just to show a person's existing tiles. Registry origin edits must not bypass the existing handoff origin allowlist.

## Behavior proposal requiring confirmation

For a typed key, propose **station > branch > operator > platform > catalogue default**, choosing only unexpired overrides from the exact live station→branch→operator lineage. A platform row has null scope ID; each other scope has its required live, owned ID. Reject mismatched/foreign references and unknown keys/values; never derive authority from the requested target. Resolution does not grant permission. Preview and enforcement use the same resolved lineage. Confirm this precedence because S2-23 lists scopes but does not define their interaction.

Maintenance leaves already established app sessions unchanged: the written default specifies tile/new handoff refusal, not account-wide revocation or denial of every existing request. No broader session effect is proposed. “Block new sign-ins for an app” must not become a global platform-login outage.

## Production consumer ownership — planner integration, not a broad grant

The builder can provide the typed flag resolver, preview, expiry and audited control surface. The planner should supply/review narrowly named call-site integrations for the approved catalogue: QR/card/manual-payment paths (`apps/api/src/services/payments/{gateway,routing,terminal}.ts`), booth (`services/booth.ts`), gate/device/offline enforcement (`packages/box-agent/**` and its existing API configuration boundary), rollups (`services/analytics-rollup.ts`), and outbound messaging (`services/inbox/send.ts`). The Inbox subtree is explicitly planner-owned; assistant subtrees stay untouched. App-specific sign-in consumers such as `apps/oto-app/server/middleware/platformSignOn.ts` are additional integration only if needed beyond the platform exchange check.

Ask the planner to bind each supported key to its actual existing consumer/refusal semantics, scoped propagation and banner/alert behavior. Do not expose an actionable switch until that consumer is integrated and proven. Do not invent offline gate/payment policy or let a generic flag store imply those actions work. Dual-control approval and expiry must be enforced server-side before a dangerous flip; its durable implementation is ordinary design, not a request for the planner to choose storage.

## First independent work and proof

P4 is closed. Start owned real-HTTP review tests against missing registry/control routes and a native Console page RED; then build the registry/read DTO and read-only `/apps`/`/releases` views, additive permissions and schema. This needs no protected consumer changes. Keep mutation enforcement/consumer offers held behind the scoped integration ruling; record partial readiness honestly.

Required pins include live scoped authority and replay, preview/enforcement agreement, foreign scope refusal, audit rollback, seed replay preservation, maintenance minted-token refusal and unaffected other apps, exact expiry boundary/later-edit preservation, self/expired approval refusal and actual named-consumer refusal with fake external adapters. Staging acceptance follows S2-23: maintenance tile/refused handoff/restoration plus release preview/refusal/alert/auto-revert/audit. No payment, provider or messaging action is authorized by this preparation.
