# SCRUM-503 prepaid-label staging proof

Verified 2026-11-02T22:36:21.376Z. Source `7a00aa1ce44af50622d3cde0bd5e84f80607c2a6`, [CI](https://github.com/vickyydev/oto-platform/actions/runs/41532107227). Fresh fixture: **ZZ TEST SCRUM-503 mvzu75yd**.

A new synthetic family paid one cash ticket (Z503-000001) including a prepaid meal, supplied a synthetic photo and acknowledged the policy, then checked in through the native board. The native food counter scanned that child's band and selected its prepaid entitlement. The order panel visibly showed **Already paid at check-in**, the darker **Prepaid** text and the zero price. **Order Confirmed** and its **Kitchen ticket** also showed the darker badge. The meal (Z503-000002) charged zero. All three native screenshots were opened and inspected.

The independent read-only database check (job-dbkh0gdbedkc73f817pg) confirms one approved cash ticket, one zero-price meal, one prepaid unit redeemed and one release. The exact synthetic child is out, all simulated print jobs finished, the box/till is disabled/archived and both proof sessions are signed out. No API setting changed. The synthetic cash audit and consent/photo records are retained for traceability.

| Service | Live source | Deploy |
|---|---|---|
| oto-api-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgtimc6qcc73fpsdu0 |
| oto-pos-web-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81g6g |
| oto-pos-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81gag |
| oto-console-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81gf0 |

Proof files: [s503](./s503/). Jira images: `s503-staging-proof.png`, `s503-prepaid-order.png`, `s503-prepaid-confirmed.png`. This closes the prepaid visual proof named in the ticket's prior comments. No new product change was needed. Simulated printing does not claim physical printer acceptance. No real person, park device, electronic payment or SMS was used.

Jira read-back: **Deployed** at 2026-11-02T22:36:58.341Z. Evidence commit `46db2c2b6362652dffc61c073069763a3686277c`; attached images 12248, 12249, 12250.
