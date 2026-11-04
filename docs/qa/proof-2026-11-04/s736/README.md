# SCRUM-736 scanner delivery

In Progress. Native local and staging proof, full gates and main landing are pending.

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
