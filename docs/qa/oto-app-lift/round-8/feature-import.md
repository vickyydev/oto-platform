# Employee import preview and results - SCRUM-518

## Staging evidence - 13 October 2026

**WORKS for the recorded import journey.** All six staging services were live at `5b2f049fba750403fe60284bf2b8b4855eb934b4`. Read-only job `job-db6quk59fdbs73e0sa50` confirmed 16 app migration journal entries through `0015`; the checked tenant columns reported `is_nullable = NO`.

The employee import screen showed what each workbook row would do before any employee changes were applied. The park could select only the intended new and changed rows, see their results, and preview the same workbook again to confirm the saved state.

| Observed action | Result |
| --- | --- |
| Preview through the import screen | HTTP 200: New 1, Changed 1, Unchanged 1, Invalid 1; two rows carried the independent Matched label. |
| Select and apply only Changed and New | HTTP 200: created 1, updated 1, errors 0. |
| Preview the same workbook again | HTTP 200: Unchanged 3, Invalid 1, New 0, Changed 0; three rows carried the Matched label. |

The second preview confirms the resulting classification after the saved changes. It does not establish that repeating an Apply request is an idempotent operation.

## Inspected staging images

- [Import preview](../../jira-comments/attachments/SCRUM-518/import-preview-staging-20261013.png) - the four preview outcomes and matching information before Apply.
- [Import results](../../jira-comments/attachments/SCRUM-518/import-results-staging-20261013.png) - the completed selected-row results.

Both images were inspected before being named in this record.

## Release checks and remaining work

The release validation recorded 4,033 passing API checks, 89 feature controls and 30 browser checks. Those checks support the release; the staging actions above are the evidence for this import journey.

The remaining seven-feature acceptance work and exact fixture cleanup are still pending. This record covers the named import cases and does not close the parent story or claim unobserved workbook variants.
