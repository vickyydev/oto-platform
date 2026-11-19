# Family profiles: several parents or guardians for the same children

SCRUM-1024 and SCRUM-1025. **State, 19 November 2026: PROPOSED.** A plan written from a read of the code at main 3231ee7e3; nothing is built. The eight questions of section 10 are the owner's to answer before the build starts. The specification is section 4 of `ANSWERS.md` beside this file. The code comparison is `DROPOFF_AND_TILL_COMPARISON.md`: rows D15 to D17 and its section 3. Nothing here is decided beyond those answers. Where a rule still belongs to the owner, it is a numbered question in section 10, with today's behaviour as the default until he answers.

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
