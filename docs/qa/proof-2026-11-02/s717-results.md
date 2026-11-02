# SCRUM-717 — station rules on the box lane

SCRUM-717 is Deployed. Source
`f8c4d4294c4a1b350e37635d1e17eaa92f7079fa` passed all six jobs in
[CI 41443707967](https://github.com/vickyydev/oto-platform/actions/runs/41443707967),
confirmed by the exact-SHA watcher. API, Console and POS deployed that source.
The native proof completed at `2026-11-02T12:53:13.476Z`, after the API's
same-source restart completed at `12:51:10.442866Z`. The inspected
`s717-staging-proof.png` is attached to SCRUM-717 as **12228**. Jira read-back
confirmed Deployed; Done remains the owner's acceptance.

The owner approved Q717-1: one dedicated staging test agent inside the
existing API, preserving the primary virtual box and adding no paid service.
Only `BOX_AGENT_TEST_SLOT` was added; all 56 existing environment values
were verified unchanged. The fixture is online and ready, with an empty
outbox and no held lease. It is retained for the assigned SCRUM-708 proof.

Before the staging-host addition, the combined local API battery passed
6,068 tests across three embedded-Postgres shards, with the existing 401
skips and four TODOs. All 838 box tests passed after the final recovery
follow-up. Shared tests (857), package typechecks, touched-file lint,
generated contracts and the workspace build passed. The final host/routing/
lease regressions passed all 38 cases. Four deliberate HIGH host mutations
reproduced while nine controls passed, then the guarded source was restored.
The final source CI covers the combined tree including the host addition.

Earlier branch checkpoint, 2 November 2026:
`a1d88200c3ea7451f90583fa8a94e96a495277ac`.

The source was first pushed on `lane/codex-box-lane-20261102`. The full branch
battery, [CI 41424651622](https://github.com/vickyydev/oto-platform/actions/runs/41424651622),
failed its workspace job on both attempts. All three API shards, POS and
OTO App jobs passed. This is not a green release or staging acceptance.

## Behaviour and local checks

The box uses the platform's shared routing defaults. QR none answers
“This counter is not set up to take QR payments”; gateway QR keeps the
existing server-required refusal. Manual card keeps the box's existing
no-terminal sentence because the platform records that approval through
`/payments/manual`. Explicit and unset terminal routes still use their
original terminals. A retry of an uncertain payment keeps its existing
attempt even if the routing changes.

Both the Pi configuration and the virtual box's `station_config` cache carry
the shared readiness decision. A known not-ready till refuses a new lease.
Missing or malformed readiness allows it; renewal of a held lease continues.
The bundle remains expand-only. Sale numbering, sealing and safeguards are
unchanged. No SCRUM-719 or SCRUM-720-owned file was edited.

Completed local gates, with Docker off and the API tests on embedded Postgres:

| Gate | Result |
| --- | --- |
| Box native full suite | 793 passed; zero failed, skipped or cancelled |
| Shared full suite | 857 passed |
| API review and platform payment/readiness regressions | 83 passed in four files |
| Shared, box and API typechecks | Passed, no diagnostics |
| ESLint on changed TypeScript files | Passed |
| Generated API contracts | Match the API |

The API review exercises the real HTTP virtual mount as well as the agent's
own bridge. A deliberate local mutation removed the new lease and tender
guards. Four HIGH findings reproduced under `it.fails`, while the five
controls passed. The guards were restored and all nine cases returned to
passing pins. The first mutation run also exposed lease contamination
between review cases; the fixture now releases its lease after every case.
No failing expectation or temporary mutation is in the source commit.

The first branch CI workspace job passed 792 box tests and failed the existing
`storage.test.ts` exact ten-second boundary case: `mirrored` instead of
`too_soon`. That file and the storage implementation are unchanged in this
unit. A separate checkout of the exact CI SHA passed all 11 storage cases
locally. The possible filesystem timestamp-rounding cause and failure details
are on SCRUM-719, which owns recovery. The single allowed retry ran after the
other jobs finished and failed on the same assertion (attempt 2, workspace
job `125218653452`). No storage assertion or guard was changed. Another
retry without a fix has not been requested.

The lane was rebased onto SCRUM-720 at `2513e1fb`. The API typecheck and all
23 cases in the routing review plus both display API review files passed on
that combined tree. SCRUM-717 product bytes are unchanged from the branch CI
source.

Main's display release at `2513e1fb385190c38f494d81006cfc1e44302f79` failed
the same storage assertion in
[CI 41425308521](https://github.com/vickyydev/oto-platform/actions/runs/41425308521).
Its exact source also passed all 11 storage cases locally. Its single
workspace-job retry also failed on the same assertion (attempt 2, workspace
job `125220163645`). All its API shards, POS and OTO App jobs passed. The
recovery and display tickets both carry the evidence. Feature pushes and
staging deployment were held while main was red. The initial report and
checkpoint were published as documentation only in `d457e574`.

## Q717-1 — staging proof host

The required proof uses a new ZZ TEST virtual box and till, forced offline
through Console, showing the QR-none refusal, the not-ready refusal and a
ready cash sale. The completed evidence is below.

Read-only inspection of the staging API's 56 Render environment entries found
`BOX_AGENT_BRANCH_CODE=hkt-central`, `PROCESS_ROLES=api,edge,jobs`, and no
`BOX_AGENT_SLOT`. Only these non-secret selectors were printed. The code
defaults the absent slot to `virtual-1`. `startVirtualBox` starts one agent,
and the virtual station mount obtains its sales queue from the in-process
agent map. Creating a new box row alone does not start another agent. The
POS's `setBridgeOrigin` also has no caller, so a local agent is not an existing
way to perform this proof from the deployed POS.

The approved option is implemented in `apps/api/src/services/box.ts`.
`BOX_AGENT_TEST_SLOT=zz-test-s717-20261102` opts in to one additional agent
only with `DEPLOY_ENV=staging` and `OPS_TEST_CONTROLS=true`. Its existing row
must be an enabled, unarchived virtual box named `ZZ TEST ...`, on the
primary box's exact operator and branch. The primary slot is unchanged.
Both agents use the existing single-instance lease; stopping it also
invalidates a startup still awaiting registration. No new service, route,
credential type or permission was added. Removing the option and restarting
the API returns to the existing one-agent setup.

The new fixture was prepared at `2026-11-02T12:11:07.296Z`:
`ZZ TEST SCRUM-717 virtual box`, slot `zz-test-s717-20261102`, and
`ZZ TEST SCRUM-717 till`, prefix `Z717`, manual card and QR none.
Exact IDs and independently confirmed session sign-outs are in
`s717-fixture.json`. Only `BOX_AGENT_TEST_SLOT` was added: all 56 previous environment values
were independently verified unchanged (57 names afterward). Existing box
and station assignments remain unchanged; no payment or SMS was attempted.
The proof is inspected and attached, and SCRUM-717 is Deployed.
SCRUM-708 may now start under its separate specification.

## Completed native staging proof

| Check | Observed result |
| --- | --- |
| Dedicated agent and configuration | New ZZ TEST virtual box served its own station and fresh catalogue; primary identity and virtual-1 slot unchanged |
| Known not-ready setup | Cleared only the test till's prefix, applied config, used Console Go offline; the box lease answered 409 STATION_NOT_READY / No receipt prefix, also visible on the disabled native till tile |
| QR none | Restored Z717, refreshed config and forced offline again; native PromptPay press answered 409 QR_DISABLED_FOR_STATION and displayed This counter is not set up to take QR payments |
| Ready cash | Native guest F&B order with ZZ TEST note completed for 90 baht, receipt Z717-000001; one queued fact while offline |
| Reconnect | Console Go online drained the outbox; the same finalised sale and receipt were read twice from the platform |
| Cleanup | Independent read-back at 12:55:04.632Z: online, ready, Z717 restored, zero queued facts, no held lease; every proof/read-back session signed out 200 and subsequently answered /me 401 |

The sale is `01a19c52-0d21-7ab7-a1c2-507dc9ab1962`. The native screenshots
are `s717-qr-none.png`, `s717-not-ready.png`, `s717-cash-offline.png` and
`s717-console-offline.png`. The Console capture shows the command being
queued; its succeeded result and the bridge's forced-offline state were
independently awaited before the sale. The box's green heartbeat badge
reports that the process is alive, not that its deliberate offline switch
is off.

Receipts: `s717-ci.json`, `s717-agent-env.json`, `s717-fixture.json`,
`s717-staging-proof.json`. The composed, inspected screenshot is
`s717-staging-proof.png`, also committed under
`docs/qa/jira-comments/attachments/SCRUM-717/`.

Scope: this is the deployed virtual mount with an existing platform session,
using the Console's real offline control. No browser network substitution,
physical Pi, fresh offline staff unlock, terminal payment, SMS or real-person
data was used. Staging has no staff-token signing key; this unit does not
claim or change that separate setup. The synthetic fixture and its dedicated
agent remain for SCRUM-708; its 90-baht cash order is a staging test record,
not money collected. No recovery, installer, display-lane or POS-server file
was edited.
