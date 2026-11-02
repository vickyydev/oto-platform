# SCRUM-713 first-stage evidence

Status: software implemented, local release checks complete; full-SHA CI and
staging proof are next. This stage ends at Testing. Real iPad, certificate,
Pi installation and physical power-cut acceptance remain unproved.

## Local release checks

The three complete API shards exercised 438 files. Aggregate result after
the unchanged seven-case demo-reset rerun: 6,131 passing tests, with the
existing 401 skips and four TODOs. One case creating a second disposable
database exceeded its existing 30-second deadline under concurrent load;
the complete file passed unchanged once the shards finished. No timeout or
assertion was relaxed. Detailed summaries and log fingerprints are in
[local-release-checks.json](local-release-checks.json).

The first full POS run passes all 1,652 tests, and all seven built native
browser journeys pass. Box: 843; Console: 588 with three existing TODOs;
database: 384. Whole touched-package typechecks, generated API contracts,
changed-file lint, POS/Console/agent/display builds, Bash syntax and the CI
ShellCheck error gate pass. The 0099 snapshot changes only nullable
core.box.bridge_origin; the SQL is one additive ALTER.

The existing benefit source inventory timed out twice while parsing every
file. The fix applies the identical guarded-name predicate first and parses
only candidate files; all files and final runtime assertions remain covered.
The guard pins now exercise every forbidden name in declarations, variable
reads, member reads and destructuring. Scan time fell from 7.9 to 2.2 seconds.
The full suite then passed with its original five-second test limit.

## Adversarial and native rehearsal

A HIGH hostname finding reproduced a trailing-DNS-dot localhost bypass;
normalizing the DNS hostname fixes it, with a retained regression pin.
Two HIGH display pins reproduced F&B/Shop disabling publication after
offline unlock. Configured local bridges now keep those publishers active,
while locks, captured-price validation, redaction and tender restrictions
remain. Till-calculated estimates are still refused by the display boundary.

[local-rehearsal.json](local-rehearsal.json) records the complete real Edge
browser and real bundled-agent journey on candidate 2c48b966, against a
disposable local API/database: Console configuration; platform cash on both
POS paths; token-only refusal and password unlock with both WAN paths cut;
customer answer; quoted offline order; cold agent/browser and empty HTTP
cache with zero external page requests; version mismatch refusal/recovery;
QR-disabled sentence; box cash receipt; reconnect to the same finalised sale
with zero quarantine; revocation, archive and sign-out. The database was
removed. That is local evidence, not a staging or physical-device claim.

HTTP tests cover redaction, missing assets/traversal, Host/Origin refusal,
forbidden staff/tender routes and thirty disconnects with zero subscribers.
Real API/database unknown-success tests retain one sale, one cash attempt
and one receipt after both lost commit and lost finalise responses.

Real Caddy 2.11.7 with dns.providers.cloudflare validated the Caddyfile with
synthetic input on Windows. Installer behavior tests exercise hostile and
duplicate input, data-only environment parsing and idempotent origin append.
No real DNS token, certificate, Linux service or Pi installer was used.

See [bench procedure, production key checklist and rollback](../../../ops/BOX_BRIDGE_BENCH.md).

## Online local-display follow-up

The initial source d0e32637fe851791594b35486ab9cee24ea59062 passed all six jobs
in [CI 41510251539](https://github.com/vickyydev/oto-platform/actions/runs/41510251539).
An extra native online check then found the local display lacked a box session.
A normal successful platform unlock now starts one bounded local request using
the existing shift token and entered password. Online access does not wait on
the box, and no password is saved. Late replies cannot revive a session after
lock, sign-out, station change or timeout. Local publication continues without
a cloud connected-screen record. Setup uses the normal lock/unlock once after
picking a newly configured station.

Three late-reply cases and the one-minute empty-cloud-presence case reproduced
red before correction. Full POS now passes 1,659 tests; all seven built native
journeys, whole POS/Console types, touched lint and builds pass. The full real
agent/browser rehearsal passed again, now also proving online unlock connects
the display before the outage. Its exact local build and checks are retained in
[local-followup-checks.json](local-followup-checks.json). Final source CI and
staging proof follow; physical bench acceptance remains open.
