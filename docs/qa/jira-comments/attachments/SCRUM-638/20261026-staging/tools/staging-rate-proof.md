# SCRUM-638 native staging rate proof

This supersedes the held read-only helper for the newly approved initial rate.
Main 590a8e41, Q18_PROVIDER_RATE_REVIEW.md and Jira 12583 authorize one native
Settings save for the existing OTO operator: claude-opus-5-5, effective from
2026-10-20T00:00:00.000Z, input 4/output 20/cache read 0.2 USD per million.
The seed remains empty. All cap and pacing overrides and their effective
values must remain unchanged.

The original full source, exact six-job CI, latest live API/Admin deployment,
real route schema, public asset bytes, demo actor/permission, original-cookie
200/401 cleanup and three inspected screenshot requirements remain. The new
helper is admin638-staging-rate-proof.mjs. The matching collector is
admin638-create-rate-proof-plan-20261026.mjs; it produces an unapproved held
plan from actual postdeploy metadata and public assets. No staging has run.

Only the first ADMIN desktop page can arm the exact revisioned body computed
from its current read. The native form fills the five rate fields, adds the
version and saves once with the app's idempotency key. A healthy settled page
and current release are checked before arming and immediately before dispatch.
The durable intent records only safe hashes and revision. Every other business
write is refused. A lost result stays unconfirmed; the helper does not retry.

The save response must use the real schema and contain only the exact rate
addition, next revision, ADMIN update attribution and fresh update time. The
rate history must then appear in the real page; subsequent phone and direct
reads must match the saved response. An already-present exact approved version
is recorded as preexisting and never saved again; conflicting history refuses
the attempt. Reception must retain its real API/UI refusal and both actors'
authority must remain unchanged. No live AI, SMS, payment, check-in, message or
channel operation is part of this proof.

Offline checks: 29 pass. Actual predispatch regression was 24 pass/2 fail before
the fix, then 26 pass with the same tests; three further native-handler checks
cover success/duplicate refusal, source-gate refusal and unknown-result refusal.
The independent review v2 binds helper 660c1afc4095d0d2cbd97313a05a03ee19f255fbbdf7cbcf3803f1fb0ebbf839.
Its original v1 binding mistake is retained with an erratum. All earlier failed
attempts remain separate. No local calibration is a staging acceptance claim.
