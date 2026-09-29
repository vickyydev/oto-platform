# SCRUM-201 separate display checkpoint

29 September 2026. Online ticket identification slice checked; full story remains In Progress. This checkpoint
uses local disposable-database evidence, not staging acceptance.

## Implemented contract

The browser at `/display` generates its own 256-bit credential, sends it
only in the Authorization header and stores it under its own display key.
Only hashes are kept on the platform. A ten-minute six-digit code is shown
once, rotated on request and consumed by a permitted manager's Console claim.
Credential responses are excluded from stored idempotency replies and logs.
Station and code locks plus the active-display index settle concurrent claims.
Revocation writes `display.revoked` and live reads recheck device scope,
operator, park and station. Credentials survive staff lock and sign-out.

Existing shared names stay intact: `StationSessionDocument`,
`StationIntent`, `actionId`, `lastSeenSequence` and `leaseId`.
The staff publisher holds its own lease. Display actions are lease-free,
stage-valid and fenced by prompt `requestId`; the box uses sequence CAS
for typed answers. A retry reuses its action and input. Out-of-order replies
cannot restore an older visitor. The first answer wins for each prompt.
The display sees a redacted document without staff lease or medical records.
Finite polling currently uses the cloud API and existing virtual box; it
does not establish the physical box's LAN/offline transport.

Staff lock retains the desktop ticket visitor, but unmounts child surfaces,
portals and toasts. Scans, quotes, publishing and payment work pause. Unlock
reads the authoritative answer before publishing. Sign-out or a context
change discards the visitor, while the display remains paired. Shell updates
wait while a retained visitor or connected display prompt is in use.

## Local browser evidence

The native POS and Console ran against a fresh migrated and seeded database.
Three isolated browser contexts exercised manager, staff and display roles.
No trading or physical hardware was used in this identification proof.

- Fresh display setup without staff login; pairing code masked in evidence.
- Console claims the actual code for Reception Till 1.
- Display at 1024 by 768 and staff at 1280 by 800 have no horizontal overflow.
- Reload retains the independently paired device.
- All five display languages persist across reload; staff remains English.
- A visitor identifies while staff are locked and the reply is deliberately
  dropped after server acceptance; unlock opens the seeded member's children.
- Lock removes the staff dialog; unlock restores the same visitor.
- Authoritative polling clears the uncertain-reply message.
- Staff lock and sign-out do not require the display to sign in again.
- Console revocation returns the display to setup on the next polling cycle.

Validation: **328 affected existing-file tests pass** (API 130, database 28,
box station 24, POS scan/display 40, payment writer 64, till voucher 40 and
Console browser controls 2). Eleven additional native browser checks pass.
All five touched packages pass typecheck and full lint; POS and Console
production builds pass. Fresh/repeat migrations and schema verification match
0031. Independent review found a queued-payment lock race; its final fence
and existing-file regression now pass. No new suite or dependency.
Six reviewed local screenshots are attached to SCRUM-201 as 10882-10887 and
named in the push comment. They do not justify Deployed.

Screenshots (all LOCAL CHECK, pairing and password fields masked):

- 01-local-display-setup.png (10882)
- 02-local-console-paired.png (10883)
- 03-local-till-member-found.png (10884)
- 04-local-display-member-welcome.png (10885)
- 05-local-display-revoked.png (10886)
- 06-local-lock-hides-staff-details.png (10887)

The payment pause checks include a known pending attempt, a late start reply,
a late cash reply, an unreadable cash reply with the original retry action,
a true scope reset and a queued gesture paused before its first write.
No collection runs merely because staff unlock.


## Remaining acceptance

The story is NOT BUILT as a whole. Preserve these boundaries in Jira:

1. Publish canonical ticket cart lines, totals, payment and thank-you from
   the existing live sale, quote and payment controller. Keep money operations
   on the staff-authorised path. Then integrate F&B/shop displays separately.
2. Add typed consent, child-slot edits and completion with authoritative
   policy checks. Supervision steps 7/8 stay inline until that is proven.
3. Add Console Snapshot, Send test intent, Expire code now and clear revoked/
   last-rejected diagnostics, with matching Box-log evidence.
4. Remove unused staff-session pending-lookup compatibility only after all
   callers are checked. Applied migrations remain forward-only.
5. Complete the story's two-browser staging smoke, both layouts, failure
   cases and reviewed screenshots before moving SCRUM-201 to Deployed.

Requirements: SPRINT_2_PLAN S2-08; PLATFORM_PLAN section 6;
POS_RULES_RECONCILIATION R-54; DEVELOPMENT_PLAN separate-display sequence.
Full reload recovery of a visitor/cart and physical/offline display transport
are not established by this first slice.

## Release gate

Main has the prior checked payment follow-ups at fe9c683. GitHub Actions run
36565169997 stopped before any step because billing/spending availability
prevented jobs starting. Render still gates deployment on successful checks;
no bypass or billing change is made. Restore Actions, verify the exact release
SHA, then use one normal deployment and run staging proof. The retained
simulated partial payment remains untouched. Pending actions are saved in
docs/progress/OPEN_QUESTIONS.md.
