# SOP history and restore - SCRUM-519

## Staging evidence - 13 October 2026

**WORKS for the recorded versioned edit, history, archive and restore journey.** The staging application ran `5b2f049fba750403fe60284bf2b8b4855eb934b4`.

Seeded administrator Anan used the original practice SOP, **ZZ TEST R7 1012 Find Procedure**, in its owning park group. The exact record is `424aed15-72e6-45ea-8350-a62eef0adeea`, in park group `681b18d1-4c75-415d-9271-5fe3afc30993`; the recorded actor is `01a0be02-edd6-726a-aa9c-5204343e636e`.

The Studio history screen showed who saved the earlier version and when, and displayed its original content for review. Restoring that content retained the SOP's current archived status and branch scope.

| Observed action | Result |
| --- | --- |
| Save the content edit | HTTP 200; one previous-content revision recorded. |
| Repeat the same edit request | HTTP 200 with the same resulting version. |
| Reuse the edit request identity with different content | HTTP 409. |
| Archive the SOP | HTTP 200. |
| Open History and preview the earlier version | Actor, time and original content visible on the staging screen. |
| Restore the chosen original content | HTTP 200; original body restored; current archived status, scope and branch choices preserved. |
| Repeat the same restore request | HTTP 200 with the same resulting version. |
| Read history or restore from another park group | HTTP 404 for both requests. |
| Read history as seeded staff Som | HTTP 403. |
| Save using an earlier version | HTTP 409. |

## Inspected staging images

- [SOP history](../../jira-comments/attachments/SCRUM-519/sop-history-staging-20261013.png) - recorded versions with actor/time and the original-content preview.
- [Restored archived SOP](../../jira-comments/attachments/SCRUM-519/sop-restored-archived-staging-20261013.png) - restored content while the current archived status remains selected.

Both images were visually inspected during the staging walkthrough before being named in this record.

## Release validation and remaining work

The green main release included 16 SOP runtime controls within the 89 feature runtime checks. Those hosted controls support the release; the table above records the observed staging journey.

The exact practice SOP and its revision IDs remain in the local cleanup ledger. Final fixture cleanup and the remaining seven-feature acceptance work are separate outstanding steps. This record does not close the parent story or establish unobserved SOP variants.
