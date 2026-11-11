# SCRUM-748 staging proof — 11 November 2026

Attempt 02 passed through the native OTO App checklist editor. Source fix
`9b3ba1f8f6544362be58fbbce3772cf16a39f722`; running source before and after
`266830f9b5b0d624325bfcd362a13a1b56009f46`. The latter includes planner work;
`runtime-wait.json` proves both upload files are identical to the fix.
Named app deployment `dep-dbq6qtei0phs73bgavb0` reached live at 13:30:29Z.

- A photo attached to an already saved item through the browser. No fault was
  injected: the queue used the app multipart fallback, returned 200, and the
  orange reference photo still displayed after reopening. The exact browser
  transport error text was not collected.
- A deliberate refusal of the bucket PUT on unsaved item zero also fell back
  to multipart, returned 200 and retained index zero. Native Create saved the
  checklist; association returned 200 / updated 1. Reopening showed the photo.
- Both templates and both attachment rows were deleted through their routes;
  template reads and attachment URL reads returned 404. This is route-level
  cleanup evidence, not an independent bucket census. App and launcher sign-out
  returned 200 and their session readbacks 401. No active fixture remains.

Pictures inspected before attachment: `s748-saved-upload.png`, `s748-saved-reloaded.png`, `s748-pending-upload.png`, `s748-pending-reloaded.png`.
The two saved-item pictures have the same SHA256 because the reopened screen
matches the uploaded screen. The image is the repository's synthetic orange
JPEG, not a real person's photograph. Dialog crops exclude other records.

Attempt 01 is retained: the saved-item path passed, but cancelling edit left
the first item expanded in the create form. The harness toggled it closed and
selected the header input. Its index-zero assertion correctly failed; the
header attachment and saved fixture were removed, all reads 404 / sessions401.
The harness now checks expansion state and scopes the input to item zero.
No product code changed for that harness error.

The owner bucket CORS setting remains open. Direct-upload success is covered
by the captured queue test; this staging proof covers the fallback. Local gates
are in ../local-gates.json. Full exact-source CI43026325155 is still running at
this proof checkpoint; app/POS jobs passed, remaining jobs tracked separately.
The owner17:32 ruling permits Deployed after inspected staging proof; never Done.
