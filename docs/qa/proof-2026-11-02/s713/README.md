# SCRUM-713 first-stage evidence

Status: local implementation; full release battery and staging proof pending.
No real iPad, certificate or Pi proof is claimed.

Local checks so far: 1,649 POS tests (122 files), 843 box tests, 588 Console
tests (three existing TODOs), seven built native-browser journeys, whole touched
package typechecks, generated API contract check and changed-file lint.
The first POS run had a five-second module-load timeout while concurrent work
was running; the entire suite passed with two workers and unchanged assertions.
The existing installer guard exposed CRLF checkout bytes; install.sh is now LF.
The initial serial API battery was stopped for the incoming SCRUM-723 rebase;
three isolated complete shards will replace it, without skipping any test.

Adversarial review: a HIGH trailing-DNS-dot bypass accepted localhost. without
the loopback flag. The finding was first recorded with it.fails, then reproduced
as one failing ordinary pin (17 other cases passing). Hostname classification
now removes the trailing dot before applying the same gate.

Real Caddy v2.11.7 with dns.providers.cloudflare validated the shipped Caddyfile
using synthetic input on Windows. This proves parsing/module provisioning only;
no DNS token, certificate, Linux service or Pi installer was used.
The installer behavior tests execute hostname/data parsing and setting append
logic, including injected text, duplicate settings and repeated installation.

The boxed display reuses the paired credential and redacted transport. Local
HTTP tests cover zero-cloud bootstrap, empty-cache assets, missing assets and
traversal, forged Host/Origin, rejected staff routes and tender intent, revocation
and thirty disconnects with zero subscribers. Unknown-success reconciliation
tests retain one sale, one cash attempt and one receipt for both lost commit
and lost finalise answers; no runtime money safeguard changed.

See [bench procedure and rollback](../../../ops/BOX_BRIDGE_BENCH.md).
