# SCRUM-854 After a left-unpaid sale is voided from the voucher refusal, its own left-unpaid notice goes too

Both tills were live at 9ca26f4d4499fb8a9a2933249d2673b7fc96df58 (oto-pos-staging dep-dbq9vs0n74is73cip1jg from 17:04:48Z, oto-pos-web-staging dep-dbq9vs95efls738cppp0 from 17:06:48Z, both read live again at 17:24Z). The till was loaded in a new browser profile (bundle index-BvRFNP6d.js). Main CI 43064423930 was still running; it was not waited for.

Two accounts at one own ZZ TEST till on the virtual box, as test C1 of apps/pos/e2e/voucher.spec.ts does on the test system: the reception-type ZZ TEST login, then the staging administrator on the same screen. The voucher was issued through the API as the administrator, the way that spec does: a ZZ TEST voucher type ("ZZ TEST SCRUM-854 150 THB Voucher", 150 baht off a ticket order) and a ZZ TEST campaign of one code. The harness is ../../SCRUM-853/staging/proof.mjs and flow.mjs (`node proof.mjs <sha> <out> 854`).

| Step | Result | What the screen read |
|---|---|---|
| a. first account rings up and leaves | Pass | 1 Hour Play, one child and one adult, the voucher on the order, "Pay ฿890" pressed: Amount Due "฿890", the sale saved unpaid (tendering). Lock, then "Sign out and hand over the till": the first account's session read 401 and the sale was still unpaid. |
| b. second account at the same till | Pass | The till opened at the same station without asking. In the order panel, one notice (count 1): "A sale rung up at this till was left unpaid — Unpaid sale at ZZ TEST SCRUM-854 proof till … · rung up 12 Nov 2026 00:23 · ฿890", with "Void that unpaid sale". |
| c. a ticket, and the same voucher | Pass | Refusal: "This voucher is on a sale already rung up at ZZ TEST SCRUM-854 proof till … — pay or void that sale first", the unpaid sale inside it with "Void that unpaid sale and use the voucher here". The left-unpaid notice is under it (count 1). No voucher card; the sale still unpaid. |
| d. "Void that unpaid sale and use the voucher here" | Pass | The voucher card is on the order (−฿150, Total ฿890), the refusal is gone (count 0), and the left-unpaid notice is gone: count 1 before the press, 0 after, still 0 after 2.5 s; the words "rung up at this till was left unpaid" are 0 times on the page. |
| e. read back | Pass | The left sale reads voided, reason "Rung up and left unpaid; voided at the till to use its voucher on a new sale". Cancel on the new order: no sale written; the voucher reads issued (unused). |

Pictures, all opened and inspected: SCRUM-854-a (the first account's unpaid sale), SCRUM-854-b (the notice as the second account's till opens), SCRUM-854-c (the refusal and the notice together), SCRUM-854-d (the voucher on, both gone). The staff identity, the voucher entry and the voucher's code lines are covered with boxes; no page text was changed.

Four runs. The first three stopped in the harness, not in the till: the first read the first account's session in the instant the lock screen appeared (the till ends it just behind the screen); the second and third pressed the header button that carries the station's name, which opens the station picker, where the till had in fact opened straight at its station. Each stopped run left its unpaid sale to the clean-up, which voided it. The fourth is the proof.

Clean-up, read back: the four unpaid sales are voided (three by the clean-up, the proof's by the press in step d); the four tills are archived with no devices; the voucher type is archived and out of the live list; both accounts' sessions read 401 after sign-out; the test number has no member. Left as records: four ZZ TEST campaigns of one code each, the codes unused and kept nowhere (there is no call that voids a campaign or a code; they expire in 14 days).
