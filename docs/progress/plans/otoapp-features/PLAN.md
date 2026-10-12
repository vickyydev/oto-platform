# OTO App feature coverage and scope - SCRUM-194

## 13 October development checkpoint

**Current release checkpoint:** Twilio runtime is active on app7402a8da;
configuration proof is committed as a labelled staging card. SCRUM-522 is
built in PR8/cb27d078 with23 focused controls and zero touched-file lint
errors, now Testing. No SMS has been sent and the feature is not deployed.
The authorized receiving number is local-only. Source integration now uses
Fixa347b853, SOP5924faac, attendanceaeab3a23 and presencef077aaea. The
attendance reviewer consistency source01bf0fa5 is ready for integration,
with six handler/database scenarios and six house pins passed. Final combined
checks and all feature staging acceptance remain. Reserve migrations0011-0014
for SOP, attendance evidence, presence inbox and camp SMS respectively, after
R7b0010; assigned numbers and combined snapshots must be verified at landing.

Local database checks are complete and stopped for workstation availability.
Use hosted CI; do not restart Docker or native PostgreSQL until available.

**Latest:** import PR3/db51ee5c, Fix preview PR4/3af75edd, SOP history
PR5/5924faac, attendance evidence PR6/9e79dacc and presence inbox PR7/7c911c02
are published source batches, with their tickets Testing. Fix's R7 integration
is complete, as is SOP integration with 16 controls and all touched-file lint
passing. Final combined migration numbering and release checks remain.
These batches have focused checks; staged release acceptance remains owed.

**SMS provider checkpoint:** SCRUM-522 is building against the current contact
matching behavior. The owner supplied the three existing Twilio variables;
read-only provider validation returned200 with matching account/service and
six-digit codes. Settings are saved on staging; the current runtime remains
unconfigured until deployment. No SMS has been sent. One controlled test is
authorized once the owner supplies local TWILIO_TEST_RECIPIENT; that number
is not a service setting or repository record. Actual receipt and verified
saved-family access remain required before delivery is claimed.

**Item7 source reconciliation:** the original requirement explicitly asks to
verify existing coverage. Current manager Complete, Save Changes and Transfer
Employee actions provide the approval action; existing history stores actor
and time. Q8's direct-action default applies; a second approval stage is not
required. Staged action/history/refusal evidence remains owed. The consistency
register below records failure and replay boundaries separately.

**Q3 answered, 13 October:** use the staff's in-app inbox. Delivered means
the notification is saved and available in that inbox; the existing read/unread
state remains separate. Show pending or failed delivery honestly and support
a reliable retry without duplicate delivery of the same attempt. No SMS
channel is added for presence.

SCRUM-194 is now In Progress. The original scope provides enough detail to
start independent implementation; Q2-Q8 record alternatives or unresolved
details, rather than imposing a blanket stop on the seven items.

- **SCRUM-517:** Fix recipient preview, using the configured department's
  existing staff selection and permissions. No extra routing or delivery
  channel is introduced. Development is starting in an isolated lane.
- **SCRUM-518:** employee import presentation, keeping the existing four
  classifications and matching order. Show New, Changed, Unchanged and Invalid,
  with Matched beside the existing matched employee; it is not a fifth
  mutually exclusive classification. Development is starting separately.
- Optional photo/document attachments can use the existing upload limits and
  request paths without changing pending review or the face-clock switch.
  Those existing kiosk paths remain refused while face clock is disabled;
  attachment support must not reopen them to obtain staging evidence.
- SOP history can preserve immutable revisions and restore content through
  existing edit permissions while retaining publication status. Recovery of
  deleted articles is additional scope, not implied by revision restore.
- Presence delivery follows the answered Q3 in-app inbox definition.
  SMS implementation can reuse the current adapter and matching eligibility;
  actual delivery proof depends on configured service and a controlled number.
- Verify existing manager confirmation and history before adding an approval
  stage. No second approver or delayed effect is inferred.

The owner requested development-first batches with focused checks, followed
by consolidated release verification. These existing-story lanes may progress
alongside the lift's final checks. They land after their dependencies through
the normal gate; no new feature is claimed live by this checkpoint. Each
feature ticket is a sibling under SCRUM-191, because SCRUM-194 is itself a
subtask. The worked fix block remains ahead of any new story.

Prepared 12 October 2026 for S2-17c. The owner's instruction to complete all
subtasks uses the original section 6.2 seven items as the working scope
baseline. This preparation checks that original list against existing code;
it does not request a new blanket scope approval. Open decision 30 remains
part of the recorded scope history, without a claim that it was explicitly
closed. Concrete unanswered behavior and provider details remain below,
with existing behavior as every default. No feature code changed here.

Implementation depends on completing S2-17b/SCRUM-193 and following the
standing fix block in
[OPEN_ITEMS section 2](../../OPEN_ITEMS.md) before any new story starts.
SCRUM-191 therefore stays separate from the completion of its lift work.
Benefit profiles belong to S2-21; POS features remain on their own tickets.

## 1. Evidence and limits

This code-only preparation read the root checkout at
`87be6039219c6381a570ad78c7a2e20f59693ece`. It did not run the seven feature
journeys or make staging requests. The current lift's staging observations
remain in [its QA records](../../../qa/oto-app-lift/round-7/README.md).
Those observations do not establish completion of these candidate features.

The coverage labels below apply only to the named inspected code path.
**WORKS** identifies the existing implemented path described beside it;
its staging acceptance is still owed. **NOT BUILT** identifies a requested
workflow without a matching complete implementation. No **BROKEN** runtime
verdict is recorded by this preparation. A later verification may refine a
coverage label; it must retain the observation and its source.

Scope sources: [S2-17c and Open decision 30](../../SPRINT_2_PLAN.md),
the [feature list section 6.2](../../../briefs/AGENCY_PROPOSAL.md), and
[the development plan](../../../architecture/DEVELOPMENT_PLAN.md).
Record each working-scope item in its own Jira subtask with acceptance and
staging evidence. No ticket status is changed by this document.

## 2. Initial coverage matrix

This is the 12 October source baseline. The 13 October checkpoint above and
the delivery board record the subsequently implemented source; this table
does not override those newer results.

| Item | Current code coverage | Requested feature coverage | Question | Main dependency |
| --- | --- | --- | --- | --- |
| 1. Missed/unscheduled attendance attachments visible before submission | Existing kiosk flows accept reason/note and create pending timekeeping records; their face switch remains in force | NOT BUILT for attached photo/document selection, preview and saved issue attachment | Q2 | Attendance request identity, private file ownership and current manager review |
| 2. Presence notification pending/delivered/failed | Presence stores clock state and event times; in-app notifications store unread/read state | NOT BUILT for delivery-state rows linked to live presence | Q3 | Agreed meaning of delivery, chosen channel and failure reporting |
| 3. Employee spreadsheet preview and row outcomes | WORKS for the current four-state preview, match metadata, selected-row application and per-row results, by code inspection only | NOT BUILT for a distinct fifth Matched status; whether one is required awaits the concrete label/behavior answer | Q4 | Existing matching/validation behavior and tenant/branch access |
| 4. SOP revision history, archive and restore | Current article supports draft/published/archived status and admin edits; article deletion removes the row | NOT BUILT for saved SOP revisions and a revision restore journey | Q5 | Agreed restore meaning, current staff visibility and knowledge indexing |
| 5. Fix recipient preview | Reports use the park's configured Fix department; queue membership is available for the current reader | NOT BUILT for a preview listing the staff who would receive a matching report | Q6 | Agreed recipient meaning and the current department assignment |
| 6. Returning-family six-digit SMS verification | The public camp form looks up saved registrations by event and phone in that event's park | NOT BUILT for the SMS verification step before saved details are returned or changed | Q7 | SMS service, verified contact policy and record-bound verification |
| 7. Review/movement approval and approved history | Managers mark probation reviews complete; movement/term actions record history and apply changes directly | NOT BUILT for a separate submit/approve lifecycle; whether existing manager action meets the request awaits Q8 | Q8 | Agreed approval meaning, reviewer roles and existing movement effects |

## 3. Item records and proposed acceptance

These are proposed checks for the working scope. They do not choose an
unanswered behavior or provider rule. Every item needs its own staged positive
path, refusal path and inspected screenshot or labelled test-run card.

### 1. Attendance attachment selection and preview

Source: [manual missed clock](../../../../apps/oto-app/server/routes.ts#L10729),
[unscheduled clock](../../../../apps/oto-app/server/routes.ts#L10864),
[kiosk submission](../../../../apps/oto-app/client/src/pages/kiosk-page.tsx#L518)
and [timekeeping issue fields](../../../../apps/oto-app/shared/schema.ts#L2158).
The inspected schemas contain reasons and notes, without an attachment
relation. A face-recognition confidence score or enrollment image is not an
attached document for this request. Face clock remains off on staging.

Proposed acceptance, after Q2:

- [ ] The confirmed request screen selects the agreed file types and shows
      the selected evidence before submission, with removal supported.
- [ ] Saving links the private attachment to that exact request; permitted
      readers see it and another park cannot attach or read it.
- [ ] Existing reason choices and pending manager-review behavior remain.
- [ ] Upload/save failure leaves a clear retry state and no incomplete
      attachment relation; the staged record and test object are cleaned.

Dependencies: confirmed request entry paths, existing identity/device checks,
private storage, and the current issue review. No face-switch change or new
approval rule is implied.

### 2. Notification delivery on live presence

Source: [presence fields](../../../../apps/oto-app/shared/schema.ts#L2940)
and [in-app notification fields](../../../../apps/oto-app/server/db/coreSchema.ts#L3518).
Presence has no delivery-state field. Notifications have `isRead`/`readAt`,
which describe reading rather than pending/delivered/failed delivery.

Proposed acceptance, after Q3:

- [ ] Presence shows the three agreed states for an identified notification,
      including the relevant time and a plain failure explanation.
- [ ] An agreed delivery success and a controlled delivery failure produce
      the corresponding state without treating unread as failed.
- [ ] Repeated delivery processing retains one reliable result for the
      same notification; retries follow the confirmed policy.
- [ ] Another park cannot see or alter the state; failures appear in the
      agreed Health/Failures record when processing can fail silently.

Dependencies: channel and delivery definition, callback/job identity, and
failure reporting. A paid or external channel depends on its service being
available; the current in-app channel remains the default until a choice.

### 3. Employee import preview and results

Source: [preview](../../../../apps/oto-app/server/routes.ts#L4889),
[classification](../../../../apps/oto-app/server/routes.ts#L5047),
[application](../../../../apps/oto-app/server/routes.ts#L5076) and
[preview page](../../../../apps/oto-app/client/src/pages/bulk-employee-upload-page.tsx#L28).
Preview returns `new`, `update`, `no_change` and `error`, together with a
matched employee, changed fields and current data. It matches email first,
then full name. The screen selects applicable rows and displays per-row
`created`, `updated`, `skipped` or `error` outcomes. Matching is metadata,
not a separate fifth status. Preview errors currently include branch
resolution/access; application can also report a row error.

Proposed acceptance, after Q4:

- [ ] A synthetic workbook demonstrates every agreed preview class and
      makes the matched employee and proposed changes visible before saving.
- [ ] Only selected applicable rows are applied, with one visible outcome
      per submitted row; unchanged rows remain unchanged.
- [ ] Invalid input follows the agreed preview/application behavior; staff
      and foreign park/branch requests do not gain write access.
- [ ] Existing matching, field handling and repeat-import behavior are
      verified on staging before any additional state or matching rule is built.

Dependencies: the existing spreadsheet parser, employee identity and
tenant/branch ownership. No new matching precedence or automatic merge is
chosen by this plan. Existing coverage may satisfy the working list through
verification rather than a new implementation.

### 4. SOP revisions, archive and restore

Source: [article model](../../../../apps/oto-app/server/db/coreSchema.ts#L1379),
[admin edit/delete](../../../../apps/oto-app/server/routes.ts#L23046),
[storage](../../../../apps/oto-app/server/storage.ts#L11178) and
[editor](../../../../apps/oto-app/client/src/pages/studio/sops.tsx#L483).
The current SOP row can change status and content; no SOP revision snapshot
table or revision restore route was found. Knowledge Base version history
is a separate module and does not establish SOP revision history.

Proposed acceptance, after Q5:

- [ ] The agreed edit/publish actions preserve identifiable prior revisions
      with author/time and the content needed for the agreed restore action.
- [ ] Archive and the agreed restore action are visible and keep staff's
      published-only reading and existing park/branch scope.
- [ ] Restoring the agreed revision updates the article and its Find/Ask
      availability together; another park cannot restore it.
- [ ] A staged edit/archive/restore journey shows the resulting article and
      history; no recovery of a deleted row is claimed without such support.

Dependencies: restore definition, retention and authoring roles, existing
article visibility, and knowledge indexing. The current direct edit/status
behavior remains while the restore details are unresolved.

### 5. Fix routing recipient preview

Source: [Fix department setting](../../../../apps/oto-app/server/routes.ts#L25259),
[queue membership](../../../../apps/oto-app/server/routes.ts#L24450) and
[report assignment](../../../../apps/oto-app/server/routes.ts#L24647).
Report creation assigns the configured department. The current queue endpoint
describes the caller's membership; it does not list a prospective report's
recipients. No recipient-preview route or screen was found.

Proposed acceptance, after Q6:

- [ ] The confirmed configuration/report screen previews exactly the staff
      selected by the agreed existing assignment or confirmed routing rules.
- [ ] An empty result is explained; inactive, unrelated or other-park staff
      are excluded according to the agreed rules.
- [ ] The preview and actual assignment/delivery use the same selection,
      while preview alone sends no report or notification.
- [ ] Staged matched/unmatched examples and a scope refusal are recorded.

Dependencies: agreed recipient meaning, department/member identity and any
chosen delivery channel. Multiple routing rules are not inferred from the
current single Fix-department setting.

### 6. Returning-family SMS verification

Source: [public lookup](../../../../apps/oto-app/server/routes.ts#L17932)
and [public form lookup](../../../../apps/oto-app/client/src/pages/public/camp-register.tsx#L456).
The current flow uses event and phone to populate saved family details from
the event's park, including matching parent/pickup contact fields. There is
no six-digit verification stage in that inspected flow. Existing password
reset SMS code handling is not proof of camp verification.

Proposed acceptance, after Q7:

- [ ] Saved details are returned or changed only after the agreed contact
      completes six-digit verification for the intended camp/family.
- [ ] Invalid, expired, reused or unrelated verification cannot release
      those details; limits and resend behavior follow the confirmed policy.
- [ ] New-family registration and existing camp agreement/photo behavior
      remain as agreed; provider failure leaves a clear recoverable state.
- [ ] An isolated staged family proves the positive flow, refusal and
      cleanup without using real family details or recording codes/links.

Dependencies: confirmed contact policy, SMS service/configuration and a
record-bound verification lifetime. No service account, expiry interval or
contact-priority rule is selected by this preparation.

### 7. Reviews, movements and approval history

Source: [review completion](../../../../apps/oto-app/server/routes.ts#L4775),
[term-change creation](../../../../apps/oto-app/server/routes.ts#L5267),
[transfer](../../../../apps/oto-app/server/routes.ts#L5451),
[review screen](../../../../apps/oto-app/client/src/pages/reviews-page.tsx#L100)
and [movement screen](../../../../apps/oto-app/client/src/pages/staff-movements-page.tsx).
Managers mark a probation review complete. Term changes and transfers record
history and apply their effects in the request; their inspected flow has no
separate submitted/approved stage. The movement screen reads activity history.

Proposed acceptance, after Q8:

- [ ] First verify whether the existing manager action and history meet the
      confirmed requirement; reuse that evidence if they do.
- [ ] If a separate stage is confirmed, only the agreed approver applies it,
      and the approved record identifies the decision, actor and time.
- [ ] Existing effective-date, schedule/access and employee-history behavior
      is preserved unless the owner explicitly chooses an alternative.
- [ ] Replayed decisions apply once, refusal changes no employee state, and
      staged history and scope refusals are recorded on isolated employees.

Dependencies: approval definition, reviewer roles and the existing movement
effects. This plan does not introduce a second approver or delay current
manager actions while the answer is pending.

## 4. Scope record and numbered behavior questions

**Q1 scope record:** the original seven-item list is the working baseline
under the owner's instruction to complete all subtasks and check the original
documents. It is not an unanswered request for another blanket approval.
The earlier Open decision 30 wording is retained as history; this note does
not invent an explicit decision closure.

Q3 is answered above. The remaining questions record alternatives to the
working scope; existing behavior remains the default unless explicitly
answered. They do not impose a blanket implementation stop.

1. **Q2 - Which missed or unscheduled request screens need an attachment,
   and should it be optional?** Default: current reason/note submission,
   with the existing face switch and pending manager review; no new required file.
2. **Q3 - What does delivered mean for a presence notification, and through
   which channel?** Default: current in-app unread/read notifications, without
   a delivery-state claim or new external sending channel. Answered 13 October:
   use the staff inbox; Delivered means saved there, with read/unread separate.
3. **Q4 - Does the existing four-state import preview plus matched employee
   details satisfy the list, or is Matched a separate state?** Default: retain
   email-then-name matching, the four current states and per-row results.
4. **Q5 - Does SOP restore mean reopening an archived article, restoring
   an earlier revision, or recovering a deleted article?** Default: current
   article edits/status changes and deletion, without saved SOP revisions.
5. **Q6 - Should Fix preview show the configured department's staff, or
   recipients selected by additional routing rules?** Default: one configured
   Fix department and its existing assignment behavior; no additional rules.
6. **Q7 - Which saved family contacts may verify by SMS, and what resend
   and expiry behavior should apply?** Default: record the current phone-match
   flow and current adapter limits/expiry; add no new contact-priority rule.
   Provider configuration and controlled-test authorization are recorded above.
7. **Q8 - Does the manager's existing review completion or recorded movement
   count as approval, or is a separate approval step needed?** Default: current
   direct manager actions and recorded history; no second approver or delay.
   Source reconciliation confirms the original normal workflow is present;
   its staged acceptance and consistency controls remain.

## 5. Delivery from the working scope

Retain the Q1 scope record and record concrete answers where an item's
behavior or provider choice needs one. Verify existing coverage against the
working list and its acceptance, then build the missing scope. Deliver
each unit through the repository landing gate with passing controls and
severity/prescribed-fix review findings, full checks, complete compiler
output, touched-file lint, rebase and full-SHA CI. Keep ticket states tied
to observed results; deployed requires its named inspected staging proof.

Every staging fixture uses the ZZ TEST prefix and exact cleanup. Applied
migrations remain immutable and numbers are checked at landing. A failed
or incomplete verification remains recorded; it is not covered by another
module's screenshot. Update this plan's coverage and acceptance from the
actual confirmed implementation and staged result before closure.

## 6. Remaining consistency controls - SCRUM-516

13 October source assessment at 7402a8da; staging reproduction remains owed.
These controls preserve existing manager actions and approval intent.

- Medium: review completion and actor history are separate writes
  (`routes.ts:4782-4808`). Persist them together. Same-request retries should
  retain the original result rather than overwrite its timestamp; distinguish
  a retried decision from an intended new action before selecting its key.
- Medium: term/transfer history, employee changes, cleanup and activity are
  separate writes (`routes.ts:5309-5391,5513-5568`). Persist the intended
  effects atomically without changing effective dates or cleanup ranges.
- High for a foreign contract link, Medium for history metadata: history PATCH
  accepts broad fields (`routes.ts:5428-5443`, `storage.ts:3583`). Allow only
  intended contract status/link fields, verify employee/park ownership, and
  retain the original actor/time and before/after history.
- High for missing tenant/empty-branch restrictions, Medium for pending-state
  selection: attendance produces OPEN issues linked to pending time entries,
  but the pending reader requests PENDING_APPROVAL as issue status and its
  storage reader ignores tenantId (`routes.ts:10798-10811,10926-10938,
  11908-11911`, `storage.ts:5216`). Read the actual issue/entry relationship,
  constrain park and allowed branches, and return none for an empty branch
  list. The existing resolution record in lift PLAN section10 also names
  linkedTimeEntryId; related mappings are resolutionNote, RESOLVED/REJECTED,
  userProposedClockInAt and note. Apply these as one scoped consistency unit,
  preserving the face switch and existing approve/reject intent. SCRUM-520
  attachment controls alone do not establish that reviewer journey works.

Keep explicit passing/refusal/replay/rollback review controls and staged
proof for each delivered unit. The unreachable upcoming-reviews handler is
already recorded in lift PLAN; the current Reviews screen uses the scoped
employee reader and no active cross-park finding is inferred from dead code.
