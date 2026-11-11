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
Attempt 07 passed on staging: 21 native Refresh responses over 600,553 ms,
zero matching failures, no next page, and unchanged settled receipts before
and after. The old deactivation events are `64948019-0a5b-4fd0-bf8e-d82df60ed0ab`
and `5133dfa0-7b45-47a1-bcd5-3e488af7aa76`; the migration settled both as
superseded with `LOGIN_DELETED`, no next attempt, and historical counts 5,458
and 6,291 retained. The older restriction receipt was already delivered.

The source is `51c558bdd4bc5fd1761d5221cb8cb606c043b15d`. Both named services
reached that source. During the proof the API ran planner descendant
`33e54e3f1ca1c4ed3093838d2793e9595561be19`; the receipt records its changed
inbox files and unchanged lifecycle paths. The app remained at the released
source. Exact landed validation is run 43016530898 on an immutable ref;
its app job passed and its entire typecheck output is byte-identical to the
667 lines already read for the candidate. The other full jobs remain tracked.

All five pictures were inspected and attached to each ticket (13104–13118).
Each ticket walked through Testing to Deployed under the owner's 17:32
direction to accept staging proof while full CI continues. None is Done.
The successful run created no records, signed out all three sessions and
read back 401. See `staging/{receipt,inspected-pictures,jira-proof}.json`.

Failed attempts remain visible. Attempt 01 did not revoke its launcher and
Console sessions before discarding the browser cookies; server-side cleanup
of those two sessions is not claimed. Subsequent attempts signed out cleanly.
The harness corrections cover browser cookie readiness, actual logout paths,
the native filter's minute precision, and the seeded administrator's actual
`masked:false` API flag. Every observed list is empty and the pictures omit
personal details. Backoff, rollback, concurrency and park isolation are local
database checks, not staging fault injections.
