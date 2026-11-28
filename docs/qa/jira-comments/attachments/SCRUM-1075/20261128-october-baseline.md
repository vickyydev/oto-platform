# October payroll clause comparison, 28 November 2026

The old staging build’s **Check the month** screen and a separate calculation agreed before the new rules reached staging. The comparison covered the people on the 14 known clause wordings. For each person the verifier summed only the earning lines from their approved clause, in integer satang. It omitted zero totals, sorted the resulting pairs by employee ID and hashed the list in memory. No individual identifiers, payments or payroll exports were retained.

| October result | Nonzero recipients | SHA-256 of the complete comparison |
|---|---:|---|
| Native staging preview before release | 7 | `29419ce7c5ef33365d24a6813bfc24b7ef2dea1b4ae00593ae49c7904c978622` |
| Independent calculation under the previous rules | 7 | `29419ce7c5ef33365d24a6813bfc24b7ef2dea1b4ae00593ae49c7904c978622` |
| Independent calculation under the approved rules, before release | 4 | `7d00099a8c6359bb5a5433059447172f639dfce5093a10a554ef48994ff75456` |

October had one active paying entity in draft. The check used the two mapped trading parks. Head Office had monthly inputs and trades nowhere. Both the general revenue clause and the birthday and special sales clause with no named park belonged to one trading park each. The word “all” described the latter clause’s sales streams. The projection excluded Head Office sales.

There were 20 qualifying childcare days at one park, all counted from clock-ins. The other park had no qualifying childcare days. The host’s individual birthday count was missing. The platform read found zero qualifying October redemptions among 4,689 genuine printed staging booth vouchers. Two waiting readings had no payroll profile. Existing approved staging assignments covered 1–31 October. One approved childcare member had no employment in October.

The final independent projection was recorded before any new staging readings were approved. The independent source receipts were `job-dc5bvkk9v7es73a0d850` for childcare attendance, `job-dc5c0km1egvs73bcoiq0` for booth redemptions and `job-dc5c4jei0phs73d77dig` for the corrected trading-park scope. A post-release native check is still required.
