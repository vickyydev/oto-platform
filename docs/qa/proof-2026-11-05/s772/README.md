# SCRUM-772 The Thai rate approved by hand: staging proof

Run on 5 November 2026, 02:06-02:16 Bangkok (18:35 UTC deploy, first step 19:08 UTC), on the live
commit `d630b22c26b49d5e9eead06e4f5f068ca88733b9` (main CI run 41883798363 green on that SHA).
oto-api-staging, oto-pos-web-staging, oto-pos-staging and oto-console-staging were live on that
commit before and after the run (`live-before.json`, `live-after.json`). Nothing was deployed or
restarted during the run and no setting was read or changed.

A real Edge browser (Playwright, `channel: msedge`) in the Bangkok time zone: the till at 1600 wide,
the phone till at 390 wide, the Console at 1500 wide. ZZ TEST records only, cash only, no SMS. The
park's Pi, Till 1 (Pi), Till 2 (test), FWBooth1 and Reception Till 1 were not used.

## Set-up

- A till made for this run on Virtual box 1, "ZZ TEST SCRUM-772 mw2hnfyc till" (prefix Z772, no
  devices, card manual, no QR), made by the staging administrator in the Console's api.
- Four members made from that till, each at the tourist tier with no verification: "ZZ TEST Hand
  Approval 772", "ZZ TEST Other Reason 772", "ZZ TEST Cancel Path 772", "ZZ TEST Document Check 772".
- The till was signed in as the staging reception account, Som (Reception).

## What a person sees

| Plan step | Result | Screenshot |
| --- | --- | --- |
| 1. The member found: "No verified rate" | Pass | `s772-st-01-member-no-verified-rate.png` |
| 1. Thai picked: "Verify Thai rate" with the four documents, the expiry, "Choose proof to verify", and "Special case, approve by hand" under them | Pass | `s772-st-02-verify-thai-rate-documents-and-special-case.png` |
| 2. The special case: three reasons, an optional note, "Approved by Som (Reception) — recorded automatically with date & time, for this sale only. The member profile is not changed." No PIN and no manager step | Pass | `s772-st-03-special-case-three-reasons-no-pin.png` |
| 2. "Thai child with a foreign parent" and the note "ZZ TEST mother is Thai, father British" | Pass | `s772-st-04-reason-and-note-chosen.png` |
| 2. The order at THAI: 2 Hours Play, kids ฿520 (tourist ฿890), one adult ฿350, total ฿870; toast "Thai rate approved by hand · Thai child with a foreign parent · this sale only · recorded by Som (Reception)" | Pass | `s772-st-05-order-at-thai-rate-and-toast.png` |
| 3. Paid by cash: ฿870 due, then "Payment Successful, Receipt Z772-000001 • ฿870 • Cash" (the ฿350 credit's QR is hidden in the picture) | Pass | `s772-st-06-pay-by-cash-at-thai-rate.png`, `s772-st-07-paid-receipt.png` |
| 4. History: the sale reads "Thai rate approved by hand by Som: Thai child with a foreign parent — ZZ TEST mother is Thai, father British, 05 Nov, 02:08" | Pass | `s772-st-08a-history-list.png`, `s772-st-08-history-sale-approved-by-hand.png` |
| 4. The phone till's transaction detail: the same line | Pass | `s772-st-08m-phone-till-transaction-detail.png` |
| 5. The same member looked up again: "No verified rate"; Thai opens the document check again ("Saved to the member profile so they won't be asked again") | Pass | `s772-st-09-next-visit-thai-asks-for-proof-again.png` |
| 6. Other, one word ("Grandmother"): "Say why in at least two words, e.g. Thai grandparent with the family." and the approve button off | Pass | `s772-st-10-other-one-word-refused.png` |
| 6. Other, "Grandmother 12345": "Never type a document number here." and the approve button off | Pass | `s772-st-11-other-five-digit-run-refused.png` |
| 6. Other, "Thai grandmother": no refusal, the approve button on; approved, one 2 Hours Play rung up at ฿870 and cancelled before payment | Pass | `s772-st-12-other-two-plain-words-allowed.png`, `s772-st-13-other-rung-up-at-thai-rate-not-paid.png`, `s772-st-14-other-sale-cancelled-before-payment.png` |
| 7. Cancel path: the special case opened, "Thai ID seen earlier, not to hand" chosen, the dialog closed: the order still TOURIST | Pass | `s772-st-15-cancel-path-reason-chosen.png`, `s772-st-16-cancel-path-still-tourist.png` |
| Thai only (owner ruling): the Expat verify step has no "Special case" button | Pass | `s772-st-17-expat-no-approval-by-hand.png` |
| 8. Document path: Passport chosen, "Verify Thai — Passport", then the order at THAI with "Thai rate verified · Passport · recorded by Som (Reception)" | Pass | `s772-st-18-document-path-passport-chosen.png`, `s772-st-19-document-path-thai-rate-verified.png` |
| 9. Console, Watch > Activity filtered to `sale_tier_claim`: two `sale_tier_claim.approve_by_hand` rows by Som (Reception) and one `sale_tier_claim.restore` (the cancelled sale); the paid sale's row opened: actor, branch, approval note, reason `thai_child_foreign_parent`, evidence type "Approved by hand", to tier thai | Pass | `s772-st-20-console-activity-approve-by-hand.png`, `s772-st-21-console-activity-row-opened.png` |
| 9. Console, Catalogue & money > Tier verifications: "Thai rate approved by hand · per staff member", Som 2 in the last 30 days, 2 in total, last approved 05 Nov 2026 (the picture is cut below the ZZ TEST row so no other member shows) | Pass | `s772-st-22-console-tier-verifications-approved-by-hand-per-staff.png` |
| 10. Offline: the sentence on a forced-offline station | Not run on staging | see below |

## Read back (`staging-receipt.json`)

- Sale Z772-000001 (`steps.s3.sale`): `finalised`, `customerTier` thai, the member "ZZ TEST Hand
  Approval 772" on it, gross 87000 satang, and `tierClaim.approval` with reason
  `thai_child_foreign_parent`, label "Thai child with a foreign parent", the note, and "Som" as the
  approver account. `tierClaim.documentKind` is "Approved by hand".
- ZZ TEST Hand Approval 772 after the sale (`steps.s5.member`): `tierCode` tourist,
  `tierVerification` null.
- The Other sale (`steps.s6.sale`): `voided`, gross 87000, no money taken, its claim released
  (`tierClaim` null on the void, and a `sale_tier_claim.restore` audit row with reason
  `sale_voided`); ZZ TEST Other Reason 772 stays tourist with no verification.
- Cancel path (`steps.s7`): the `sale_tier_claim` audit rows were 18 before and 18 after, no new
  row; the member stays tourist with no verification.
- Document path (`steps.s8.member`): `tierCode` thai, `tierVerification` Passport, verified by
  Som (Reception), so the normal path still saves to the profile.
- `GET /audit?entityType=sale_tier_claim` (`steps.s9.auditThisRun`): exactly three rows from this
  run, two `approve_by_hand` (one with the note, one Other "Thai grandmother") and one `restore`.
- `GET /sales/tier-approvals/by-staff` (`steps.s9.byStaff`): Som, 2 recent, 2 total, last at
  19:12:16 UTC.

## Step 10 was not run on staging

No station on staging was forced offline at the time of the run: Virtual box 1 was online and every
other box was offline or unclaimed with no agent running (read at 02:06). A station answers
`503 STATION_FORCED_OFFLINE` only when its virtual box's agent has gone offline on purpose. Making
one would mean sending Virtual box 1 offline, which takes every till on it offline for anyone else
using staging, or adding a second test agent through a new api setting and a restart. Neither was
done. The sentence "Approving by hand needs the platform, and this till is offline. Check a document
instead." is pinned by `apps/pos/test/s772-tier-approval.test.ts`, which passed on the landed tree and
in main CI.

## Clean-up, read back at 02:16 (`cleanup` in the receipt)

- No unpaid sale was left on the ZZ TEST till: the Other sale was already voided by the till's
  Cancel, and nothing else was open.
- The four ZZ TEST members were archived from the till (each now 404, and a phone lookup finds
  nobody).
- The ZZ TEST till was archived.
- Kept for the record, as on other proofs: the paid cash sale Z772-000001, its two bands
  (Z772-YQB9JC, Z772-FTKX9W), its ฿350 credit, the voided Other sale and the audit rows. The Other
  approval, released by the void, lapses by itself at 02:42 Bangkok.
- Untouched, read back: FWBooth1, Reception Till 1, Till 1 (Pi) and Till 2 (test). Every session the
  run opened was signed out (both `/me` reads after sign-out answer 401).
