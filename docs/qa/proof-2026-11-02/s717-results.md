# SCRUM-717 — station rules on the box lane

2 November 2026. Source: `a1d88200c3ea7451f90583fa8a94e96a495277ac`.

The source is on `lane/codex-box-lane-20261102`, not main. The full branch
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
workspace-job retry is running at this checkpoint; the recovery and display
tickets both carry the evidence. Feature pushes and staging deployment are
held while main is red. This report and its checkpoint may be published as
documentation only, without landing the feature.

## Q717-1 — staging proof host

The required proof uses a new ZZ TEST virtual box and till, forced offline
through Console, showing the QR-none refusal, the not-ready refusal and a
ready cash sale. It has not been run.

Read-only inspection of the staging API's 56 Render environment entries found
`BOX_AGENT_BRANCH_CODE=hkt-central`, `PROCESS_ROLES=api,edge,jobs`, and no
`BOX_AGENT_SLOT`. Only these non-secret selectors were printed. The code
defaults the absent slot to `virtual-1`. `startVirtualBox` starts one agent,
and the virtual station mount obtains its sales queue from the in-process
agent map. Creating a new box row alone does not start another agent. The
POS's `setBridgeOrigin` also has no caller, so a local agent is not an existing
way to perform this proof from the deployed POS.

The question on SCRUM-717 is which staging host should run that additional
test virtual box while preserving the existing box and station assignments.
No staging record, environment setting, existing virtual box, park Pi or
station has been changed for this unit. No payment or SMS was attempted.
SCRUM-717 stays Testing until the specified proof is inspected and attached.
SCRUM-708 has not started and waits for that Deployed state.
