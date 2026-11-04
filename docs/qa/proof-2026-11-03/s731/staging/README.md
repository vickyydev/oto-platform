# SCRUM-731 staging proof: a wristband read by the box opens what a typed code opens

Run on 4 November 2026 between 08:48 and 09:08 Bangkok on live commit
3f60a2bf3dbad3c7037e62c7d46f24258cfcb1a5 (oto-api-staging, oto-pos-web-staging and
oto-pos-staging, live from 08:37), in the POS at oto-pos-web-staging, in a real browser.
Signed in as the staging reception account (Som) at the till "ZZ TEST SCRUM-731 mw1gk7c6
till 2" (prefix Z8D) on Virtual box 1, the box the api process runs, so a scan reaches the
till. On a real Pi box no scan reaches the till until SCRUM-736 lands, and the cradle stays
in the iPad until then.

The child "ZZ TEST S731 Band Child" (allergy "ZZ TEST peanut allergy", restriction
"ZZ TEST no dairy", no food authorised) was registered, sold a drop-off in cash (Z8D-000001,
฿1,115) and checked in. The band printed on a ZZ TEST simulated band printer on Virtual box 1;
its QR was read from the printer's own preview, as a scanner reads paper. A ZZ TEST credit
voucher (Eat & Play Kids Pass, one adult, cash, ฿350) was sold at the first ZZ TEST till.
Every scan went through `POST /stations/<till>/scan/simulate` in `hid` mode: the simulator
feeds the code as key events through the reader the real DS2278 goes through. The band code
and the voucher code never left the proof's scratch folder: no file here holds either, and
the voucher code is hidden in picture 04.

| Plan step | Result | Evidence |
|---|---|---|
| 5. F&B first screen, band scanned: allergy alert, restriction, food not authorised | Pass | `s731-01-fnb-band-read-opens-the-order.png` |
| 5. Cleared, short code Z8D-VJWJRA typed: the same screen | Pass | `s731-02-fnb-typed-short-code-same-screen.png` |
| 6. Credit voucher on the open order: "Credit voucher not opened", order unchanged | Pass | `s731-03-fnb-voucher-on-open-order-changes-nothing.png` |
| 7. Credit voucher on the F&B first screen: its tab with ฿350 credit | Pass (code hidden) | `s731-04-fnb-voucher-opens-its-tab-with-credit.png` |
| 8. Shop first screen, band scanned: the sale on the child's tab | Pass | `s731-05-shop-band-read-opens-the-sale.png` |
| 9. Shop at payment, band scanned: "Wristband Z8D-VJWJRA not opened / Finish this sale first. Nothing changed." Charge ฿50 before and after | Pass | `s731-06-shop-band-at-payment-changes-nothing.png` |
| 10. History list, band scanned: its code, its credit, its drop-off order | Pass | `s731-07-history-band-read-opens-its-orders.png` |
| 11. History with the sale open: "go back first", the sale stays | Pass | `s731-08-history-sale-open-band-says-go-back.png` |
| 11. Credit voucher at History: "That is a credit voucher, not a bracelet" | Pass | `s731-09-history-credit-voucher-is-not-a-bracelet.png` |
| 12. Add time, bracelet unticked, band scanned: ticked, "Bracelet Z8D-VJWJRA added" | Pass | `s731-10-add-time-band-read-is-ticked.png` |
| 12. Add time at payment, band scanned: "already set for payment. Nothing changed." | Pass | `s731-11-add-time-at-payment-changes-nothing.png` |
| 13. Ticket till with a walk-in ticket on the order: band and voucher each say where they go; the order is unchanged | Pass | `s731-12-…`, `s731-13-…` |
| 14. Locked, band scanned from a second session (heard by the box: band, handled), unlocked: nothing landed | Pass | `s731-14-locked-scan-heard-by-the-box.png`, `s731-15-after-unlock-nothing-landed.png` |
| 15. iPad: the wristband field, tapped, asks for a text keyboard (`inputmode="text"`, `autocapitalize="characters"`) | Pass in an iPad Pro 11 emulation; the real iOS keyboard is for the bench | `s731-16-ipad-wristband-field-full-keyboard.png` (raw: `-tapped-raw.png`) |
| Set-up 4. A queued `scanner.scan` carrying the voucher: 409 SIMULATOR_ACTION_CARRIES_SECRET, nothing queued, the code absent from the command list | Pass | `s731-17-queued-voucher-scan-refused.png` |

Every scan answer is in `staging-fixture.json` (`walk.a` to `walk.d`), by kind, outcome and
handler only: each band scan `band / handled / band`, each voucher scan `wallet / handled /
wallet-qr`.

## Finding: a band short code typed at F&B on a till with a four-character prefix

The first ZZ TEST till had the prefix ZI7C. Its band scanned correctly
(`s731-finding-first-till-band-read-opens-the-order.png`), but its short code ZI7C-QV8QZ8,
typed at F&B, opened a guest order with "Invalid code ZI7CQV8QZ8"
(`s731-finding-fnb-typed-short-code-of-a-four-character-till-read-as-voucher.png`). Without
its dash the code is ten characters, two of any letter or digit and eight of the booth
alphabet, which is the shape of a legacy Lucky Wheel voucher code. F&B's band field hands any
value of that shape to the voucher path before the band lookup (`OrderStation.tsx`,
`onSubmitCapture`, from S2-10b). A scan is not affected: it reaches the form by another path.
The park's tills use two- and three-character prefixes (T1, T2, PI1, PI2), whose short codes
are eight or nine characters, so they are not affected today. A till given a four-character
prefix whose last two characters are in the booth alphabet (no 0, 1, I, L, O or U) would be,
for every band; a five-character prefix of that kind, for about one band in 37 (when the
check character happens to fit). This predates
SCRUM-731 and was not changed here. The proof was rerun on a ZZ TEST till with the
three-character prefix Z8D. The first till's run is kept in `staging-fixture.json`
(`firstTill`).

## Clean-up, read back at 09:08

- Voided (exact ids, after reading they were unpaid and on this till): the Add time charge
  (฿60) and the shop guest sale (฿50) left at "till 2".
- Both children, "ZZ TEST S731 Scan Child" (first till) and "ZZ TEST S731 Band Child", went
  out through the normal pick-up release, dropper-off collecting, with a synthetic pick-up
  picture that shows no person. Both read `out`.
- Archived: both ZZ TEST tills, the ZZ TEST simulated band printer (assigned to no station
  when archived), the ZZ TEST shop item and its category.
- Kept for the record, as on other proofs: the three paid sales (ZI7C-000001, ZI7C-000002,
  Z8D-000001), their bands and registrations, the ฿350 voucher's wallet and the audit rows.
- Untouched, read back: Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1. No box
  release, no setting and no SMS. Every session the proof opened was signed out.

## Jira

The 17 pictures are attached to SCRUM-731 and shown inside comment 13382
(`jira-publication.json`, wording in `jira-proof-comment.txt`). `jira.mjs walk` moved the
ticket to Deployed and linked 5 commits; a fresh read says Deployed, never Done.

The proof's scripts are under `scripts/` as `.mjs.txt`. They read sign-ins from the
environment and keep the band and voucher codes in a scratch file outside the repository.
