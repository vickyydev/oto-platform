# SCRUM-717 — station rules on the box lane

The owner approved Q717-1 on 2 November: one dedicated staging test agent
inside the existing API, preserving the primary virtual box and adding no
paid service. The implementation is ready locally; source CI, deployment
and the native offline proof remain pending.

The current base includes SCRUM-718 at
`c2fdd28fdc9e944d058af62dec1347e5f2b7a56f`, whose
[CI 41439428324](https://github.com/vickyydev/oto-platform/actions/runs/41439428324)
passed. It also includes the planner's complete recovery repair, including
`119e2c59`; that source passed all six jobs in
[CI 41436309930](https://github.com/vickyydev/oto-platform/actions/runs/41436309930).

Before the staging-host addition, the combined local API battery passed
6,068 tests across three embedded-Postgres shards, with the existing 401
skips and four TODOs. All 838 box tests passed after the final recovery
follow-up. Shared tests (857), package typechecks, touched-file lint,
generated contracts and the workspace build passed. The new host has 13
review pins plus 25 routing, lease and existing agent regressions; its API
typecheck, lint and generated-contract check pass. A deliberate mutation
removed the environment and late-start guards: four HIGH findings
reproduced while nine controls passed, then the guarded source was restored.

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
ready cash sale. It has not been run.

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
`s717-fixture.json`. The test agent has not yet been enabled. Existing box
and station assignments remain unchanged; no payment or SMS was attempted.
SCRUM-717 stays Testing until the specified proof is inspected and attached.
SCRUM-708 has not started and waits for that Deployed state.

## Planned staging procedure — not yet executed

1. Verify the green release SHA and the completed API deployment before
   enabling the prepared ZZ TEST virtual box and till. Preserve their exact IDs in
   the proof receipt. Start the test agent only through the chosen host setup.
2. Give that till its own receipt prefix, manual-card routing and QR none.
   Confirm its configuration/cache has arrived, then use Console's offline
   switch. Capture the actual box-bridge refusal and the POS sentence for QR.
3. Reconnect the test box, release the test lease, remove the test till's
   prefix, wait for the new readiness to reach its cache, and force it offline
   again. Capture the not-ready lease response and its sentence on screen.
4. Restore the test prefix, refresh the cache and force offline again. Sell
   one guest cash order with a ZZ TEST note; record its box-bridge result,
   receipt and queued fact without using real customer data or a real tender.
5. Reconnect and verify the one test sale reaches the platform once. Release
   the test lease and sign out both sessions. Record the exact fixture state
   and any remaining synthetic sale; do not call an unexecuted cleanup done.
6. Inspect the native captures, publish the timestamped receipt and evidence,
   attach the image to SCRUM-717, and only then move it to Deployed.
