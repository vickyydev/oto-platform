# SCRUM-633 — employee sign-in and lifecycle

Local source release passes. Staging acceptance and screenshots are pending.
Keep this ticket at Testing until exact-source CI, API/Admin/OTO App rollout,
postdeploy readiness and attached staging evidence are complete.

The employee editor reserves a local login graph atomically and calls the owned
platform provisioning seam. Current actor and employee scope are checked on
every retry. Pending actions survive reload; a returned credential is shown
once and is neither persisted in the receipt nor retained in the query cache.
Legacy login and existing role, advisor and branch rules remain.

Platform reactivation enables the same linked app user. An app disable,
including the existing scheduled leaver path, queues a private immutable event
in the same transaction. The identity seam checks current ownership and the
last-administrator rule, deactivates the platform account, evicts sessions,
audits and settles its durable receipt together. A later reactivation makes
old delivery harmless. Migration0031 is expand-only, with no backfill, cascading
foreign key, broad grant or applied-history edit.

The protected old Dashboard and troubleshooting addresses redirect to the
existing Today, Fix and Studio pages. The unsupported Setup card is removed.

Local verification: full API5339 passed across361 files (3 skipped,5 TODOs),
POS1437, Box749, all13 other package test tasks,16 workspace typechecks,
five builds, generated contracts, platform schema and no-mock checks.
The app fresh install,29-command build/release battery and real PostgreSQL16
restore rehearsal pass. Its whole compiler remains418 diagnostics across54
files and109 file/code buckets. Forced lint of17 touched app TypeScript files
has3 inherited errors and no new errors. All39 new app checks also run through
the existing CI entry against a standalone app database, with cleanup verified.

Broad checks bind source manifest99162fd2de839885ab82652145f20810197293db14407a43da2c3c221972c590.
The final3739-input manifest29d46a6af64025ee2e8701d688009d79e0d0d2f4410f1e483225bdca95f83dd2
differs only in two later CI test files; production, API and dependency bytes
are identical. Those two files have separate execution and forced-lint proof.

Original failures are retained: an omitted historical seam-table entry, an
unchanged Booth cache expectation, fixture-only scheduling/timestamp mistakes,
and a superseded API run deliberately interrupted after a real concurrency
finding. The exact final identity-link regression fails without the lock fix
and passes with it, including in the full battery. No Booth production fix or
cause is claimed, and no guard was weakened. See local-release.json for bound
receipts and their limits.

Positive new-login proof uses captured local transport. Staging uses existing
demo controls; no invitation, real SMS, payment, check-in, hardware or channel
mode action is authorized by this proof. Native screenshots, when captured,
must be named SCRUM-633-NN-what.png, timestamped after the relevant deployments,
viewed before attachment, and cited in the single Jira outcome comment.
