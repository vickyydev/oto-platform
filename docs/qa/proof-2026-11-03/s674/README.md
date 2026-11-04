# SCRUM-674 staging proof: the Console's Support page finds gate events, vouchers and OTO App records

Run on 4 November 2026 between 15:57 and 16:32 Bangkok on live commit
4fa1762860ec468eefc658fbf6b7356c21f9fd45 (oto-api-staging, oto-console-staging, oto-pos-web-staging and
oto-app-staging all live on it), in a real browser, with ZZ TEST records only and cash only. No SMS was sent, no
setting was changed, nothing was deployed or restarted by hand, and no park device (the Pi, its tills or the
FortuneWheel box) was used. The record of every step is `staging-fixture.json`; the scripts that drove the browser
and the one-off jobs are under `scripts/`. No voucher code, wallet QR or password is in any file here, and the
voucher codes and wallet QR codes are painted over in the pictures.

Fixtures (Oto Play Park, Central Floresta): till "ZZ TEST SCRUM-674 mw1vxv8u till" (prefix Z3) on Virtual box 1; voucher
type "ZZ TEST SCRUM-674 mw1vxv8u 20 baht off"; two vouchers issued at that till by the staging reception account; a
walk-in ticket (1 child, 1 adult) sold for 1,020 baht cash with one voucher, receipt Z3-000001, bands Z3-ENP9EH
(adult) and Z3-B6CVZM (child). Staging has no gate that can send a passage, so three passages for the adult band
(entry 09:07:20Z, refused ANTI_PASSBACK 09:07:54Z, exit 09:08:54Z) were written by a checked one-off job against
"ZZ TEST SCRUM-674 mw1vxv8u gate lane" on an unclaimed ZZ TEST gate box that no agent runs, each marked
`detail.zzTest`. Two OTO App staff records (employment LEFT, so the employee copy never copies them) share the ZZ TEST
phone +66896740001, one at Central Floresta and one at Robinson Chalong. Two ZZ TEST Console users were written
invited by a one-off job (the create route would send a set-up SMS), then given, through the Console's own routes,
the support role operator-wide, an OTO App user at Central Floresta only (manager / staff) and a temporary password,
which each changed at first sign-in.

| Plan step | Result | Evidence |
|---|---|---|
| (a) A band that passed the gate: Gate events found with time, kind, direction, lane and park, no signed code | Pass | `s674-a1-band-gate-events-found.png`, `s674-a1-band-gate-events-whole-answer.png` |
| (a) A short code with no passages: Gate events empty | Pass | `s674-a2-band-no-passages-whole-answer.png`, `s674-a2-band-no-passages-empty.png` |
| (b) Voucher by its grouped on-screen form: status, worth, park, last four, no staff name | Pass (input masked) | `s674-b1-voucher-issued-found.png` |
| (b) A made-up code: empty, with the note that park promo codes are not searched | Pass | `s674-b2-made-up-code-empty-with-note.png` |
| (b) The redeemed one: also where and the receipt (Z3-000001) | Pass (input masked) | `s674-b3-voucher-redeemed-where-and-receipt.png` |
| (c) Ten made-up codes searched in the Console, then the voucher redeemed at the ZZ TEST till: taken the first time, no lock, no miss count | Pass; `promo.voucher_miss` read 0 rows for the admin and for the till | `s674-c1-tenth-made-up-code.png`, `s674-c2-till-takes-the-voucher-first-time.png`, `s674-c3-till-payment-step.png`, `s674-c4-till-sale-paid-voucher-used.png` |
| (d) Phone, admin: OTO App records found at both parks, names shown | Pass | `s674-d1-admin-oto-app-records.png`, `s674-d1-admin-whole-answer.png` |
| (d) Without admin:audit:read_sensitive: names masked; a one-park manager sees only that park | Pass (one record, Central Floresta, Masked) | `s674-d2-park-manager-masked-whole-answer.png`, `s674-d2-park-manager-masked-oto-app-records.png` |
| (d) An account the OTO App refuses: denied in the app's own sentence ("Insufficient permissions") | Pass | `s674-d3-staff-level-refused-oto-app-records.png`, `s674-d3-staff-level-refused-whole-answer.png` |
| (e) One console.support.lookup row per search, kinds and sections, no searched value; the OTO App search's auth.handoff_issue row | Pass: 15 rows for the admin's 15 searches; the manager's row and its hand-off rows share one request id | `s674-e1-activity-park-manager-lookup-and-handoff-rows.png`, `s674-e2-activity-one-lookup-row-for-one-search.png`, `s674-e3-lookup-row-opened-kinds-no-value.png` |

Noticed, not changed:

- The Activity page's Data access preset does not list `console.support.lookup` (or `console.support.trace`) rows
  (`s674-finding-data-access-preset-misses-support-lookups.png`). They are written with `after.category =
  'data_access'` but no `category` column, and `DATA_ACCESS_ACTIONS` in `apps/api/src/routes/audit.ts` does not name
  them. Pre-existing since SCRUM-648; the rows show under Everything. A one-line follow-up adds both actions there.
- A voucher issued at a till reads "Counter (station not recorded)" as where it came from: `issueVoucherAtTill` does
  not store the issuing station. Pre-existing; the redemption side names the till.

Cleanup, read back from the database at 16:32 (`staging-fixture.json`, `cleanup`): both ZZ TEST accounts inactive with
no role, no app identity and no live session; their two employees archived; their OTO App users and branch access,
both OTO App staff records and the three passages deleted (each only after every foreign key read empty); voucher A
voided (no route voids an unused voucher), voucher B redeemed; the till, the gate lane, the gate box and the voucher
type archived. The paid ZZ TEST sale, its receipt, both bands, its 350 baht credit and every audit row stay for the
record, as with earlier proofs. Jira: comment 13449 with 13 images inline; `jira.mjs walk` read back Deployed.
