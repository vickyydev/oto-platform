# SCRUM-736 scanner delivery

In Progress. Source 936cfbbe3f9062d955d3afdbdae26f38bfaeff89 is pushed on
lane/codex-box-scanner-20261104-r2. Staging proof, full gates and main landing
are pending. SCRUM-674/672 holds the source/API/proof slot.

The till hears the authenticated box staff channel directly and keeps the platform
channel for online compatibility. One scanId identifies both copies. A new scan
of the same code gets a new identity. Hidden and stopped listeners do not act.
The cloud relay checks the box credential and current station ownership, is
bounded to eight concurrent two-second calls, and has no disk queue or retry.
A till that unlocked while the box was unreachable needs a fresh password unlock
to establish its box session before direct offline use; no password is retained.

Initial review: six POS cases failed before the direct listener was added; seven
now pass. The combined POS channel/recovery set passes 78 cases. The agent/router
set passes 28, including a real SQLite agent with an unreachable platform and a
slow relay. Seven real API/database cases pass ownership, duplicate, archive,
shape/size and credential-storage controls. Types and touched-file lint pass.

An initial API typecheck rejected send() for a null 204 response; send(null)
corrected it. An initial agent test used a nonexistent outbox helper; it now
checks the actual store depth. The old polling exact-field pin rejected the
new scanId; its exact field list and UUID assertion were updated deliberately,
without dropping the raw-code privacy pin. These are not full acceptance receipts.

Real park Pi/DS2278 HID and CDC acceptance remains for the owner after installing
the next release and moving the cradle. No park device or real address is used.

The real local runner, SQLite store, HTTP bridge and built POS passed all six
requested native cases: wristband, credit voucher and booking QR, online and
with both the browser's platform requests and the agent's cloud transport cut.
The scanner input uses the actual HID burst and CDC record readers. No fake
scan event is injected into the page. See local/core-result.json. The test
database was dropped and its runner, browser, proxy and forwarder stopped.

An extended run also passes wristbands at the shop, online and offline, and
History online. Its last case fails honestly: offline History hears the scan
and opens its lookup view, but that existing view requires the platform and
says it cannot look up the bracelet. The failure and its screenshot are retained
under local/extended, alongside nine opened success images. Voucher keys are
masked at capture. No cached History behavior has been added.

Q736-1 (owner approval pending): temporary staging test settings. A read-only
census found the API's two bridge-zone/test-loopback keys absent among 57 names
and the corresponding two POS build-time keys absent among four. The prepared
single-key procedure adds only those four keys for a local test agent, then
restores all original fingerprints and counts: API 57 to 59 to 57; POS 4 to 6
to 4. The signing key and BOX_AGENT_TEST_SLOT are untouched. No setting has
been written. The owner was asked because the current authorization explicitly
excludes a new setting. Full gates continue independently.

Q736-2 (owner scope decision pending): keep delivery as this unit and record
offline History as a follow-up, or expand the unit to define cached History.
History.tsx openBand calls the platform-only lookupSales route. Substituting
partial local records needs a rule for what incomplete history should show.
The failed extra walkthrough is not a pass and is not removed or weakened.

Build, workspace typechecks, lint (zero errors, eight inherited warnings),
API contract generation check and tool checks passed on this source. The first
full API/workspace/browser batch was interrupted with process startup and
database connection failures and no completion receipts; it is not counted.
All three whole API shards are running again. Workspace tests and the normal
POS/Console browser batteries still need completed receipts. Early native
harness runs corrected phone formatting, an encoded label and handling of the
deliberately failed cloud request; none required a product change.

The lower credit offered offline follows the existing wallet spending cap;
this unit changes scan delivery, not credit limits. Product-barcode catalog
resolution on a standalone box is not covered by these native cases: its
product handler is currently installed by the API's in-process registration.
No physical device, private HTTPS or printer acceptance is claimed.
