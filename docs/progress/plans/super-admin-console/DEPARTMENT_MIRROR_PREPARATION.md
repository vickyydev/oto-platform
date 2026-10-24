# SCRUM-631 department mirror preparation

**Release checkpoint, 24 October 2026:** Independent work and requested container cleanup are captured. Q16 remains the only known production-edit dependency; the actual seed replay still fails and the feature is unlanded. The three complete API shards recorded4,892 passes/two failures/401 skips/five TODOs; the stale writer-register failure then passed with all57 affected cases. The other13 suites2,653, POS1,437, Box749, browser195, workspace compilers/builds/contracts/schema and scoped OTO install/compiler/29commands/restore all pass. The final source bridge adds only the worker reliability fix and two named test-register updates to the OTO frozen inputs. No631 staging proof exists.

Local receipt pointers (hashes bind the actual retained artifacts):

| Artifact | SHA256 |
|---|---|
| C:/w/admin631-source-input-bridge.json | 351e812ad01f5797d29ebc8366a08c5a8243b246ce7bffe9ee93cb344c2b063a |
| C:/w/admin631-oto-complete-review.json | 37e6e232421d26057035bac98f79772b3070709d17914bcd0c3a95d97355c0db |
| C:/w/admin631-local/cleanup-result.json | 9560243e0251e41f0717fd6c871819c01e6c9e56f5c3a8a25768bd39a6224dad |
| C:/w/admin631-worker-final-review.json | 924e2d94235e5e69e99c864241529afd8dd05df98d9e38bb21f37ce26daa4c24 |

The current safe source manifest is 4249af21006e52c3c5afac7115bf36e40512f96ccd24fe7689291300a5b3c1ab (3,716 inputs). Its incremental archives and full command logs are retained under C:/w/admin631-local. Q16’s unapplied patch is C:/w/admin631-q16-proposed.patch. [Next read-only page preparation](READ_ONLY_ADMIN_PREPARATION.md) is a source map, not implementation.

**24 October 2026 update:** Q15 is approved in PLAN section9 and implemented locally. The earlier preparation below remains a historical source map. Core0086/app0030 and the source/worker/directory changes are locally built and checked; full release/staging remain. Q16 asks the planner to authorize only the seed helper change needed to prevent a recreated legacy row after a mirrored rename. The actual regression preserves team/grant references but fails on one extra department row; no protected production file has changed.

Read-only inspection on 24 October 2026, based on main
`859db77e03af89ed7047bec4631b6a4cbe8bb20a`. This is preparation, not an
implementation or test result. Q15 in PLAN section 9 awaits the planner.
No source, migration, staging login or staging data changed.

The model conflict is concrete: the committed OTO App sample has one
Reception department assigned to both Central and Chalong. The platform
holds separate reception department ids per park. Its teams and scoped
grants already use those ids. A unique operator/external-id key cannot
retain both rows for that single source department.

| Existing fact | Source |
|---|---|
| Departments belong to a tenant, with many branch assignments and an `isActive` flag | `apps/oto-app/shared/schema.ts:2457` |
| Reception and several other sample departments span both parks | `apps/oto-app/script/sample/data.generated.ts:35` |
| The sample loader creates one department and its branch assignments | `apps/oto-app/script/sample/main.ts:237` |
| Core departments hold one nullable branch; null means operator-wide | `packages/db/src/schema/tenancy.ts:71` |
| Separate seeded reception ids exist per park | `packages/db/src/seed/index.ts:425` |
| Inbox seed reuses those ids; no protected source edit is proposed | `packages/db/src/seed/inbox.ts:307` |
| Department grants cover an exact id and affect the initial seat | `apps/api/src/services/permissions.ts:63`, `apps/api/src/services/access-control.ts:442` |

Q15 proposes a projection per assigned platform branch, with uniqueness on
operator, source department and branch, including a separate null-branch
rule. A seeded name would be adopted only within the same operator and
exact branch, once, with trim/case normalization and refusal to guess when
ambiguous. Rename keeps the id; branch reassignment archives and restores
projections without moving an existing id or its grants to another park.
Assigned-but-unmapped or foreign branches never become operator-wide.
These are proposed rules until the planner resolves Q15.

The source and UI gaps are already located:

- `apps/api/src/services/otoapp-employees.ts` reads the app-owned employee
  view, which does not expose primary department identity. New employee
  copies currently set `departmentId` to null in `otoapp-employee-sync.ts`.
  Membership must join the copied department for both the directory count
  and the Employees department label to populate.
- The existing sync enumerates employee tenants. Department enumeration
  must also cover a department with no employees. Use the existing unique
  tenant anchor, validated branch mapping and per-operator transaction;
  an absent, denied or failed source read is not an empty department list.
- `apps/api/src/services/departments.ts` already reads core only and filters
  departments and counted employees independently by operator and branch
  reach. Counts include archived employees. Preserve that existing rule.
- `apps/console/src/pages/Departments.tsx` and its generated API adapter
  already call `GET /departments`; old and current addresses remain wired.
  Use the same list with accurate source/status wording and an OTO App
  link, keeping all department edits in the app.
- `jobs.ts` and `routes/ops.ts` already invoke the same copy service for
  scheduled and manual runs. No new public mutation route is needed.

The approved copy-job extension in PLAN section 4.3 is the integration
boundary. Its source must remain an app-owned read-only seam. A new
expand-only app migration may publish department assignments and an
additive primary-department projection; do not edit applied migration0005
or change existing employee-view column order/types. Keep API access at
view SELECT, with explicit missing-grant refusal. No raw HR table grant or
protected production file change is proposed. Existing exact seam guards
must learn only the declared reader/view and retain their write/raw-table
prohibitions.

The app restore rehearsal's mandatory view list also needs the new views.
The existing employee readback script checks only the employee view and
grants nothing; require a bounded readback of every new view as the actual
API database role. Do not assume that staging ownership grants are portable.
If changing a helper outside the lane becomes necessary, post that exact
scope request to the planner before editing it.

Seed convergence is a further review case: name-based seed lookup recreates
the old name after an adopted department is renamed. The actual replay
regression confirms an extra unlinked row; existing teams and grants retain
their original references. Prove the complete copy/seed/replay sequence
preserves those ids without recreating a fallback. Do not edit protected
Inbox services or silently add seed behavior; any necessary outside-lane
seed fix goes to the planner with the failing case and exact paths.

The inspected journals end at core0085 and app0029. Provisional next
numbers are0086 and0030, respectively; neither is reserved or created.
Recheck main and renumber at landing. Core columns and uniqueness depend
on Q15. Adding an archive label does not authorize automatic grant
revocation or changing the app's department access rules.

The regression and acceptance cases are prepared for implementation:

1. A two-park source department adopts both seeded ids without changing
   any existing team, grant or seat reach. An empty department still copies.
2. Create, rename, deactivate, reactivate, remove/reappear and branch
   reassignment preserve the approved ids and converge on repeat runs.
   No-op and concurrent runs create no duplicate row or audit entry.
3. Membership create, adoption, update, clear, branch change and restoration
   populate the right copied employee links. Preserve platform-owned staff
   and the existing archived-employee counting rule.
4. Ambiguous names, source/core tenant mismatches, foreign or malformed
   branch mappings, case collisions and zero/two tenant anchors must not
   adopt, expose or archive another park's rows. A failed or unexpectedly
   empty read must not retire live copies. Late failures roll back the
   operator's department and membership changes together.
5. Retain `departments.test.ts`, `s615-departments-review.test.ts` and the
   existing source-seam/employee-sync assertions. Add the house review
   pins and demonstrate their failures before the implementation. Verify
   both migration chains, schema, generated route types when changed,
   whole compilers and the normal release gates.
6. After green exact-source CI and automatic deployment, create only an
   empty `ZZ TEST` department through the app's own API as the acting demo
   user. Observe create/rename/deactivation through the deployed copy job
   and the native Admin list. No employee creation, SMS, pay data or
   hardware action is required. Keep fixture ids and postdeploy timestamps,
   restore/archive the exact fixture, verify original state and sign-outs,
   inspect the staging PNG, then attach and name it before Deployed.

No tests or staging actions were run during this preparation. The three
independent inspection receipts remain local at
`C:/w/admin631-model-audit.json`, `C:/w/admin631-ui-preparation.json` and
`C:/w/admin631-seam-preparation.json`; their existence and contents are
checked before the final preparation checkpoint. SCRUM-632 preparation
is read-only while Q15 is pending; no later implementation is claimed.

For SCRUM-632, the inspected native pages are
`client/src/pages/{users-page,permissions-page,operators-page}.tsx` in the
OTO App. Preserve their lists and existing gates. The shared `CONSOLE_URL`
and existing handoff link patterns provide Admin destinations; app legal
entities are not platform park groups, so do not invent matching operator
records. Server checks must consider the target's current entity flag,
old sessions, mixed enabled/disabled targets, atomic bulk writes and
alternate module-override/Data Admin writers. Session claim presence alone
is insufficient. These are preparation findings, not a chosen mixed-entity
policy or an authorization to implement632 before631 is Deployed.
