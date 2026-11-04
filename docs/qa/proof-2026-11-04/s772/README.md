# SCRUM-772 local proof, 4 November 2026

The Thai rate approved by hand, driven in a real browser (Edge, Playwright) against a disposable
local database built from the lane's migrations (through 0102) and the dev seed, with the lane's
api, till and Console dev servers. Signed in at the till as the seeded reception account (Som) on
Reception Till 1; the Console as the seeded owner account. Only ZZ TEST members were created. Staging
was not touched. Read-backs taken through the api afterwards are in `receipt.json`.

| Screenshot | What a person sees |
| --- | --- |
| `01-member-no-verified-rate.png` | ZZ TEST Hand Approval found: "No verified rate", Thai needs proof |
| `02-verify-step-document-check-and-special-case.png` | The verify step as before (four documents, expiry, Verify), with "Special case, approve by hand" under it |
| `03-special-case-reasons.png` | The special case: three reasons, an optional note, "Approved by Som (Reception)… for this sale only. The member profile is not changed.", no PIN and no manager |
| `04-special-case-reason-and-note.png` | "Thai child with a foreign parent" chosen, note typed |
| `05-thai-rate-on-this-sale.png` | The order at THAI (kids ฿520), toast "Thai rate approved by hand · this sale only" |
| `06-payment-at-thai-rate.png`, `07-after-payment.png` | Paid by cash: receipt T1-000001, ฿870 |
| `08a-history-list.png`, `08-history-sale-document-check.png` | History's sale: "Thai rate approved by hand by Som (Reception): Thai child with a foreign parent — Mother is Thai, father British, 04 Nov, 17:44" |
| `09-next-visit-asks-again.png` | The same member looked up again: still "No verified rate", Thai still asks for proof |
| `10-document-path-passport-chosen.png`, `11-document-path-verified-to-profile.png` | The document path unchanged: Passport on ZZ TEST Document Check, "Thai rate verified", saved to the profile |
| `12-cancel-path-reason-chosen.png`, `13-cancel-path-nothing-applied.png` | Cancel: the special case opened, a reason chosen, the dialog closed: still TOURIST, nothing recorded |
| `14-audit-row-approve-by-hand.png` | `GET /audit?entityType=sale_tier_claim`: one `sale_tier_claim.approve_by_hand` row, actor Som, reason and note |
| `14b-console-activity-log.png`, `14c-console-activity-row-opened.png` | The same row in the Console's Activity log |
| `15-console-approvals-per-staff.png` | Console, Tier verifications: "Thai rate approved by hand" per staff member, Som 1 in 30 days, 1 in total |

Read back after the run (`receipt.json`):

- sale T1-000001: `customerTier` thai, the member on it, `tierClaim.approval` with reason, label, note and
  "Som (Reception)" as approver;
- ZZ TEST Hand Approval: `tierCode` tourist, `tierVerification` null, so the member was not marked;
- ZZ TEST Document Check: `tierCode` thai with a Passport verification by Som (the document path);
- ZZ TEST Cancel Path: tourist, no verification; the audit shows one hand approval only, so the cancelled
  one wrote nothing;
- `GET /sales/tier-approvals/by-staff`: Som, 1 recent, 1 total.

Automated: `packages/shared/test/s772-tier-approval.test.ts` (10), `packages/db/test/migration-0102.test.ts`
(3), `apps/api/test/s772-tier-approval.test.ts` (12), `apps/pos/test/s772-tier-approval.test.ts` (11), and
the operations markup test and Console fixture for the count.

## Staging proof plan

After the lane lands and the api, POS web and Console are live on the landing commit with main CI green:

1. On `oto-pos-web-staging`, as reception on a ZZ TEST till, create or find a ZZ TEST member at the
   tourist tier, pick Thai, and capture the verify step with the third button.
2. Special case: "Thai child with a foreign parent" with a note; add one 2 Hours Play kid and one adult;
   pay by cash. Read back the sale: `customerTier` thai, `tierClaim.approval` with the reason and
   reception's name.
3. History: open the sale and capture "Thai rate approved by hand by <name>: <reason>".
4. Look the same member up again: "No verified rate", Thai asks for proof; read back the member:
   tourist, `tierVerification` null.
5. Other: "Other" with a one-word reason (refused on screen), then two words; cancel the sale (a void of a
   sale that took no money gives the claim back) and read back nothing on the member.
6. Cancel path: open the special case on another ZZ TEST member and close it; read back no claim and no
   audit row for it.
7. Document path on a third ZZ TEST member: Passport still verifies and is saved to the profile.
8. Console: Watch, Activity shows `sale_tier_claim.approve_by_hand` with actor, reason and note; Catalogue,
   Tier verifications shows the per-staff count for the reception account.
9. Offline: with the till on the box lane, the special case says it needs the platform and points at the
   document check; nothing is recorded.

Clean up: void the ZZ TEST sales that took no money; the cash sale stays as a ZZ TEST record.
