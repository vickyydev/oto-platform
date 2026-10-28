# SCRUM-679 — payment audit decision summary

Source: `5da2fe226a3fec8f4d9c725deba9428d040275b0`. Audit only; no product change or implementation approval.

**Current controls:** Tenders and branch Tax are editable in Catalogue. Devices → station drawer configures card/QR/cash routing and offline wallet cap. Discounts, voucher campaigns and event pricing are nearby native controls. Money oversight is read-only. Cash counts/close/settlement remain POS; Integrations provides documented fixture-format settlement CSV import. Gateway secrets/provider configuration are environment-only. The three Releases payment kill switches are explicitly unsupported and cannot yet affect a till.

| Priority | Finding / impact | Proposed owner and acceptance before implementation |
| --- | --- | --- |
| 1 / medium | Foreign operator category accepted by own-branch tax override: HTTP200 and persisted cross-owner pointer. No foreign-value disclosure demonstrated. | API catalogue owner: native reference lookup in the write transaction, consistent foreign/missing refusal and no persisted row; add category/product/rollback parity controls. Category is reproduced; product remains source-only. |
| 2 / medium | Missing category produces HTTP500 `INTERNAL`, “Internal server error”, instead of an actionable reference refusal. No row persisted. | Same narrow API change: 404 before FK insertion; retain unexpected-error sanitization. Confirm own reference still succeeds and audit/transaction behavior stays intact. |
| 3 / low | Tender DELETE description/inventory incorrectly says used tenders are refused; current approved behavior archives after confirmation. | API/docs owner: text-only correction; preserve all existing archive/history behavior and 24 tender assertions. |

**Approval proposal:** fix priorities 1–3 first. Then improve discovery through existing Set up / Operate in POS / Reconcile / Investigate links and explicit editable/read-only/environment-only/unsupported labels. Use stable refusal codes with a matching action; preserve saved-but-refresh-failed states. Any new payment kill integration, generic writer, provider settings editor or changed business rule requires separately approved scope. Loaded-list filters must state their range and preserve totals/date basis; no new server filters are assumed approved.

**Actual local evidence:** four unchanged whole native files passed 53/53 (tenders24, Money16, settlement9, tax seam4). The bounded new diagnostic had one own-category control and two functional failures, retained honestly. No hardware, external provider, live payment, cash-close or staging mutation was performed.

**Reproduction and cleanup:** preserved test `admin-audit-payment-ownership.test.ts.txt`; native receipts `native-targeted-v1.json`, `tax-ownership-v1.json`; safe actual statuses `tax-override-native-observations-v1.json`. The temporary test was removed from `apps/api/test`; all five own embedded PG identities/listeners are absent. Existing/product test source is unchanged. Detailed capability/error/filter matrix: `payment-capability-and-audit.md`.
