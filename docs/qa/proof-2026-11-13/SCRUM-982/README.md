# SCRUM-982 and scoped SCRUM-981 proof

The reviewed repair is live on both staging tills at `3e29803bf0d2c935a9a0c23f76c60c4182bcc104`. Eight fresh native journeys passed on 14 November 2026. Exact-source CI [43489637902](https://github.com/vickyydev/oto-platform/actions/runs/43489637902) completed successfully across all six jobs. The app job path-skipped 113 steps, so this is not fresh app acceptance; three workspace steps were skipped. Full job/step readback is in `source-ci.json`.

Root reviewed and approved the final shared scope helper and all five selling-screen integrations. Complete local validation passed 3,902 POS tests in 274 files, three POS type configurations, zero-output API types, touched lint, eleven adversarial pins, four new scope cases and seven production-build browser journeys. The original corrected-order amount, row-count and quantity assertions remain unchanged. See `cart-scope-validation.json` and `REVIEW.md`.

## Exact staging sources

- `oto-pos-staging`: `dep-dbrm1n0n74is7398u3t0`, live 14 November at 02:12:36 Bangkok.
- `oto-pos-web-staging`: `dep-dbrm1nmtlv9c73b1ura0`, live 14 November at 02:14:56 Bangkok.
- Both deploys remained live at the same source after the proof. `final-deploys-start.json` and `final-deploys-end.json` bind these reads. The old `deploys-start.json` is historical evidence for 157d6cb.
- Native JavaScript `/assets/index-CYejgRrr.js` returned 200 before and after; its SHA-256 parts match in `final/native-source-before.json` and `final/native-source-after.json`.
- The API was live at `239ef48248d7ec1af739f432db7c91dda778c2c0`. Its API, shared and database source is unchanged from the verified 979 release `0ea85faaf5b4e62204eaabdda5d691dd2b9a248c`. No API deployment was requested for this till repair.

## Native results

| Case | Observed result |
| --- | --- |
| Desktop ticket, A to B | The same waiting QR completed as PromptPay, with one approved attempt and seller A. |
| Desktop F&B, B to A | The retained QR was cancelled, then one Cash payment closed the same sale with seller B. |
| Desktop Shop, A to B | The same QR completed as Thai QR / PromptPay; seller A and one approved attempt remained. |
| Phone ticket, A to B | The waiting QR survived Continue and the family hand-back flow. Cancellation followed by Cash closed the same sale with seller A. |
| Phone F&B, B to A | The same waiting QR completed as Thai QR / PromptPay, with seller B. |
| QR introduced during lock | The sale had zero attempts before lock. A QR was created and paid while locked. B's Continue restored PromptPay automatically, with zero financial POSTs after Continue. |
| Waiting terminal payment, A to B | B retained the exact card attempt, terminal route and original seller A. Continue sent no new tender. The own simulator deliberately returned no response. |
| Genuine cart correction | Adding an adult directly on payment voided the original 104,000-satang charge and paid a distinct 139,000-satang sale. The ledger contains Kids 1, Adults 2 and one approved Cash attempt, with seller B. No unpaid orphan remains. |

The final matrix created nine sale rows on three fresh ZZ TEST stations: seven paid, one original corrected-cart row voided by the till, and one unresolved simulated card row. Detailed IDs and readbacks are in `final/summary.json`, `receipt.json` and `exact-ledger.json`. All fifteen selected images were opened and inspected; their list and limits are in `final/inspected-images.json`. Payment and benefit QR blocks are masked. The committed Jira copies have the `s982-final-` prefix.

## Cleanup and limits

Seven final-source simulated paid sales were refunded exactly: 492,500 satang (4,925 baht). Every refund reads `pending=false`, with its tender allocations done. The no-response simulated card was confirmed as no money taken and then voided; its attempt is declined. Together with the already voided corrected-cart row, both unpaid rows are closed. The three final stations have no device assignments and are archived; the own simulated terminal is archived. Both old and final display credentials read revoked.

Both reused ZZ TEST 964 staff retain their original names and history, are inactive again and have zero live sessions. Sign-in returned 401 for each. All three native sessions and the separate manager/admin contexts signed out and read 401; browser and driver are closed. Earlier old-source fixtures were also fully retired: six refunds totalling 353,500 satang, one unpaid void and three archived stations. No live fixture or credential remains.

This is bounded staging proof with simulated QR and terminal providers. No physical terminal, bank, printer or park-device acceptance is claimed. The existing paired-display lease can hold the previous screen for a minute after a staff change; the staff screen can continue and the own-display notice is visible. Some screenshots show that held-minute state or an existing printer toast. Printer output is not acceptance in this run.

SCRUM-964's earlier seven points were already proved; this matrix closes its remaining cross-staff waiting-payment dependency with final green CI and inspected Jira publication. SCRUM-981 remains partial: its owner-held choices, the app-view set-menu/extra-name collision reserved for stage 3 and the shared End-of-Day composer are still open. Family read-blip, long-name layout, stock wording and other narrow till pins have local regression coverage; this run does not add a native claim beyond the visible own-display hint and the payment matrix.

The earlier CI failures are preserved honestly. Run 43429015391 exposed two stale test selectors/timings, reproduced as complete files and repaired without weaker assertions. Run 43435242291 exposed a real corrected-cart regression, reproduced with the complete original three-case browser file. The final captured-scope repair fixed that source fault. Historical 157d6cb images are not acceptance of the final repair; unselected intermediate images remain in the scratch archive.

Jira publication and readback are complete: SCRUM-982 and SCRUM-964 are Deployed; SCRUM-981 stays In Progress. Native evidence comments are 14741, 14742 and 14743; final green/closure comments are 14745, 14746 and 14747. Seventeen named image attachments independently read back (12 on 982, four on 964, one on 981). See `native-jira.json` and `jira-proof.json`. Stage 2.4 is complete and the approved stage 3 partitions may proceed after this checkpoint. Only the owner moves tickets to Done.
