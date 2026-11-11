# Login lifecycle repair — SCRUM-778, SCRUM-781 and SCRUM-810

The platform settles a retained event for a deleted login as superseded, after
proving park ownership. A deleted app login no longer leaves requests pending.
The app retains the receipt and its tenant snapshot; it does not remove audit
history or reactivate a platform account. The last-administrator guard remains.

Transport attempts use a durable due time. Failure delays are 30, 60, 120, 240
and 480 seconds; the sixth failure parks the event with a safe reason and no
due time. A second process cannot claim the same due attempt. Losing a reply
after platform settlement does not reopen the receipt. Failure auditing keeps
one record per event, operator, action and cause; unrelated operations retain
their existing per-request failure records.

Migration 0049 was regenerated against main's 0048 at landing, with identical
SQL and an equivalent generated schema snapshot. It adds the tenant snapshot and
due time, stamps ownership, settles old orphaned requests and parks already
exhausted requests without resetting their historical attempt count. The
restricted API writer keeps its existing table permissions. Only the stamp
trigger executes as its owner, with a fixed pg_catalog search path, qualified
references and no public EXECUTE. No historical migration is edited.

The first app suite exposed the missing ownership-read permission. Its failed
receipt remains in `local-gates.json`; after the correction, all 51 checks pass
in a disposable app database, including the real restricted-role check. The
new nine checks run in CI through the existing suite-sign-in-routes entry and
s633-suite runner. Eight API review pins and 26 existing lifecycle checks pass.
The required app text reviews, API types, app ratchet (418/418), production build,
API contract check and lint are recorded separately with log fingerprints.
The full CI result is a separate release check; local focused checks do not
claim full-suite coverage.

`staging/proof.mjs <full-sha>` is the prepared native staging observation. It
enters the app through the launcher, reads only the old SCRUM-769 and SCRUM-795
ZZ TEST receipts through the authenticated app route, and watches the filtered
Console Activity screen for ten real minutes. It saves each response count,
compares attempt counters before/after, takes masked pictures and signs out.
No new staging record is needed. At this checkpoint the staging proof has not
run and these three tickets remain In Progress.
