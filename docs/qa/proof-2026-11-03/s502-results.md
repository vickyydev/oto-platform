# SCRUM-502 staging payment wording proof

Verified 2026-11-02T22:33:51.735Z. Source: `7a00aa1ce44af50622d3cde0bd5e84f80607c2a6`. [CI](https://github.com/vickyydev/oto-platform/actions/runs/41532107227). The native staging POS used the clean, same-source actual Windows box agent: oto-box 0.1.0-20261102-7a00aa1c built 2026-11-02T21:51:28.209Z.

The proof used only **ZZ TEST SCRUM-502 mvztxbuj**. A browser cut its own API traffic while the actual agent lost its own WAN connection. No park device or other session was interrupted.

- **Refusal:** remove only that local box's receipt mark, press cash once, and observe its genuine `RECEIPT_MARK_MISSING` refusal. The panel says the unpaid order is held only on this till. Restore the exact cached receipt mark. The refused sale has zero platform rows.
- **Lost reply:** one native cash POST reached the box and completed; only the reply was dropped. The panel says the payment is not yet confirmed and the box may already have recorded it. No automatic write retry or second payment press occurred. Reconnect produced one finalised sale, one approved cash attempt and receipt Z502-000001. Queue, quarantine and sync anomalies are zero.
- **Cleanup:** the exact box and station are archived, the box is disabled, its loopback address is cleared and both sessions are signed out. Only BOX_BRIDGE_ALLOW_LOOPBACK was added and removed; 57 API names remain, every remaining value byte-identical. The same-source cleanup restart is live and routed health passes.

The local proof found a real wording defect: an accepted payment with a lost reply was described as not taken. The narrow fix changes only the connection sentence and uncertain-payment heading. Two HIGH review findings were reproduced and pinned before the full local release checks and rebuilt native rehearsal passed. Payment logic, IDs and retries did not change.

| Service | Live source | Deploy |
|---|---|---|
| oto-api-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgtimc6qcc73fpsdu0 |
| oto-pos-web-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81g6g |
| oto-pos-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81gag |
| oto-console-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81gf0 |

Independent read-only database job: job-dbkgt0d9fdbs73fll0lg. Receipts and screenshots are in [s502](./s502/). The opened images are `s502-staging-proof.png`, `s502-box-refused.png` and `s502-box-answer-lost.png`, also copied to the Jira attachment directory.

This proves the required staging wording using the real local agent. It does not claim physical printer, Pi, iPad, private HTTPS certificate or power-cut acceptance. Unchanged OTO App checks were path-gated in this release. Keep the ticket at Testing until these inspected images are attached and the helper walk reads back Deployed.

Jira read-back: **Deployed** at 2026-11-02T22:34:31.975Z. Evidence commit `f5e728cb8ca68e71d39e62b5f47ababd85052dbd`; attached images 12245, 12246, 12247.
