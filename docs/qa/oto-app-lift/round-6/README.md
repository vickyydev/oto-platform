# Round 6 staging walkthroughs - 12 October 2026

The eight pages below record actions and refusals observed on OTO App staging
source `633cae416ff7e4a1c253ec4904cdc22351cf7df1`. The administrator and staff
entered through the launcher. A separate `ZZ TEST R56 Foreign Park` and
`ZZ TEST R56 Foreign Administrator` provided the other park group's requests;
provisioning used an existing seeded platform account and sent no setup message.
Screenshots are actual 820 x 1180 browser captures, inspected before attachment.
The download evidence is explicitly a test-run card with real signing screens.

| Module             | Current walkthrough                                               |
| ------------------ | ----------------------------------------------------------------- |
| Contracts          | [Contract signing and private download](contracts.md)             |
| Letters            | [Resignation letter signing and private download](letters.md)     |
| Templates          | [Template save and use](templates.md)                             |
| Policies           | [Draft and publication in separate park groups](policies.md)      |
| Employee documents | [Private upload, read and removal](employee-documents.md)         |
| Assets             | [Assignment, return and repeat refusal](assets.md)                |
| Offboarding        | [Screen submission, checklist and repeat refusal](offboarding.md) |
| Organisation chart | [Isolated vacancy and foreign edit refusal](org-chart.md)         |

## Cleanup read-back

The employee document was deleted through its own route (204); its subsequent
file read was 404. Job `job-db6a5m0473hc73do05kg` matched the downloaded contract
and letter bytes by SHA-256 before removing their two synthetic objects; both
object read-backs were 404.

Job `job-db6a80ijnfac73d14btg` checked the exact employee, contract, letter,
template and chart IDs against their ZZ TEST labels and relationships, then
removed their records in one transaction:

| Records                                                              | Removed |
| -------------------------------------------------------------------- | ------: |
| Activity rows                                                        |      13 |
| Attention rows                                                       |       4 |
| Offboarding checklist items                                          |       6 |
| Letter, employee change, contract, offboarding                       |  1 each |
| Assigned asset, employee, mirrored platform employee, catalogue item |  1 each |
| Templates                                                            |       2 |
| Policies                                                             |       2 |
| Chart vacancy                                                        |       1 |

The final counts for the employee, documents, offboarding, checklist, contracts,
letters, assets, Attention and mirrored platform employee were all zero. There
was no payroll profile to remove. Som's deliberate 14 October sick day and the
seeded employees were preserved.

The shared ZZ TEST practice park, branch, app user and branch-access row remain
in use for the round-5 attendance walkthroughs. Their final removal is still
owed by that evidence unit and is tracked in STATUS; this is not a claim that
all walkthrough fixtures have been removed. No runtime code or migration changed.
The complete parent-story gate remains open for rounds 7 and 8.
