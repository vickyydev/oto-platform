# The Lucky Wheel booth — the plan to "ready for the bench"

_Written 2026-09-24 after the read-only audit (`AUDIT-2026-09-24.md`, same folder).
The owner's decisions of the same day are final and listed first. This file is
the brief every round of this work is cut from; the audit is the evidence._

## The owner's decisions (24 September 2026)

1. **The Pi is a real box beside the virtual box.** The virtual box stays for
   staging demos; a Raspberry Pi 5 must run the booth against the same staging
   api at the same time, each with its own booth. The Console shows both.
2. **Codes stay minted on the box**, so the booth prints with the mall's
   internet down. They are validated only against the cloud at the counter.
   This question is settled and is not raised again.
3. **Redemption is built now**, and the owner tests it with a typed code (no
   scanner yet). A voucher is **held** when scanned and **used up** when the
   sale is paid; removing the line or voiding the sale releases it. The value
   comes from the voucher type on the server, never from the till. A second
   scan answers who, when and where. Booth vouchers are online only.
4. **Switched-off prizes must not appear on the wheel.**
5. **Staff sign-in stays.** The Pi boots into a screen where staff pick the
   booth from the booths set up on that box and sign in — with their own
   account (phone and password, checked by the platform, only if the
   administrator assigned them to that booth and their role allows it) or with
   the booth PIN. The session lasts the booth's session length set by the
   administrator and never ends on idle. With nobody signed in the wheel still
   plays and the spin is flagged unattributed (spec §5).
6. **The Pi is plug-and-play** for staff: it boots, starts the agent and the
   TV page itself, and loads the published wheel. The owner tests it himself.
7. **Expiry per prize with "never" allowed; any branch may redeem; THB
   vouchers come off ticket lines, capped, no change, not combinable with
   another voucher or promo code** (member tier prices stay allowed — an
   assumption to confirm).
8. **The old four-digit codes** are imported and honoured once each when the
   Radar dump arrives; static QRs stop on the switch day.
9. **After the build: a full audit again**, with no hidden defect or
   loophole, then "ready", then the owner names the printer and connects the Pi.

## The rounds

Each round is a gated workflow on `claude-opus-5-5` (build → gate that
refutes → fix round if refused → commit by explicit file list → CI → staging
evidence → Jira). File ownership is disjoint inside a round.

| Round | Slice | Ticket | Owns | Delivers |
|---|---|---|---|---|
| 1 | **P1 — the Pi runs the booth box** | SCRUM-398 (S2-24a), SCRUM-399 (S2-07c), SCRUM-394, SCRUM-395, SCRUM-396 | `packages/box-agent`, `packages/print`, `packages/shared` (`booth.ts`, `permissions.ts`), `apps/booth`, the api's box-side staff verify route, `sync.ts`'s staff scope, `scripts/pi`, `docs/ops/PI_BOOTH.md` | `oto-box claim` and `oto-box run`; a loopback server serving the booth page and the `/booth/*` contract; the booth picker; sign-in by account (online, under the box credential) or PIN; a session of the admin-set length; reprint; the staff name on the slip; inactive prizes never on the wheel; printing to the real printer; the install script, systemd units and the owner's guide |
| 1 | **P2 — voucher redemption in the api** | SCRUM-207 (first half), SCRUM-397 | `apps/api` vouchers service and routes, `sale.ts`, migration 0021, `promo.ts`, `booth-code.ts` | lookup without consuming; hold, consume at payment, release; server-side pricing from the voucher type; exact messages; online only; a persisted guess throttle with an alert; an append-only redemption record; the check character |
| 2 | **P3 — the till** | SCRUM-207 (second half) | `apps/pos` ticket and F&B tills, the box's voucher classifier in `scan.ts` | the till hears the counter's scanner (box channel, and a USB scanner typing into the laptop), takes a typed code as the fallback, shows what to hand over or take off, puts it on the sale, pays; a voucher on an offline sale is refused |
| 2 | **P4 — the Console** | SCRUM-400 (S2-07d) | `apps/console` booth and voucher screens, `booth-admin.ts`, a migration for the session length and the wording | voucher types created and edited with links, wording in Thai and English, expiry or never, combinable; booth staff and PINs; the session length; the seeded types on staging linked |
| 3 | **P5 — the end-to-end proof and the closing audit** | all of the above | — | a real agent process on this machine as a box against staging: claim, pick the booth, sign in, spin, the voucher synced, redeemed once at the staging till by typed code, refused the second time; then an adversarial audit of the whole path (open endpoints, replay, offline trust, guessable codes, permission gaps, restarts, printer down, internet down, clock, two tills racing) and its fix round |

Then "ready" to the owner, the printer model, and the bench test of §5 of the
audit, this time with paper.

## The bench test the owner runs at the end

1. Console → Booths: prizes, chances, caps, expiry; Review and publish.
2. Console → Devices → Add a box (the Pi); claim on the TV or by `oto-box claim`.
3. Console → Devices → the Pi's box → add the receipt printer at its address.
4. Console → Booths: create the booth on the Pi's box; assign the staff; set the
   PIN and the session length.
5. The TV: pick the booth, sign in (account or PIN), press the red button — a
   slip comes out of the printer.
6. The staging POS on a laptop: type the code — the till shows the prize or the
   discount and puts it on the sale; pay; type it again — "Already redeemed on
   … at … by …".
7. Pull the Pi's internet, spin, plug it back: the voucher arrives, and the
   counter redeems it.

## What stays open after this plan

Badge sign-in at the booth (SCRUM-218), discount QR batches for posters, the
booth report (SCRUM-216), the legacy import (the Radar dump), the TV layout
for a landscape screen, the credential throttle (SCRUM-385), the branch image
for the park (the rest of SCRUM-223).
