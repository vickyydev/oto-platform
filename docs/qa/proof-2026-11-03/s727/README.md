Historical first local checkpoint. Current evidence is in [the release report](../../proof-2026-11-02/s727/README.md).

# SCRUM-727 evidence

Status: **In Progress**. This is a local checkpoint, not staging acceptance.
Source `57e806045a761e0a246581c5c9b688e5fd2c655a` is committed locally and
has not been pushed. No source CI run or staging proof is claimed.

The real Edge browser, bundled Windows agent and disposable local API/database
rehearsal passed from 2026-11-03T06:44 to 06:47 UTC. [The receipt](local-browser.json)
records the exact source, agent version, fixture identities and checks:

- Saving an unrelated DNS name or literal IP was refused. The Console saved
  only a dedicated test hostname below the configured localhost test zone.
- The API delivered the existing public signing key and the OD-6 setting to
  the real agent. A normal online unlock sent one token-and-password request
  to that trusted host, with no retry.
- With browser API access and agent WAN cut, a token alone was refused and
  native password unlock with a valid token worked.
- Password-only sign-in returned the fresh-sign-in marker and its notice
  remained visible after unlock on desktop and mobile.
- A manager ended only this fixture's shift. After the real agent pulled the
  decision, both token-present and token-omitted attempts were refused.
- The bridge address was cleared, the exact ZZ TEST box and station archived,
  staff sessions signed out, the agent stopped and the local database removed.

The notice and refusal screenshots were opened. The first notice captures
contain page-transition fading; they prove the notice, not overall floor-flow
acceptance. Final staging captures remain to be made and inspected.
An additional session-lifecycle browser probe stopped while returning to the
till after a new sign-in; it is not counted as a pass and is being isolated.

Automatic approval review rejected deletion of the first disposable agent's
local cache with `blocked by policy`. [The cleanup record](local-cache-cleanup.json)
names that private directory outside Git. No staging data was used.

All five application builds, display build and bundled-agent build passed.
All 16 workspace typecheck tasks passed; lint has zero errors and eight
existing warnings; generated API contracts match. Both changed installers
pass Bash syntax and the ShellCheck error gate. Targeted real-agent session,
address, API trust, production-boot and installer checks passed.
The complete local API gate is still running. Its payment-provider production
fixture needs the newly required generated staff signing key. Concurrent
workspace tests also hit the existing box SQLite busy-time bound and a POS
display-holder timeout; these failures are retained and the affected complete
suites will run without competing load, with unchanged deadlines/assertions.
Shared tests passed 883; Console passed 588 with three existing TODOs.

SCRUM-726 holds staging source and API through 16:15 Bangkok or its exact
cleanup record. No code push, staging proof, API restart, Render change or
BOX_AGENT_TEST_SLOT change has been made. SCRUM-728 remains queued until 727
is Deployed with inspected and attached proof. No real box hostname, Pi,
certificate, physical printer, payment or SMS was involved.
