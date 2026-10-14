
## C+W (1)
| advisors-page.tsx:512 | Dialog | selectedPerson ? "Edit Advisor" : "Add | `max-w-md max-h-[85vh] overflow-y-auto` | Modules row `flex gap-4` (6 items incl. "Studio (Legacy)") does not wrap: 66px wider than the card; card is th |

## B (10)
| beo/entertainment-templates-settings.tsx:245 | Dialog | editing ? "Edit Entertainment Template | `base` | No cap; tall (7 fields / 93 lines) |
| beo/line-item-templates-settings.tsx:274 | Dialog | Add Line Item Template / Edit Line Ite | `max-w-md` | No cap; tall (7 fields / 111 lines) |
| issue-warning-modal.tsx:208 | Dialog | step === "comple | `max-w-lg` | Live 732px step 1; fits 800 by 34px |
| offboarding-modal.tsx:211 | Dialog | step === "complete" ? "Offboarding Com | `max-w-lg` | Live 812px: clips at 800 (top -6, bottom 806) |
| casual-workers-page.tsx:411 | Dialog | Add Casual Worker / Edit Casual Worker | `max-w-md` | Live 704px; fits 800 tightly |
| employee-editor-page.tsx:933 | Dialog | Edit Access Settings | `max-w-md` | Live 772px: fits 800 with 14px to spare, no cap |
| org-chart-page.tsx:1246 | Dialog | Add Vacant Position | `base` | No cap; tall (7 fields / 112 lines) |
| scheduling-page.tsx:5013 | Dialog | Add Shift | `base` | Add Shift: 906px natural, no cap; clips at 800 (verified) |
| scheduling-page.tsx:5491 | Dialog | templateApplyStep === "select" ? "Appl | `sm:max-w-lg` | No cap; tall (1 fields / 171 lines) |
| users-page.tsx:337 | Dialog | Create New User / Edit User | `max-w-md` | Live 806px: clips at 800 (top -3, bottom 803) |

## W+N (8)
| create-checklist-dialog.tsx:363 | Dialog | Create Checklist Template | `max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto` | Ops checklist quick-create. Live 1080px natural: whole card scrolls at BOTH 1080 and 800, title/footer scroll  |
| access-config-page.tsx:295 | Dialog | editingItem ? "Edit Access Item" : "Ne | `max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| payroll-statutory-rules-page.tsx:578 | Dialog | Create Statutory Rule Set | `max-w-2xl max-h-[90vh] overflow-y-auto` | Live 1116px natural: whole card scrolls even at 1080, title/footer scroll away; JSON textarea scroller nested  |
| public/supplier-portal.tsx:349 | Dialog | details?.title "Fix Request" | `max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| scheduling-page.tsx:6039 | Dialog | Merge Shift Rows | `sm:max-w-xl max-h-[80vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| studio/camp-detail.tsx:1814 | Dialog | Add Child to Camp | `max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| studio/checklists.tsx:1537 | Dialog | Create Checklist Template | `max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto` | Card scrolls whole (90vh) + nested max-h-40 list |
| studio/knowledge-base.tsx:467 | Dialog | Create Article / Edit Article | `max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |

## W (27)
| beo/set-menu-templates-settings.tsx:367 | Dialog | New Set Menu Template / Edit Set Menu  | `max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| hiring/GenerateHiringPostDialog.tsx:199 | Dialog | Generate Hiring Post | `max-w-4xl max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| core/event-detail.tsx:221 | Dialog | Add Task for Event | `max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| core/today.tsx:971 | Dialog | checkinEvent?.title | `sm:max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| employee-editor-page.tsx:827 | Dialog | Edit Module Overrides | `max-w-lg max-h-[80vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| locations-page.tsx:359 | Dialog | Create Location | `max-h-[90vh] overflow-y-auto` | Card scrolls whole; short form, rarely triggers |
| locations-page.tsx:413 | Dialog | Edit Location | `max-h-[90vh] overflow-y-auto` | Card scrolls whole; short form, rarely triggers |
| operators-page.tsx:356 | Dialog | Create Operator | `max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole; short form, rarely triggers |
| operators-page.tsx:428 | Dialog | Edit Operator | `max-w-lg max-h-[90vh] overflow-y-auto` | Card scrolls whole; short form, rarely triggers |
| ops/index.tsx:1674 | Dialog | New Announcement / Edit Announcement | `max-w-md max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| org-chart-page.tsx:834 | Dialog | Edit isVacant ? "Vacant Position" : di | `max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| payroll-statutory-rules-page.tsx:721 | Dialog | Edit Statutory Rule Set | `max-w-2xl max-h-[90vh] overflow-y-auto` | Card scrolls whole; short form, rarely triggers |
| permissions-page.tsx:664 | Dialog | Edit Permissions - editPerson?.nicknam | `max-w-md max-h-[85vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| scheduling-page.tsx:5859 | Dialog | Scan & Fix Schedu | `sm:max-w-xl max-h-[80vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| scheduling-page.tsx:6303 | Dialog | Schedule History | `sm:max-w-2xl max-h-[80vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| studio/camp-detail.tsx:1280 | Sheet | Child Profile | `w-full sm:max-w-lg overflow-y-auto` | Sheet scrolls as a whole: title and footer scroll away |
| studio/camp-detail.tsx:1488 | Sheet | Edit Camp Event | `w-full sm:max-w-md overflow-y-auto` | Sheet scrolls as a whole: title and footer scroll away |
| studio/checklists.tsx:913 | Dialog | Edit Checklist Template checklistType  | `max-w-md max-h-[90vh] h-[calc(100vh-4rem)] sm:h-auto overflow-y-auto` | Card scrolls whole (90vh); mobile forced full-height |
| studio/checklists.tsx:2352 | Dialog | Checker History | `max-w-md max-h-[80vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| studio/children.tsx:613 | Sheet | Child Profile | `w-full sm:max-w-lg overflow-y-auto` | Sheet scrolls as a whole: title and footer scroll away |
| studio/events.tsx:2335 | Dialog | Create Event / Edit Event | `max-w-md max-h-[90vh] overflow-y-auto` | Live 736px: fits at 1080; at 800 whole card scrolls (title/footer move) |
| studio/events.tsx:2775 | Sheet | editingOneOffEvent ? `Edit $EVENT_TYPE | `w-full sm:max-w-md overflow-y-auto` | Sheet scrolls as a whole: title and footer scroll away |
| studio/events.tsx:3160 | Sheet | Create Camp Event / Edit Camp Event | `w-full sm:max-w-md overflow-y-auto` | Sheet scrolls as a whole: title and footer scroll away |
| studio/events.tsx:3408 | Dialog | viewingStudioEvent?.title | `max-w-md max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| studio/events.tsx:3634 | Sheet | Add Booking / Edit Booking | `w-full sm:max-w-lg overflow-y-auto` | Sheet scrolls as a whole: title and footer scroll away |
| studio/knowledge-base.tsx:675 | Dialog | Version History | `max-w-md max-h-[80vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |
| studio/quizzes.tsx:185 | Dialog | New training module / Edit training mo | `max-w-2xl max-h-[90vh] overflow-y-auto` | Card scrolls whole: title/footer scroll away; overflow-x becomes auto |

## D (6)
| ops/ChecklistRunSheet.tsx:17 | Dialog | Checklist Details | `w-[min(96vw,560px)] max-w-[560px] h-[min(92vh,900px)] p-0 gap-0 overflow-hidden` | Fixed height h-[min(92vh,900px)] even when content is short |
| core/ask.tsx:525 | Dialog | articleDetail?.title selectedArticle?. | `max-w-2xl max-h-[80vh]` | max-h on a grid card with no overflow; relies on ScrollArea max-h (Radix viewport does not honour max-h) |
| departments-page.tsx:492 | Dialog | Assign Employees to assigningDept?.nam | `max-w-lg` | Fixed ScrollArea h-[400px] list; always 400px regardless of screen |
| roles-page.tsx:479 | Dialog | Assign Employees to assigningRole?.nam | `max-w-lg` | Fixed ScrollArea h-[400px] list |
| studio/sops.tsx:715 | Dialog | Create SOP / Edit SOP | `max-w-2xl max-h-[90vh]` | max-h on a grid card with no overflow; ScrollArea max-h calc (same Radix quirk) |
| studio/tasks.tsx:624 | Dialog | Create Task / Edit Task | `max-w-lg` | Live: body max-h-[60vh] holds the footer buttons too (footer scrolls away); body 1033px so it scrolls even at  |

## A2 (1)
| studio/children.tsx:974 | Dialog | Merge Profiles | `sm:max-w-lg` | Body max-h-[60vh], header/footer outside |

## A (25)
| ai-event-assistant.tsx:289 | Sheet | AI Event Assistant | `w-full sm:max-w-lg flex flex-col` | Sheet: header + ScrollArea flex-1 + footer bar |
| beo/beo-event-editor.tsx:3271 | Dialog | aiFillStep === "paste" | `max-w-2xl max-h-[85vh] flex flex-col` |  |
| create-task-dialog.tsx:366 | Sheet | Create Task | `w-[400px] sm:w-[480px] sm:max-w-[480px] p-0 flex flex-col` | Sheet: body scroll + absolute footer bar |
| media/MediaViewerModal.tsx:138 | Dialog | Media Viewer | `max-w-[95vw] max-h-[95vh] w-full h-full p-0 bg-black/95 border-none` | Full-screen media viewer (exempt: designed to fill) |
| notification-bell.tsx:120 | Sheet | Notifications | `w-full sm:max-w-md p-0 flex flex-col gap-0` | Sheet: header + ScrollArea body |
| ops/TaskDetailSheet.tsx:887 | Sheet | Task Details | `w-[400px] sm:w-[500px] sm:max-w-[500px] p-0 flex flex-col` | Sheet: body scroll + absolute comment bar |
| scheduling/BorrowStaffModal.tsx:124 | Dialog | Find Staff from Other Branches | `max-w-lg max-h-[80vh] overflow-hidden flex flex-col` |  |
| scheduling/DutyBlocksSheet.tsx:261 | Sheet | Duty Blocks | `h-[85vh] sm:h-[70vh] rounded-t-xl p-0` | Bottom sheet fixed 85/70vh with ScrollArea body |
| scheduling/EmployeeInfoPopup.tsx:158 | Dialog | Employee Information | `sm:max-w-md max-h-[85vh] overflow-hidden flex flex-col` |  |
| studio/knowledge-files.tsx:553 | Dialog | viewingFile && getFileIcon(viewingFile | `max-w-2xl max-h-[80vh] overflow-hidden flex flex-col` |  |
| core/dashboard.tsx:590 | Dialog | Task Details | `max-w-md max-h-[85vh] flex flex-col` |  |
| core/dashboard.tsx:659 | Dialog | Event Details | `max-w-md max-h-[85vh] flex flex-col` |  |
| core/dashboard.tsx:747 | Dialog | Checklist Run Details | `max-w-md max-h-[85vh] flex flex-col` |  |
| core/dashboard.tsx:801 | Dialog | Issue Details | `max-w-md max-h-[85vh] flex flex-col` |  |
| core/dashboard.tsx:875 | Dialog | Escalation Details | `max-w-md max-h-[85vh] flex flex-col` |  |
| core/fix-board.tsx:812 | Dialog |  | `max-w-lg max-h-[90vh] flex flex-col p-0 gap-0` |  |
| core/fix.tsx:158 | Dialog |  | `max-w-lg max-h-[90vh] flex flex-col p-0 gap-0` |  |
| ops/index.tsx:1586 | Sheet | Recent Updates | `max-h-[70vh] rounded-t-xl p-0` | Bottom sheet max-h 70vh, ScrollArea body |
| ops/index.tsx:2294 | Dialog | expandedDate && new Date(expandedDate  | `sm:max-w-md max-h-[80vh] flex flex-col` |  |
| scheduling-page.tsx:5183 | Dialog | Edit Shift | `max-h-[85vh] overflow-hidden flex flex-col !grid-rows-none` | Reference pattern (cap 85vh, header/footer flex-shrink-0, body overflow-y-auto min-h-0). Body still scrolls at |
| signing-page.tsx:641 | Dialog | policyData?.title (Version policyD | `max-w-4xl max-h-[90vh] overflow-hidden flex flex-col` |  |
| studio/camp-detail.tsx:2168 | Dialog | Convert to Full Profile | `max-w-lg max-h-[90vh] flex flex-col` |  |
| studio/children.tsx:833 | Dialog | Find Duplicate Profil | `sm:max-w-2xl max-h-[80vh] flex flex-col` |  |
| studio/events.tsx:3607 | Sheet |  | `w-full sm:max-w-2xl p-0 overflow-hidden` | Sheet delegates to BeoEventEditor (own scroll) |
| studio/events.tsx:3622 | Sheet |  | `w-full sm:max-w-md p-0 overflow-hidden` | Sheet delegates to BeoDayOfView (own scroll) |

## B-ok (92)
| beo/beo-day-of-view.tsx:1888 | Dialog | Parent Menu Selection Link | `max-w-md` | No cap; short content |
| beo/beo-event-editor.tsx:3439 | Dialog | Parent Menu Selection Link | `max-w-md` | No cap; short content |
| beo/beo-package-module.tsx:674 | Dialog | Add Entertainment | `base` | No cap; short content |
| clickable-employee-avatar.tsx:73 | Dialog | fullName | `sm:max-w-md` | No cap; short content |
| interactive-checklist.tsx:148 | Dialog | viewingImage?.title | `max-w-2xl` | No cap; short content |
| nanny-calendar.tsx:654 | Dialog | Reserve Nanny | `max-w-sm` | No cap; short content |
| phone-verification.tsx:256 | AlertDialog | Remove Phone Number? | `base` | Short confirm |
| session-replay-dialog.tsx:41 | Dialog | Start Recording | `sm:max-w-md` | No cap; short content |
| studio/knowledge-files.tsx:446 | Dialog | Upload Knowledge File | `max-w-md` | No cap; short content |
| studio/knowledge-files.tsx:620 | AlertDialog | Delete File | `base` | Short confirm |
| update-terms-modal.tsx:235 | Dialog | transferResult ? "Transfer Complete" : | `base` | No cap; short content |
| update-terms-modal.tsx:275 | Dialog | Update Employment Terms | `max-w-md` | Live 558px, fits both |
| access-page.tsx:249 | Dialog | selectedItem?.title | `max-w-md` | No cap; short content |
| advisors-page.tsx:488 | Dialog | Advisor Kiosk Enrollment | `max-w-md` | No cap; short content |
| advisors-page.tsx:723 | Dialog | Manage Access - selectedPerson?.prefer | `max-w-lg` | Live: 512x488, fits; "Studio (Legacy)" wraps inside 512px so no overflow |
| advisors-page.tsx:848 | AlertDialog | Delete Advisor | `base` | Short confirm |
| attention-page.tsx:356 | AlertDialog | Condition Still Act | `base` | Short confirm |
| branches-page.tsx:417 | Dialog | Create New Branch / Edit Branch | `base` | No cap; short content |
| branches-page.tsx:670 | Dialog | Delete Branch | `base` | No cap; short content |
| branches-page.tsx:698 | Dialog | Branch Logo | `sm:max-w-md` | No cap; short content |
| branches-page.tsx:760 | Dialog | selectedQrBranch?.name Check-in QR | `max-w-sm` | No cap; short content |
| branches-page.tsx:797 | Dialog | Reception Kiosk Setup | `max-w-md` | No cap; short content |
| casual-workers-page.tsx:352 | AlertDialog | Deactivate Casual Worker | `base` | Short confirm |
| casual-workers-page.tsx:374 | AlertDialog | Delete Casual Worker | `base` | Short confirm |
| contract-detail-page.tsx:631 | Dialog | Send Contract via Email | `sm:max-w-[500px]` | No cap; short content |
| contracts-page.tsx:559 | AlertDialog | Delete Contract | `base` | Short confirm |
| contracts-page.tsx:583 | AlertDialog | Archive Contract | `base` | Short confirm |
| core/checkins.tsx:304 | Dialog | Notes & Restrictions for checkin.child | `base` | No cap; short content |
| core/checkins.tsx:703 | Dialog | Check In Child | `max-w-sm` | No cap; short content |
| core/checkins.tsx:762 | Dialog | Check Out Child | `max-w-sm` | No cap; short content |
| core/checkins.tsx:1401 | Dialog | Assign Service Details | `max-w-sm` | No cap; short content |
| core/checkins.tsx:1476 | Dialog | Assign Nanny | `max-w-sm` | No cap; short content |
| core/checkins.tsx:1543 | Dialog | Check Out Child | `max-w-md` | No cap; short content |
| core/fix-board.tsx:725 | Dialog | Mark as Complete | `max-w-sm` | No cap; short content |
| core/form-builder.tsx:765 | Dialog | Publish Form | `base` | No cap; short content |
| core/today.tsx:1188 | Dialog | Quick Task | `max-w-md` | No cap; short content |
| data/model-detail-page.tsx:112 | AlertDialog | Delete this model?.name? | `base` | Short confirm |
| departments-page.tsx:247 | Dialog | Create Department | `base` | No cap; short content |
| departments-page.tsx:427 | Dialog | Edit Department | `base` | No cap; short content |
| employee-editor-page.tsx:632 | Dialog | Enable Login Access | `max-w-md` | Live step 1: 496px, fits (later steps not driven) |
| employee-editor-page.tsx:1111 | Dialog | Generate Login | `max-w-md` | No cap; short content |
| employee-editor-page.tsx:1212 | Dialog | Reset Password | `max-w-md` | No cap; short content |
| employees-page.tsx:297 | AlertDialog | Delete Employee | `base` | Short confirm |
| employees-page.tsx:541 | AlertDialog | Delete Employee | `base` | Short confirm |
| employees-page.tsx:1124 | AlertDialog | Delete selectedEmployees.size Employee | `base` | Short confirm |
| ops/index.tsx:1445 | AlertDialog | Delete deleteTarget?.type === "task" ? | `base` | Short confirm |
| ops/index.tsx:1460 | AlertDialog | Override Status | `base` | Short confirm |
| ops/index.tsx:1489 | Dialog | Quick Task | `sm:max-w-md` | No cap; short content |
| ops/index.tsx:2104 | Dialog | Reschedule Task | `base` | No cap; short content |
| payroll-page.tsx:376 | Dialog | Create Payroll Period | `base` | No cap; short content |
| payroll-periods-page.tsx:169 | Dialog | Create Payroll Period | `base` | Live 284px tall, fits |
| policies-page.tsx:1368 | Dialog | Publish Policy Document? | `base` | No cap; short content |
| policies-page.tsx:1406 | Dialog | Create Leave Policy / Edit Leave Polic | `base` | Live 560px, fits |
| policies-page.tsx:1523 | Dialog | Delete Leave Policy? | `base` | No cap; short content |
| policies-page.tsx:1563 | Dialog | Add Public Holiday / Edit Public Holid | `base` | No cap; short content |
| policies-page.tsx:1611 | Dialog | Delete Public Holiday? | `base` | No cap; short content |
| roles-page.tsx:242 | Dialog | Create Role | `base` | No cap; short content |
| roles-page.tsx:413 | Dialog | Edit Role | `base` | No cap; short content |
| scheduling-page.tsx:4973 | Dialog | Create Shift Group | `sm:max-w-md` | No cap; short content |
| scheduling-page.tsx:5413 | Dialog | Save as Template | `base` | No cap; short content |
| scheduling-page.tsx:5669 | Dialog | Clear Week Schedule | `base` | No cap; short content |
| scheduling-page.tsx:5766 | Dialog | Set Weekly Off Days | `sm:max-w-md` | No cap; short content |
| scheduling-page.tsx:6369 | Dialog | Confirm Restore | `sm:max-w-md` | No cap; short content |
| settings-page.tsx:359 | AlertDialog | Replace development data? | `base` | Short confirm |
| settings-page.tsx:652 | Dialog | Capture MD Signature | `sm:max-w-lg` | No cap; short content |
| studio/camp-detail.tsx:1455 | AlertDialog | Remove from Camp? | `base` | Short confirm |
| studio/camp-detail.tsx:1711 | AlertDialog | Cancel Entire Camp? | `base` | Short confirm |
| studio/camp-detail.tsx:1736 | Dialog | Edit Attendance | `max-w-sm` | No cap; short content |
| studio/camp-detail.tsx:2299 | Dialog | event?.title | `max-w-sm mx-auto` | No cap; short content |
| studio/children.tsx:765 | Dialog | Enroll in Camp | `sm:max-w-md` | No cap; short content |
| studio/event-settings.tsx:482 | Dialog | Add Location / Edit Location | `base` | No cap; short content |
| studio/event-settings.tsx:565 | Dialog | Add Setup Item / Edit Setup Item | `base` | No cap; short content |
| studio/events.tsx:2217 | Dialog | isBirthday && previewEve | `max-w-sm` | No cap; short content |
| studio/events.tsx:2680 | AlertDialog | Cancel Event? | `base` | Short confirm |
| studio/events.tsx:2713 | Dialog | New Event | `max-w-xs` | No cap; short content |
| studio/events.tsx:3051 | Dialog | <span className="inline-block w-3 h-3  | `max-w-sm` | No cap; short content |
| studio/sops.tsx:421 | Dialog | viewingImage?.title "Step Photo" | `max-w-2xl` | No cap; short content |
| supplier-tokens-page.tsx:256 | Dialog | Create Supplier Token | `base` | No cap; short content |
| supplier-tokens-page.tsx:330 | Dialog | Token Created Successfull | `base` | No cap; short content |
| supplier-tokens-page.tsx:392 | AlertDialog | Revoke Supplier Token? | `base` | Short confirm |
| templates-page.tsx:529 | Dialog | Manage Branch Assignments | `sm:max-w-md` | No cap; short content |
| templates-page.tsx:584 | Dialog | Template in Use | `sm:max-w-md` | No cap; short content |
| time-events-page.tsx:448 | Dialog | Add Time Override | `base` | Live 570px, fits |
| time-events-page.tsx:632 | Dialog | PIN Authentication Photo | `sm:max-w-lg` | No cap; short content |
| timekeeping-employee-detail-page.tsx:244 | Dialog | Add Missed Clock Event | `base` | No cap; short content |
| timekeeping-employee-detail-page.tsx:649 | Dialog | PIN Authentication Photo | `sm:max-w-lg` | No cap; short content |
| timekeeping-live-page.tsx:500 | Dialog | photoModalEmployee?.name | `max-w-sm` | No cap; short content |
| timekeeping-live-page.tsx:521 | Dialog | Staff Details | `max-w-sm` | No cap; short content |
| timekeeping-review-page.tsx:748 | Dialog | resolveAction === 'approve' ? 'Approve | `base` | No cap; short content |
| timekeeping-review-page.tsx:914 | Dialog | Correct Advisor attendance | `sm:max-w-xl` | No cap; short content |
| timekeeping-review-page.tsx:1004 | Dialog | PIN Authentication Photos | `sm:max-w-lg` | No cap; short content |
| users-page.tsx:478 | Dialog | Reset Password | `max-w-md` | No cap; short content |

## dead
components/beo/beo-billing-module.tsx:627 B
components/beo/beo-billing-module.tsx:726 B-ok
components/beo/beo-billing-module.tsx:790 W
pages/core_admin/branches.tsx:152 B-ok
pages/core_admin/events.tsx:274 W
pages/core_admin/events.tsx:517 B-ok
pages/core-tasks-page.tsx:341 B-ok
pages/core-tasks-page.tsx:480 W
pages/core/task-detail-multiday.tsx:769 B-ok
pages/core/tasks.tsx:1183 A2
pages/core/tasks.tsx:1676 A
pages/core/tasks.tsx:1816 A
pages/studio/departments.tsx:175 B-ok
