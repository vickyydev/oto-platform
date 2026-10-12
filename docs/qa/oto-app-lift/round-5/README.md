# Round 5 staging walkthroughs - 12 October 2026

The ten pages record actual staging actions and access refusals on app source
`633cae416ff7e4a1c253ec4904cdc22351cf7df1`. Administrator and staff sessions
entered through the launcher. An isolated ZZ TEST park’s manager was restricted
to one of its two practice branches. Screens are actual 820 x 1180 captures; the
attendance image is a labelled test-run card. Its photo fixture was generated.

| Module                           | State  | Walkthrough                                 |
| -------------------------------- | ------ | ------------------------------------------- |
| Kiosk devices and reception      | WORKS  | [Actions and refusals](kiosk-reception.md)  |
| Face, PIN and phone clock policy | WORKS  | [Actions and refusals](clock-policy.md)     |
| Timekeeping                      | WORKS  | [Actions and refusals](timekeeping.md)      |
| Scheduling                       | BROKEN | [Actions and refusals](scheduling.md)       |
| Leave and holidays               | WORKS  | [Actions and refusals](leave-holidays.md)   |
| Tasks and Ops board              | WORKS  | [Actions and refusals](tasks-ops.md)        |
| Checklists and media             | WORKS  | [Actions and refusals](checklists-media.md) |
| Announcements                    | WORKS  | [Actions and refusals](announcements.md)    |
| In-app notifications             | WORKS  | [Actions and refusals](notifications.md)    |
| Casual workers                   | WORKS  | [Actions and refusals](casual-workers.md)   |

## Records and cleanup at this checkpoint

The module actions and images are complete. Exact cleanup of the attendance,
operations and media fixtures is next; no all-fixtures-removed claim is made.
Their IDs and object SHA-256 fingerprints are held in ignored local ledgers.
The employee is `2b4c8217-cb3f-4ecc-a284-b6ae604e2eee`, in the default
park’s Central Floresta branch; its name starts ZZ TEST R5 1012. It has no
login or person link. Only this employee’s clock/leave and mirror rows are removed.
Existing department/role parents, shared week plans and Som’s 14 October sick
day remain. A week plan is removed only if creation ownership is established.

The shared practice park `39ab8ff6-b3a7-4e1d-b9eb-3a3a7c15049d`, its two
ZZ TEST branches and app user `01a12f45-12ff-7a10-8ad7-bb2d54ad464f` are
retained for round 7’s isolated form/Data Admin checks. Their final cleanup is
owed before story closure, including unlinking only the temporary app identity
from the seeded second-operator platform account. That account is preserved.

Scheduling Q39 remains BROKEN for the observed other-park read. No runtime code
or migration changed for this evidence unit. SCRUM-191 and SCRUM-193 remain
In Progress until the remaining round-7/8 and acceptance gates are complete.
