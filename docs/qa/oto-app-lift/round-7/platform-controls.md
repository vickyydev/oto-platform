# Platform action evidence - 13 October 2026

Actual staging source: d18d3fd80cc6418e42a03d97d5f7e871d127223e. Both administrator sessions entered through the launcher. This is a labelled request/action card, not a claim of full screen coverage.

| Control | Observed result |
| --- | --- |
| Separate-park Settings | Same unique ZZ TEST key saved200 for each park; read200 returned exactly that park's distinct value. Existing settings unchanged. |
| Activity Log | Owned synthetic employee query200 with one entry; foreign employee filter200 with zero; foreign branch404. |
| Attention | Refresh200, engine active; exact synthetic employee alert snooze200 and resolve200; foreign resolve404; final owned read200 confirms resolved. |

Inspected evidence: [r14-settings-activity-attention-staging-20261013.png](../../jira-comments/attachments/SCRUM-193/r14-settings-activity-attention-staging-20261013.png).

The exact two Settings row IDs and alert ID are recorded in the ignored fixture ledger. The expanded read-only cleanup preview passed with 263 rows across 61 tables and ten exact objects; no deletion has run. These fixtures remain for feature acceptance and will be removed with guarded reference and absence checks. No existing park setting, employee, payment or seed record was altered by this case.

## Directory HR and POS seam

On the live app4dcc6664, job-db6km8om7kps73b9r2bg passed twelve Directory GET cases: owned employee/roster/search/branches/roles/departments200, foreign employee/roster404, foreign department filter200 with an empty result, missing scope403, missing key401 and disabled shared-key403. Both temporary credentials were revoked, refused403, then removed by exact guarded IDs with absence confirmed. No HR record changed. [Inspected Directory card](../../jira-comments/attachments/SCRUM-193/directory-hr-staging-20261013.png).

The seeded Story Time event dated7 October was discovered through a read-only view query. POS list/detail returned200; the same event requested under another permitted branch returned404, as did a foreign event under the owned branch. No station, sale or event changed. The source reader uses otoapp_v.events; the staging requests and source control jointly establish the seam. [Inspected POS card](../../jira-comments/attachments/SCRUM-193/pos-event-view-staging-20261013.png).

## R7b live migration

Render confirms all six services live at4dcc6664fc2892a0becaaa0fe179f80f40646bde. Read-only job-db6kmb5g1s2s739ntp20 confirms eleven app migration journal entries through0010 and required tenant_id on asset_catalog, leave_policies, policy_documents and templates. [Live ownership card](../../jira-comments/attachments/SCRUM-193/r7b-document-ownership-live-20261013.png).

## Jobs and final cleanup

Historical October8 job success and forced-failure/Retry records are recovered. Current scheduled-job results correctly report the isolated practice park as unkeyed while the existing park's groups succeed. OPEN_ITEMS records the exact cleanup/census/Retry follow-through; this page does not claim today's full jobs gate green. No scheduled-job credential or behavior was changed for the practice fixture.
