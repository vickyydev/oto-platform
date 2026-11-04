# SCRUM-747/746 staging proof: longer till codes show a payment QR, and a typed band code opens the child's F&B order

Run on 4 November 2026 between 17:31 and 17:47 Bangkok (10:31 to 10:47 UTC) on live commit
01b5b64daf9684940161ec62e526d2ebc3592c0e. `preflight.json` read oto-api-staging, oto-pos-web-staging and
oto-pos-staging all live on that commit (from 17:24 to 17:27), main CI 41810103161 green on it (all six jobs), the
gateway read back as the simulator (a yes/no check, no value printed) and the API's 57 setting names unchanged. A
real Edge browser drove the staging Console and POS; reception signed in on the tills, the administrator made the
fixtures and pressed the simulator's paid event. ZZ TEST records only, simulator only, no SMS, no setting changed,
nothing deployed or restarted by hand, no park device (the Pi, its tills, FWBooth1/FortuneWheelBox) touched. Every
image below was opened and read before it was used. The record of every step is `receipt.json`; the scripts are
under `harness/`. No voucher code, claim code, phone or password is in any file here; the one issued voucher code
is painted over in its picture.

Fixtures (Oto Play Park, Central Floresta): box "ZZ TEST SCRUM-747 mw1ze0to virtual box" (role virtual, slot
zz-test-s747-mw1ze0to, never claimed, so nothing ran it); tills "ZZ TEST SCRUM-747 mw1ze0to four" (code ZQ7C) and
"ZZ TEST SCRUM-747 mw1ze0to six" (code ZZ747A) on it, QR to the gateway, card manual, both Ready for selling. ZI7C,
the plan's example four-character code, is already used on staging by a live SCRUM-731 till, so ZQ7C was chosen:
its third and fourth characters are in the voucher alphabet, so its band code has the old voucher shape that
SCRUM-746 is about.

| Plan step | Result | Evidence |
|---|---|---|
| 1. Console: ZZ TEST box and two tills, codes four and six characters, read back | Pass: ZQ7C and ZZ747A saved, Ready for selling | `s747-01-console-tills-four-and-six-character-codes.png`, `receipt.json` fixture.readback |
| 2. SCRUM-747: six-character till, PromptPay, Show payment QR, on the till and the customer display, no internal error | Pass: invoice SBX0AX261104000001 (prefix SBX, segment 0AX, 261104, 000001), provider simulator, 25 baht F&B guest order (one bottled water) | `s747-02-six-character-till-gateway-qr-till-and-customer-display.png` |
| 2. Simulator paid | Pass: Order Confirmed, receipt ZZ747A-000001, sale finalised, attempt approved | `s747-03-six-character-till-paid-through-simulator.png` |
| 2. Again on the four-character till | Pass: SBXCUJ261104000001 (segment CUJ), simulator, approved (the 890 baht ticket of step 4) | `receipt.json` fixture.family.attempt, dbReadback |
| 3. Park tills unchanged (read only) | Pass: the live code computes T01, T02, PI1, PI2 for T1, T2, PI1, PI2 (and null for a seven-character code); newest staging invoices SBXPI1261029000003 and SBXPI2261030000003 keep PI1/PI2; T1 has only card-terminal numbers and T2 none, so the shared test is their pin | `receipt.json` dbReadback.park, parkSegments; finalReadback.liveSegments |
| 4. SCRUM-746: ZZ TEST child, ticket on the four-character till, checked in; band code typed with its dash at F&B | Pass: ZQ7C-A3H6QK typed, Load Tab opened the child's order and the customer display greeted the child; no "Invalid code"; zero voucher requests (the lookup went to /api/wallets/scan) | `s746-01-four-character-till-band-code-typed-with-dash.png`, `s746-02-four-character-till-child-order-opens.png`, `receipt.json` steps.typedBand |
| 5. Regression: a real ZZ TEST voucher typed into the same field opens its tab, held, then let go | Pass: POST /sales/:id/vouchers 200, Remove voucher shown, then released (DELETE 200) | `s746-03-genuine-voucher-typed-opens-its-tab-held.png` (code painted over) |
| 6. Clean-up and readback | Pass, see below | `receipt.json` cleanup, finalReadback |

The child's order shows "Food not authorized" because the ZZ TEST child was registered with no food permission
(no phone either, so no contact message could go out); the order is the child's.

The voucher type was fixed-code (free bottled water). Typing the fixed code at the till issued one voucher of its
own, printed by the signed-in reception account, and held it; Remove voucher released it, leaving it issued and
unused.

Open, as the ticket says and asked of the owner: a band code typed without its dash on a till whose code has four
or five characters is still decided by shape and can read as a voucher. Typing it with the dash, as printed, works.

Cleanup, read back at 17:46 by a read-only one-off job (`finalReadback`): the child picked up by the dropper-off
(a synthetic picture as the pickup photo) and out; the voucher type switched off and archived; its one issued voucher
voided by a checked one-off job (no route voids an unused voucher) with a qa.voucher.void audit row; both tills
signed out (/me 401), archived, zero live sessions, both station leases released; the box archived; zero pending
attempts, zero open sales, nothing held. The Console session signed out (/me 401). The two paid ZZ TEST sales
(ZZ747A-000001, 25 baht; ZQ7C-000001, 890 baht), their approved simulator attempts and the child's band stay as
records, as with earlier proofs.

Jira: SCRUM-747 comment 13459 (3 images inline) and SCRUM-746 comment 13460 (4 images inline), checked by attachment
id (`jira-render-check.json`); `jira.mjs walk` moved both to Deployed with 3 commit links each and a fresh read says
Deployed, never Done (`jira-publication.json`).
