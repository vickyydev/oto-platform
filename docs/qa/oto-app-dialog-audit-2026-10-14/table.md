| # | file:line | kind | title (screen) | container classes | class | note |
|---|---|---|---|---|---|---|
| 1 | components/ai-event-assistant.tsx:289 | Sheet |  AI Event Assistant | `w-full sm:max-w-lg flex flex-col` | A | Sheet: header + ScrollArea flex-1 + footer bar |
| 2 | components/beo/beo-billing-module.tsx:627 | Dialog | editingItem ? "Edit Line Item" : "Add Manual  | `max-w-md` | B (dead) | UNROUTED. No cap; tall (7 fields / 94 lines) |
| 3 | components/beo/beo-billing-module.tsx:726 | Dialog |  Generate Billing from BEO | `max-w-md` | B-ok (dead) | UNROUTED. No cap; short content |
| 4 | components/beo/beo-billing-module.tsx:790 | Dialog | Add from Templates | `max-w-lg max-h-[80vh] overflow-y-auto` | W (dead) | UNROUTED. Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 5 | components/beo/beo-day-of-view.tsx:1888 | Dialog |  Parent Menu Selection Link | `max-w-md` | B-ok | No cap; short content |
| 6 | components/beo/beo-event-editor.tsx:3271 | Dialog |  aiFillStep === "paste"  | `max-w-2xl max-h-[85vh] flex flex-col` | A |  |
| 7 | components/beo/beo-event-editor.tsx:3439 | Dialog |  Parent Menu Selection Link | `max-w-md` | B-ok | No cap; short content |
| 8 | components/beo/beo-package-module.tsx:674 | Dialog | Add Entertainment | `(base)` | B-ok | No cap; short content |
| 9 | components/beo/entertainment-templates-settings.tsx:245 | Dialog | editing ? "Edit Entertainment Template" : "Ad | `(base)` | B | No cap; tall (7 fields / 93 lines) |
| 10 | components/beo/line-item-templates-settings.tsx:274 | Dialog | editing ? "Edit Line Item Template" : "Add Li | `max-w-md` | B | No cap; tall (7 fields / 111 lines) |
| 11 | components/beo/set-menu-templates-settings.tsx:367 | Dialog | editingTemplate ? "Edit Set Menu Template" :  | `max-w-lg max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 12 | components/clickable-employee-avatar.tsx:73 | Dialog | fullName | `sm:max-w-md` | B-ok | No cap; short content |
| 13 | components/create-checklist-dialog.tsx:363 | Dialog | Create Checklist Template | `max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto` | W+N | Ops checklist quick-create. Live 1080px natural: whole card scrolls at BOTH 1080 and 800, title/footer scroll away, nested Branches list scroller |
| 14 | components/create-task-dialog.tsx:366 | Sheet | Create Task | `w-[400px] sm:w-[480px] sm:max-w-[480px] p-0 flex flex-col` | A | Sheet: body scroll + absolute footer bar |
| 15 | components/hiring/GenerateHiringPostDialog.tsx:199 | Dialog |  Generate Hiring Post | `max-w-4xl max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 16 | components/interactive-checklist.tsx:148 | Dialog | viewingImage?.title | `max-w-2xl` | B-ok | No cap; short content |
| 17 | components/issue-warning-modal.tsx:208 | Dialog |  step === "comple | `max-w-lg` | B | Live 732px step 1; fits 800 by 34px |
| 18 | components/media/MediaViewerModal.tsx:138 | Dialog | Media Viewer | `max-w-[95vw] max-h-[95vh] w-full h-full p-0 bg-black/95 border-none` | A | Full-screen media viewer (exempt: designed to fill) |
| 19 | components/nanny-calendar.tsx:654 | Dialog | Reserve Nanny | `max-w-sm` | B-ok | No cap; short content |
| 20 | components/notification-bell.tsx:120 | Sheet | Notifications | `w-full sm:max-w-md p-0 flex flex-col gap-0` | A | Sheet: header + ScrollArea body |
| 21 | components/offboarding-modal.tsx:211 | Dialog |  step === "complete" ? "Offboarding Comp | `max-w-lg` | B | Live 812px: clips at 800 (top -6, bottom 806) |
| 22 | components/ops/ChecklistRunSheet.tsx:17 | Dialog | Checklist Details | `w-[min(96vw,560px)] max-w-[560px] h-[min(92vh,900px)] p-0 gap-0 overflow-hidden` | D | Fixed height h-[min(92vh,900px)] even when content is short |
| 23 | components/ops/TaskDetailSheet.tsx:887 | Sheet | Task Details | `w-[400px] sm:w-[500px] sm:max-w-[500px] p-0 flex flex-col` | A | Sheet: body scroll + absolute comment bar |
| 24 | components/phone-verification.tsx:256 | AlertDialog | Remove Phone Number? | `(base)` | B-ok | Short confirm |
| 25 | components/scheduling/BorrowStaffModal.tsx:124 | Dialog |  Find Staff from Other Branches | `max-w-lg max-h-[80vh] overflow-hidden flex flex-col` | A |  |
| 26 | components/scheduling/DutyBlocksSheet.tsx:261 | Sheet |  Duty Blocks | `h-[85vh] sm:h-[70vh] rounded-t-xl p-0` | A | Bottom sheet fixed 85/70vh with ScrollArea body |
| 27 | components/scheduling/EmployeeInfoPopup.tsx:158 | Dialog | Employee Information | `sm:max-w-md max-h-[85vh] overflow-hidden flex flex-col` | A |  |
| 28 | components/session-replay-dialog.tsx:41 | Dialog | Start Recording | `sm:max-w-md` | B-ok | No cap; short content |
| 29 | components/studio/knowledge-files.tsx:446 | Dialog | Upload Knowledge File | `max-w-md` | B-ok | No cap; short content |
| 30 | components/studio/knowledge-files.tsx:553 | Dialog | viewingFile && getFileIcon(viewingFile.fileTy | `max-w-2xl max-h-[80vh] overflow-hidden flex flex-col` | A |  |
| 31 | components/studio/knowledge-files.tsx:620 | AlertDialog | Delete File | `(base)` | B-ok | Short confirm |
| 32 | components/update-terms-modal.tsx:235 | Dialog | transferResult ? "Transfer Complete" : "Gener | `(base)` | B-ok | No cap; short content |
| 33 | components/update-terms-modal.tsx:275 | Dialog | Update Employment Terms | `max-w-md` | B-ok | Live 558px, fits both |
| 34 | pages/access-config-page.tsx:295 | Dialog |  editingItem ? "Edit Access Item" : "New  | `max-w-lg max-h-[90vh] overflow-y-auto` | W+N | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 35 | pages/access-page.tsx:249 | Dialog |  selectedItem?.title | `max-w-md` | B-ok | No cap; short content |
| 36 | pages/advisors-page.tsx:488 | Dialog | Advisor Kiosk Enrollment | `max-w-md` | B-ok | No cap; short content |
| 37 | pages/advisors-page.tsx:512 | Dialog | selectedPerson ? "Edit Advisor" : "Add New Ad | `max-w-md max-h-[85vh] overflow-y-auto` | C+W | Modules row `flex gap-4` (6 items incl. "Studio (Legacy)") does not wrap: 66px wider than the card; card is the scroller so it shows a sideways bar. Also 1111px tall: scrolls at 1080 too |
| 38 | pages/advisors-page.tsx:723 | Dialog | Manage Access - selectedPerson?.preferredName | `max-w-lg` | B-ok | Live: 512x488, fits; "Studio (Legacy)" wraps inside 512px so no overflow |
| 39 | pages/advisors-page.tsx:848 | AlertDialog | Delete Advisor | `(base)` | B-ok | Short confirm |
| 40 | pages/attention-page.tsx:356 | AlertDialog |  Condition Still Act | `(base)` | B-ok | Short confirm |
| 41 | pages/branches-page.tsx:417 | Dialog | editingBranch ? "Edit Branch" : "Create New B | `(base)` | B-ok | No cap; short content |
| 42 | pages/branches-page.tsx:670 | Dialog | Delete Branch | `(base)` | B-ok | No cap; short content |
| 43 | pages/branches-page.tsx:698 | Dialog | Branch Logo | `sm:max-w-md` | B-ok | No cap; short content |
| 44 | pages/branches-page.tsx:760 | Dialog | selectedQrBranch?.name Check-in QR | `max-w-sm` | B-ok | No cap; short content |
| 45 | pages/branches-page.tsx:797 | Dialog | Reception Kiosk Setup | `max-w-md` | B-ok | No cap; short content |
| 46 | pages/casual-workers-page.tsx:352 | AlertDialog | Deactivate Casual Worker | `(base)` | B-ok | Short confirm |
| 47 | pages/casual-workers-page.tsx:374 | AlertDialog | Delete Casual Worker | `(base)` | B-ok | Short confirm |
| 48 | pages/casual-workers-page.tsx:411 | Dialog | editingWorker ? "Edit Casual Worker" : "Add C | `max-w-md` | B | Live 704px; fits 800 tightly |
| 49 | pages/contract-detail-page.tsx:631 | Dialog | Send Contract via Email | `sm:max-w-[500px]` | B-ok | No cap; short content |
| 50 | pages/contracts-page.tsx:559 | AlertDialog | Delete Contract | `(base)` | B-ok | Short confirm |
| 51 | pages/contracts-page.tsx:583 | AlertDialog | Archive Contract | `(base)` | B-ok | Short confirm |
| 52 | pages/core_admin/branches.tsx:152 | Dialog | selectedBranch?.name QR Code | `max-w-sm` | B-ok (dead) | UNROUTED. No cap; short content |
| 53 | pages/core_admin/events.tsx:274 | Dialog | editingEvent ? t.events.editEvent : t.events. | `max-w-lg max-h-[90vh] overflow-y-auto` | W (dead) | UNROUTED. Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 54 | pages/core_admin/events.tsx:517 | AlertDialog | Cancel Event? | `(base)` | B-ok (dead) | UNROUTED. Short confirm |
| 55 | pages/core-tasks-page.tsx:341 | Dialog | Create Task | `max-w-md` | B-ok (dead) | UNROUTED. No cap; short content |
| 56 | pages/core-tasks-page.tsx:480 | Sheet | task.title | `w-full sm:max-w-lg overflow-y-auto` | W (dead) | UNROUTED. Sheet scrolls as a whole: title and footer scroll away |
| 57 | pages/core/ask.tsx:525 | Dialog | articleDetail?.title // selectedArticle?.titl | `max-w-2xl max-h-[80vh]` | D | max-h on a grid card with no overflow; relies on ScrollArea max-h (Radix viewport does not honour max-h) |
| 58 | pages/core/checkins.tsx:304 | Dialog | Notes & Restrictions for checkin.childFullNam | `(base)` | B-ok | No cap; short content |
| 59 | pages/core/checkins.tsx:703 | Dialog | Check In Child | `max-w-sm` | B-ok | No cap; short content |
| 60 | pages/core/checkins.tsx:762 | Dialog | Check Out Child | `max-w-sm` | B-ok | No cap; short content |
| 61 | pages/core/checkins.tsx:1401 | Dialog | Assign Service Details | `max-w-sm` | B-ok | No cap; short content |
| 62 | pages/core/checkins.tsx:1476 | Dialog | Assign Nanny | `max-w-sm` | B-ok | No cap; short content |
| 63 | pages/core/checkins.tsx:1543 | Dialog | Check Out Child | `max-w-md` | B-ok | No cap; short content |
| 64 | pages/core/dashboard.tsx:590 | Dialog |  Task Details | `max-w-md max-h-[85vh] flex flex-col` | A |  |
| 65 | pages/core/dashboard.tsx:659 | Dialog |  Event Details | `max-w-md max-h-[85vh] flex flex-col` | A |  |
| 66 | pages/core/dashboard.tsx:747 | Dialog |  Checklist Run Details | `max-w-md max-h-[85vh] flex flex-col` | A |  |
| 67 | pages/core/dashboard.tsx:801 | Dialog |  Issue Details | `max-w-md max-h-[85vh] flex flex-col` | A |  |
| 68 | pages/core/dashboard.tsx:875 | Dialog |  Escalation Details | `max-w-md max-h-[85vh] flex flex-col` | A |  |
| 69 | pages/core/event-detail.tsx:221 | Dialog | Add Task for Event | `max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 70 | pages/core/fix-board.tsx:725 | Dialog |  Mark as Complete | `max-w-sm` | B-ok | No cap; short content |
| 71 | pages/core/fix-board.tsx:812 | Dialog |  | `max-w-lg max-h-[90vh] flex flex-col p-0 gap-0` | A |  |
| 72 | pages/core/fix.tsx:158 | Dialog |  | `max-w-lg max-h-[90vh] flex flex-col p-0 gap-0` | A |  |
| 73 | pages/core/form-builder.tsx:765 | Dialog | Publish Form | `(base)` | B-ok | No cap; short content |
| 74 | pages/core/task-detail-multiday.tsx:769 | Dialog | Block Task | `(base)` | B-ok (dead) | UNROUTED. No cap; short content |
| 75 | pages/core/tasks.tsx:1183 | Dialog | Create Task | `max-w-lg` | A2 (dead) | UNROUTED. Body max-h-[60vh] (unrouted page) |
| 76 | pages/core/tasks.tsx:1676 | Dialog |  Task Details | `max-w-md max-h-[85vh] flex flex-col p-0` | A (dead) | UNROUTED.  |
| 77 | pages/core/tasks.tsx:1816 | Dialog |  Recent Updates | `max-w-md max-h-[80vh] flex flex-col p-0` | A (dead) | UNROUTED.  |
| 78 | pages/core/today.tsx:971 | Dialog | checkinEvent?.title | `sm:max-w-lg max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 79 | pages/core/today.tsx:1188 | Dialog | Quick Task | `max-w-md` | B-ok | No cap; short content |
| 80 | pages/data/model-detail-page.tsx:112 | AlertDialog | Delete this model?.name? | `(base)` | B-ok | Short confirm |
| 81 | pages/departments-page.tsx:247 | Dialog | Create Department | `(base)` | B-ok | No cap; short content |
| 82 | pages/departments-page.tsx:427 | Dialog | Edit Department | `(base)` | B-ok | No cap; short content |
| 83 | pages/departments-page.tsx:492 | Dialog | Assign Employees to assigningDept?.name | `max-w-lg` | D | Fixed ScrollArea h-[400px] list; always 400px regardless of screen |
| 84 | pages/employee-editor-page.tsx:632 | Dialog | Enable Login Access | `max-w-md` | B-ok | Live step 1: 496px, fits (later steps not driven) |
| 85 | pages/employee-editor-page.tsx:827 | Dialog | Edit Module Overrides | `max-w-lg max-h-[80vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 86 | pages/employee-editor-page.tsx:933 | Dialog | Edit Access Settings | `max-w-md` | B | Live 772px: fits 800 with 14px to spare, no cap |
| 87 | pages/employee-editor-page.tsx:1111 | Dialog | Generate Login | `max-w-md` | B-ok | No cap; short content |
| 88 | pages/employee-editor-page.tsx:1212 | Dialog | Reset Password | `max-w-md` | B-ok | No cap; short content |
| 89 | pages/employees-page.tsx:297 | AlertDialog | Delete Employee | `(base)` | B-ok | Short confirm |
| 90 | pages/employees-page.tsx:541 | AlertDialog | Delete Employee | `(base)` | B-ok | Short confirm |
| 91 | pages/employees-page.tsx:1124 | AlertDialog | Delete selectedEmployees.size Employees | `(base)` | B-ok | Short confirm |
| 92 | pages/locations-page.tsx:359 | Dialog | Create Location | `max-h-[90vh] overflow-y-auto` | W | Card scrolls whole; short form, rarely triggers |
| 93 | pages/locations-page.tsx:413 | Dialog | Edit Location | `max-h-[90vh] overflow-y-auto` | W | Card scrolls whole; short form, rarely triggers |
| 94 | pages/operators-page.tsx:356 | Dialog | Create Operator | `max-w-lg max-h-[90vh] overflow-y-auto` | W | Card scrolls whole; short form, rarely triggers |
| 95 | pages/operators-page.tsx:428 | Dialog | Edit Operator | `max-w-lg max-h-[90vh] overflow-y-auto` | W | Card scrolls whole; short form, rarely triggers |
| 96 | pages/ops/index.tsx:1445 | AlertDialog | Delete deleteTarget?.type === "task" ? "Task" | `(base)` | B-ok | Short confirm |
| 97 | pages/ops/index.tsx:1460 | AlertDialog | Override Status | `(base)` | B-ok | Short confirm |
| 98 | pages/ops/index.tsx:1489 | Dialog | Quick Task | `sm:max-w-md` | B-ok | No cap; short content |
| 99 | pages/ops/index.tsx:1586 | Sheet |  Recent Updates | `max-h-[70vh] rounded-t-xl p-0` | A | Bottom sheet max-h 70vh, ScrollArea body |
| 100 | pages/ops/index.tsx:1674 | Dialog | editingAnnouncementId ? "Edit Announcement" : | `max-w-md max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 101 | pages/ops/index.tsx:2104 | Dialog | Reschedule Task | `(base)` | B-ok | No cap; short content |
| 102 | pages/ops/index.tsx:2294 | Dialog | expandedDate && new Date(expandedDate + "T00: | `sm:max-w-md max-h-[80vh] flex flex-col` | A |  |
| 103 | pages/org-chart-page.tsx:834 | Dialog | Edit isVacant ? "Vacant Position" : displayNa | `max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 104 | pages/org-chart-page.tsx:1246 | Dialog | Add Vacant Position | `(base)` | B | No cap; tall (7 fields / 112 lines) |
| 105 | pages/payroll-page.tsx:376 | Dialog | Create Payroll Period | `(base)` | B-ok | No cap; short content |
| 106 | pages/payroll-periods-page.tsx:169 | Dialog | Create Payroll Period | `(base)` | B-ok | Live 284px tall, fits |
| 107 | pages/payroll-statutory-rules-page.tsx:578 | Dialog | Create Statutory Rule Set | `max-w-2xl max-h-[90vh] overflow-y-auto` | W+N | Live 1116px natural: whole card scrolls even at 1080, title/footer scroll away; JSON textarea scroller nested inside |
| 108 | pages/payroll-statutory-rules-page.tsx:721 | Dialog | Edit Statutory Rule Set | `max-w-2xl max-h-[90vh] overflow-y-auto` | W | Card scrolls whole; short form, rarely triggers |
| 109 | pages/permissions-page.tsx:664 | Dialog | Edit Permissions - editPerson?.nickname // ed | `max-w-md max-h-[85vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 110 | pages/policies-page.tsx:1368 | Dialog | Publish Policy Document? | `(base)` | B-ok | No cap; short content |
| 111 | pages/policies-page.tsx:1406 | Dialog | editingLeavePolicy ? "Edit Leave Policy" : "C | `(base)` | B-ok | Live 560px, fits |
| 112 | pages/policies-page.tsx:1523 | Dialog | Delete Leave Policy? | `(base)` | B-ok | No cap; short content |
| 113 | pages/policies-page.tsx:1563 | Dialog | editingHoliday ? "Edit Public Holiday" : "Add | `(base)` | B-ok | No cap; short content |
| 114 | pages/policies-page.tsx:1611 | Dialog | Delete Public Holiday? | `(base)` | B-ok | No cap; short content |
| 115 | pages/public/supplier-portal.tsx:349 | Dialog |  details?.title // "Fix Request" | `max-w-lg max-h-[90vh] overflow-y-auto` | W+N | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 116 | pages/roles-page.tsx:242 | Dialog | Create Role | `(base)` | B-ok | No cap; short content |
| 117 | pages/roles-page.tsx:413 | Dialog | Edit Role | `(base)` | B-ok | No cap; short content |
| 118 | pages/roles-page.tsx:479 | Dialog | Assign Employees to assigningRole?.name | `max-w-lg` | D | Fixed ScrollArea h-[400px] list |
| 119 | pages/scheduling-page.tsx:4973 | Dialog | Create Shift Group | `sm:max-w-md` | B-ok | No cap; short content |
| 120 | pages/scheduling-page.tsx:5013 | Dialog | Add Shift | `(base)` | B | Add Shift: 906px natural, no cap; clips at 800 (verified) |
| 121 | pages/scheduling-page.tsx:5183 | Dialog | Edit Shift | `max-h-[85vh] overflow-hidden flex flex-col !grid-rows-none` | A | Reference pattern (cap 85vh, header/footer flex-shrink-0, body overflow-y-auto min-h-0). Body still scrolls at 1080 (natural 916 > 918 cap) |
| 122 | pages/scheduling-page.tsx:5413 | Dialog | Save as Template | `(base)` | B-ok | No cap; short content |
| 123 | pages/scheduling-page.tsx:5491 | Dialog | templateApplyStep === "select" ? "Apply Templ | `sm:max-w-lg` | B | No cap; tall (1 fields / 171 lines) |
| 124 | pages/scheduling-page.tsx:5669 | Dialog | Clear Week Schedule | `(base)` | B-ok | No cap; short content |
| 125 | pages/scheduling-page.tsx:5766 | Dialog | Set Weekly Off Days | `sm:max-w-md` | B-ok | No cap; short content |
| 126 | pages/scheduling-page.tsx:5859 | Dialog |  Scan & Fix Schedu | `sm:max-w-xl max-h-[80vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 127 | pages/scheduling-page.tsx:6039 | Dialog | Merge Shift Rows | `sm:max-w-xl max-h-[80vh] overflow-y-auto` | W+N | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 128 | pages/scheduling-page.tsx:6303 | Dialog | Schedule History | `sm:max-w-2xl max-h-[80vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 129 | pages/scheduling-page.tsx:6369 | Dialog | Confirm Restore | `sm:max-w-md` | B-ok | No cap; short content |
| 130 | pages/settings-page.tsx:359 | AlertDialog | Replace development data? | `(base)` | B-ok | Short confirm |
| 131 | pages/settings-page.tsx:652 | Dialog | Capture MD Signature | `sm:max-w-lg` | B-ok | No cap; short content |
| 132 | pages/signing-page.tsx:641 | Dialog |  policyData?.title (Version policyD | `max-w-4xl max-h-[90vh] overflow-hidden flex flex-col` | A |  |
| 133 | pages/studio/camp-detail.tsx:1280 | Sheet |  Child Profile | `w-full sm:max-w-lg overflow-y-auto` | W | Sheet scrolls as a whole: title and footer scroll away |
| 134 | pages/studio/camp-detail.tsx:1455 | AlertDialog | Remove from Camp? | `(base)` | B-ok | Short confirm |
| 135 | pages/studio/camp-detail.tsx:1488 | Sheet | Edit Camp Event | `w-full sm:max-w-md overflow-y-auto` | W | Sheet scrolls as a whole: title and footer scroll away |
| 136 | pages/studio/camp-detail.tsx:1711 | AlertDialog | Cancel Entire Camp? | `(base)` | B-ok | Short confirm |
| 137 | pages/studio/camp-detail.tsx:1736 | Dialog | Edit Attendance | `max-w-sm` | B-ok | No cap; short content |
| 138 | pages/studio/camp-detail.tsx:1814 | Dialog |  Add Child to Camp | `max-w-lg max-h-[90vh] overflow-y-auto` | W+N | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 139 | pages/studio/camp-detail.tsx:2168 | Dialog |  Convert to Full Profile | `max-w-lg max-h-[90vh] flex flex-col` | A |  |
| 140 | pages/studio/camp-detail.tsx:2299 | Dialog | event?.title | `max-w-sm mx-auto` | B-ok | No cap; short content |
| 141 | pages/studio/checklists.tsx:913 | Dialog | Edit Checklist Template checklistType === "ch | `max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto` | W | Card scrolls whole (90vh); mobile forced full-height |
| 142 | pages/studio/checklists.tsx:1537 | Dialog | Create Checklist Template | `max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto` | W+N | Card scrolls whole (90vh) + nested max-h-40 list |
| 143 | pages/studio/checklists.tsx:2352 | Dialog | Checker History | `max-w-md max-h-[80vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 144 | pages/studio/children.tsx:613 | Sheet |  Child Profile | `w-full sm:max-w-lg overflow-y-auto` | W | Sheet scrolls as a whole: title and footer scroll away |
| 145 | pages/studio/children.tsx:765 | Dialog |  Enroll in Camp | `sm:max-w-md` | B-ok | No cap; short content |
| 146 | pages/studio/children.tsx:833 | Dialog |  Find Duplicate Profil | `sm:max-w-2xl max-h-[80vh] flex flex-col` | A |  |
| 147 | pages/studio/children.tsx:974 | Dialog |  Merge Profiles | `sm:max-w-lg` | A2 | Body max-h-[60vh], header/footer outside |
| 148 | pages/studio/departments.tsx:175 | Dialog | editingDepartment ? "Edit Department" : "Add  | `max-w-sm` | B-ok (dead) | UNROUTED. No cap; short content |
| 149 | pages/studio/event-settings.tsx:482 | Dialog | editingLocation ? "Edit Location" : "Add Loca | `(base)` | B-ok | No cap; short content |
| 150 | pages/studio/event-settings.tsx:565 | Dialog | editingSetup ? "Edit Setup Item" : "Add Setup | `(base)` | B-ok | No cap; short content |
| 151 | pages/studio/events.tsx:2217 | Dialog | isBirthday &&  previewEve | `max-w-sm` | B-ok | No cap; short content |
| 152 | pages/studio/events.tsx:2335 | Dialog | editingEvent ? "Edit Event" : "Create Event" | `max-w-md max-h-[90vh] overflow-y-auto` | W | Live 736px: fits at 1080; at 800 whole card scrolls (title/footer move) |
| 153 | pages/studio/events.tsx:2680 | AlertDialog | Cancel Event? | `(base)` | B-ok | Short confirm |
| 154 | pages/studio/events.tsx:2713 | Dialog | New Event | `max-w-xs` | B-ok | No cap; short content |
| 155 | pages/studio/events.tsx:2775 | Sheet | editingOneOffEvent ? `Edit $EVENT_TYPE_LABELS | `w-full sm:max-w-md overflow-y-auto` | W | Sheet scrolls as a whole: title and footer scroll away |
| 156 | pages/studio/events.tsx:3051 | Dialog | <span className="inline-block w-3 h-3 rounded | `max-w-sm` | B-ok | No cap; short content |
| 157 | pages/studio/events.tsx:3160 | Sheet | editingCampEvent ? "Edit Camp Event" : "Creat | `w-full sm:max-w-md overflow-y-auto` | W | Sheet scrolls as a whole: title and footer scroll away |
| 158 | pages/studio/events.tsx:3408 | Dialog | viewingStudioEvent?.title | `max-w-md max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 159 | pages/studio/events.tsx:3607 | Sheet |  | `w-full sm:max-w-2xl p-0 overflow-hidden` | A | Sheet delegates to BeoEventEditor (own scroll) |
| 160 | pages/studio/events.tsx:3622 | Sheet |  | `w-full sm:max-w-md p-0 overflow-hidden` | A | Sheet delegates to BeoDayOfView (own scroll) |
| 161 | pages/studio/events.tsx:3634 | Sheet | editingBooking ? "Edit Booking" : "Add Bookin | `w-full sm:max-w-lg overflow-y-auto` | W | Sheet scrolls as a whole: title and footer scroll away |
| 162 | pages/studio/knowledge-base.tsx:467 | Dialog | editingArticle ? "Edit Article" : "Create Art | `max-w-lg max-h-[90vh] overflow-y-auto` | W+N | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 163 | pages/studio/knowledge-base.tsx:675 | Dialog |  Version History | `max-w-md max-h-[80vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 164 | pages/studio/quizzes.tsx:185 | Dialog | editingId ? "Edit training module" : "New tra | `max-w-2xl max-h-[90vh] overflow-y-auto` | W | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| 165 | pages/studio/sops.tsx:421 | Dialog | viewingImage?.title // "Step Photo" | `max-w-2xl` | B-ok | No cap; short content |
| 166 | pages/studio/sops.tsx:715 | Dialog | editingSop ? "Edit SOP" : "Create SOP" | `max-w-2xl max-h-[90vh]` | D | max-h on a grid card with no overflow; ScrollArea max-h calc (same Radix quirk) |
| 167 | pages/studio/tasks.tsx:624 | Dialog | editingTask ? "Edit Task" : "Create Task" | `max-w-lg` | D | Live: body max-h-[60vh] holds the footer buttons too (footer scrolls away); body 1033px so it scrolls even at 1080 |
| 168 | pages/supplier-tokens-page.tsx:256 | Dialog | Create Supplier Token | `(base)` | B-ok | No cap; short content |
| 169 | pages/supplier-tokens-page.tsx:330 | Dialog |  Token Created Successfull | `(base)` | B-ok | No cap; short content |
| 170 | pages/supplier-tokens-page.tsx:392 | AlertDialog | Revoke Supplier Token? | `(base)` | B-ok | Short confirm |
| 171 | pages/templates-page.tsx:529 | Dialog | Manage Branch Assignments | `sm:max-w-md` | B-ok | No cap; short content |
| 172 | pages/templates-page.tsx:584 | Dialog |  Template in Use | `sm:max-w-md` | B-ok | No cap; short content |
| 173 | pages/time-events-page.tsx:448 | Dialog | Add Time Override | `(base)` | B-ok | Live 570px, fits |
| 174 | pages/time-events-page.tsx:632 | Dialog |  PIN Authentication Photo | `sm:max-w-lg` | B-ok | No cap; short content |
| 175 | pages/timekeeping-employee-detail-page.tsx:244 | Dialog | Add Missed Clock Event | `(base)` | B-ok | No cap; short content |
| 176 | pages/timekeeping-employee-detail-page.tsx:649 | Dialog |  PIN Authentication Photo | `sm:max-w-lg` | B-ok | No cap; short content |
| 177 | pages/timekeeping-live-page.tsx:500 | Dialog | photoModalEmployee?.name | `max-w-sm` | B-ok | No cap; short content |
| 178 | pages/timekeeping-live-page.tsx:521 | Dialog | Staff Details | `max-w-sm` | B-ok | No cap; short content |
| 179 | pages/timekeeping-review-page.tsx:748 | Dialog | resolveAction === 'approve' ? 'Approve Time E | `(base)` | B-ok | No cap; short content |
| 180 | pages/timekeeping-review-page.tsx:914 | Dialog | Correct Advisor attendance | `sm:max-w-xl` | B-ok | No cap; short content |
| 181 | pages/timekeeping-review-page.tsx:1004 | Dialog |  PIN Authentication Photos | `sm:max-w-lg` | B-ok | No cap; short content |
| 182 | pages/users-page.tsx:337 | Dialog | editingUser ? "Edit User" : "Create New User" | `max-w-md` | B | Live 806px: clips at 800 (top -3, bottom 803) |
| 183 | pages/users-page.tsx:478 | Dialog | Reset Password | `max-w-md` | B-ok | No cap; short content |