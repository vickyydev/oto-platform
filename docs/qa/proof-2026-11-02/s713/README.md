# SCRUM-713 first-stage evidence

Status: **Testing**. The software stage passed staging proof. Real iPad private
HTTPS access, a real certificate and real Pi acceptance remain bench work.

Source: `f3b793dcc35d296a03582d617a9a94a3b555da60`. All six jobs passed in
[CI 41515189496](https://github.com/vickyydev/oto-platform/actions/runs/41515189496).
The OTO App job's unrelated checks were skipped by its path gate on this follow-up;
its full suite passed in the initial source run below. [ci.json](ci.json) preserves
the exact job and step outcomes.

API, new POS, old POS and Console were live at that source before proof. Their
post-cleanup commit/deployment read-back is in [live-commits.json](live-commits.json).
The real local agent was built cleanly as `oto-box 0.1.0-20261102-f3b793dc built 2026-11-02T20:00:39.735Z`.

The real Edge browser and actual agent proof ran from 2026-11-02T20:35:14.003Z
to 2026-11-02T20:38:09.486Z. [The full receipt](proof-mvzpx429.json)
records each assertion and its time. The inspected staging card is
[s713-staging-proof.png](s713-staging-proof.png).

## Staging outcome

- The real Console saved the dedicated ZZ TEST counter's bridge address, and
  both station selections returned it. The public staff key reached the agent.
- One synthetic cash sale on each POS address stayed on the platform. A normal
  online unlock also connected the local customer display.
- With browser API access and agent WAN cut, the token alone was refused and
  the native till unlocked with token **and password**. A synthetic customer
  reply reached the till and its captured order reached the local display.
- The real agent and browser restarted with the HTTP asset cache empty. Pairing
  remained and the display loaded with zero external page requests. A different
  page/agent version refused to start; matching versions recovered.
- The unavailable QR tender showed its box refusal. Synthetic cash sealed
  receipt `Z713-000003` for sale `01a19dfa-d28b-7e4c-8593-8e373c61ac90`.
  Reconnect drained the queue with zero quarantine.
- The independent read-only database job job-dbkf9ooae00c73cir98g found one finalised sale,
  one approved cash attempt, one receipt number and zero sync anomalies.
  [database-proof.json](database-proof.json) records the counts and public-key
  fingerprint. No real electronic payment was taken.

## Settings and cleanup

Only STAFF_TOKEN_PRIVATE_KEY and temporary BOX_BRIDGE_ALLOW_LOOPBACK were added
through individual named-key writes after private reads. The API count went
57 → 59; every prior value was byte-identical.
The loopback flag was then removed, 59 → 58,
with all remaining values byte-identical and the same source redeployed.
Routed health passed at 2026-11-02T20:44:07.120Z. The signing key remains;
STAFF_OFFLINE_SIGN_IN stays off and BOX_AGENT_TEST_SLOT is preserved for 722.
The API proof window is closed. See [enable](env-enable.json) and
[cleanup](env-restore.json) receipts; these contain names/fingerprints, never values.

The exact ZZ TEST box and station are archived, its bridge address is cleared,
the paired display is revoked and the staff sessions are signed out. Native
cleanup completed at 2026-11-02T20:38:08.974Z; the independent database read confirms
those records. Synthetic financial audit rows remain.

Automatic approval review rejected deletion of the local proof-agent cache and excluded full-page Console capture with only "blocked by policy". Those files remain outside Git; the staging fixture and sessions are retired. See [local-cleanup.json](local-cleanup.json). No park Pi, iPad,
production, old-site setting or new Render service was changed.

## Remaining bench acceptance and way back

The proof used Windows loopback. It does not prove a real iPad reaching private
HTTPS, certificate issuance/renewal, router DNS, local-network permission,
physical power loss, Linux installation or a real printer. The dark installer
has not run on a Pi. Follow [BOX_BRIDGE_BENCH.md](../../../ops/BOX_BRIDGE_BENCH.md)
for the domain/DNS preparation, production key list, acceptance and rollback.
Do not rotate or remove the signing key as a UI rollback; issued shifts depend
on it. This first stage stays Testing, not Deployed or Done.

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
[local-followup-checks.json](local-followup-checks.json). Final source CI and staging proof are recorded above; physical bench acceptance remains open.
