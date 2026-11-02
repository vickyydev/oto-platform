# SCRUM-710 staging result - 2 November 2026

**Testing. Speed acceptance is BROKEN on the canonical staging POS path. Do not mark Deployed from this evidence.**

Source: [ab528a549f22fb9d204b4c7404c9deb36b6e0c94](https://github.com/vickyydev/oto-platform/commit/ab528a549f22fb9d204b4c7404c9deb36b6e0c94).
All six jobs passed in [CI 41405433935](https://github.com/vickyydev/oto-platform/actions/runs/41405433935).
POS deployed at 07:42:13 UTC and API at 07:45:03 UTC. Both attempts happened after those deployments.

The owner expressly kept the active park Pi and its existing Till 2 (test) unchanged. These checks used a newly created virtual box and station named **ZZ TEST SCRUM-710 display**, station `01a19afe-d88c-74d2-b7b9-7cdde25d43b8`, box `01a19afe-d33c-7ea1-b583-c525b9322da7`. Pairing and revocation used the native Console controls. No payment, SMS, member creation, booth or physical hardware operation occurred.

| Measurement | First attempt | Repeat | Required |
| --- | ---: | ---: | ---: |
| Customer phone answer to till snapshot | 1,241 ms | 1,709 ms | <500 ms |
| Till Add to order tap to customer snapshot | 2,191 ms | 2,230 ms | <500 ms |

Both directions used polling. Click timestamps and received snapshot timestamps used `Date.now()` in browser contexts on the same computer. Instrumentation recorded only timing, sequence, stage, cart kind/line count, answer type and transport; no bearer, cookie, pairing code or snapshot content was logged. The synthetic phone lookup returned no member. Adding French Fries changed only the draft; Charge was never pressed. Screenshots were taken after recording the timing, so screenshot settling waits are not included in it.

Connection recovery WORKS in both attempts: the order and total remained with Reconnecting at approximately 10 seconds; at approximately 20 seconds only the paused notice remained and the total was hidden; restoring the network recovered the order automatically. The repeat also verified that revocation returned the display to pairing and explicitly expired the replacement code.

The [transport diagnostic](s710-transport-diagnostic.json) used the unchanged staff stream, which shares `openChannel` with the new display route. A direct request to the live API received headers and its first chunk in 255 ms. Through the POS static proxy it received neither headers nor bytes within 3,000 ms. Direct warm health reads were 62-65 ms; POS-proxied health reads were 498-518 ms, and staff-session reads were 497-849 ms. This reproduces the buffering limitation already described in `apps/pos/src/lib/scanChannel.ts`. It is a diagnostic, not evidence that a browser can switch origins with its existing session.

**SCRUM-710-Q1:** Which approved streaming-capable, same-origin staging route or hostname should POS use? The Chat A brief says the staff channel remains unchanged and excludes SCRUM-713 hosting/DNS work. Direct cross-origin use would require additional hosting or authentication/CORS work; the existing staff session is an HttpOnly SameSite=Lax cookie. No alternate credential, cross-origin session, pairing change or hosting migration was introduced. File-edit permission is already authorized; the remaining dependency is the routing decision. Record that decision, implement the selected transport, run the affected gates and exact-SHA CI, then repeat native staging measurements before Deployed.

[Independent cleanup](s710-cleanup.json) at 08:00:50 UTC confirmed both test credentials revoked, zero active displays and no held station lease. The test virtual box/station remains for follow-up. The first harness timed out waiting for a hidden revoked row, but independent readback confirmed that its Console revocation had succeeded. The repeat fixed that harness wait and completed cleanup. Staff sessions signed out with HTTP 200.

Evidence:

- [Inspected evidence card](s710-staging-proof.png), explicitly labelled STAGING TIMING FAILED; Jira attachment **12219**, `s710-staging-proof.png`.
- [First timing receipt](s710-first-attempt.json) and [repeat receipt](s710-staging-proof.json); both failures retained.
- Native PNGs: `s710-order-till.png`, `s710-order-display.png`, `s710-phone-till.png`, `s710-phone-display.png`, `s710-offline-10s.png`, `s710-offline-20s.png`, `s710-recovered.png`, `s710-revoked.png`.
- Exact attachment copy: `docs/qa/jira-comments/attachments/SCRUM-710/s710-staging-proof.png`.

Local validation before the source push: API 5,992 passing tests (existing skips/TODOs unchanged), POS 1,559, box 763, shared 822, database 384, all other workspace package suites, 16 package typechecks, touched-file lint, API types and seam inventory, workspace build, seven built-till journeys and 357 built-Console journeys. The first Console run had a local sign-in navigation failure before assertions; the unchanged full rerun passed. No test or guard was weakened.
