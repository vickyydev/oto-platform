# SCRUM-679 audit evidence

Audit completed on 29 October 2026 Bangkok time (28 October UTC). Product repairs await owner approval. These files are evidence, not a new source release or a claim that the failed cases are fixed.

- [Complete audit and approval plan](../../../../admin-console-audit-2026-10-29.md).
- [Bound summary](audit-summary.json): 66 resolved default-page observations, 685 successful native responses, two exact sessions revoked.
- [UI report](ui/UI-AUDIT.md) and [route/family matrix](ui/ui-audit-matrix.json). Family summaries are not per-page control claims.
- [API report](api/api-audit-report.json): 675 existing passes, eight new controls passed, one new 404-envelope failure; twelve output-schema gaps.
- [Payment report](payments/payment-capability-and-audit.md): 53 existing passes; own-category control passed and two tax-reference failures. Read the [usage-banner addendum](payments/discount-usage-addendum.md).
- [Final UI diagnostic receipt](ui/browser-probes-v3.json): six intended assertions fail. [Earlier whole-browser receipt](ui/browser-all-v1.json) retains 327 passing controls and the initial imperfect diagnostic attempt.
- [Proposed tickets](approval-tickets.json): SCRUM-680 through 683 remain To Do, awaiting approval.

## Images and limits

Fourteen native staging PNGs are in the parent folder. Root inspected each; they are partial viewports, captured after the bound deployment. Personal fields and images/canvases were hidden or masked. In particular, blank print-preview image areas are the privacy mask; the native preview responses were 200 and are recorded in staging-preview-v2/receipt.json. Fonts/external images were suppressed. No visual-print fidelity claim is made.

Six SCRUM-679-UI*.png files are LOCAL controlled-response illustrations; all six were inspected, as recorded in ui/probe-v3/image-review.json. They are not staging proof. UI01 shows the selected booth while the history assertion is below the viewport; the actual failure log is primary evidence. The other five visibly show their stated defect.

Initial UI attempts had harness selector/PNG-routing errors; those are not product findings. The final run reaches all six intended assertions. The native child reports exit 0 despite failed Playwright assertions; the outer audit correctly returns failure based on the retained test result. This is not a green release gate.

External original logs, exact diagnostic sources, full source manifests and helper code remain under C:/oto-lanes/admin-audit-evidence/. Temporary tests were removed from the source tree. Existing test and product bytes are unchanged. No Docker, shared worktree or planner-owned source was altered.

Native logs are committed as lossless `.log.gz` files so terminal whitespace is preserved without failing source whitespace checks. [Compression index](compressed-log-index.json) records both compressed and original hashes; decompressing recovers the exact log bound by each receipt. External original plaintext logs remain unchanged.

One PowerShell-created cleanup JSON was normalized from CRLF to LF by Git. [Normalization record](text-normalization.json) binds the original external bytes and committed bytes; its data is unchanged. Native logs remain byte-exact after decompression.
