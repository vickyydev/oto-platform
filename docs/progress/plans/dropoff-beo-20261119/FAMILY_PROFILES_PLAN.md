# Family profiles: several parents or guardians for the same children

SCRUM-1024 and SCRUM-1025. **State, 20 November 2026: APPROVED, the eight questions answered; steps F1 and F2 landed and the backfill run clean on staging. Step F3 is built on lane `lane/family-f3-20261119`, not landed: the platform's readers, the counter box's readers, and the shadow compare. All of it is behind the switch, which stays off everywhere (section 11).** The owner answered section 10 on his plan page; his answers are at the end of that section and in section 4 of ANSWERS.md. A plan written from a read of the code at main 3231ee7e3. The build starts with steps F1 and F2 when the drop-off counter flow has landed. The specification is section 4 of `ANSWERS.md` beside this file. The code comparison is `DROPOFF_AND_TILL_COMPARISON.md`: rows D15 to D17 and its section 3. Nothing here is decided beyond those answers. Where a rule still belongs to the owner, it is a numbered question in section 10, with today's behaviour as the default until he answers.

## 1. Today's model

### 1.1 Tables, columns, constraints and indexes (`packages/db/src/schema`)

- **`crm.member`** (`members.ts`)
  - `phone`: E.164, not null. `member_phone_unique` is on (operator_id, phone) WHERE archived_at IS NULL. There are also `member_phone_idx` and `member_operator_idx`.
  - `tier_code`, and `preferred_channel` (check: whatsapp, telegram, line, instagram).
  - `children_review_since`: the offline merge flag (OD-7).
  - Reception can change the phone with `PATCH /members/:id` (`pos:member:update`).
- **`crm.member_alias`**: pk `alias_member_id`, plus `member_id`. These are member ids merged at sync.
- **`crm.child`** (`members.ts`)
  - `member_id` is NOT NULL, FK to member ON DELETE RESTRICT, with `child_member_idx`.
  - It has no `operator_id`. Tenancy is proved through the member: `packages/db/test/schema-shape.test.ts` lists `crm.child` as scoped by `member_id`.
  - Care fields: allergies, medical_notes, medical_alert, dietary, food_restrictions, notes. Also last_confirmed_at, consent_recorded_at and archived_at.
- **`crm.visit`** (member_id nullable, `visit_member_idx`) and **`crm.visit_child`** (pk visit_id, child_id).
- **`crm.registration`** (`checkin.ts`)
  - member_id is nullable.
  - It keeps its own `guardian_name` and `guardian_phone` (E.164 check), plus `contact_channel` and `contact_confirmed_at`/`_by`.
  - Indexes: `registration_member_idx`, `registration_phone_idx`.
- **`crm.guardian`** (`checkin.ts`) is something else: an authorised collector on ONE registration (that stay's pickup list), with `revoked_at`. The new table must not take this name.
- **Rows that name a child by id only:** `pos.checkin.child_id`, `pos.supervision_waiver.child_id` and `sibling_child_id`, `pos.sale_line.child_id`, `pos.band.child_id` (and `member_id`), and `pos.event_attendee_link` and `pos.event_pass_hold` (child_id and member_id).
- **Wallets:** a `pos.wallet_key` of kind `child` (the value is the child id: one prepaid food wallet per child), and `pos.wallet.member_id` (a backlink to the sale's member).
- **On the box:** `box_overlay` (`edge.ts`) carries a member_id with no FK. The box's own store mirrors it (`packages/box-agent/src/store-sqlite.ts`).

### 1.2 Every reader and writer of the link, by flow

| Flow | Where (file, function) | What it does with `child.member_id` |
|---|---|---|
| Lookup at the counter | `apps/api/src/routes/members.ts`: `GET /members/lookup` and `memberWithChildren` | Finds the live member by phone; lists children WHERE member_id = member. |
| Member detail | same file: `GET /members/:id`; also the answers of `POST /members` replay and of tier verify and revoke | `memberWithChildren` |
| Add a child | same file: `POST /members/:id/children` | Writes member_id. The replay check is `row.memberId === m.id`. Publishes `childCacheView` (which carries memberId). |
| Edit or remove a child | same file: `PATCH` and `DELETE /members/children/:childId`; `apps/api/src/services/members.ts` `archiveChild` | The "owner" is child.member_id: same operator, and live for PATCH. |
| Console register | `services/members.ts` `listRegister`; `packages/admin-screens/.../members/MembersPanel.tsx` and `MemberFormDialog.tsx` through `lifted/api/platform.ts` `membersApi` | Children grouped by member_id. |
| Support and Inbox | `services/support-lookup.ts` `supportLookup` (through the lookup route); `services/inbox/read.ts` (childCount by member_id) | Read only. |
| Till | `apps/pos/src/pages/Till.tsx`: `identifyPhone`, `findOrCreateGateMember`, `loadDropOffRegistration`, `handleSellEventPassFromStep1`. `api/members.ts` `lookupMember`. `components/till/VisitChildrenModal.tsx` (`GET /members/:id`). `lib/gateChildren.ts` `saveGateChildren` (`POST` children). `lib/savedChildren.ts` `prefillSlots`. `components/mobile/MobileTill.tsx`, `components/parties/PartyTicketModal.tsx`, `pages/History.tsx`, `lib/deferredTierVerification.ts` | One `Member` object; every child write names `member.id`. |
| Customer display | No direct read. It gets the till's member (the `child_review` prompt). SCRUM-1014 adds and removes children through the routes above with `source=customer_display`. | Indirect. |
| Visits | `routes/visits.ts` `POST /visits`; `services/visit-children.ts` `addVisitChildren` | Refuses a child unless member_id = the visit's member. |
| Drop-off and nanny | `services/checkin.ts`: `assertChildrenOfMember` (from `createRegistration` and `addRegistrationChildren`), `recordWaiver` (operator through child to member), and the board edit that patches the saved child (around line 2033) | Refuses a child that is not the member's. |
| Online booking | `services/member-code.ts` `publicSavedChildrenOf` and `familyPassMember`; `services/family-online.ts` `saveFamilyOnline` (`row.memberId !== memberId`, inserts with memberId) and `checkBookingFamilyLinks`; `services/booking-supervision.ts` (links `savedChildId` only if child.member_id = booking.member_id); `routes/public.ts` saved-children code, verify and save; `apps/pos/src/pages/Book.tsx` | Children of the one member whose phone passed the code. |
| Events and camps | `services/event-writes.ts` walk-up check (`child.memberId = body.memberId`); `pos.event_attendee_link` | A saved child must be the member's. |
| Kitchen print | `services/sale-printing.ts` `orderChildren` | With no visit, every child WHERE member_id = sale.member_id. |
| Pickup (release) | `services/release.ts` `pickupsOf` and the release write | Does NOT read the link: the dropper-off plus that stay's `crm.guardian` rows. |
| Wallets and bands | `services/wallet.ts` `loadChildPrepaid` and `grantSaleCredit`; `bands.ts`, `band-food.ts`, `payments/offline.ts` | Keyed by child id or sale member. They do not read the link. |
| Files | `routes/files.ts` (owner `child`) | Operator through child to member. |
| Box: server side | `services/sync.ts`: the `members` scope of the cache bundle (members page, children by member_id, alias ids), `memberChange`, `childChange` (carries memberId); `member.created` (merge plus alias); `child.created` (alias, sibling check, sets the review flag); `child.updated` (operator through member); `visit.created` (`SYNC_VISIT_CHILD_NOT_SAVED`); `visit.children_added`. `services/sync-checkin.ts`: registration replay (`rows.some(r => r.memberId !== memberId)`) and `checkinCacheItemAt` (operator join). | Mirrors every rule above. |
| Box: on the Pi | `packages/box-agent/src/station-bridge.ts`: `cachedMemberOf`, `childOf`, `lookup`, `present` (offline children by member ids), `resolveMember`, `locateChild` (first member whose nested children hold the id); `child.create`, `child.update`, `visit.create` and `visit.children_add` checked against the cached children. `agent.ts` `pullBundle` (whole bundle, `CACHE_SCHEMA_VERSION = 1`). | Children are nested under each member item. |
| Messages | `services/checkin.ts` `autoSendRegistrationContact` and `sendContactTest`; `services/inbox/mirror.ts` `mirrorNotice` | Sent to `registration.guardian_phone` only. Not the member. |
| Seed and demo | `packages/db/src/seed/index.ts` (child inserts); `services/demo-reset.ts` (deletes children by member_id) | Writer. |
| HR app camps | `apps/oto-app` `camp_registrations` (`emergency_contact_number`, `parent_contacts` jsonb `[{name, phone}]`, `authorized_pickup_persons` text, allergies). The views `otoapp_v.children` and `otoapp_v.event_attendees` (`apps/oto-app/migrations/0004_otoapp_v_views.sql`) expose only `emergency_contact_number`. The platform reads them in `services/otoapp-events.ts` `listSeamChildren`. | No link to `crm.child`. Only `pos.event_attendee_link`, when a pass is sold from a saved child. |

Not found:
- `apps/booth` reads no member or child.
- No report or analytics query joins a child to a member (`aggregates-members.ts`: "No child join").
- `packages/shared` holds only schemas: `station-bridge.ts` `Offline*Schema` and `booking-supervision.ts` `FamilyOnlineChildSchema`.
- The till never shows `childrenReviewSince`, so the OD-7 merge flag has no screen today.

## 2. The target model

### 2.1 Three shapes, compared

| Shape | Schema | Backfill | Offline copy | Risk |
|---|---|---|---|---|
| A. A guardian link per child: `crm.child_guardian(child_id, member_id)`, keeping `child.member_id` as the first guardian | 1 table | One row per child. A composite key allows pure SQL. | Children nested under every linked member. | A child added later by one parent is not seen by the other unless someone links it each time. Offline, an old box's `child.created` reaches one parent only. The family is implicit, and the two parents can drift apart. |
| B. A family: `crm.family` plus `crm.family_guardian(family_id, member_id)`, and `child.family_id`; `child.member_id` kept | 2 tables, 2 columns | One family and one guardian row per member with children; set `child.family_id`. A script, because ids are UUIDv7. | The same nesting. An old box's `child.created` lands in the family by itself. | One helper predicate. Blended households work because a member may sit in several families. |
| C. Pure many-to-many, dropping `child.member_id` | Link table, plus `child.operator_id`, plus contract | Every child | `childChange.memberId` disappears for old boxes. | Every tenancy join changes at once: `archiveChild`, PATCH, `files.ts`, `child.updated`, `recordWaiver`, `checkinCacheItemAt`. Highest risk, and no answer needs it. |

**Recommendation: B.**
- It makes "the family" a real thing, which is what the owner's answers talk about: "saved to the family", "the line about linking another parent", "messages go to both".
- A child added by either parent, online or from an old box, is seen by both without a counter question.
- Blended households stay correct: a child belongs to one family, a member may be a guardian in several, and a family can be as small as one child. So nobody sees a child they are not linked to.
- `child.member_id` stays NOT NULL with its meaning "first saved under". Every tenancy join and every old reader keeps working until it is switched.

### 2.2 The recommended schema (forward-only, next free number, 0135 today)

- **`crm.family`**
  - Columns: `id` (UUIDv7), `operator_id`, `source` (check: backfill, till, sync, booking, link), `created_by_account_id` (null), timestamps, `archived_at`.
  - A unique key on (operator_id, id) as a tenant fence, the inbox pattern.
- **`crm.family_guardian`**
  - Columns: `id`, `operator_id`, `family_id`, `member_id`, `source`, `added_by_account_id`, `branch_id`, `station_id`, timestamps (`created_at` is the "when"), `archived_at` (stays unused until removal is decided, question 4).
  - Partial unique on (family_id, member_id) WHERE archived_at IS NULL.
  - An index on member_id WHERE archived_at IS NULL, and indexes on every FK.
- **`crm.child`** gains two columns:
  - `family_id` (null during expand, FK RESTRICT, indexed).
  - `merged_into_child_id` (null, FK to crm.child RESTRICT, indexed): set only on a duplicate that reception said is the same child.
- **`crm.child_camp_link`** is added later, with the camp step: `operator_id`, `family_id`, `child_id` (null), `otoapp_registration_id`, `state` (saved or dismissed), `by`, `at`. Unique on (family_id, otoapp_registration_id).
- **The rule, held in one helper** in a new `apps/api/src/services/family.ts`: a member sees a child when the member is live, holds a live guardian row in the child's family, and the child is live and not merged.
- **Where a new child goes:** the family the request names. If none is named, the member's only live family. If the member is in several, their oldest live family, plus the member's review flag. If the member has no family yet, a new family for that member.
- **A suite flag** `crm.family_profiles` in `FLAG_CATALOGUE` (`packages/db/src/schema/suite-controls.ts`): an enum `off`, `read`, `on`, at operator scope, default `off`, and set without an expiry, because an expired override falls back to the default.
  - `off`: readers use `child.member_id`, as today.
  - `read`: readers use the family.
  - `on`: adding and linking guardians, family messages and camp offers.

## 3. Migration and backfill

1. **E1, expand (migration 0135).**
   - Create both tables and both child columns. Nothing reads them.
   - Write `packages/db/migrations/undo/0135_family_profiles.sql` beside it, as that folder's README asks.
   - Proof: migrations applied twice from empty, `schema-shape.test.ts` and `verify-schema`.
2. **W1, writers (same release).** `ensureFamilyFor` is called by every child insert:
   - `POST /members/:id/children`, `sync.ts` `child.created` and the `family-online.ts` insert;
   - the seed;
   - and `demo-reset.ts`, which must delete guardian and family rows before children.
   
   A child written by an old instance during the deploy is caught by B1.
3. **B1, backfill.**
   - A script, `packages/db/scripts/family-backfill.ts`, run as a Render job, batched by member id, one transaction per batch, re-runnable.
   - For each member (archived or not) that has a child without a family: one family (source backfill) and one guardian row, then `family_id` on that member's children.
   - One `family.backfill` audit row per batch, with counts and the id range.
   - A dry-run mode prints the counts first.
4. **V1, verification** (`family-verify.ts`, read only). Every check must be zero before going on:
   - children with a null `family_id`;
   - families with no live guardian;
   - children whose family's live guardians are not exactly `{child.member_id}`;
   - rows whose family, guardian member and child member disagree on the operator.
5. **R1, switch readers** (flag `read` on staging only).
   - Every row of the table in 1.2 that tests or lists by `child.member_id` uses the helper instead.
   - While every family has one guardian, the two answers are identical. A shadow-compare script lists, for every member, the old and the new child set, and must report zero differences before and after the deploy.
6. **F1, features** (flag `on` per operator): sections 4 to 6. Production stays `off` until each step is proved on staging.
7. **C1, contract (later).**
   - `CHECK (family_id IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT`, then `SET NOT NULL`, which uses the validated check and does not scan.
   - `child.member_id` is never dropped.

**Staging proof with ZZ TEST families.** Before any reader is switched, run B1 and V1 on staging. Then, with the flag at `read`, take two ZZ TEST members (numbers from the test range) through:
- lookup;
- a visit;
- a drop-off;
- the booking site code;
- a virtual box offline lookup and replay;
- the kitchen print;
- the register.

All must match the shadow compare. Then turn `on` and run sections 4 to 6 on new ZZ TEST families only.

**Undo without losing data.**
- Before F1, run the undo file. Nothing reads the new rows, and the backfilled families can simply be left.
- After F1, set the flag back to `off`. Readers fall back to `child.member_id`, each parent sees only the children first saved under them, and every family, guardian and merge row stays for a later `on`.
- A failed B1 batch rolls back alone and is run again.

## 4. Linking two existing records

### 4.1 What happens to each record (one transaction, idempotent on a client-minted operation id)

The rows are locked in id order: both families, both members, every child named.

| Thing | Rule |
|---|---|
| The second parent | Gets a live guardian row on the first family (source `link`, who, when, branch, station). |
| A child marked "same as" | The duplicate gets `archived_at` and `merged_into_child_id` = the kept child. Its own values are never changed. The kept child takes the values chosen in 4.2. |
| A child marked "another child of this family" | Its `family_id` moves to the first family. |
| A child marked "not this family's" | Stays in the second parent's own family, which the second parent keeps. |
| The second family | Archived once it holds no live child. The second parent's guardian row on it is archived with it. |
| Visits, stays, registrations, sale lines, bands, waivers, event links | Untouched: they are history and keep naming the id they named. |
| Food and credit wallets | Not moved. A balance on the duplicate stays on its band or child key until it expires (`expireWalletsForDay`), and the screen says so. |
| A child in the park, or registered today | The link is refused ("Finish today's drop-off first"), so a band, a wallet and a pickup never point at a record that is being changed. |
| Facts still queued on a box that name the duplicate | `visit.created`, `visit.children_added` and the registration replay resolve it through `merged_into_child_id` (a `survivingChildId` beside `survivingMemberId`). A `child.updated` naming the duplicate is applied to the archived duplicate only, filed as an anomaly, and sets the review flag, so no note overwrites the kept one silently. |
| Audit and box | `family.link`, `family_guardian.add`, and one `child.merge` per pair, with both full rows before and the field-by-field choice after. `recordChange` for both members and both children (a delete for the duplicate). The bundle's hash changes by itself. |

### 4.2 When the two versions of a care note differ

Allergies, medical notes, medical alert, dietary, food restrictions and staff notes are compared field by field:
- **Same text:** shown once and kept.
- **One empty and one filled:** the filled one is kept and marked "from the second record".
- **Both filled and different:** staff must choose before Link is enabled. The choices are "Keep both" (the default for allergies and medical notes: both texts joined, each labelled with its record), "Use the first", or "Use the second". There is never an empty choice when either side had text.
- **Medical alert:** on if either record had it on. Turning it off stays the ordinary child edit.
- **Name and date of birth:** staff choose one, or go back and say "not the same child".

The archived duplicate keeps its original text, so nothing is lost even after "Use the first".

### 4.3 The reception screen, in the till's own design

It uses the till's Dialog with header and description, large Checkbox and choice rows, outline and primary Buttons, the lucide UserPlus and AlertTriangle icons, and a toast at the end. It opens from two places: "Parents and guardians: + Add parent or guardian" in the Membership Check (`VisitChildrenModal`), and from "Edit details" at step 7 (SCRUM-1025). Online only. Offline it says "Adding a parent needs the internet."

1. **"Add parent or guardian".**
   - Staff type the other number (the till's keypad) and a name, and press Find.
   - If the number has no record, or a record with no children, the screen says: "<Name> will be a parent or guardian on this family. Their number will find: <children>." Staff then press Add.
2. **"Which children are the same?"** This appears when the other number already has children.
   - Two columns: "<first name>'s record" and "<second name>'s record". Each child is a card with name, age and an allergy badge.
   - Under each child of the second record, three large choices: "Same child as …" (preselected, and labelled "Looks like the same child", when name and date of birth match), "Another child of this family", and "Not this family's child".
   - Continue stays off until every child has a choice.
3. **"Check the details".** One card per pair, with fields side by side.
   - Identical fields are grey with a tick.
   - Different ones are amber with the choices of 4.2.
4. **"Confirm".**
   - One plain summary: who is added, what their number will find, which records become one, and which child stays only on the second record.
   - The footer reads "Recorded with your name and the time."
   - Buttons: Link and Back.
   - On success: a toast reading "Linked", and the lookup reads the family again with both parents' names.

## 5. Messages to both parents

**Today.**
- The only check-in message is the connection check. `services/checkin.ts` `sendContactTest` builds it, and `autoSendRegistrationContact` calls it from `createRegistration` (line 790), `booking-payment.ts` (line 257) and the box replay `sync-checkin.ts` (line 311). Staff resend it from the board (`routes/checkin.ts` line 516, and `checkin.ts` line 2144 after a number change).
- It goes once per registration, to `registration.guardian_phone`. The "once" is guarded by the newest `registration.contact` audit row (`contactsOf`).
- The sender is `buildNoticeSender` in `services/sms.ts`, which is the console sender: a log line, delivered to no phone in code today.
- `mirrorNotice` then copies the same text into the Inbox thread.

**Change.**
- A new `familyNoticeRecipients(tx, registrationId)` returns:
  - the registration's own number (the dropper-off, or the family's nanny, who is not made a guardian);
  - plus every live guardian of the families of the SAVED children on that registration;
  - de-duplicated by E.164.
- A guardian linked only to other children of a parent is never told about this drop-off.
- Each extra recipient gets one copy: wording per question 7, on that member's `preferred_channel`, otherwise the registration's channel.
- Each copy is guarded by its own `registration.family_notice` audit row per (registration, member), written in the same transaction under a `FOR UPDATE` lock on the registration. The copy is hooked inside `autoSendRegistrationContact`, so all three callers get it.
- The connection check status stays the registration's own number's. Resend still goes only to that number.
- A registration without a phone still sends copies to the family.

**What must not double-send.**
- The same number as both the registration number and a guardian: de-duplicated.
- A box replay, a restored outbox, an added sibling, the paid-booking path and a second press: each finds the audit row first.
- The Inbox mirror is unique on (channel account, `external_message_id`), and the id is built from `<source>:<sourceId>:<sentAt>`. Two copies on one channel at the same instant would collide and be dropped as `already_mirrored`. So the copies use a new source, `checkin.family_copy`, with sourceId `<registrationId>:<memberId>`, and the `NoticeMirrorInput.source` union widens.
- A failed copy is recorded and never blocks the check-in or the other copies.

## 6. Camp children

**Where they are.**
- The HR app (`apps/oto-app`) keeps one `camp_registrations` row per child per camp, with `emergency_contact_number`, `parent_contacts` (jsonb, first entry is the main contact), `authorized_pickup_persons` (free text), allergies, allergy notes, food restrictions and date of birth (`1900-01-01` and `MANAGER_ADDED` are placeholders).
- Numbers are stored as typed (trimmed), not E.164 (`camp-registration-routes.ts`, `camp-family-verification.ts` `campPhone`).
- The HR app has no child record of its own.

**The existing bridge.**
- Same database: the HR app's tables are in schema `otoapp` (platform migration 0008), and the read-only views are in `otoapp_v`, fenced by mapped platform branch.
- The platform reads them only in `services/otoapp-events.ts`. `test/otoapp-events-seam.test.ts` holds that file to being the only one that names `otoapp_v`.
- Writes go through the HR app's directory API.
- No view exposes `parent_contacts`.

**Smallest safe way.**
1. **HR app migration 0053.**
   - A new view, `otoapp_v.camp_contacts`: registration id, tenant, branch_id, `phone_raw`, a digits-only form, and kind (main or additional).
   - Built from `emergency_contact_number` and `jsonb_array_elements(parent_contacts)`, without placeholders, and without pickup persons (question 8).
   - The view is added to `SEAM_VIEWS` and to the post-import grants. That step is held by the seam test; it was not found as a script in the repository.
   - Deploy the HR app first.
2. **A read in `otoapp-events.ts`**, `campChildrenByPhone`.
   - Fenced to the operator's mapped branches.
   - Pre-filtered on the last nine digits, then each candidate is normalised with `normalizePhone` and must equal the E.164 exactly.
   - Joined to `otoapp_v.children`, then grouped by normalised name and date of birth into distinct children (each with its camps).
3. **A route**, `GET /members/camp-children?phone=` (`pos:member:read`, station trading, online only).
   - Leaves out children already saved or dismissed for this family (`crm.child_camp_link`), and those matching a saved child by name and date of birth, which are offered as "Same as <saved child>?" instead.
   - Writes a `member.camp_children_read` audit row with a count and no names.
4. **The till.** After the lookup, the Membership Check shows "Known from camps": name, age, camp and date.
   - Save opens the child's details, already filled with the allergies and food notes, for staff to confirm. The child is then saved to the family with a `crm.child_camp_link`.
   - "Not our child" stores a dismissal. "Not now" stores nothing.
   - Staff side only: never on the paired display, the booking site or the box.

## 7. The offline counter box

**What the copy needs.**
- Each item in the `members` scope keeps today's fields.
- Its nested `children` become the union of the member's families. Each child keeps `memberId` as today, plus a new `familyId`.
- The item gains `familyIds`.
- `CACHE_BUNDLE_SCHEMA_VERSION` stays 1, because the change only adds fields.

**An old box release against the new server.**
- `cachedMemberOf` and `childOf` ignore unknown fields. A lookup by the second parent's number, offline, shows the family's children.
- The facts an old box files with the second parent's id and the first parent's children are `visit.created`, `visit.children_added` and registrations. They are accepted once R1 has switched `sync.ts` and `sync-checkin.ts`. So R1 must be live on the server before any family has two guardians.
- A child added offline under either parent lands in that parent's family through the `child.created` rule.
- Known small gaps, without harm:
  - `locateChild` picks the first member holding a child id.
  - A child added offline under one parent is not shown under the other parent on the same box until the sync.
- Adding and linking guardians and camp offers are online only.

**A box release** is not needed for correctness. An optional later one could list offline children by family and send `familyId` on `child.create`.

## 8. Privacy and safety review

| Where a number could reveal children | Guard |
|---|---|
| The till's lookup and `GET /members/:id` by the added parent | Only through a live guardian row that signed-in staff added, audited with who, when and station. Archived members are never found. The other parents' numbers are shown masked (last three digits). |
| A phone number changed by `PATCH /members/:id` | It is already audited. The family read follows the member, so changing a parent's number now opens the family to the new number: show the family's children in the confirm dialog of that change. |
| The box's offline copy | Built only from live guardian rows. A removal (when decided) or a flag `off` drops the children at the next pull. The window is the pull interval. |
| The booking site's code check by the added parent | An SMS code to that parent's own phone, then the family's children (the same fields as today). What that parent may change is question 5. |
| The paired display | Shows what the till looked up, with the parent present; unchanged. |
| The Console register and support lookup | The register is `pos:member:list` (managers), and its rows carry identity only. Support lookup is masked unless `admin:audit:read_sensitive`. |
| Inbox childCount | A count only. |
| The kitchen print with no visit | Limited to the member's family children: the same scope as the lookup, and no wider than today. |
| Check-in message copies | Only guardians of the children on that registration. |
| Camp children by a parent number | Staff side, online, the operator's branches only. Names and ages first, care notes only when staff open the child to save it. An audit row per read. |
| Linking by reception on a stranger's word | Any reception staff, by the owner's answer. Audited. Question 6 offers a notice to the existing parents. Removal (question 4) is the remedy. |
| Pickup | Unchanged: the dropper-off and that stay's list (question 1). |

## 9. Build order

| Step | Content | Size | Tests | Lane |
|---|---|---|---|---|
| F1 | Migration 0135, its undo file, `services/family.ts` `ensureFamilyFor`, every child writer, seed, demo reset order, flag entry | M | Migrations twice from empty; `schema-shape`; `verify-schema`; each writer leaves `family_id` set; demo reset | A |
| F2 | `family-backfill.ts` and `family-verify.ts`, run on staging | S | A fixture with archived members, aliases and archived children; a re-run writes nothing; verify is zero | A |
| F3 | Switch every reader in 1.2 behind the flag, including the bundle, `child.created`, `sync-checkin`, booking, events, print, register, and the PATCH and DELETE owner checks | L (3 days) | The whole api suite with the flag `off` and `read`; an equivalence test; the shadow compare on staging; a box test of an offline visit by the second parent | A |
| F4 | Add parent or guardian: `routes/families.ts`, lookup answer with the family and masked guardians, Membership Check and Edit details buttons, the D17 line in five languages (`dictionary.ts`, `ConsentCapture.tsx`, `PublicConsentCapture.tsx`) | M to L | Route happy path, refusal and replay; audit; `route-write-conformance`; lookup by both numbers; bundle nesting; till dialog; dictionary keys | B |
| F5 | Link two records: merge service, `survivingChildId` in sync, the three screens | L | Conflicts kept both; empty filled; alert OR; in-park refusal; replay; facts naming the duplicate; audit contents | B, after F4 |
| F6 | Messages to every parent of the children | M | De-duplication, nanny case, child-scoped recipients, box replay and booking path send once, two distinct mirror threads, a failed copy does not block | C, after F3 |
| F7a | HR app view, grants, seam test | S to M | HR app migration check; seam test; placeholder and other-operator exclusion | D, any time after F1 |
| F7b | Camp read, route, till offer, `crm.child_camp_link` | M to L | Number normalisation match; grouping; no re-offer; display never receives it; audit read | B, after F5 |
| F8 | Contract `family_id` NOT NULL; the flag's default per the owner's word | S | Migration; verify | A |

Lanes A, C and D touch different files: `services/family.ts` is read-only to C, and the HR app plus `otoapp-events.ts` belong to D. B owns the members and families routes, `VisitChildrenModal`, `Till.tsx` and the dictionary, so F4, F5 and F7b stay in one lane. Each step is proved on staging with ZZ TEST families before the next starts.

## 10. Questions for the owner

1. **May a parent on the family collect a child they did not drop off, without being on that stay's pickup list?** A. No: staff add them as a collector or record them on the spot. B. Yes: the family's parents appear on every stay's pickup list. C. Yes, but only if the dropping-off parent ticks it on the form. Today: A, which the plan builds.
2. **Which rate applies when the other parent's number is used?** A. Each parent's own rate and document. B. The family shares a verified rate. Today: A (tier and documents are on the member).
3. **Credit vouchers and ticket credit.** A. They stay with the parent whose sale made them. B. Either parent's number finds the family's. Today: A. A child's prepaid food is keyed to the child and band, so it already serves both parents.
4. **Who may take a parent or guardian off a family?** A. A manager in the Console, with a reason. B. Any reception staff, logged. C. Only at a parent's request after a code. Today: no removal exists, so a wrong link stays until it is corrected in the database. Please answer before production is turned on.
5. **What may the added parent do on the family record (care notes, Remove from saved, the booking site with their own code)?** A. The same as the first parent. B. Change notes, but removing a child needs the parent it was first saved under. C. View only. Today: A in effect.
6. **When a parent or guardian is added, do the existing parents get a short message saying so?** A. No. B. Yes. Today: A.
7. **The other parent's check-in message.** A. The same connection check, asking them to confirm their number. B. A notice naming the children and who dropped them off. Today: only the drop-off number is messaged.
8. **Which camp numbers find a child?** A. The main contact and the additional parent contacts. B. Also numbers written under authorised pickup persons (the HR app's own code check accepts them). Today: no camp child is offered.

### The owner's answers (19 November 2026)

1. A (unchanged: staff add a collector for that stay). 2. B: the family shares one verified rate. 3. B: either parent's number finds the family's credit. 4. B: any reception staff, recorded with who and when. 5. A: the same as the first parent. 6. B: the parents already on the family get a short message. 7. B: a notice naming the children and who dropped them off. 8. B: also the numbers written under people allowed to collect.

What the answers add to the plan:

- **Answer 2** makes the rate a family matter: section 8 and step F4 gain the rule for reading a rate through the family. Still open with him: which rate applies when two parents each hold a different verified rate. The working reading is a parent's own valid rate first, otherwise a valid rate held by another parent on the family.
- **Answer 3** adds a step after F3: credit vouchers and ticket credit are found through the family, not only through the member whose sale made them. A child's prepaid food is unchanged.
- **Answer 4** adds removal to F4: any reception staff, audited; the removed parent's number stops finding the children at once, and on the counter box at its next pull.
- **Answer 6** adds one message to F4 and F6, with the same once-only guard as the check-in copies.
- **Answer 7** fixes the wording of F6.
- **Answer 8** widens the camp view of F7a to numbers found in the free text of people allowed to collect; a number is taken only when it normalises to a valid phone number.

## 11. Build progress

### Step F1, the tables and the writers (19 November 2026, lane `lane/family1024-20261119`, not landed)

Built and tested on the lane; nothing is on staging, the switch is off everywhere, and no reader uses a family.

- **Migration `0136_family_profiles`** (0135 was taken by another lane; renumbered at landing if needed), with `undo/0136_family_profiles.sql`.
  - `crm.family`: id, operator_id, source (backfill, till, sync, booking, link), created_by_account_id, timestamps, archived_at; the tenant fence `family_tenant_key` on (operator_id, id).
  - `crm.family_guardian`: as section 2.2. The family is reached by a composite foreign key `(operator_id, family_id)` onto the fence, so a guardian row cannot name another operator's family. One live row per family and member (`family_guardian_live_unique`), the live member index, and an index leading on every foreign key.
  - `crm.child.family_id` and `merged_into_child_id`: nullable, RESTRICT, indexed.
- **The switch** `crm.family_profiles` is in `FLAG_CATALOGUE` as a feature switch (off, read, on; operator scope; default off; no expiry). It is listed as not supported, so no write path accepts it until step F3 makes it supported with its readers. Nothing reads it yet.
- **`apps/api/src/services/family.ts`**: `ensureFamilyFor` (the rule of section 2.2) and `childAuditView` (below). The read rule of section 2.2 and the reading of the switch are step F3 and are not in this step.
- **Every insert into `crm.child`** now gives the child a family: `POST /members/:id/children`, the box's `child.created` in `services/sync.ts`, the booking site's save in `services/family-online.ts`, and the seed (the demo families, as source `backfill`). `services/demo-reset.ts` deletes guardian rows, then children, then families that nothing names. No other insert exists outside test fixtures.

Where the code or the build differs from the text above:

- **The member side of the fence is a service check, not a key.** `family_guardian.member_id` and `child.family_id` are plain foreign keys. A member or a child crossing operators is stopped by `ensureFamilyFor`, which checks the member's operator, and by the backfill, which only ever puts a child in its own member's family. Verify check 4 counts any that cross. A composite key would need `unique (operator_id, id)` on `crm.member`, which does not exist. Building one would cost about what this migration's two indexes on `crm.child` cost (well under a second at today's size), so the lock is not why it was left out. It was left out because before step F4 no path other than those two writes a guardian row. **Open for F4:** before second guardians are added, choose between a `member_tenant_key (operator_id, id)` with a composite foreign key from `family_guardian` (the inbox pattern) and keeping the service check as final.
- **Several families and the review flag.** When a member is a live guardian in several families, `ensureFamilyFor` takes the oldest and reports `ambiguous`, but does not raise the member's review flag: until F4 a member cannot hold a second family, and the flag is published to the boxes, so it belongs with the step that makes the case possible.
- **An archived member.** The box's `child.created` accepts a child under a member archived since it went offline, as it did before, so `ensureFamilyFor` does not refuse an archived member.
- **A lock only for a first family.** A member who already has a family is answered from a plain read, because nothing archives a family before F5. Only a member with no family yet has their row locked (FOR NO KEY UPDATE) and their families read again, so two first children saved at the same moment share one family. A box applies a whole batch in one transaction. If every child took the lock, it would be held to the end of the batch, and a till editing that member would wait. **For F5:** linking archives a family, so that step must take the member lock before it archives one.
- **No audit row of its own.** The plan names no audit action for F1. The family and its first guardian row record who made them (`created_by_account_id`, `added_by_account_id`), where (`branch_id`, `station_id`) and when (`created_at`). The caller's `child.create` row, written in the same transaction, is the audit of the act, as before. Further guardians will be `family_guardian.add` (section 4.1).
- **A box fact under an account this server does not know** is still filed as `actor_unknown`. The family now names the account before the audit row does, so the sync's failure classes treat the family's two account foreign keys like the audit row's.

**Inert with the switch off.** No route answer, cache view, box bundle, receipt, report or audit row changed (`api-types --check` reports no change). The audit rows that store a whole child row are `child.update` from the till and the box, and `child.archive` from the till's and the booking site's "Remove from saved". They leave out the two new columns (`childAuditView`), so they read exactly as before. The demo reset's answer keeps its fields. Two differences remain, for the landing note:
- The Console's switch list shows one more entry, `crm.family_profiles`, the first of kind feature: listed, not supported and not settable. The plan's F1 asks for this entry.
- The migration takes a short lock on `crm.child` while it adds two columns, builds two indexes and checks two foreign keys. It runs in one transaction with no lock timeout, as every migration here does. Deploy it to production at a quiet hour (runbook section 3).

**At landing:** `origin/main` has `0135_voucher_stock_link` at journal index 135. On the rebase:
1. Set this migration's journal entry to index 136 and keep the file name `0136`.
2. Regenerate `0136_snapshot.json` on top of 0135's (prevId `c0acd661-9756-4403-b771-ea6660471850`) and confirm the SQL is unchanged.
3. Run `s1024-family-migration.test.ts` and `verify-schema` again.

Done on the rebase onto `main` (19 November). The file keeps the name `0136`, its journal entry is index 136 after `0135_voucher_stock_link`, and `0136_snapshot.json` was regenerated with prevId `c0acd661-9756-4403-b771-ea6660471850`. `drizzle-kit generate` against 0135's snapshot wrote the same statements as the committed SQL, which differs only in its header comment. In the new snapshot the family tables and `crm.child` match the old snapshot, and every other table matches 0135's. `s1024-family-migration.test.ts` and `verify-schema` pass on the result. The same rebase met the drop-off counter flow's customer-display audit on the till's child edit (SCRUM-1020): both are kept, with the family columns left out of that row too.

### Step F2, the backfill and its checks (19 November 2026, same lane, not landed, not run)

Built and tested on the lane against embedded test databases only. **No script has been run on staging or on any real database**; that is a data job for the owner's separate go. How and in what order they are run is `FAMILY_BACKFILL_RUNBOOK.md` beside this file.

- **Where they live.** The repository's pattern for a one-off data job (the OTO App staff accounts, SCRUM-795): the logic in `packages/db/src` (`family-backfill.ts`, `family-verify.ts`, exported from the package), a thin command line in `packages/db/scripts` (now inside the package's typecheck), a test in `packages/db/test`, and a Render one-off job on the api image (`node scripts/agent/render.mjs job "pnpm --filter @oto/db exec tsx scripts/<name>.ts"`).
- **Tests:** `packages/db/test/s1024-family-backfill.test.ts`, including the command lines run against the test database.
- **The shadow compare** of section 3, R1, is not in this step. It calls the read rule, which is built with the readers in step F3, and it is that step's proof. A first version was written on this lane and later removed from it. It is kept in the lane's history at commit `8bf90373b` (branch `wip/family1024-20261119`), for F3 to start from.

Where the build differs from the text of section 3:

- **A member's own family first.** Section 3 says "one family and one guardian row" for each member. But the writers are live before the backfill runs (W1 comes before B1), so a member who added a child since F1 already has a family. A second one would put that member in two families, which `ensureFamilyFor` would report as ambiguous and verify check 5 would count. So for the older children the backfill follows the rule of section 2.2 for where a child goes ("the member's only live family"): they go into the member's family when the member is its only live guardian. A member in several families, or in a family with another guardian, is left untouched and listed as "needs a hand", so the backfill never guesses. Neither case can happen before F4.
- **It never waits for the till.** Members and then their children are locked `FOR NO KEY UPDATE SKIP LOCKED`, the lock `ensureFamilyFor` takes for a first family. A row a till holds is skipped, counted "busy" and done by the next run, so the backfill cannot be part of a deadlock. Measured on the laptop's test database, a batch held its locks for 40 to 75 ms at 200 members, 75 to 125 ms at 500, and about 150 ms at 1000; each applied batch prints its own time.
- **Audit:** one `family.backfill` row per batch and operator (audit rows are scoped to one operator), with the member id range and that operator's counts, request id `script:family-backfill`, origin `job`. A run that writes nothing writes no audit row, so a second run leaves the database exactly as it was.
- **`child.updated_at` is not changed** by the backfill: the family is not an edit of the child's details, and nothing reads that column.
- **Check 2** counts live families only, because linking two records (F5) archives a family together with its guardian row.
- **Check 5** is added to the plan's four: members who are a live guardian of more than one live family. A member with two families of their own, with the children split between them, passes checks 1 to 4. It must be zero until F4, when a member may rightly be in several families and the check is retired.

### Step F3, first part: the platform's readers (19 November 2026, lane `lane/family-f3-20261119`, not landed)

Built and tested on the lane. Nothing is on staging, and the switch is `off` for every park group. Turning it to `read` anywhere, staging included, is a setting change that waits for the owner's word.

- **One way in.** `apps/api/src/services/family.ts` holds the switch and the read rule; no reader writes its own family join.
  - `familyProfilesMode(exec, operatorId)`: the switch at operator scope. It is read once per request (or per box batch) and handed to every read that request makes, so one answer never mixes the two rules.
  - `childOfMember(mode, { operatorId, memberId, memberLive })`: "a child of this member" as a condition on `crm.child`. At `off` it is `child.member_id = memberId`, word for word the condition each reader had, so its query is unchanged. Otherwise the member holds a live guardian row on the child's live family; the guardian row, the family and the member are all of the caller's operator; and the child is not merged.
  - `childGuardedInOperator`: "this child has a live guardian in this operator", for the owner checks of an edit or a removal, which name a child and no member.
  - `familyChildrenOfMembers`: which of several members sees which child, for the Console register.
  - `childrenSeenBy` and `memberSeesChild`: the whole rule of section 2.2, the child's own state included (the shadow compare and the tests).
- **What each reader keeps.** The child's own state (`archived_at`) and the member's own state are asked exactly where the reader asked them before.
  - The counter's lookup, the member page, the register and the booking site serve live members only, as before.
  - A visit opened before its member was archived, a drop-off naming saved children, a paid booking's stay links, the event walk-up check, the kitchen slip and the Inbox count never asked, and still do not. So an archived member gets the same answer at both settings (a reprint of an old sale keeps its allergy line).
  - The guardian ROW must always be live: a parent taken off a family (F4) sees nothing of it.
- **Ordering and paging** are unchanged: each reader keeps its own order, and the register still pages members and lists each row's children by name.
- **The switch.** `crm.family_profiles` is supported.
  - `read` is set for a park group through the Console's switch route (`PUT /console/flags`, permission `console:release:flag_manage` as every feature switch, audited `feature_flag.set`). Clearing it (`POST /console/flags/clear`, audited `feature_flag.clear`) returns to `off`.
  - `on` is refused by every write and the preview with `FLAG_VALUE_UNSUPPORTED` (the catalogue's new `settableValues`) until step F4.
  - The default stays `off` for every park group.
- **No shapes changed.** No family field is in any route answer, box bundle or audit row; `api-types --check` reports no change.

| Reader | File | Today (`off`) | At `read` | Pinned by |
|---|---|---|---|---|
| Counter lookup; member page; `POST /members` replay; tier verify and revoke answers; through them the support lookup and the assistant's member tools | `routes/members.ts` `memberWithChildren` | the live member's live children by `member_id` | the member's families' live children | `s1024-family-readers`: equivalence (lookup and page for every kind of member) and fence |
| Edit a child (owner) | `routes/members.ts` PATCH | the child's member, live, same operator | a live guardian (live member) in the operator | equivalence (owner checks); fence (guardian rows taken off) |
| Care note from the paired display | `routes/members.ts` PATCH; `services/members.ts` `displayCareRefusal` | `child.member_id` is the family named | the family named holds the child | equivalence; fence (second guardian, bystander) |
| Remove from saved (till, display, booking site) | `routes/members.ts` DELETE; `services/members.ts` `archiveChild` | the child's member in the operator | a live guardian row in the operator | equivalence (incl. already removed, archived member); fence |
| Console register | `services/members.ts` `listRegister` | children by `member_id`, by name | each member's family children, by name | equivalence (three pages); fence (second guardian on both rows) |
| Open a visit | `routes/visits.ts` POST | the member's own live children | the member's families' live children | equivalence (visits); fence |
| Add children to a visit (till; the box's `visit.children_added` reads its batch's switch) | `services/visit-children.ts` | the visit member's own live children | the visit member's families' | equivalence (visits) |
| Drop-off registration's saved children | `services/checkin.ts` `assertChildrenOfMember` | the member's own live children | the member's families' | equivalence (registration) |
| Booking site code check and save answer | `services/member-code.ts` `publicSavedChildrenOf` | the member's live children, in saved order | the member's families' | equivalence (booking site) |
| Booking site save (own child, new id, removal) | `services/family-online.ts` `saveFamilyOnline` | `row.memberId` is the pass holder | the pass holder holds the child | equivalence (booking site) |
| Booking's saved-child check | `services/family-online.ts` `checkBookingFamilyLinks` | the holder's live children | the holder's families' | equivalence (booking site) |
| Paid booking's stay links | `services/booking-supervision.ts` `registerPaidBookingChildren` | the booking member's live children | the booking member's families' | condition equivalence; booking suites at `read` |
| Event walk-up saved child | `services/event-writes.ts` `planAttendee` | `child.member_id` is the member | the member holds the child | condition equivalence; event suites at `read` |
| Kitchen slip with no visit | `services/sale-printing.ts` `orderChildren` | the member's live children, by name | the member's families' | equivalence (kitchen slip for every kind of member) |
| Inbox member child count | `services/inbox/read.ts` `conversationDetail` | a count by `member_id` | a count through the family | condition equivalence (the correlated count) |

No platform reader was missing from section 1.2. The assistant's member tools and the support lookup read through the counter's routes and need nothing of their own.

Joins of `crm.child` to `crm.member` that are NOT "this member's children", left as they are:
- **Tenancy only.** A child id is proved to be the operator's through the member it was first saved under, which never changes and is always of the family's operator: `routes/files.ts` (a child's photo), `services/photo-reuse.ts`, `services/checkin.ts` `recordWaiver`, `services/sync-checkin.ts` `checkinCacheItemAt`.
- **By child id, no member** (the stay, the band or the visit names the child): the board's edit of the saved child (`checkin.ts`), `band-food.ts`, `bands.ts`, `payments/offline.ts`, `GET /visits/:id`, the kitchen slip's visit branch.
- **Writers' own identity checks:** the replay check of `POST /members/:id/children` (`row.memberId === m.id`, the same request sent again); the inserts in `members.ts`, `sync.ts`, `family-online.ts` and the seed; `demo-reset.ts`, which deletes by `member_id`.

**The counter box is not switched in this part** (it is in the second part, below). The bundle (`services/sync.ts`, `members` scope), `child.created`'s sibling check, `child.updated`'s owner check, `visit.created`'s saved-children check and the registration replay in `sync-checkin.ts` still read `child.member_id` at both settings; they are the next part of F3. A box on today's release, with the switch at `read` on its server:
- pulls the same bundle as today: the children nested under the member they were first saved under, which, while each family has one guardian, is the family;
- has every fact it replays accepted or refused exactly as today. `visit.children_added` reads the batch's switch and gives the same answer while each family has one guardian;
- sends and receives nothing of a changed shape.

**Tests.** `apps/api/test/s1024-family-readers.test.ts`:
- every reader above at `off` and at `read`, over members with no child, several children, a removed child, an archived member, a merged member's alias and another park group's member, the answers compared whole;
- the read condition for every member of a park group, by id and in the correlated form the Inbox count uses;
- the fence: a hand-made second guardian sees exactly that family's live children besides their own and nothing else; a guardian row taken off; an archived family; another park group's member with a hand-made row; an archived member; an alias; a child not yet backfilled;
- the switch through the Console route.

`OTO_TEST_FAMILY_PROFILES=read` (test helper) runs any api suite with the switch at `read` for every park group. The shadow compare of section 3 (R1) is back on the lane: `apps/api/src/services/family-shadow.ts`, `apps/api/scripts/family-shadow-compare.ts`, and its test `s1024-family-shadow-compare.test.ts`.

Where the build differs from the text above, or chose what the text left open:

- **The member's own state, reader by reader** (above). The plan's rule says "the member is live". The readers that never asked it (a visit's member, a sale's member, a box's fact) still do not, so switching to `read` changes no answer for an archived member. For a removal the rule is "a live guardian row", without asking whether its member was archived since, as the removal never asked.
- **`on` reads as `read`** wherever a reader meets it; it cannot be set before F4.
- **The Console's control** (built in the continuation below). The Release controls page offers a supported feature switch with named values at the places its catalogue entry allows (a park group, for this switch). It is offered to a platform administrator holding `console:release:flag_manage` platform-wide, the grant the server's flag write checks. Set offers the values other than the default (`read`, `on`), takes a preview of exactly that choice, a reason and the typed key, and sends no expiry. `on` is refused at the preview (`FLAG_VALUE_UNSUPPORTED`), so its Set never enables. Each place where it is set is listed, and "Switch off…" (`POST /console/flags/clear`) returns that place to `off`. The kill switch card and its forms are unchanged.

**The readers' suites at `read`** (83 files: members, check-in, booking, visits, events, the Console, the Inbox, support, the assistant, the box's sync, the demo; `OTO_TEST_FAMILY_PROFILES=read`): 1299 of 1307 tests pass. The 8 that do not are expected, and none is a reader giving a wrong answer:
- `s1024-family-writers` (3): two pin the switch itself (they set it, and the run had already set it), and one pins a child saved before families, which at `read` nobody sees until the backfill gives it a family (the reason verify must be zero before the switch moves).
- `assistant-golden` (4): its recorded world inserts its children straight into `crm.child` with no family, as a child saved before families is; at `read` the lookup finds none of them, so the recorded answers no longer match.
- `prebooking-notice-996-review` (1): an Inbox deposit timing check; it passes on its own at `read` and at `off`.

**The whole api suite at `off`** (no test changed for it; the two catalogue pins above changed because the switch did): 550 of 560 files pass, 8 are skipped as always; 7649 tests pass. Two files did not, neither through a family reader:
- `events-e5` (9 tests): the run reached it after 17:00 UTC, when the park's day (Asia/Bangkok) had already turned while the test's own date (UTC) had not, and its booking was refused "visitDate must be between" the park's today and later. It passes whole at `off` run in the park's timezone, and passed at `read` in the run before that hour. To be run again under `TZ=UTC` between 00:00 and 17:00 UTC before landing.
- `prebooking-notice-996-review` (1 test, an Inbox deposit timing check): fails only inside the long run; on its own it passes at `off` and at `read`.

### Step F3, first part, continued (20 November 2026, same lane, not landed)

- **Rebased** onto `origin/main` at `d048c9c0d` (28 commits: the till's extra food credit, up to three displays per station, a number with no name). No conflict. `checkin.ts`, `sale-printing.ts` and `sync.ts` met main's changes cleanly, and none of main's new code reads a member's children by `member_id` (its new child reads go by band or ticket line).
- **The Console's control** for the switch, as described above: `apps/console/src/lib/suiteControlRules.ts` (`featureValueChoices`, `isSettableFeature`, `choiceAt`, `featureSetGate`), `apps/console/src/components/suite/SuiteControlViews.tsx` (the feature flags card lists each place where a switch is set, with Set… and Switch off…; `FeatureSetForm`; the clear form and the place rows say "Never: it stays until it is cleared" for a setting with no expiry) and `apps/console/src/pages/SuiteControls.tsx` (the set drawer, the `console:release:flag_manage` grant). Pinned by `apps/console/test/s1024-feature-switch-markup.test.ts`.
- **The whole api suite at `off`** after the rebase (`TZ=UTC`, `OTO_TEST_FAMILY_PROFILES` unset, no test changed): 557 of 565 files pass, 8 skipped as always; 7692 tests pass, none fails. `events-e5` passed 18 of 18 inside that run and again on its own at 21:04 UTC, both under `TZ=UTC`. It has not been run in the 00:00 to 17:00 UTC window. `prebooking-notice-996-review` passed inside the long run.
- **The readers' suites at `read`** after the rebase, widened to 151 files by name (members, children, families, check-in, booking, visits, events, register, kitchen and print, the Inbox, support, the assistant, sync, the demo, drop-off, the displays, care notes, supervision, the Console and the suite controls; `OTO_TEST_FAMILY_PROFILES=read`, `TZ=UTC`). 145 files pass; 2306 tests pass, 13 fail, 9 are skipped. None of the 13 is a reader giving a wrong answer:
  - `s1024-family-writers` (3) and `assistant-golden` (4): as recorded above.
  - `assistant-engine` (2, W5 and D2): the same world as the goldens (`test/assistant-support.ts`) inserts its two children straight into `crm.child` with no family. At `read` the lookup finds none, so the model's scripted answer names children the tool did not return and the number guard holds it back.
  - `suite-controls-integration` (3, P5, P7, P8) and `suite-controls-review` (its setup, so its 9 tests are skipped): the test helper's `read` setting is itself a row in `feature_flag`, one per park group. P5, P7 and P8 count every stored setting; the review's setup deletes the app registry, which that row references. They pin the switch table and pass at `off`.
  - `prebooking-notice-996-review` (1): the Inbox deposit timing check. Run alone at `read` it failed once and passed the next time; alone at `off` it passed.
- **Other checks after the rebase:** the api typecheck (4096 MB) prints nothing; `api-types:check` reports that `packages/api-types` matches the api, and its seam walker passes (10); `routes-guarded`, `route-write-conformance`, `id-conformance`, `leaks-and-trail` and the four `s1024` and suite-controls api files pass (169 tests); the Console's typecheck and its whole suite pass (73 files, 689 tests); the db typecheck and its family, schema-shape and suite-controls tests pass (46); eslint is clean on every file the lane touched.
- **Still the next part of F3:** the counter box's readers (section 7), unchanged in this part.

### Step F3, second part: the counter box's readers and the shadow compare (20 November 2026, same lane, not landed)

Built and tested on the lane. Nothing is on staging, and the switch stays `off` for every park group. Turning it to `read` anywhere, staging included, is a setting change that waits for the owner's word.

- **Rebased** onto `origin/main` at `d97354f79` (9 commits: the OTO App's activity log, the till's smoke tests, proof pictures), and after the checks below once more onto `b95813a4f` (35 commits: the till's counter-flow points and the OTO App's kitchen plan lines). Neither rebase had a conflict. Neither brought a change to `apps/api/src` or `packages`; only the api test `s217b-r6-review` changed.
- **The box's readers on the server** now read the switch, once per bundle (only when the `members` scope is asked, so the frequent receipt-mark pulls read nothing more) or once per batch of facts (`BatchScope.familyMode`, read in `pushEvents`). At `off` each keeps its query word for word. The plan's text above, "the counter box is not switched in this part", is replaced by this table.

| Reader | File | Today (`off`) | At `read` | Pinned by |
|---|---|---|---|---|
| The bundle's `members` scope: each member's children | `services/sync.ts` `cacheBundle` | the page's members' live children by `member_id`, nested under that member | the live children of each member's live families, nested under every member of the page who holds the family (`childrenByMemberThroughFamilies`) | `s1024-family-box`: the whole scope and a paged one compared whole, version included; second guardian; fence |
| `child.created`: the sibling check that raises the review flag (OD-7) | `services/sync.ts` | the survivor's live children by `member_id` | the survivor's families' live children | equivalence (flag raised; not raised when the only child was removed) |
| `child.updated`: the owner check | `services/sync.ts` | the child's member is in the box's park group | a live guardian of the child's family in the box's park group (the member's state not asked, as before) | equivalence; fence (an archived family, a child put in another park group's family) |
| `visit.created`: the saved children | `services/sync.ts` | the member's own live children | the member's families' live children | equivalence; second guardian; fence |
| `visit.children_added` | `services/visit-children.ts` (first part, the batch's switch) | as above | as above | equivalence; second guardian |
| The registration replay (`checkin.created`): saved children | `services/sync-checkin.ts` `applyCheckinCreated` | every saved child's `member_id` is the guardian (a removed child not asked, as before) | every saved child is held by the guardian's families | equivalence; second guardian; fence |

Left as they are, because they do not read "a member's children": `checkinCacheItemAt` (tenancy only, section 11 first part), the band and board edits by stay and child id, `payments/offline.ts` by band, the `child.created` insert (a writer, `ensureFamilyFor`), and the `member.created` merge (reads no child). The box reads members only from the bundle, never from the change feed, so the feed's `childChange` (which names `memberId`) feeds no box copy.

- **Shapes.** No field is added to a bundle item, a child in it, a fact or an audit row; `CACHE_BUNDLE_SCHEMA_VERSION` stays 1; `api-types --check` reports no change. While each family has one guardian the bundle is the same document at both settings, its version included, so a box does not even pull again when the switch moves. The `familyId` on each child and the `familyIds` on each item that section 7 describes come with step F4, which first shows a family anywhere.
- **The order of a member's children in the bundle.** Today's read sets no order. At `read` the children are read by a filter on `crm.child.family_id` with no order, as today's filter on `member_id`. Within one family the database returns them in the order it holds them, which is the order the old read gave within one member. So while each family has one guardian, every member's list comes back in the same order at both settings. The equivalence test compares the bundles whole.
- **The counter box (`packages/box-agent`) needs no change.** The code that reads the `members` scope (`cachedMemberOf`, `childOf`, `present`, `resolveMember`, `locateChild`) has not changed since 30 September (`d10d78fae`), so every box release since then reads the bundle the same way. With its server at `read`, a box on today's release:
  - while every family has one guardian (all of them until step F4): does exactly what it does today. It gets the same bundle, under the same version, and every fact it files is applied or refused as today.
  - once step F4 adds a second parent: at its next pull it gets the family's children under both parents. Offline, the second parent's number shows them, and a visit, added children or a drop-off it records under the second parent for the family's children is taken by the server. The small gaps of section 7 stay. `locateChild` names the first member holding a child; `child.updated` names no member, so nothing on the server depends on it. A child added offline under one parent shows under the other on the same box only after the next pull.
  - if the switch is set back to `off` while a box still holds a copy pulled at `read` (possible only from step F4): a visit it records offline under the second parent for the family's child is filed and refused, `apply_failed` `SYNC_VISIT_CHILD_NOT_SAVED`, and kept in the Failures list for a replay. Its next pull takes the family's children off the second parent.
- **The plan's box test** (section 9, F3), in `s1024-family-box.test.ts`. An offline visit filed under a second guardian's member id (a hand-made guardian row) for the family's child behaves as follows:
  - **At `off` it is refused, exactly as today.** `off` reads `child.member_id`, the child was first saved under the other parent, and so it is "not on this member's saved list". `visit.created` is refused `apply_failed` `SYNC_VISIT_CHILD_NOT_SAVED`; `visit.children_added` and the registration (`SYNC_CHECKIN_CHILD_UNKNOWN`) are refused `apply_failed` too. All of them are kept for a replay, never poison.
  - **At `read` all three are taken.** The family's removed child, a bystander's child, and the second parent's own child under the first parent are still refused.
  - The test is run twice: with raw facts, and with the box's own code (`createBoxAgent`, as the Pi runs it, over a cut link). At `read` the box's offline lookup by the second parent's number shows the family's child, and the visit lands when the link is back. At `off` the box's copy shows only their own child, and the counter refuses the family's child before anything is filed.

**The shadow compare, reworked** (`apps/api/src/services/family-shadow.ts`, `apps/api/scripts/family-shadow-compare.ts`, `s1024-family-shadow-compare.test.ts`; its section in `FAMILY_BACKFILL_RUNBOOK.md`, section 9).
- **What it compares.** It used to compare only the counter lookup's set (a live member's live children). It now compares the link itself, for every member of every park group, archived or not:
  - the children first saved under the member (removed ones included);
  - the children the member holds through its families: `childOfMember` at `read`, called as the readers call it, without asking the member's state; removed ones included, merged ones not.
  Every reader asks one of these two and adds its own conditions the same way at both settings. So one clean run stands for every reader, the box's included.
- **What it reports.** The number of members compared, the children on each side, and the members with a difference. Under each kind of difference (no family; a family the member does not hold; an archived family; merged; another member's child) it gives the count and up to `--sample` member ids (default 20), each with its operator and child ids. It never prints a name. It exits 1 when any member differs.
- **Where it lives.** It stays beside the api (`pnpm --filter @oto/api exec tsx scripts/family-shadow-compare.ts`), not beside `family-verify.ts`. It calls the read rule the readers call, in `apps/api/src/services/family.ts`, which the db package cannot import, and a copy of the rule in the db package would compare the data with a second description of the rule rather than with the code that runs. It takes its database from `DATABASE_URL` like the other two.

**Choices this part made** that the text above left open:
- `child.updated` at `read` asks "a live guardian of the child's family in this park group", not the member's state, because this path never asked it. That is the removal's rule, not the till edit's, which asks for a live member because the till's always did.
- The bundle reads the family with two plain index reads (the members' families, then those families' children) rather than `childOfMember`'s correlated form, so that a page of 1,000 members costs two statements and keeps today's order. The helper sits in `services/family.ts` with the rest of the rule.
- A child put by hand into another park group's family (verify check 4 counts it) is read as that family's: at `read` the box of the child's first member no longer reaches it. The compare reports it on both members (not held; another member's child).

**Checks** (on the lane after the rebase, `TZ=UTC`, embedded test databases only):
- **The box's suites in the api, 58 files by name** (sync, offline, bridge, box, gate and booth sync, the check-in sync and offline gates, printing on the box, the virtual box, and the four `s1024` files):
  - at `off` (`OTO_TEST_FAMILY_PROFILES` unset, no existing test changed): all 58 files pass; 611 tests pass, 1 todo.
  - at `read` (`OTO_TEST_FAMILY_PROFILES=read`): 57 files pass; 608 tests pass, 1 todo, 3 fail. The 3 are the `s1024-family-writers` tests recorded in the first part. Two of them pin the switch itself; the third pins a child saved before families, which nobody sees at `read` until the backfill gives it a family.
- **`packages/box-agent`'s own suite:** 1001 of 1001 pass. It has no server, so the switch does not apply to it.
- **The new and reworked tests:** `s1024-family-box`, 7 of 7; `s1024-family-shadow-compare`, 9 of 9. Both are also inside the runs above.
- **The db package:** its tests pass (73 files, 485 tests), and `verify-schema` matches `0137_snapshot.json`. No migration was added.
- **The api:** its typecheck (4096 MB) prints nothing. `api-types:check` reports that `packages/api-types` matches the api, and the seam walker passes (10 of 10).
- **eslint** is clean on every file this part touched.
- **Not run in this part:**
  - The whole api suite. It was last run at `off` after the first part's rebase; it is to be run again, at `off` and with no test changed, before landing.
  - The compare on staging. It needs this release live there and the owner's go.
