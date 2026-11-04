# SCRUM-736 staging proof: a scanner on the counter box reaches the till, online and with the platform unreachable

Run on 4 November 2026 between 18:51 and 19:15 Bangkok (11:51 to 12:15 UTC) on live commit
b8286644d37daa604caf761f32bac7614c5d3f92. Main CI 41818481483 passed all six jobs on that exact commit.
`receipt.json` holds every step; the scripts are under `harness/`. A real Microsoft Edge (156) drove the
staging POS (oto-pos-web-staging) and Console; a local box agent on this machine, built from the same commit,
was the counter box. ZZ TEST records only, cash and the payment simulator only, no SMS, no park device: the
park's Pi, Till 1 (Pi), Till 2 (test) and FWBooth1 were not touched. No phone, password, claim code, band code,
voucher code or booking QR is in any file here; the voucher code is painted over in its pictures. Every image
below was opened and read before it was used.

## Temporary settings (owner-approved for this proof only, 4 November)

Read first, names and counts only: oto-api-staging 57 settings, oto-pos-web-staging 4, none of the four test
keys present. Written one key per call: BOX_BRIDGE_ZONE and BOX_BRIDGE_ALLOW_LOOPBACK on the API (57 to 59),
VITE_BOX_BRIDGE_ZONE and VITE_BOX_BRIDGE_ALLOW_LOOPBACK on the POS web build (4 to 6), all localhost only; every
other setting read back byte-identical. Both services redeployed on the same commit (API dep-dblhock9v7es73a2eks0,
POS web dep-dblhodk9v7es73a2en4g, both live by 18:55). After the proof the four keys were deleted one per call,
the counts read back 57 and 4, every remaining setting matched its original fingerprint, and both services
redeployed on the same commit again (see `settings.json`). The signing key and BOX_AGENT_TEST_SLOT were not
touched. The only box address saved was a loopback test name on this machine (zz-test-s736.localhost), removed
at clean-up; no real box address was saved.

## Fixtures (Oto Play Park, Central Floresta)

- Login "ZZ TEST SCRUM-736 mw22ag5p staff", reception at this branch only. Made without SMS: a checked one-off
  job wrote the invited account with an audit row, the Console issued a temporary password, and the first
  sign-in changed it.
- Box "ZZ TEST SCRUM-736 mw22ag5p" (counter), claimed by the local agent, with a simulated receipt printer and
  a simulated band printer; till "ZZ TEST SCRUM-736 mw22ag5p till", code ZAH.
- A second till, "ZZ TEST SCRUM-736 mw22ag5p virtual till" (code Z22), on Virtual box 1, the box the api
  process runs, for the unchanged virtual path.
- A ZZ TEST child with "ZZ TEST peanut allergy", no phone, ticket paid in cash (ZAH-000001) and checked in;
  the band printed on the simulated band printer and its QR was read off the printout, as a scanner reads paper.
- A ZZ TEST credit voucher (Eat & Play Kids Pass, cash, ZAH-000002, ฿350 credit).
- A ZZ TEST booking (OTO-CL3W-029C) paid through the payment simulator.
- Two ZZ TEST shop items: a cap sold by its own barcode and socks whose sizes S and M each carry a barcode
  (in-store numbers starting with 2, never printed on a real product).

## How a scan was made

Each code was read by the box's own scanner readers, exactly as the DS2278 sends it: the keyboard-wedge burst
reader (HID) or the record reader (CDC), then delivered by the box's scanning service. "Link cut" means both
the box's platform link (its traffic went through a local proxy that then refused every connection) and every
platform request of the till's browser were cut; the box reported its link as down before the scan. Only the
counter network between the till and the box stayed up. The pictures of the two modes look the same because the
till behaves the same.

| Plan case | Online | Link cut | Evidence |
|---|---|---|---|
| 1. Printed band QR at F&B opens the band | Pass: allergy alert, the child's order | Pass, the same screen | `s736-online-band.png`, `s736-offline-band.png` |
| 2. The same band QR at the shop opens the band | Pass: the child's sale | Pass | `s736-online-shop-band.png`, `s736-offline-shop-band.png` |
| 3. Credit voucher QR reaches the till and applies | Pass: its tab with ฿350 credit | Pass: ฿300 credit, the existing offline spending cap | `s736-online-voucher.png`, `s736-offline-voucher.png` |
| 4. Booking QR opens the booking | Pass: Redeem Online Booking, OTO-CL3W-029C, Confirm & Issue ready | Pass | `s736-online-booking.png`, `s736-offline-booking.png` |
| 5. Band QR at History | Pass: #ZAH-WPDEKG, total spent ฿890, its order | The scan arrived and History opened its bracelet view, which says "No connection to the platform, so a bracelet cannot be looked up here." That is SCRUM-753, recorded, not counted here | `s736-online-history-band.png`, `s736-offline-history-band.png` |
| 6. Shop barcodes | Pass: cap (own barcode) one line, socks size M (size barcode) one line, an unknown barcode "Unknown barcode, Nothing was added to the sale"; total ฿120 | Pass, the same | `s736-online-shop-barcode-unknown.png`, `s736-online-shop-barcode.png`, `s736-offline-shop-barcode-unknown.png`, `s736-offline-shop-barcode.png` |
| 7. Every online case acts once | Pass: one opened record or one line per read, no "already open" message, and the platform scan tape (GET /stations/:id/scans) held exactly one entry per read, each with its own scanId (`receipt.json` cases.*.platformTape) | With the link cut nothing was relayed (no POST /box/v1/scans left the machine) | `receipt.json` |
| 8. Virtual box unchanged | Pass: a scanner-simulator read of the band sent from the Console session (POST /stations/:id/scan/simulate, keyboard-wedge mode) opened the band on the virtual-box till through the platform stream (stream answered 200, no poll); then, with the stream refused, the page polled the scan tape (4 polls) and the next read opened it again. The virtual-box till made no counter-network request | n/a | `s736-virtual-box-platform-channel-band.png`, `s736-virtual-box-poll-band.png` |

## Observation: one relayed copy was rate limited

The first online voucher run (11:59:17 to 11:59:27 UTC) opened the voucher on the till, but the platform scan
tape held no entry for it. Render's request log shows POST /box/v1/scans at 11:59:21.375 answered 429. The box
posts a relayed copy once and never retries it, by design, so that copy was dropped; the counter-network copy had
already reached the till. The proof's local box ran with 1-second heartbeat, command poll and sync intervals
(a real box heartbeats every 60 seconds), close to the per-box ceiling of 240 requests a minute that every box
route shares, the relay included. The rerun at 12:00:37 relayed in 61 ms and the tape held one entry; every
later online relay answered 204 in 61 to 119 ms (`receipt.json` relayLog, observations).

## Harness corrections during the run (no product change)

- Signing the administrator out of the launcher right after the Console hand-off also ended the Console
  session; the launcher session was kept until the end instead.
- A child of 6 needs drop-off at this branch (409 SERVICE_MISMATCH, nothing written); the ZZ TEST child was
  registered at 9, as other proofs do.

## Clean-up, read back

Through the routes a person uses: the child picked up by the dropper-off with a synthetic picture (no person
photographed) and read out; the booking redeemed at the ZZ TEST till so it no longer waits for today; both tills
signed out from the lock screen (/me 401); the local box stopped; both tills, both printers, the box (address
removed, disabled), both shop items and their category archived; the login made inactive with its only role
removed. Then one checked, audited one-off job (job-dblhv01srm7s73bfade0): the four bands of the proof's three
sales revoked (no physical band exists), the two tills' empty inactive working rows removed, the ZZ TEST employee
archived. Its read-only readback: zero live till or staff sessions, zero working rows, zero pending prints or
commands, zero live bands, zero open sales; login inactive, employee archived, no roles. The three paid ZZ TEST
sales (ZAH-000001, ZAH-000002 and the booking's), their approved cash and simulator payments, the voucher's and
the booking's wallet credit and the audit rows stay as records, as with earlier proofs. Virtual box 1 read back
online and unchanged. The Console and launcher sessions were signed out (/me 401). The local agent's home folder
was deleted.

After the settings were restored and both services were live again on the same commit (API 19:10:59, POS web
19:10:05; /health and /ready 200; the relay route answers 401 without a box credential), a separate read-only
job (job-dbli34bncjis73du17l0, 19:14:57) read back: both tills archived; the box disabled and archived with no
address and no secret; both printers archived; Virtual box 1 online, not archived, no address; the login inactive
with no role, no live session and its employee archived; zero till sessions, working rows, live bands, pending
commands or pending prints; three finalised sales; the child out; the booking redeemed; both shop items inactive
and archived (`receipt.json` finalReadback). A first attempt of that read-only job named a table wrongly and
stopped with nothing read.

## The park's Pi

This proof used a local agent as the counter box. The real DS2278 cradle on the park's Pi works this way only
after the next box release carrying this change is installed on it. With the staging settings now removed, a
staging or production till accepts no box address, so it hears a Pi only through the online relay; scans with
the internet down need a permanent box address zone the park controls (owner question Q736-3). An offline
History lookup is SCRUM-753.
