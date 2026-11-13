# Independent source review: SCRUM-966 / SCRUM-945 slip baselines

Candidate: 53be0beca1245b6e9cafca3405ab633ff5528176. Worktree: C:/oto-lanes/codex-slip-baseline-20261114. Verdict: REQUEST CHANGES for one unresolved HIGH. This is read-only source review; no gate was repeated and no source was edited by the reviewer.

## HIGH S1: a publication-format transition can print a false staff change

apps/api/src/services/party-slips.ts:746-754 accepts a previous snapshot whenever its given-run source matches. It does not distinguish a composer-generation upgrade within one publication format from a legacy-to-kitchen_plan_1 publication-format transition. The composer string already carries that distinction.

Concrete supported sequence: this API records a valid semantic snapshot while the app still publishes the legacy set-menu view, then the app publishes kitchen_plan_1 without staff changing the party. The newer view can expose an already-existing typed extra, cake or bar service time which the legacy view never supplied (party-plan.ts:164-186). Recomposition of the saved legacy input cannot contain those fields. The code therefore compares the limited old input with newly published content and emits UPDATED as though staff changed the party. This regresses the existing SCRUM-906 rule that either a composer generation or the publication shape changing must not itself print a staff change. The current upgrade tests change generation only while keeping kitchen_plan_1; the actual legacy-row test establishes metadata but does not exercise this transition.

Prescribed narrow fix: only use a prior semantic snapshot across a generation upgrade when its recorded publication format is compatible with the current row format. A real source-format transition without enough old input must take the explicit established rebase-to-current fallback and capture a prospective snapshot. Preserve known-empty VOID behavior and cancellation of actual paper, and do not infer a format from an absent row. Add an integration pin which prints from a real legacy view, restores the whole-plan view with extra/cake/time already present but no staff mutation, expects no change slips once, then verifies a subsequent genuine edit is printed. The existing no-snapshot historical limitation applies; no new owner policy choice is needed. This finding is established from the reader/comparator control flow; the reviewer did not run a new reproduction.

## Reviewed sound behavior

The version-1 input schema validates semantic fields, enum routes and a complete explicit routing answer for every referenced nonempty code. Unsupported/malformed/missing route input becomes historical fallback; null live-code routing is distinct from no recorded answer. Persistence strips prices, unrelated line IDs and catalogue flags, while retaining fields the composer consumes.

Within one format, saved routing and previous semantic input are recomposed under current code, and actual current input uses current routing. Normalization writes PREVIOUS semantics in the existing locked transaction; only stations with real change rows advance to change:run/current input. Recorded empty output is distinct from a missing snapshot. rowPresent separates a real legacy row from absence; a missing row retains per-station epoch or leaves an unmarked historical station unmarked. Cancellation uses actual last-given print/change documents, including after silent normalization. Existing advisory lock/action replay and complete-file concurrent tick pins remain.

Scope is exactly two service files and two dedicated test files plus documentation; no migration, shared composer bump, settlement/pricing/editor changes were found.

## Receipt verification

Independently verified all four source SHA256s, all four exact candidate Git blobs, both original base service blobs and all eight raw-log size/hashes: zero mismatches. Read complete summary output: original 9 assertion failures /48 passes, fixed four-file95/95, final changed integration59/59. Unique final coverage is96 across4 files, not the sum of overlapping batches. Both API typecheck outputs and touched lint logs are zero bytes. Recorded cleanup reports no live owned PostgreSQL and zero staging fixtures; no live browser/fixture was opened for this review.

Release still requires fixing S1 and reviewing the exact delta, then normal relevant gates/rebase/commit-list checks, resolved main CI and released844 proof slot, exact-source hosted CI and bounded staging/native proof with inspected images/Jira/cleanup. This verdict does not authorize a feature push while main is red or through another proof freeze. Physical printer output and reconstruction of previously lost historical edits remain unproved.
