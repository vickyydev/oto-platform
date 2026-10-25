# SCRUM-640 integration preparation

Prepared2026-10-25. Tested source 88e99b26ebc159dd952062baf2076bf6f8e5ecc8; remote lane/admin-operator-switch checkpoint a5071169c1b7177867d3620377334c768b933b4b. Q20 central/protected integration remains held; this note grants no outside scope and activates no switch.

## Exact current owned inputs

| Path | SHA256 |
| --- | --- |
| `apps/api/src/services/operator-switch.ts` | `a3bd4707333ce735db408c949c9ced0a2537fb6286a13bcbb739440613235eb7` |
| `apps/api/src/services/fleet.ts` | `a0a09556a5411e57a64e0da827217842c0bbe549cf44c7f10dc9e1f50e98f58d` |
| `apps/api/test/operator-switch-review.test.ts` | `fd7198fa385b5a7ae9a84c1063ff1f15de4dce5d0adeaf7403456c60f3071d72` |
| `apps/api/test/operator-switch-seat-review.test.ts` | `9dabcd90a6936c85a06d7058e5aed8ce5c5c08bd601b012c6212662d9ec660e9` |
| `apps/console/src/components/OperatorSwitchPicker.tsx` | `eb82456d93b072e852bfd6266684e1b494abec570f5beb6a17086071664960ae` |
| `apps/console/test/operator-switch-picker-markup.test.ts` | `b94634c0ca22de52bb908119c63499517c5ed2662a2d0a7609b77b6412ba5aa7` |
| `packages/db/src/schema/tenancy.ts` | `ffe7b37b05a68296ddf87a7f3354b652ffaf99ae36e1a04ec97aeb61c6ea5569` |
| `packages/db/migrations/0087_operator_switch.sql` | `40940090aae6caa464ceb992782f8381b4261a560ca7df57bbb5a09ff7853e5f` |
| `packages/db/migrations/meta/0087_snapshot.json` | `d32b0d999d37798e323941de74598454b91bd6da3a110f33ac2f0e8c6ad13889` |
| `packages/db/migrations/meta/_journal.json` | `dfe294319fb49cc44c2396a8c1f5b59493cd5afee067b48c3b3b602f014fb09f` |
| `packages/db/test/s640-operator-switch-migration.test.ts` | `f86de4d6f6d29319d3793e420ab2749afd2024d0090754642501d913565c0d01` |
| `packages/shared/src/permissions.ts` | `932b720ee370347ae260f48eeaf751f8186848b5014645911e798ed93e381b28` |
| `packages/shared/src/permission-words.ts` | `9eeab3f009f09ef8a87f035082e09645c77e7da011c3606f65dc7111a05a25e2` |
| `packages/shared/test/operator-switch-permission.test.ts` | `84d7d4e73267e63136e9fe708bb67d8fde42167767715e0f80f7f316db6a2535` |

The migration adds only nullable `core.session.operator_override` plus its operator FK; it does not backfill or rewrite accounts. Number 0087 is provisional and conflicts with the isolated 638 addition: inspect main and renumber at landing, preserving SQL semantics and applied history.

## Implemented service and unwired HTTP decisions

- `switchSessionOperator(db, {accountId, sessionId, operatorId: string | null, expectedRevision}, ctx?, now?)` returns `{homeOperatorId,effectiveOperatorId,operatorOverride,branchId,stationId,revision,changed}`. IDs supplied by an authenticated route must come from its actual session, never a body-selected account/session.
- `null` or the explicit home ID canonicalizes to `operatorOverride:null`. A changed effective operator clears branch and station; a same-context accepted selection preserves both. Every accepted selection, including a no-op, creates one atomic `session.operator_switch` audit and advances the session's audit-derived revision by one. A stale expected revision conflicts; concurrent selections at one revision cannot both succeed. Audit failure rolls back state and revision.
- The service validates live account/session/home/target, lock/password state, staff session class, owned live seat and one live null-operator-scope assignment carrying `platform:operator:switch`. A role name, own-operator grant, unrelated global permission or branch union cannot substitute. Invalid context refuses rather than repairing itself to home. Fleet station update now rechecks exact account/branch/effective operator before minting its token.
- `operatorSwitchOptionsOf(db,{accountId,sessionId},now?)` is an unregistered read-only repeatable-read service returning the canonical context and live `{id,name}` operators. Neither export is connected to an HTTP route or SessionContext.
- Pending Q20 decision: add canonical context metadata to existing `GET /me` (home account unchanged), or a separate authenticated context GET such as `GET /me/session/operator`. Fields needed by the controller are the result's home/effective/override/seat/revision, not a repurposed `account.operatorId`. The route name and DTO extension are proposals, not an active contract.
- Existing platform-wide `GET /operators` already supplies live `{id,name}` choices. Decide whether to reuse it with the canonical context read or expose the options service through an agreed read route; do not fetch two competing operator lists. Existing operator-management URLs stay unchanged. The planned `PUT /me/session/operator`, generated DTOs and four conformance guards remain unwired.

## Held integration and replay requirements

Q20 expressly holds `apps/api/src/plugins/session.ts`, `apps/api/src/routes/me.ts`, `apps/api/src/services/handoff.ts` and `apps/api/src/plugins/idempotency.ts`. Required work is live effective `auth.operatorId`, truthful separate home/context metadata, live exchange context and context-safe cached writes. Review invalid/archived overrides, withdrawn grants, lock/password state, expiry and branch/station races before enabling the endpoint. A human override must not rewrite machine, device or scheduled-job operator ownership.

Before any cached answer, revalidate the actual same session, current context revision and fresh switch/liveness authority. Ordinary write replays must not return A's result under B. A lost A-to-B switch response needs a narrow replay contract: its cached **post-selection** revision must still be the session's current revision; another session or a later selection (including A-B-A) cannot replay an obsolete confirmation. Comparing only operator IDs or blindly adding the current operator to every hash does not solve switch retries. Preserve existing transaction/retry/conflict/secret-response rules. Current service tests do not establish global cached replay safety.

Handoff must keep the real home account/identity, one-use claim, audience/origin/cookie/liveness rules and current app placement fences. OTO App tenant, role, raw advisor and branch restrictions remain authoritative; switching must never auto-create/link a foreign app identity or fabricate foreign employee/role reach. Test mint-before-switch/exchange-after-switch and an already-open app separately. Planner owns `services/assistant/**`, `services/inbox/**`, `packages/assistant/**` and Inbox UI. In particular, `assistant/call-platform.ts` re-resolves a captured cookie per tool request; a mid-ask switch needs planner-owned context/attribution tests and any required fix, including `assistant/call-otoapp.ts`. No protected edit is included here.

## Console scope inventory and controller integration

All paths below are under `apps/console/src/`; these seventeen existing consumers currently derive scope or lifetime from the home `me.account.operatorId`. Switch them to agreed canonical effective context where they mean working scope, while keeping home identity displays intact.

| Current file:line | Scope use |
| --- | --- |
| `pages/Accounts.tsx:36,40` | Native account/access ports |
| `pages/Roles.tsx:81` | Native role port |
| `pages/Branches.tsx:45` | Operator grant comparison |
| `pages/Devices.tsx:172,183,192` | Device/station grant comparisons |
| `pages/Catalogue.tsx:50` | Catalogue scope |
| `pages/MenuCatalogue.tsx:40` | Menu owner/context |
| `pages/Money.tsx:56` | Money owner/context |
| `pages/Care.tsx:33` | Care scope |
| `pages/StaffBenefits.tsx:19` | Benefit scope |
| `pages/VoucherTypes.tsx:57` | Voucher scope |
| `pages/Reports.tsx:25,39,41,101` | Request keys and scoped offers |
| `pages/Staff.tsx:20` | HR summary authority key |
| `pages/BoothReport.tsx:39` | Report authority key |
| `pages/Operations.tsx:35,70,109` | Request key, branch/menu reach |
| `pages/TeamsRouting.tsx:38,45,49` | Routing key and target grants |
| `pages/Channels.tsx:19,26` | Context key and scoped offers |
| `lib/platformAuthority.ts:22,25` | Strict global-health offer and lifetime key |

Integration points remain `api/platform.ts`, `auth/SessionContext.tsx` and `App.tsx:225-229`. Invalidate the session authority epoch at dispatch/refresh start; mask old content until canonical context plus fresh permissions agree, reject overlapping branch/operator changes, and recover uncertain responses through a canonical read before more actions. Keep SessionProvider outside an effective-context/revision-keyed subtree containing PlatformStatusProvider, ConsoleLayout and pages. This also clears the enabled-only caches in `lib/platformStatus.tsx:58` and `components/redesign/useFailureCount.ts:30`. Remount alone cannot stop retained callbacks: guard every dispatch and post-await result, including saves, dialogs, exports/downloads, clipboard and app handoff, against actor/session/context/revision/epoch. Preserve previous paths and native permission rules.

The standalone picker takes `{home,current,options,epoch,canSwitch,loading,switching,error,onSelect,onRetry}` and uses native SelectChip/ErrorNote. Canonical current must be present in options; missing/null current disables a placeholder instead of selecting home/first. Home stays visible, selection is never optimistic, pending/error blocks selection, and retained callbacks check render lifetime. No active picker offer or SessionContext integration exists yet.

## Required actual browser and central integration proof

1. Reuse `e2e/organisation.spec.ts` branch-switch lifetime patterns and `e2e/platform.spec.ts` authority/ABA fixtures. With real SessionProvider, show correct home/current, canonical list, null/missing-current refusal, pending/error/Retry and 390px geometry.
2. Hold the switch response and then canonical reads: old scope cards, offers, dialogs, secret state and callbacks must be masked immediately; only confirmed new context can restore them. Prove unknown/refused/late responses, A-B-A, unmount, logout/new actor, lock/password refresh and grant withdrawal.
3. Hold A reads/writes/exports/handoff, switch to B, then release: no stale display or follow-up dispatch. Exercise PlatformStatus/failure caches, all seventeen scope consumers and retained callbacks, not just picker markup. Preserve unchanged paths and ordinary null-override behavior.
4. Real DB/HTTP cases must cover all central read/write ownership, original-seat preservation on same-context selection, seat clearing on change, cross-session isolation, same-key ordinary/switch replays, stale revisions, target archive and branch/station concurrency. Add generated-contract and exact route-guard pins only after the actual route exists.
5. Planner must prove mid-ask and cross-app attribution/identity restrictions. Only after combined release gates, exact-source CI and automatic deployments should a separately reviewed staging proof enter/leave its own safe target, inspect audit and restore/close sessions. None of that acceptance has run here.

## Actual groundwork evidence and limits

The remote lane's [local checks](https://github.com/vickyydev/oto-platform/tree/lane/admin-operator-switch/docs/qa/jira-comments/attachments/SCRUM-640/local) bind all observed commands, input hashes, original failures and log hashes. Scoped observations:322 DB,775 shared,205 affected API,297 Console/three TODO; native schema verification, package compilers, Console build and lint pass. Post-rebase 2026-10-25T12:36:33.705Z: migration9, shared775, newAPI31 and Console297 repeat with clean compilers and eleven-file lint on unchanged final inputs. The DB-wide run's shared transitive inputs changed during preparation; final post-rebase focused DB/full shared checks pass, and no frozen whole-workspace battery is claimed. Console build predates only removal of an EOF blank line; final Console units/compilers/lint repeat.

Actual initial REDs are storage8fail/one control, permission3fail/one control, service27fail, picker14fail/two controls. The paused native station pick proved stale200, A station attached after B switch and A token minted; the normal mint control passed. The conditional update now refuses409 before write/mint and normal mint stays200. Actual27pass/two audit failures R18/R19 precede verified failure attribution and branchless home-session scope fixes; all29 service cases now pass. Every accepted selection is an operator-wide home-account/session audit with branch null; before/after retain factual effective seats. Caller context cannot spoof attribution.

Original regex/cleanup-lint/markup-typing failures remain recorded. One ID-guard run failed only because embedded PostgreSQL could not bind its randomly selected port, followed by failed setup teardown; unchanged isolated retry23 and final affected205 pass. No guard/assertion/timeout is weakened. No full final API/workspace release battery, native browser interaction/pixel acceptance, feature CI, migration deployment or staging acceptance exists. SSR does not prove retained DOM callbacks or phone layout. All acceptance follows the real combined integration.
