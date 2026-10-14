# Confirms audit, slice B (scheduling, policies, settings, signing, studio, timekeeping, public, beo native)

All paths relative to apps/oto-app.

## Findings (cross-checked)

1. HIGH. client/src/pages/studio/events.tsx:2679-2692 "Cancel Event? This will mark the event as cancelled." Opened by the "Delete" button (2809). Mutation events.tsx:583 DELETE /api/admin/events/:id -> server/routes.ts:17197 -> storage.deleteStudioEvent (server/storage.ts:10920) hard-deletes core_events (cascades). Toast "Event cancelled successfully". Also refused (500) when the event has core tasks: tasks.event_id FK ON DELETE NO ACTION (migrations/0000_otoapp_baseline.sql:3452, server/db/coreSchema.ts:627); events created with tasks via events.tsx:503.
2. HIGH. client/src/pages/scheduling-page.tsx:6368-6404 "Confirm Restore ... Current assignments in this scope will be replaced." For apply_template_additive entries (routes.ts:16184, whole-week snapshot) restore goes to storage.ts:7924 restoreWeekPlanFromSnapshot: deletes ALL assignments (no date filter, 7972) on every branch shift row active that week, deletes the rows (cascade duty_blocks/breaks), reinserts only that week. Every other week's assignments on those rows are lost.
3. MED. client/src/pages/studio/camp-detail.tsx:1710-1716 (+ banner :763) "new registrations will see the cancelled status". PATCH status only (routes.ts:17129). Public camp page/registration never checks status (camp-register.tsx, camp-registration-routes.ts, camp-family-verification.ts:30). Registrations still accepted.
4. MED. scheduling-page.tsx:5673 "Shift row definitions and leave records are never deleted." routes.ts:15253 deletes CHANGE_DAY_OFF time-off for affected employees (branch-wide, any dept). Duty blocks cascade-deleted (duty_blocks FK cascade) and not in snapshot (storage.ts:7674) so toast at :1990 "restore from Schedule History" does not bring them back.
5. MED. scheduling-page.tsx:5866/5908 Scan & Fix "Auto-Fix All". routes.ts:16503 only handles duplicate shifts (HAVING count>1); shift+day-off conflicts untouched; it also deletes CHANGE_DAY_OFF on those dates; per-duplicate delete not branch-scoped (16535, 16571).
6. MED. studio/children.tsx:980/1096 Merge Profiles. routes.ts:18147 overwrites secondary regs' allergies, food restrictions, behavioural/special notes, DOB, photo, parent with primary's. Not disclosed.
7. MINOR. policies-page.tsx:1371 "make it the active version. All new contracts will include this policy". publishPolicyDocument (storage.ts:4465) does not demote older published; contract attach (routes.ts:6141) picks first published in branch/company scope by versionInt desc; one policy per contract.
8. MINOR. scheduling-page.tsx:5571 apply-template preview count: storage.ts:10276-10341 counts assignments only on rows that already exist; apply (10512) also adds to new rows and skips ineligible employees.
9. MINOR + bug. scheduling-page.tsx:6043 Merge Shift Rows. Server (routes.ts:14985) moves assignments of every week, hard-deletes source rows, no Schedule History entry. source_vs_source conflict + "Keep source" moves a duplicate in (15032 only looks in target).
10. MINOR. scheduling-page.tsx:3221 menu "Clear Day/3 Days/Month" but dialog/server clear one week of one dept.
11. MINOR. settings-page.tsx:361 prod-sync confirm shown on every deployment; server/prod-sync.ts:597 devOnly refuses off local.
12. MINOR. studio/checklists.tsx:526 delete wipes all checklist runs history (routes.ts:20779-20788), unmentioned.
13. MINOR. scheduling-page.tsx:1015 toast "will no longer appear on future schedules"; storage.ts:8200 sets activeUntilDate=yesterday, row vanishes from the current week too. (No confirm before Delete at :5363.)
14. MINOR. beo-event-editor.tsx:2504 "Remove them first via Reset" - button is "Reset Selections" (2657), only shown once a parent link exists; reset (beo-routes.ts:2724) also wipes the parent's submitted choices and invalidates the sent link.
15. MINOR. scheduling-page.tsx:6256 restore toast "Restored N shifts" for dept restores; rows untouched (storage.ts:7917). actionLabels lacks apply_template_additive (shows raw key).

## Checked accurate
quizzes delete (cascade), KB delete/archive, SOP delete, studio scheduled task delete, leave policy delete, public holiday delete, Remove from Camp (attendance cascade), camp delete native confirms (true; cascade; same tasks-FK caveat), timekeeping approve/reject, set off days, save template, clear-week dept-scoped restore.

Side: routes.ts:19741 deletes task_questions before tenant check.
