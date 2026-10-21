# Unified Inbox: the build plan for Cut B, with Cut A marked inside it

**Ticket:** SCRUM-220 (S2-19). **Spec:** `docs/features/inbox.md`, plus the
S2-19 block in `docs/progress/SPRINT_2_PLAN.md:2699-2763`.
**Source of the rules:** the park's prototype in `imports/oto-asset-manager/`.
The working logic is in `artifacts/oto-org-chart/src/WhatsAppDemo.tsx`, and
the in-app IT Brief is in `Brief.tsx`. The prototype is reference input only.
Nothing is built from `imports/`, and nothing under it is committed. Every
ported function is copied into our tree and committed there.
**Status:** plan only. No product code, migrations or Jira changes come with
this file.

## The decision this plan is for

The owner chooses one of two cuts before the build starts. Both run from this
document.

- **Cut A: the pillars and the designed shell.** This is the S2-19 block as
  narrowed on 2026-10-14. It delivers:
  - the `inbox` schema, permissions and seed;
  - read-only routes;
  - the shell in the prototype's design, reading seeded conversations;
  - one real feed: the check-in confirmation, which appears as an outbound
    message.

  Every write action is visible and disabled, with the line "Coming with the
  channel connection".
- **Cut B: the Inbox working (recommended).** Cut B is everything in Cut A,
  plus these, all working for real:
  - routing, with a default primary per category and language and the backup
    added automatically;
  - assignment, with category-follows-primary and its confirmation;
  - Divert, move-team, reply, Handled and reopen (including the automatic
    reopen when the customer writes again);
  - templates, the dashboard counts, the PDPA erasure path and the webhook
    ingest.

  They run against a **simulator channel** and the real check-in feed. Only
  live WhatsApp and Instagram wait, because they need the park's Meta
  accounts. Connecting one later is configuration plus a webhook URL: the
  adapter skeleton is built and tested against recorded payloads, but it is
  never live in this story.

**How Cut A is marked.** Every section below tags its pieces **[A]** (in both
cuts) or **[B]** (Cut B only). If the owner picks Cut A, build only the [A]
pieces, in the same rounds. Nothing in Cut A is thrown away by Cut B later:
- **Write switch.** The write actions are disabled by a server capability
  (`writes` on `GET /inbox/me`), not by code that is deleted later. Cut A
  ships with the capability off. Cut B turns it on for every channel except
  the check-in notices.
- **Write routes.** In Cut A they do not exist yet. Adding them is additive.

**Effort, in rounds** (§8 has the detail):
- **Cut A:** four short rounds, about 2.5 round-equivalents of lane work.
- **Cut B:** four full rounds, about 4 round-equivalents.
- **The difference:** about 1.5 rounds. That is the write half of the api
  (routing, assignment, reply, ingest, simulator) and the write half of the
  shell (the pickers, confirmations, composer and simulator panel).

## What reading the repo changed

These findings correct or sharpen the feature doc and the S2-19 block. Each
one is fixed in `docs/features/inbox.md` in the commit that lands I1.

- **There is no `packages/contracts`, and we do not create one.** The S2-19
  block puts `MessagingChannel` there (`SPRINT_2_PLAN.md:2734`). The 2C2P
  work met the same gap and recorded its answer: the contract, the simulator
  and the provider live in one package of their own
  (`packages/payments-2c2p/src/contract.ts:15-21`). The Inbox follows that
  precedent as **`packages/messaging` (`@oto/messaging`)**. If a contracts
  package ever exists, moving the contract is an import-path change, not a
  redesign.
- **The "console adapter" is the SMS console sender, hard-wired.** The
  check-in confirmation goes through `sendContactTest`
  (`apps/api/src/services/checkin.ts:2000-2027`). The sender it receives is
  always `buildSmsSender({ adapter: 'console' })`, even on staging, where
  `SMS_ADAPTER=twilio` (`render.yaml:530-531`) is used only for staff codes.
  The callers are:
  - `apps/api/src/routes/checkin.ts:304-306` (`consoleMessenger`);
  - `apps/api/src/services/booking-payment.ts:255-256`;
  - `apps/api/src/services/sync-checkin.ts:311-314` (the offline-box replay).

  The booking confirmation is a second console send
  (`booking-payment.ts:276-289`). The feed is therefore built as a **mirror
  inside `sendContactTest`** (§2.4), which catches all three callers at once.
  It is not built by swapping a sender.
- **The check-in message is "WhatsApp-shaped" but delivered nowhere.** The
  registration's `contactChannel` is `whatsapp | telegram | line`
  (`checkin.ts:1515`, `crm` `CONTACT_CHANNELS` at
  `packages/db/src/schema/members.ts:57`). The feature doc's channel list
  omits Telegram. The `inbox` CHECK therefore includes `telegram`, as a
  channel with no adapter, which is owner Q22's stated default.
- **The prototype's tab rules differ from the IT Brief.**
  - The Brief says "three tabs, same shape for everyone", and that Team Inbox
    is "everything Active for my team that isn't already mine"
    (`Brief.tsx:336-341`).
  - The code hides My Inbox for the owner and for both reception views
    (`WhatsAppDemo.tsx:705-710`).
  - In the code, Team includes the viewer's own conversations
    (`WhatsAppDemo.tsx:716-717`).

  Under the standing ruling that prototype code is ported as is (see
  `oto-prototype-rules-not-bugs`), we port the **code**. The difference goes
  to the owner as a note on SCRUM-220, not as a question that blocks the
  build.
- **The prototype's assignee pick is not the IT Brief's routing.**
  `aiPickAssignee` (`WhatsAppDemo.tsx:678-695`) filters on availability
  toggles and a language preference, and returns the first candidate. The IT
  Brief replaces this with fixed primary and backup pairs plus Divert
  (`Brief.tsx:393-403`, `:463-465`). The code has no backup logic and no
  Divert at all. Routing is therefore built as the rule table the Brief
  describes, and `aiPickAssignee` is not ported. What is ported from it are
  two rules: manual-only people are never picked automatically (`:686`), and
  a branch value of "all" matches any branch (`:688`).
- **Status values.** The code stores `"new"` and labels it "Active"
  (`WhatsAppDemo.tsx:63, 181`). The database stores `active | handled`.
- **The dashboard's average response is a constant.** It is hard-coded per
  role (`WhatsAppDemo.tsx:1110-1116`). The real figure is computed from
  `first_response_at`.
- **The sign-on pattern is the Console's, not Radar's.**
  - Radar exchanges the hand-off on its own Express server
    (`apps/radar/server/signOn.ts`, plus its Dockerfile).
  - A static site has no server. It exchanges through its `/api` rewrite and
    gets a cookie on its own origin, as the Console does
    (`apps/console/src/auth/handoff.ts`, `render.yaml:845-853`).
  - The `inbox` audience is already a cookie audience. Only `booth` is
    identity-only (`apps/api/src/services/handoff.ts:530`).
- **There is no worker process.** The feature doc's "messaging role in the
  worker" (`inbox.md:299-301`) has nowhere to run: the jobs worker is
  commented out (`render.yaml:1352`). Jobs run in the api through pg-boss
  (`apps/api/src/services/jobs.ts`). Inbox jobs go there.
- **The `inbox` schema is anticipated but not registered.** `helpers.ts:7`
  names it. `OWNED_SCHEMAS` (`packages/db/src/schema/helpers.ts:35`) and
  `schemaFilter` (`packages/db/drizzle.config.ts:18`) both lack it, so I1
  adds it to both.
- **Only administrators can see the tile today.**
  - `app:inbox:access` exists (`packages/shared/src/permissions.ts:291`), but
    only `platform_admin` and `operator_admin` hold it, through `ALL`
    (`:384-386`).
  - The tile's origin is unset, so the tile stays "coming soon"
    (`apps/launcher/src/suite/apps.ts:130-140`). `VITE_INBOX_URL` is
    deliberately absent from the launcher's env (`render.yaml:806-825`).

## 1. Schema [A]

### Rules for every new table

- **Placement.** A new Postgres schema `inbox`, declared as
  `export const inbox = pgSchema('inbox')` in `helpers.ts`, and added to
  `OWNED_SCHEMAS` and `schemaFilter`. These are **platform** migrations in
  `packages/db/migrations`. They are not the OTO App's journal.
- **Numbering.** The journal ends at `0077_voucher_product_link`, so ours is
  **`0078_inbox_schema`**. If another lane lands a migration first, ours
  shifts up by one, and the I1 lane re-checks the head before generating.
- **Generation.** Use `pnpm db:generate`, then hand-edit, then commit the
  `.sql`, the snapshot and the journal together. The migration is
  expand-only, so it needs no undo notes.
- **Columns every table carries.**
  - `operator_id uuid NOT NULL REFERENCES core.operator`.
  - `created_at` and `updated_at` (the `timestamps` helper).
  - UUIDv7 ids generated in the application. **A reader never orders by
    id: `created_at`, then `id`** — the id breaks a tie, it is never the
    order. An id is minted by its caller (OD-12) on the caller's clock, and a
    browser's `crypto.randomUUID()` is a v4 that sorts after every v7
    (customer-AI test night 2026-10-21, CR6, in the assistant plan).
  - Enumerations as `text` with a CHECK constraint, never a pg enum, so that
    adding a channel takes no DDL lock (`members.ts:52-56`).
- **Tenant fence on child tables.** `conversation` carries a unique
  `(operator_id, id)`. `message`, `participant`, `assignment`, `event`,
  `conversation_tag` and `note` reference it through a **composite foreign
  key** `(operator_id, conversation_id) → conversation(operator_id, id)`. A
  row can then never point across operators. This pattern is new to the
  platform schema, which uses plain foreign keys plus operator-scoped loads
  (SCRUM-248), and it costs nothing here. Services still load every row
  scoped to the caller's operator first.
- **Indexes.** Every foreign key and every lookup column is indexed: phone,
  handle, `status`, `last_message_at` and `handled_at`.
- **Cross-schema links are soft.** `member_id`, `department_id`,
  `booking_ref` and `event_order_ref` are plain uuid or text columns with no
  foreign key across schemas (`inbox.md:322-323`). The exceptions are `core`
  accounts, branches and files, which are hard foreign keys, as the other app
  schemas do.

### Tables (all in `0078_inbox_schema`)

These follow `docs/features/inbox.md:351-421`, with the changes marked
*(added)* or *(changed)*.

| Table | Columns and constraints |
|---|---|
| `channel_account` | `branch_id` (null means operator-wide); `channel` CHECK in (`whatsapp`, `instagram`, `facebook`, `line`, `telegram` *(added)*, `webform`); `provider` CHECK in (`meta_cloud`, `meta_graph`, `line`, `respond_io`, `webform`, `simulator`, `console` *(added)*); `external_id`; `display_name`; `credential_ref` (the name of a secret, never its value); `opening_hours` jsonb; `out_of_hours_template_key`; `default_category` *(added)*, the classification used when nothing classifies; `can_reply` bool *(added)*, false on `console`; `status` CHECK in (`active`, `paused`, `error`); `archived_at`. Unique on `(operator_id, provider, external_id)`. |
| `contact` | `channel`; `external_handle`; `display_name`; `avatar_file_id` → `core.file_object`; `phone` (E.164 when known); `member_id` (soft link); `language`; `first_seen_at`; `last_seen_at`; `opted_out_at`. **PDPA:** `erased_at`, `erased_by_account_id`. Unique on `(operator_id, channel, external_handle)`. Index on `(operator_id, phone)`. |
| `team` | `key` CHECK in (`birthdays`, `reception`, `marketing`); `branch_id` (set only for `reception`); `department_id` (soft link to `core.department`; membership is the department-scoped role assignment); `name`; `colour`; `sort_order`. Unique on `(operator_id, key, coalesce(branch_id, …))`. |
| `routing_rule` | `team_id`; `category` CHECK in (`birthdays`, `general`, `marketing`); `language` (null means any); `branch_id` (null means any); `primary_kind` CHECK in (`account`, `team`) *(changed: `team_phone` becomes `team`)*; `primary_account_id`; `backup_account_id`; `auto_add_backup`; `priority`; `active`. CHECK: `primary_kind='account'` requires `primary_account_id`. |
| `conversation` | `contact_id`; `channel_account_id`; `team_id`; `branch_id`; `category`; `intent`; `language`; `status` CHECK in (`active`, `handled`); `handled_at`; `handled_by_kind` CHECK in (`account`, `ai`); `handled_by_account_id`; `reopened_at`; `first_response_at`; `last_customer_message_at`; `last_staff_message_at`; `last_routed_at` *(added)*; `last_message_at`; `last_message_preview` *(added; at most 140 characters; cleared on erasure)*; `member_id`; `booking_ref`; `event_order_ref`; `ai_summary` (unused). **PDPA:** `retain_until` (null means no purge, per owner Q19's default). **Unique on `(operator_id, contact_id, channel_account_id)`**: one continuous thread per contact per number, which is what makes "the customer writes again" reopen the same thread. Indexes on `(operator_id, status, team_id)`, `(operator_id, last_message_at desc)`, `(contact_id)` and `(retain_until)`. |
| `message` | `conversation_id`; `direction`; `author_kind` CHECK in (`customer`, `staff`, `ai`, `system`); `author_account_id`; `body`; `body_language`; `translated_body`; `translated_to`; `media_file_ids` uuid[]; `audio_file_id`; `transcript`; `template_id`; `external_message_id`; `provider_status` CHECK in (`queued`, `sent`, `delivered`, `read`, `failed`); `error`; `sent_at`; `delivered_at`; `read_at`; `source` *(added: `channel`, `checkin.contact`, `booking.confirmation`)*; `source_id` *(added)*. **PDPA:** `redacted_at`. Unique on `(channel_account_id, external_message_id)` where `external_message_id` is not null. |
| `participant` | `conversation_id`; `account_id`; `first_seen_at`; `last_read_message_id`; `last_read_at`; `muted_at`. Unique on `(conversation_id, account_id)`. |
| `assignment` | `conversation_id`; `slot` CHECK in (`primary`, `support`); `assignee_kind` CHECK in (`account`, `team`, `ai`); `account_id`; `team_id`; `assigned_by_kind`; `assigned_by_account_id`; `reason` CHECK in (`auto`, `manual`, `divert`, `move`, `reopen`); `assigned_at`; `released_at`. Partial unique indexes on rows where `released_at` is null: one primary per conversation; one row per (conversation, account); one row per (conversation, team). At most two active support rows, enforced by the service under `SELECT … FOR UPDATE` on the conversation, because a CHECK cannot count rows. |
| `template` | `key` CHECK in (the eight keys at `inbox.md:395-397`); `language`; `channel` (null means any); `branch_id` (null means any) *(added: the brochure is per branch)*; `body`; `attachment_file_ids`; `provider_template_name`; `approval_status` CHECK in (`not_required`, `pending`, `approved`, `rejected`); `active`; `updated_by_account_id`; `archived_at`. Unique on `(operator_id, key, language, coalesce(channel,''), coalesce(branch_id,…))` where `archived_at` is null. |
| `tag`, `conversation_tag` | As in the doc. Created and left unused (the briefs use structured fields). |
| `sla_policy` | As in the doc. Created and left unused (owner Q25). |
| `event` | `conversation_id`; `kind` (the doc's list, plus `notice_mirrored`); `actor_kind`; `actor_account_id`; `payload` jsonb, which **never holds a message body** (a check in §6 asserts this); `created_at`. Append-only, through a trigger that refuses UPDATE and DELETE, except the erasure function, which nulls payload fields. |
| `note` | Reserved, unused (the IT Brief forbids staff-only notes). |
| `webhook_receipt` | `channel_account_id`; `provider_event_id`; `received_at`; `signature_ok` *(added)*; `payload` jsonb; `processed_at`; `error`. **PDPA:** `payload_purged_at`. **Unique on `(channel_account_id, provider_event_id)`** *(changed from globally unique, because ids are only unique within one provider account)*. |

### Permissions [A]

All are declared in `packages/shared/src/permissions.ts` under a new
`// Inbox (S2-19)` block. Declaring them in I1 means the roles can carry
them before any route enforces them (the rule at `permissions.ts:7-11`).

| Permission | What it opens |
|---|---|
| `inbox:conversation:read` | Lists, threads, the dashboard of the teams in scope. |
| `inbox:conversation:reply` | Send in a thread the account can read. |
| `inbox:conversation:assign` | Add or remove support; change primary; Divert on someone else's behalf. |
| `inbox:conversation:move` | Move to another team (and branch). |
| `inbox:conversation:handle` | Mark as Handled. |
| `inbox:conversation:reopen` | Reopen by hand (the automatic reopen needs no permission). |
| `inbox:template:manage` | Templates. |
| `inbox:channel:manage` | Channel accounts, the simulator panel. |
| `inbox:dashboard:read` | The metric cards. |
| **`inbox:routing:manage`** *(proposed addition)* | The routing rules: who is default primary and backup. Its own permission because changing who receives every Thai birthday enquiry is not channel configuration. |
| **`inbox:contact:erase`** *(proposed addition)* | The PDPA erasure. It is irreversible, so it is held by the operator administrator only. |

The two additions are flagged on SCRUM-220. If the owner declines them,
routing folds into `inbox:channel:manage` and erasure into
`admin:operator:all`.

### Roles [A]

The five system bundles stay as they are. `platform_admin` and
`operator_admin` take the new permissions automatically through `ALL`. The
nesting rule (staff ⊆ reception ⊆ branch_manager) is not touched, so the
dominance tests do not move. `platformSync` seeds three **operator roles**,
insert-if-absent:

| Role | Permissions | Assigned with scope |
|---|---|---|
| `inbox_agent` | `app:inbox:access`, conversation `read`, `reply`, `handle`, `inbox:dashboard:read` | **department**: the team's department. This is what makes a person "in the team". |
| `inbox_manager` | agent's set plus `assign`, `move`, `reopen`, `inbox:template:manage` | **operator**, for the owner and the GM, who see everything. **Branch**, for a branch manager. |
| `inbox_admin` | manager's set plus `inbox:channel:manage`, `inbox:routing:manage` | operator |

`inbox:contact:erase` is in none of the three, so only `operator_admin`
holds it.

**What counts as a team.** A team is `inbox.team.department_id`:
- **Reception · Central and Reception · Chalong** reuse each branch's
  existing `reception` department (`packages/db/src/seed/index.ts:385-409`).
- **Birthdays & Events and Marketing** are two new operator-wide departments
  (`branch_id` null).

`platformSync` creates them insert-if-absent.

**Manual-only people.** The entertainment coordinator and the GM
(`WhatsAppDemo.tsx:139, 143`; `Brief.tsx:148-153`) get no `inbox_agent`
assignment on a team. They see only the conversations they are assigned to,
through the assignment rule in §3.2. They are never picked by routing,
because routing picks only from `routing_rule` rows.

### Seed [A]

There are two kinds of seed data.

**Configuration** is real, idempotent and laid by `platformSync`, which runs
on every staging deploy. It never overwrites an edit:
- the four teams;
- the routing rules for the IT Brief's defaults:

  | Category and language | Primary | Backup (auto-added) |
  |---|---|---|
  | EN and RU birthdays | birthday manager EN/RU | EN/RU backup |
  | TH birthdays | birthday manager TH | TH backup |
  | marketing | marketing owner | GM |
  | general | reception team of the branch | none |

- one **catch-all rule per team** with `primary_kind='team'`, so routing can
  never leave a conversation unowned;
- the eight template keys in English, with RU and TH rows marked for
  translation (`approval_status='not_required'` until a Meta account
  exists);
- one `console` channel account per operator and per notice channel
  (whatsapp, line, telegram), with `can_reply=false`.

The rules' **people are blank** (`primary_kind='team'`) until someone names
them. Naming them is an edit in the Inbox settings or the Console, never
code (owner Q20).

**Demo data** is fictional and never laid by `platformSync`:
- `pnpm --filter @oto/db seed:inbox-demo` follows the `seed:demo-day`
  precedent. It runs locally and in CI, and by hand on staging once.
- It creates:
  - **ten fictional conversations** written fresh for this story (none copied
    from the export), spread across WhatsApp, Instagram and Facebook,
    across all three categories and across EN, RU and TH;
  - **six demo staff accounts** with plainly fictional names, linked to the
    rules, so routing and Divert show real people.
- On **Cut A** the script inserts the rows directly.
- On **Cut B** the same fixtures are **played through the simulator**
  (`POST /inbox/simulator/scenario`), so the demo data itself proves the
  ingest and routing path.

## 2. The channel contract: `@oto/messaging`

### 2.1 The package

`packages/messaging` has the same shape as `packages/payments-2c2p`: it is
pure Node, depends only on `@oto/shared`, has no database access, and has its
own Vitest tests.

- **`contract.ts` [A].**
  - **`MessagingChannel`**:
    ```ts
    interface MessagingChannel {
      readonly provider: Provider;
      readonly capabilities: { reply: boolean; media: boolean; freeTextWindowHours: number | null };
      verifyWebhook(req: RawWebhook): WebhookVerdict;          // signature + verify-token challenge
      parseWebhook(req: RawWebhook): InboundEvent[];           // normalise: message | status | unknown
      send(msg: OutboundMessage): Promise<SendResult>;         // provider message id or a typed refusal
      fetchMedia(ref: MediaRef): Promise<{ contentType: string; bytes: Uint8Array }>;
    }
    ```
  - **The normalised types.** `InboundEvent` carries the provider event id,
    the external message id, the handle, the display name, the phone, the
    text, media refs and a timestamp. A status event carries delivered, read
    or failed.
  - **The refusals.** `SendResult` refusals are values, never throws:
    `OUT_OF_WINDOW`, `TEMPLATE_REQUIRED`, `RATE_LIMITED`, `REJECTED`,
    `UNREACHABLE`.
  - **Optional classification hints.** `ClassificationHint` carries
    category, intent, language and branch. The simulator supplies it;
    nothing live does yet (§3.1).
- **`console.ts` [A].** `ConsoleChannel` wraps an injected `SmsSender`, so
  the api passes the same console sender it uses today. `send()` writes the
  log line exactly as now, with the phone hashed (`sms.ts:97-104`). Its
  capabilities are `reply: false`. Webhook and media throw "not a receiving
  channel".
- **`simulator.ts` [B].** `SimulatorChannel` is the twin of a Meta account.
  - **Webhooks.** It signs synthetic payloads with a per-deployment secret,
    in the same envelope shape the WhatsApp parser reads. A simulator press
    therefore goes through `verifyWebhook` and `parseWebhook` like a real
    one, as the 2C2P simulator signs its own notification
    (`apps/api/src/routes/webhooks.ts`, header comment).
  - **Send.** `send()` accepts at once and schedules delivered and read
    status events.
  - **Media.** `fetchMedia()` returns a bundled fixture image.
  - **The 24-hour rule.** It honours `freeTextWindowHours: 24`, so the
    template-only rule outside the window is exercised before any Meta
    account exists.
- **`whatsapp-cloud.ts` [B, skeleton].** It implements the contract against
  the WhatsApp Cloud API shapes:
  - the GET verify-token challenge;
  - `X-Hub-Signature-256` HMAC verification with the app secret;
  - parsing of the `messages` and `statuses` changes;
  - the send body for text and template messages;
  - the two-step media download.

  It is tested only against **recorded fixture payloads**. It is never
  constructed unless `INBOX_WHATSAPP_ENABLED=true` and its four variables
  are set. The api refuses to boot with the flag on and a variable missing,
  as `buildSmsSender` does for Twilio (`sms.ts:427-544`). No Meta account is created or used in
  this story.

Instagram, Messenger and LINE adapters are **not** built (owner Q22). The
contract and the skeleton fix the shape they will take.

### 2.2 Where the adapters are chosen

`apps/api/src/services/inbox/channels.ts` maps a `channel_account.provider`
to an instance:

| Provider | Instance |
|---|---|
| `console` | `ConsoleChannel` |
| `simulator` | `SimulatorChannel`, only where `INBOX_SIMULATOR=on` (local, CI, staging; refused in production by `assertProductionSafe`) |
| `meta_cloud` | the skeleton, only behind its flag |

Anything else answers `CHANNEL_NOT_CONNECTED`.

### 2.3 Environment variables (documented in `.env.example` and `render.yaml`)

| Variable | Notes |
|---|---|
| `INBOX_SIMULATOR` | `on` or `off` [B]. |
| `INBOX_SIMULATOR_SECRET` | [B]. |
| `INBOX_WHATSAPP_ENABLED` | Default `false` [B]. |
| `INBOX_META_APP_SECRET`, `INBOX_META_VERIFY_TOKEN` | Names only [B]. |
| `INBOX_WHATSAPP_TOKEN_<ref>` | Read through `credential_ref`, names only [B]. |
| `INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS` | Unset means no purge [B]. |

### 2.4 The check-in feed: one real feed from day one [A]

The feed is a mirror inside `sendContactTest`
(`apps/api/src/services/checkin.ts:2000-2027`), after `sms.send` succeeds:

```
await mirrorNotice(tx, {
  operatorId, branchId: reg.branchId,
  channel: reg.contactChannel, phone: reg.guardianPhone, displayName: reg.guardianName,
  body, source: 'checkin.contact', sourceId: reg.id,
});
```

`mirrorNotice` (in `apps/api/src/services/inbox/notices.ts`) does five
things:
1. finds or creates the `console` channel account for that channel;
2. upserts the `contact` on `(operator, channel, phone)`, linking
   `member_id` by E.164 when the phone is a member's;
3. upserts the conversation;
4. inserts an outbound `message` with `author_kind='system'`,
   `provider_status='sent'`, the `source` and `source_id` columns, and a
   synthetic `external_message_id` of `checkin.contact:<regId>:<sentAt>`;
5. writes an `event` of kind `notice_mirrored`.

The rules around it:
- **A notice routes like anything else.** The conversation is routed by the
  same router as other new conversations (category `general`, the
  registration's branch, so the reception team of that branch). A notice
  thread therefore has an owner like every other thread.
- **It runs inside a savepoint** (`tx.transaction(...)`). A failure is
  logged and recorded as an `ops_run` of kind `inbox:notice_mirror`. It is
  **never** thrown into the check-in: a family is never held at the counter
  because the inbox could not write.
- **It covers every path that sends the notice.** All three callers (the
  till routes, the booking payment and the offline-box replay) reach
  `sendContactTest`. The replay is already de-duplicated by
  `autoSendRegistrationContact`'s contact check (`checkin.ts:1984`), so a
  restored outbox mirrors nothing twice.
- **The booking confirmation is mirrored too.**
  `sendBookingConfirmation` (`booking-payment.ts:276-289`) uses
  `source='booking.confirmation'` and the same function.
- **Erasure must reach the duplicate.** The audit row `recordContact` writes
  already holds no body (`checkin.ts:1962-1974`). The mirror is the first
  place the notice's text is persisted, which is one more reason the erasure
  path in §3.6 must cover it.

## 3. Services and routes on the platform api

Services live in `apps/api/src/services/inbox/*.ts` and routes in
`apps/api/src/routes/inbox.ts` and `routes/webhooks.ts`. Business logic
stays in services. Every write follows the platform recipe:
- it runs through `withTx`;
- it writes `audit.record` in the same transaction;
- it accepts an `Idempotency-Key`;
- it gets its entry in the conformance lists (§6).

### 3.1 Routing [B, with the read-side helpers in A]

These pure rules go in `packages/shared/src/inbox.ts`, so that the server's
counts and the shell's tabs are the same code, tested once:
- `teamDestOf` (`WhatsAppDemo.tsx:965-969`);
- `inTab` (`:712-721`) and `tabsForRole` (`:705-710`, ported as is; see
  "What reading the repo changed");
- `isUnanswered` (`:644-656`, restated over columns as
  `status='active' AND (last_staff_message_at IS NULL OR last_customer_message_at > last_staff_message_at OR last_routed_at > last_staff_message_at)`);
- the scope rule (`:662-674`).

Messages written by the AI do not count as answered (`:651`).

**Default routing** (`router.ts`) runs on every new conversation:
1. **Classify.** Without AI (owner Q24 is out of scope), the classification
   is the simulator's hint when there is one. Otherwise it is the channel
   account's `default_category` and `branch_id`, with the contact's
   language or `en`.

   A `Classifier` interface holds this place. The AI provider plugs in
   later, and nothing else changes.
2. **Pick the rule.** Take the highest-priority active `routing_rule`
   matching category, language and branch, where null means any and
   "all" matches any branch (`WhatsAppDemo.tsx:688`). The catch-all
   guarantees a match. The service refuses to archive the last catch-all of
   a team.
3. **Assign.** Insert the primary assignment (`reason='auto'`). If the rule
   has `auto_add_backup` and a backup, insert the backup as **support**
   from the first message (`Brief.tsx:400`).
4. **Record.** Set `last_routed_at` and write `event` rows of kind
   `routed` and `assigned`. These are the grey system pills.
5. **Branch confirmed later.** When a birthday's branch is set later, the
   birthday manager who hosts at that branch is added as support if a slot
   is free (`inbox.md:128-129`). That is a `routing_rule` lookup with
   `category='birthdays'` and `branch_id` set.

### 3.2 Visibility (all reads) [A]

A conversation is visible to an account when any one of these holds
(`inbox.md:158-164`, `WhatsAppDemo.tsx:662-674`):
- (a) it holds `inbox:conversation:read` at operator scope;
- (b) it holds it at the scope of the conversation's branch;
- (c) it holds it at the scope of the conversation's **team department**;
- (d) it has an active `assignment` on the conversation, which is how the
  GM and the coordinator see their threads.

This is implemented once as `visibleConversations(db, auth)`, which returns
a SQL predicate built from `resolveEffectivePermissions`. By-id routes load
the conversation **inside the caller's operator** first and then check
(a)–(d). That satisfies `route-scope-target.test.ts` (SCRUM-290). A
conversation the account cannot see answers 404, not 403, so its existence
is not revealed.

### 3.3 Routes

**[A]** marks a route in both cuts, **[B]** a route in Cut B only. Every
response is a zod schema, so `api-types` sees it.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /inbox/me` [A] | `app:inbox:access` | The viewer's teams, their tabs (`tabsForRole`), the assignable people per team, and `writes` (false in Cut A). |
| `GET /inbox/conversations` [A] | `inbox:conversation:read` | Query: `tab`, `category`, `branchId`, `status`, `language`, `q`, `unanswered`, `handledFrom`, `handledTo`, `resolvedBy`, `cursor`. Visibility predicate from §3.2; keyset pagination on `last_message_at`; unread counts from `participant`. |
| `GET /inbox/conversations/{id}` [A] | read, by-id load | Header, assignments, contact, the linked member's name and child count (no allergy text here; the POS owns that). |
| `GET /inbox/conversations/{id}/messages` [A] | read | `before` cursor. Media come back as ids; signed URLs from `GET /files/{id}` after the conversation check (§3.6). |
| `POST /inbox/conversations/{id}/read` [A] | read | Advances `participant.last_read_message_id`, and records the **sampled read audit** (§3.6). |
| `GET /inbox/dashboard` [A] | `inbox:dashboard:read` | New today, unanswered, handled today, average first response (opening hours ignored; owner Q25), messages by category, all within visibility. "Needs manager" and "unassigned" are gone under the IT Brief, and the BEO card waits on Q23. |
| `GET /inbox/templates` [A] | read | Active templates for the composer. |
| `POST /inbox/conversations/{id}/messages` [B] | `reply` | Body `{ id, text? , templateId? }`. The id is caller-named (UUIDv7), so a retried send is the same message. Refused when handled (`CONVERSATION_HANDLED`, "Reopen it to reply"), when the channel cannot reply, and outside the 24-hour window without a template (`TEMPLATE_REQUIRED`). Inserts the message `queued` and enqueues `inbox:send`. Sets `first_response_at` if unset. |
| `PUT /inbox/conversations/{id}/primary` [B] | `assign`, or the actor is the current primary | Body `{ assignee: {kind, id}, confirmMove?: boolean }`. **Category follows primary** (`WhatsAppDemo.tsx:1150-1162`): if the new primary's team differs, the server answers `409 CATEGORY_MOVE_UNCONFIRMED`, with the destination, unless `confirmMove` is true. That is the prototype's "Changing primary owner will move this conversation to the new department. Continue?" (`:1699-1723`), enforced on the server. A management primary (operator-scoped, no team) keeps the category (`:1153`). One slot per person (`:1142`). |
| `POST /inbox/conversations/{id}/support` [B] | `assign` | Adds to the next free support slot. A third is refused (`SUPPORT_FULL`). |
| `DELETE /inbox/conversations/{id}/support/{assignmentId}` [B] | `assign` | Releases (`released_at`). Never deletes. |
| `POST /inbox/conversations/{id}/divert` [B] | the current primary, or `assign` | Swaps the primary with the routing rule's backup (`Brief.tsx:401-402, 465`). The old primary becomes support. A rule with no backup (reception) answers `DIVERT_NO_BACKUP`. |
| `POST /inbox/conversations/{id}/move` [B] | `move` | Body `{ dest: TeamDest }`. Clears support, sets the branch for a reception destination, then re-runs routing for the new team and branch, adding the backup too. The prototype picks only a primary (`:1179-1223`), but the IT Brief puts the backup on every chat in the category (`:400`). The interpretation is noted on the ticket. Writes the `moved_team` event with the Brief's wording (`Brief.tsx:381-383`). |
| `PATCH /inbox/conversations/{id}/branch` [B] | `assign` | The branch select in the assignment strip (`:1129-1133`). |
| `POST /inbox/conversations/{id}/handle` [B] | `handle`, and the actor is on the conversation or in its team | Status `handled`, `handled_by`. The confirmation is the shell's ("Mark as handled for everyone?"). |
| `POST /inbox/conversations/{id}/reopen` [B] | `reopen` | Status `active`, `reopened_at`. Assignments are kept. |
| `POST`/`PATCH /inbox/templates[/{id}]` [B] | `inbox:template:manage` | Caller-named ids. Archive, never delete. |
| `GET`/`PUT /inbox/routing-rules` [B] | `inbox:routing:manage` | The named-people edit (owner Q20). The catch-all guard applies. |
| `GET`/`PATCH /inbox/channel-accounts` [B] | `inbox:channel:manage` | Status, opening hours, defaults. No secrets are ever returned; only `credential_ref` names. |
| `POST /inbox/contacts/{id}/erase` [B] | `inbox:contact:erase` | §3.6. |
| `GET /webhooks/inbox/{channelAccountId}` [B] | public | The Meta verify-token challenge. |
| `POST /webhooks/inbox/{channelAccountId}` [B] | public, signature-verified | Ingest (§3.4). Always answers 200 quickly; refusals are values plus `ops_run` rows, as the 2C2P webhook does (`routes/webhooks.ts`, header). |
| `POST /inbox/simulator/inbound`, `/scenario`, `/status` [B] | `inbox:channel:manage`, and `INBOX_SIMULATOR=on` | Sign a synthetic payload and post it through the real webhook handler in-process. The secret never reaches the browser. |

### 3.4 Ingest, the automatic reopen and the out-of-hours reply [B]

The webhook handler runs these steps:
1. Verify the signature. Insert the `webhook_receipt` with
   `ON CONFLICT (channel_account_id, provider_event_id) DO NOTHING`. A
   replay ends here, answering 200.
2. Parse into `InboundEvent[]`.
3. For each message:
   - upsert the contact (WhatsApp joins `crm.member` by E.164);
   - upsert the conversation;
   - insert the message (unique on the external id);
   - update `last_customer_message_at`, `last_message_at` and the preview.
4. **If the conversation was `handled`, set it `active`, with
   `reopened_at` and an `event` of kind `reopened` and
   `actor_kind='customer'`** (`Brief.tsx:326`, `inbox.md:151-154`).
   Assignments stay as they were.
5. If the conversation is new, route it (§3.1).
6. **Out of hours** [B, small]. If the channel account has `opening_hours`
   and the time now falls outside them in the branch timezone, send the
   `out_of_hours` template in the contact's language. Send it at most once
   per closed period per conversation (`Brief.tsx:466`). The conversation
   stays active.
7. Status events update `provider_status` and the `delivered_at` and
   `read_at` columns.
8. Set `processed_at`.

All of this runs in one transaction per receipt.

### 3.5 Sending [B]

The send is a job, `inbox:send`, which runs in the api's pg-boss runner
(`services/jobs.ts`), one job per message id:
- it calls `adapter.send`;
- it records `sent` or `failed` and the provider message id;
- each attempt is an `ops_run` with a redacted payload (the message id only,
  never the body);
- failures reach the Console's Failures page through the existing alert
  machinery.

A sweeper re-enqueues anything `queued` for more than five minutes. The
provider is called with the message id as its client reference, where the
provider supports one, so that a retry is not a second message.

### 3.6 PDPA: audit, reads, files and erasure

- **Audit rows never copy bodies.**
  - Before and after values hold ids, slots, statuses, the team, the branch
    and template keys.
  - Sends record `{ messageId, conversationId, templateKey?, length }`.
  - Erasure records counts.

  A check in §6 sends a sentinel string and asserts that no `core.audit_log`
  row, no `inbox.event` payload and no `ops_run` payload contains it.
- **Reads are audited, sampled [A].** `POST …/read` writes one
  `inbox.conversation.read` audit row per account per conversation per
  Bangkok day. That meets the acceptance line "reads are audited
  (`inbox.conversation.read` category access, sampled)"
  (`SPRINT_2_PLAN.md:2753`). It follows the `file.read` precedent
  (`routes/files.ts:416`).
- **Files [B].** Inbound media are `core.file_object` rows with
  `owner_entity_type='inbox.message'`. The existing `GET /files/{id}` signs
  a URL only after the conversation visibility check, and objects are never
  public.
- **Erasure [B]** (`POST /inbox/contacts/{id}/erase`) anonymises in place
  (`inbox.md:346-349`), in one transaction:
  - the contact: name becomes "Erased contact", the handle becomes a hash,
    phone and member link are set to null, `erased_at` is set;
  - on every message: `body`, `transcript` and `translated_body` become
    null, `redacted_at` is set;
  - the preview is cleared;
  - the media file objects are deleted from storage;
  - the webhook payloads for the contact's events are nulled;
  - body-bearing keys in event payloads are nulled.

  The conversation, its assignments and its timeline shape stay, so the
  counts still add up.
- **Retention [B].** A daily job purges by `retain_until` and nulls
  `webhook_receipt.payload` after `INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS`.
  **Both are dormant until periods are set** (owner Q19: "no general purge
  this sprint"). The columns exist from day one [A], so switching on is
  configuration.

## 4. The shell: `apps/inbox`

### 4.1 Shape [A]

`apps/inbox` is React with Vite, Tailwind 4 and `lucide-react`, from the
workspace catalogue, like `apps/console`. It is a static build into
`dist/public`, reading `@oto/api-types` for every response type, so no
hand-typed shapes are added to `migration-list.ts`.
- **Design.** It uses the prototype's design language as written down at
  `inbox.md:218-259`: white cards on a faint slate gradient, Inter, the
  three-column workspace (a 220 px rail, a 360 px list, the chat), the
  category colours, the badges and the bubbles.
- **What is ported** from `WhatsAppDemo.tsx`, with the markup moved into
  components and the logic imported from `@oto/shared/inbox`:
  - `Avatar`, `StaffChip`, `StatusBadge`, `CategoryBadge`, `ChannelDot`,
    `MetricCard`, `CategoryMixCard`, `FilterSelect`, `EmptyState`;
  - `ChatPanel` (`:1870`) and `MessageBubble` (`:2064`);
  - `SlotPicker` (`:753`);
  - the handle confirmation (`:1744`) and the primary-move confirmation
    (`:1699-1723`).
- **What is left out:**
  - the role switcher, the "Phone preview" toggle, `WeeklyScheduleUpload`
    and the availability toggles (the IT Brief withdrew them);
  - the BEO modal and `parseBeoFromConversation` (owner Q23).

  The viewer is the signed-in account, and the tabs come from
  `GET /inbox/me`.
- **Dialogs.** Every dialog follows a **DialogBody-equivalent**:
  - the card is capped at the window height less 1 rem on each side;
  - only the body scrolls, while the header and footer stay put;
  - the card never scrolls sideways.

  This is the rule at `apps/oto-app/client/src/components/ui/dialog.tsx:32-45`,
  written once as `components/Dialog.tsx` in the shell. A grep in I3 refuses
  a dialog without it.
- **Phone width.** At 390 px the three columns collapse to list, then
  thread, with a back control: the prototype's `showChatMobile`
  (`:1047`). Desktop-first per owner Q25. A Playwright check at 390 × 844
  fails on any horizontal scroll, as `apps/console/e2e/console-smoke.spec.ts:14`
  does.

### 4.2 Sign-on [A]

The sign-on is the Console's pattern, copied:
- `src/auth/handoff.ts` takes `#handoff=` from the fragment and strips it
  before render;
- it posts to `/api/auth/handoff/exchange` through the site's own `/api`
  rewrite, and gets a host-only cookie bound to the same session row;
- the refusal wordings are aligned with the Console's
  (`apps/console/src/auth/handoff.ts:13-21`);
- sign-out returns to the launcher.

There is no inbox-specific server. The `inbox` audience is pre-wired in
`HANDOFF_AUDIENCES` (`packages/db/src/schema/tenancy.ts:312`), and
`appAccessPermission('inbox')` already types.

### 4.3 Writes in the shell [B]

These are wired to the [B] routes:
- the composer, with template insert;
- the slot pickers, with the 409 confirmation flow;
- Divert, shown only to the primary or to `assign` holders, and only when
  the rule has a backup;
- the move-team badge;
- the branch select;
- Mark as Handled, with its confirmation;
- Reopen, from the status picker and from the disabled composer's link;
- Settings pages for templates, routing rules and channel accounts.

There is also a **Simulator panel** (when `INBOX_SIMULATOR=on`). It plays
the demo scenario, sends a customer message as any fictional contact, and
pushes delivery receipts. This is how staging is demonstrated.

**In Cut A** all of the above render, disabled, with "Coming with the
channel connection", driven by `writes=false`. The disabled state is the
same component, so Cut B is a capability flip, not a rewrite. **In both
cuts**, Book Date and Create BEO render disabled with "With the event orders
(open decision)", which is owner Q23.

### 4.4 Hosting [A]

Hosting is a Render **static** site, `oto-inbox-staging`. A static site is
not a paid service, so no new paid service is added. Its build command
follows the Console's. Its routes are `/api/*` → the api (written above the
SPA rule), then `/*` → `/index.html`.

**Three settings move together** (`render.yaml:405-409`):
1. `inbox=https://oto-inbox-staging.onrender.com` in the api's
   `HANDOFF_APP_ORIGINS`;
2. the same origin in `ALLOWED_ORIGINS`;
3. `VITE_INBOX_URL` on the launcher.

No blueprint is linked, so all three are set in the **Render dashboard**,
and `render.yaml` is updated to document them (see `oto-render-staging`).

## 5. What the seven owner questions block, and what they do not

The build follows the IT Brief's defaults throughout. Named people are
editable seed rows.

| Q | Question | What we build without the answer | What the answer gates |
|---|---|---|---|
| 20 | IT Brief statuses, tabs, pairs and Divert; who is EN/RU primary | All of it, as the IT Brief: two statuses, the three tabs (ported as coded), fixed pairs, Divert. The rules ship with **blank people** (team as primary) and demo accounts on staging. | Only **data**: the account ids in four `routing_rule` rows, an edit in the routing settings. No code waits. |
| 21 | Language: chooser or detection | A `language` field on contact and conversation, set by the classifier hint or channel default and editable by staff. No chooser and no detection (detection is AI). | Nothing in this story. Detection arrives with the AI (Q24). A chooser would be a new flow, raised then. |
| 22 | Channels, reception numbers, shared phones | The contract, the simulator, the WhatsApp Cloud **skeleton**, `channel_account` rows on the simulator, named accounts for reception staff, and Telegram as a contact value with no adapter. | **Only the live adapters**: which `meta_cloud` and `meta_graph` accounts to create, the numbers per branch, Meta Business verification, and whether reception signs in with a shared account (we build named accounts; a shared one would be a new account kind). Instagram, Messenger and LINE adapters wait on this. |
| 23 | Which calendar Book Date reserves; where the BEO lives | **Out.** The buttons render disabled with the reason. `booking_ref` and `event_order_ref` exist as unused soft keys. The BEO dashboard card is omitted. | The whole Book Date / BEO slice, a later story. |
| 24 | AI direct replies, its maintainer, budget | **Out.** The `Classifier` interface with a non-AI implementation; `author_kind='ai'`, `handled_by_kind='ai'` and `ai_summary` exist and are unused. | The AI first responder, detection, translation, transcription and the knowledge base. |
| 25 | Phone notifications, reply-time targets | **Out.** A responsive shell (the phone-width check), no push, and `sla_policy` present and unused. Average first response is on the dashboard. | Push and alerts, and SLA targets with named recipients. |
| 26 | Importing old conversations, marketing permission, 3 or 6 metrics | **Out:** import and marketing sends. `opted_out_at` exists. The dashboard route returns every computable metric, and the shell shows unanswered, average response, by category, new today and handled today. | The import job; any marketing send; **which cards render**, which is a list in one component, not a route change. |

Owner Q19 (retention) also gates switching on the purge jobs. The columns
and the dormant jobs are built anyway.

## 6. Checks

### Every round

- `pnpm typecheck`, `pnpm lint` (eslint on the landing list before push),
  `pnpm test`, and `pnpm api-types:check`.
- CI is watched by the exact landing SHA (see `oto-ci-watch-by-sha`).

### The platform census: what each new route must satisfy

| Census | What the Inbox adds |
|---|---|
| `apps/api/test/routes-guarded.test.ts` | Every `/inbox/*` route declares a permission or `dynamicPermission`, and the webhook routes declare `public: true`. |
| `apps/api/test/route-write-conformance.test.ts` | Every [B] write has `withTx`, audit and idempotency. `POST /webhooks/inbox/:channelAccountId` joins the exemption list beside `POST /webhooks/2c2p/payment` (`:641-652`), with the reason "the provider event id is its own key". The simulator routes write nothing of their own; they call the handler. |
| `apps/api/test/id-conformance.test.ts` | Message, template and routing-rule creates are **caller-named**. Contact and conversation are **platform-named** (minted on ingest). |
| `apps/api/test/route-scope-target.test.ts` | By-id routes load inside the operator and then check visibility (§3.2). |
| `packages/api-types` | Run `pnpm api-types:generate` in every round that touches a route, and commit `openapi.json` and `src/openapi.ts` with it. |
| `packages/api-types/test/seam-walker.test.ts` | **I2:** each new route is a `NOT_YET_CALLED` line dated with its reason ("the Inbox shell lands in I3"). **MACHINE_CALLERS:** add `{ prefix: '/webhooks/inbox/', caller: 'Meta (WhatsApp Cloud), or the inbox simulator in-process' }` **above** the generic `/webhooks/` entry, which names 2C2P (`:80`), because `find` takes the first match. **I3:** add `'apps/inbox/src'` to `FRONT_ENDS` (`seams.ts:38-43`) and `$TURBO_ROOT$/apps/inbox/src/**` to `@oto/api-types#test` inputs (`turbo.json:41-50`), then delete the `NOT_YET_CALLED` lines the shell now calls. The walker fails on a stale line. |

### Inbox-specific checks (Vitest, in `apps/api/test/inbox-*.test.ts` and `packages/messaging/test`)

- **I1:**
  - migrations apply twice from empty (the CI migration check) and
    `verify-schema` passes;
  - `platformSync` run twice lays the teams, rules, templates and roles
    once, and does not overwrite an edited rule;
  - the composite foreign key refuses a cross-operator child row.
- **I2:**
  - the shared rules (`inTab`, `isUnanswered`, `teamDestOf`, `tabsForRole`)
    are table-tested against the prototype's own cases;
  - routing: EN/RU, TH, marketing and general by branch, the backup added,
    the catch-all, and a manual-only person never picked;
  - visibility: (a)–(d), and a 404 on an invisible conversation;
  - category-follows-primary: 409, then the confirmed move, and a
    management primary keeps the category;
  - Divert: the swap, and `DIVERT_NO_BACKUP`;
  - move-team: support cleared, routing re-run, branch set for reception;
  - handle and reopen, and the **customer-writes-again automatic reopen**;
  - a webhook replayed with the same event id makes one message and
    answers 200 both times;
  - a bad signature produces a receipt with `signature_ok=false` and no
    message;
  - the 24-hour window: free text refused, a template accepted;
  - the send job: success, failure, the sweeper;
  - **the no-body sentinel check across audit, event and ops**;
  - erasure leaves no sentinel anywhere and keeps the counts;
  - **the check-in feed:** a registration's contact test produces one
    outbound message in that phone's thread, and a forced mirror failure
    still completes the check-in;
  - the WhatsApp skeleton parses and verifies the recorded fixtures.
- **I3:**
  - a shell unit test of the tab and filter wiring;
  - a Playwright smoke: launcher hand-off, list, thread, (B) reply on the
    simulator, (B) handle and the customer's reopen, then the 390 px
    no-horizontal-scroll check;
  - the DialogBody grep.

## 7. Risks

- **PDPA.** Message bodies, previews, transcripts and media are personal
  data.
  - *Mitigation:* audit, event and ops rows never copy bodies (enforced by
    the sentinel check); erasure is in place and complete; the retention
    columns exist from day one and purges are dormant until Q19 is answered;
    webhook payloads are raw duplicates, so they get the shortest retention
    once a period is set.
  - *Residual:* the console mirror makes the check-in notice text persistent
    where today it is only a log line. That is intended, and erasure covers
    it.
- **Seam walker and api-types drift on new routes.** Every route-touching
  round regenerates `api-types`. The I2 and I3 landing order is fixed (I2
  first), so the walker never sees a call to a missing route. The
  `NOT_YET_CALLED` lines are dated, and I3 must remove them. The
  `/webhooks/inbox/` machine-caller entry must sit above the 2C2P one, or
  the walker names the wrong caller silently.
- **Concurrent edits on assignments.** Two managers changing slots at once
  could break the two-support limit. The service locks the conversation row
  (`FOR UPDATE`), and the partial unique indexes catch the rest.
- **The launcher tile flip.** Setting `VITE_INBOX_URL` turns the tile live
  for everyone holding `app:inbox:access`. Today that is only
  `platform_admin` and `operator_admin`, so the flip is safe. The tile
  reaches park staff only when `inbox_*` roles are assigned, which is a
  deliberate act.
  - *The trap:* the three settings that must move together (§4.4). Set one
    without the others and the tile opens onto a hand-off refusal. I4
    proves all three on staging before any proof shot.
  - The tile's `arriving` text (`apps.ts:138-139`) is updated in the same
    commit.
- **Retention.** Building purge jobs before periods are approved is the
  risk the owner flagged under Q19. Both jobs ship disabled (an unset
  variable or a null `retain_until`), and a check pins "no rows purged with
  the defaults".
- **The webhook surface on the public internet.** It has a signature check,
  answers 200 always, inserts the receipt first, is rate-limited by IP like
  2C2P, and has no route to it without a channel account id. The skeleton
  is never constructed in this story.
- **Simulator leakage into production.** `assertProductionSafe` refuses
  `INBOX_SIMULATOR=on` with `NODE_ENV=production`, as it refuses the SMS
  console adapter.
- **Ported tab rules versus the Brief.** The ported rules may surprise
  someone reading the Brief. This is recorded as an owner note, not a
  blocker (see "What reading the repo changed").
- **Migration number collision** with parallel lanes. The I1 lane reads the
  journal head at generation time.

## 8. Rounds

Rounds run as lanes in worktrees at `C:/w/<lane>` (see `oto-lanes-and-models`).
Money and safety build and review run on Opus. Docs and Jira run on Sonnet.

| Round | Lanes (parallel within the round) | Cut A part | Size A / B |
|---|---|---|---|
| **I1: schema, permissions, seed** | one lane, `inbox-i1` | all of it | M / M |
| **I2: api** | `inbox-i2a`: `@oto/messaging` (contract, console, simulator, WhatsApp skeleton); pure, no db, lands first. `inbox-i2b`: services and routes (reads, visibility, dashboard, read-audit, the check-in feed; in B also routing, ingest, writes, send job, erasure, retention). The two lanes run **in parallel**. | i2a = contract plus console only; i2b = reads, dashboard, read-audit, feed | S+M / M+L |
| **I3: the shell** | `inbox-i3a`: the static site, sign-on, the read side, the design, dialogs, phone width, Render. `inbox-i3b` [B]: write actions, settings pages, simulator panel. i3a can **start in parallel with I2** against the zod shapes fixed in I1 and the seeded rows, but **lands after i2b**. i3b starts after i3a's components exist. | i3a only, writes disabled | M / M+M |
| **I4: staging and proofs** | one lane: the Render dashboard settings, the demo script or scenario on staging, the capture round, docs status, and the Deployed walks. | yes | S / S |

**Why the API contract goes in I1.** The request and response zod shapes for
the [A] routes are written in I1 (`packages/shared/src/inbox.ts`). The shell
lane can then build without waiting for the routes.

**Elapsed order:**
- **Cut A:** I1, then (i2a ‖ i2b ‖ i3a), landing in the order i2a, i2b,
  i3a, then I4. That is three sequential steps.
- **Cut B:** I1, then (i2a ‖ i2b ‖ i3a), then i3b, then I4. That is four
  sequential steps.

### I1: schema, permissions and seed [A]

- Steps:
  - Add `inbox` to `helpers.ts` and `drizzle.config.ts`.
  - Write `packages/db/src/schema/inbox.ts` and generate
    `0078_inbox_schema`.
  - Add the permissions (including the two proposed ones) and the three
    `inbox_*` roles, the two departments, teams, rules, templates and
    console channel accounts, all in `platformSync`.
  - Write the `seed:inbox-demo` script (Cut A inserts; Cut B's version
    calls the simulator).
  - Put the shared rules and the [A] route zod shapes in
    `packages/shared/src/inbox.ts`.
  - Correct the feature doc against "What reading the repo changed".
- **Checks:** migrate twice from empty, `verify-schema`, the `platformSync`
  idempotence test, the shared-rule tests, the cross-operator foreign-key
  test.
- **Staging proof:**
  1. The deploy log shows `0078` applied and platform-sync laying the inbox
     configuration.
  2. A read-only query count of teams, rules and templates (as text
     evidence).
  3. `GET /me/permissions` for an admin lists the `inbox:*` strings.

### I2: the api

- **i2a [A: contract and console; B: simulator and skeleton].** The
  package, its tests and the recorded WhatsApp fixtures.
- **i2b [A].** The read routes, visibility, dashboard, the read audit, the
  check-in mirror and the booking mirror.
- **i2b [B].** The router, the ingest webhook, every write route, the send
  job and sweeper, the simulator routes, erasure, the dormant retention
  jobs, and the env variables with their boot refusals.
- **Checks:** §6 I2 list; `api-types:generate`; seam-walker
  `NOT_YET_CALLED` and `MACHINE_CALLERS`; the four censuses.
- **Staging proof (api level, before the shell):**
  1. A POS check-in on staging produces an outbound message in that phone's
     thread (a `GET /inbox/conversations/{id}/messages` JSON capture).
  2. [B] `POST /inbox/simulator/scenario` routes ten conversations, and the
     assignments match the rules (JSON).
  3. [B] The same webhook replayed answers 200 with one message.

### I3: the shell

- **i3a [A].** The app, sign-on, the list, thread, rail, filters, search,
  unanswered toggle and dashboard, the handled archive filters (date range,
  resolved by), the disabled writes, dialogs, phone width, the Render static
  site entry, and the seam-walker `FRONT_ENDS` and turbo inputs.
- **i3b [B].** The composer, pickers and confirmations, Divert, move, the
  branch select, handle and reopen, the settings pages and the simulator
  panel.
- **Checks:** §6 I3 list; the walker's stale-line removal; the eslint
  landing list.

### I4: staging and proofs [A, with the B items marked]

- **Settings.** The three dashboard settings (§4.4), plus `INBOX_SIMULATOR`
  and its secret [B].
- **Data.** Run the demo script on staging (Cut A), or play the scenario
  (Cut B).
- **Roles.** Assign `inbox_*` roles to the demo accounts only.
- **Proof list** (every Deployed ticket carries its screenshots; see
  `oto-jira-workflow`):
  1. The launcher showing the Inbox tile live (admin), and the tile absent
     for a reception account without an inbox role.
  2. The Inbox opened from the tile with no second sign-in, showing the
     dashboard cards.
  3. A thread in each category: Birthdays (violet), General (sky), Marketing
     (pink).
  4. A check-in confirmation from the POS, then the matching thread showing
     it as an outbound system message.
  5. **Cut A:** a pressed write action showing "Coming with the channel
     connection".
  6. **[B]** A simulator inbound, routed to the default primary with the
     backup chip.
  7. **[B]** A reply with a delivered tick.
  8. **[B]** Mark as Handled, with its confirmation and the thread in the
     Handled tab.
  9. **[B]** The customer writes again, and the thread is back in Active
     with the reopened pill.
  10. **[B]** A primary change across teams, with its confirmation and the
      "Auto-moved" pill.
  11. **[B]** Divert, with the chips swapped.
  12. **[B]** A move to Reception · Chalong, with support cleared and the
      branch set.
  13. **[B]** A template inserted outside the 24-hour window.
  14. The phone-width view (list, then thread).
  15. The audit page filtered to `inbox.*`, showing no message text.
- **Docs.** The `docs/features/inbox.md` status table, and
  `SPRINT_2_PLAN.md` S2-19 marked to whichever cut ran.

## 9. Proposed subtasks for SCRUM-220

These are ready to create. The cut tag shows which choice includes each one.

| # | Title | One line | Cut |
|---|---|---|---|
| 1 | Inbox plan and feature-doc corrections | This plan; the findings in "What reading the repo changed" folded into `docs/features/inbox.md`; owner notes for the tab-rule and move-backup interpretations. | A, B |
| 2 | Inbox schema, permissions and roles (I1) | Migration `0078_inbox_schema` (15 tables, tenant-fenced, PDPA columns), `inbox:*` permissions, the `inbox_agent`, `inbox_manager` and `inbox_admin` roles, teams, rules and templates through platform-sync. | A, B |
| 3 | Inbox demo conversations | Ten fictional conversations and six demo staff for local, CI and staging, inserted (A) or played through the simulator (B). | A, B |
| 4 | Messaging channel contract and adapters (I2a) | `@oto/messaging`: the `MessagingChannel` contract and console adapter (A); the simulator and the WhatsApp Cloud skeleton on recorded fixtures (B). | A (part), B |
| 5 | Inbox read routes and visibility (I2b-read) | List, thread, messages, dashboard and `/inbox/me`, with team, branch and assignment visibility and the sampled read audit. | A, B |
| 6 | Check-in confirmation into the Inbox | Mirror the contact test and the booking confirmation into `inbox.message`, without ever blocking a check-in. | A, B |
| 7 | Inbox routing and ingest (I2b-write) | The default primary plus automatic backup, the signed idempotent webhook, the automatic reopen on a new customer message, the out-of-hours reply. | B |
| 8 | Inbox assignment, Divert, move and Handled | Category-follows-primary with the server-side confirmation, support slots, Divert, move-team re-routing, handle and reopen. | B |
| 9 | Inbox reply, templates and sending | Reply through the channel, the 24-hour template rule, template management, the send job and its sweeper. | B |
| 10 | Inbox PDPA erasure and retention | Erase a contact in place; the dormant retention and webhook-payload purges; the no-body sentinel check. | B |
| 11 | Inbox shell (I3a) | `apps/inbox` in the prototype's design: launcher sign-on, workspace, dashboard, disabled writes, phone width, the Render static site. | A, B |
| 12 | Inbox shell actions and simulator panel (I3b) | Composer, pickers, confirmations, Divert, move, handle and reopen, the settings pages, the simulator panel. | B |
| 13 | Inbox on staging, with proofs (I4) | The dashboard settings, the demo data, the role assignments, the capture round and the Deployed walks. | A, B |

## Open matters for the owner (non-blocking, raised on SCRUM-220)

1. **Cut A or Cut B.**
2. **The two proposed permissions:** `inbox:routing:manage` and
   `inbox:contact:erase`.
3. **Tabs: code versus Brief.** The ported code hides My Inbox for the
   owner and reception, and Team Inbox includes "mine". The Brief says
   otherwise.
4. **Move-team adds the backup.** It follows the Brief, where the code
   adds only a primary.
5. **Check-in notice threads are read-only** in the Inbox until a real
   channel exists.
6. **Retention periods** for conversations and webhook payloads, under
   Q19.

## Test night (2026-10-21): the api and seed side of the human-style test of the rails

The owner and the park's admins test on staging on 2026-10-22. The evening
before, a human-style walk of the rails raised nine findings; this section
records what the api and the seed changed for each, the one they deliberately
did not, and the names the shell depends on. SCRUM-220, lane
`lane/inbox-testnight-api`, migration `0083_inbox_test_night` (expand-only:
three CHECK swaps that only widen a list, no row written).

### R1 — every Thai and Russian template was English text

Eighteen TH and RU rows carried the English body marked `needs_translation`,
and nobody translated them: a Russian customer outside the 24-hour window
received English.

- `packages/db/src/seed/inbox.ts` lays every key in English, Thai and Russian,
  each language in its own words (`INBOX_TEMPLATE_TRANSLATIONS`): Thai as a
  receptionist writes it, with the polite particles (ค่ะ / คะ / นะคะ); Russian
  natural and polite. Each carries the same `{{placeholders}}` as its English
  source and no number the source does not: the out-of-hours line's
  10:00–20:00 is the English body's own literal, kept.
- Platform-sync's inbox step **back-fills** a deployed operator
  (`backfillTranslations`): a TH or RU row takes its translation and the flag
  clears only while it is still flagged `needs_translation` AND its body still
  equals the English source word for word. A body anybody changed — flagged or
  not, archived or not — is left exactly as written. A row equal to an older
  English wording stays as it is, for an admin to word.
- The sync counts report `translations`; the deploy log line says how many.
- Pin: `packages/db/test/inbox-i1.test.ts` — the ten keys in three languages
  with their own script and placeholders; the staging shape (English-bodied,
  flagged TH/RU rows) translated on one sync and nothing on the next; an
  admin's flagged edit and an unflagged edit both untouched.
  `inbox-ai-a1b.test.ts` — `handover_general` in three distinct bodies, nothing
  flagged.

### R2 — outside the window every template was a "please hold" line

- Template key **`follow_up`**: en "Hello {{name}}, following up on your
  message to OTO Play Park — reply here whenever you're ready and we'll pick
  it up.", with th and ru equivalents, laid at every operator that lacks it
  under the same insert-if-absent rule as the others.
- The placeholder is the composer's `{{name}}` form (`@oto/shared`
  `templateVariables`), so the composer asks for the customer's name before
  sending.
- **The template table has no purpose column; the shell picks the follow-up
  by key `follow_up`** — the natural choice outside the window, the only key
  whose line is not a holding line. The assistant's holding-line list
  (`@oto/assistant` `AI_HOLDING_TEMPLATE_KEYS`) is unchanged: `follow_up` is a
  person's line.
- Pin: the same i1 test — `follow_up` is the only key with a placeholder, and
  the two key lists (`@oto/db` `INBOX_TEMPLATE_KEYS`, `@oto/shared`
  `INBOX_TEMPLATE_KEY_NAMES`) agree.

### R3 — By category counted 15 while Active said 12

- `GET /inbox/dashboard` `byCategory` counts the **active** conversations —
  the Active card's population — and the response says so:
  **`population: 'active'`** (`INBOX_DASHBOARD_POPULATIONS = ['active', 'all']`).
- The prototype counted every scoped conversation whatever its status
  (`WhatsAppDemo.tsx:1121-1125`), and the first port kept that rule. The
  owner's finding on the test night replaces it; the label lets the tile say
  which population it shows.
- Pin: `apps/api/test/inbox-read.test.ts` "the dashboard" — by category over
  the active threads only, the three adding up to `active`, for four viewers;
  the demo data's three handled threads make the two populations differ.

### R4 — setting a birthday thread's branch added no host and gave no reason

- `PATCH /inbox/conversations/{id}/branch` answers, additively:
  **`hostSkipped: 'no_host' | 'host_inactive' | 'already_on' | 'support_full' | null`**
  (`INBOX_HOST_SKIP_REASONS`) and **`host: { accountId, name } | null`** (the
  name is the employee record's; null without one). Both are null on a thread
  that is not a birthday, and `host` is null whenever `hostSkipped` is set.
- The `branch_set` pill's payload carries **`fromBranchName`** and
  **`branchName`** beside `fromBranchId` / `toBranchId` (`branchName` null
  when the branch is cleared); the audit row's `after` carries **`branchName`**.
- Pin: `apps/api/test/inbox-actions.test.ts` "the branch" — the host named on
  join; `already_on`, `support_full`, `no_host`; a general thread and a
  cleared branch answer null; the pill and the audit row name the branch.

### R5 — AI pause and resume left no timeline event

- `POST …/ai-pause` and `…/ai-resume` write a conversation event in the table
  every other pill reads from: kinds **`ai_paused`** and **`ai_resumed`**
  (added to `@oto/db` `INBOX_EVENT_KINDS` and the `event_kind_check`; the
  shared timeline schema's `kind` is a string, so nothing else widens),
  `actorKind: 'account'` with the actor's id, payload
  `{ turnsCancelled, messagesWithdrawn }` on a pause (counts, never words) and
  `{}` on a resume. The same state again writes nothing, as the audit row
  already did not.
- The names follow the enum's own `ai_*` form (`ai_handover`, `ai_silent`,
  `ai_withdrawn`), not a dotted one.
- Pin: `apps/api/test/inbox-ai-kb.test.ts` "pause" — one `ai_paused` pill with
  the actor and the counts, one `ai_resumed`, and none for a repeat of either.

### R6 — "Unanswered" still showed after the assistant replied: no change

Both plans exclude AI replies from "answered", deliberately, so nothing
changed. The words:

- This plan, §3.1: "Messages written by the AI do not count as answered
  (`:651`)."
- The AI plan (`docs/progress/plans/inbox-ai-build/PLAN.md`), "What stays":
  "**AI messages never count as an answer.** `isUnanswered` reads
  `last_staff_message_at` only, 'AI lines do not count as an answer'
  (`packages/shared/src/inbox.ts:128-159`). An AI-answered thread therefore
  stays in 'unanswered' for staff until a person replies or it is handled."
- The AI plan, X7: "`isUnanswered` is unchanged. (G4.)" and R10: "**Shared
  rules unchanged, deliberately:** `isUnanswered` keeps AI lines out of
  'answered' (prototype rule, `shared/inbox.ts:132`); the AI-handled case is
  covered by G4, not by changing the rule."
- G4 is the only exit: the assistant marks a thread handled after a closing
  on an AI-only episode. The prototype's `isUnanswered`
  (`WhatsAppDemo.tsx:644-656`) walks back to the last human agent reply and
  ignores the AI's.

The shared rule and the SQL (`read.ts` `unansweredSql`) already run over the
same rows in the read test. If the owner wants an end-to-end AI answer to
count as answered and a holding line not to, that is a rule change to raise
with him, not a defect of the build.

### R7 — the correction dialog's default topic was refused on an unclassified thread

- `POST /inbox/ai/examples` accepts a **category name** (`general`,
  `birthdays`, `marketing`) in `intent`. When the assistant classified the
  thread (a turn's intent, else the thread's), that classification stands in
  for the category; when it never did, the category's default intent is
  stored — `CATEGORY_DEFAULT_INTENT` in `services/inbox/ai-settings.ts`:
  `birthdays → birthday_party`, `marketing → influencer_marketing`,
  `general → faq` (the assistant's own table routes the first two to those
  teams; a general thread's correction is a factual one). A default for the
  editor's picker, which the examples queue may change before approval.
- The two refusals, `INTENT_REQUIRED` and `INTENT_UNKNOWN`, now carry
  **`details.intents`** (the assistant's intents, in table order) so the
  screen can preselect.
- Which option: the api accepts the category (the first), and exposes the
  topics on the refusal (the second) as well.
- Pin: the same ai-kb suite — an `off` line's never-classified thread: the
  bare refusal with the topics, the category accepted as the default intent,
  an odd word still refused, and a classified thread's classification winning
  over the category.

### R8 — the support cap

The refusal was already right: `409 SUPPORT_FULL`, "Both support places are
taken. Remove someone first." What changed: every action route now
**declares** its 409 — **`InboxActionRefusalSchema`** in
`@oto/shared/inbox-actions`, the platform's envelope
`{ error: { code, message, details? } }` with `code` one of
`INBOX_ACTION_REFUSALS` or an idempotency code — so the OpenAPI document and
`@oto/api-types` carry it and the shell can show the sentence. No behaviour
changed; the existing `SUPPORT_FULL` pin in the actions suite now runs through
the declared schema.

### R9 — the average response time differed by viewer with no label of whose

- Every dashboard number is over `visibleConversationsSql`, so two viewers see
  two averages. The response now says whose: **`scope: 'mine' | 'team' | 'all'`**
  (`INBOX_DASHBOARD_SCOPES`) — `all` for an operator-wide reader, `team` for
  a reader with a branch grant or a department grant that maps to an inbox
  team, `mine` for a reader in no inbox team (a manual-only person sees, and
  averages, only the threads they hold).
- Pin: the dashboard test — `all` for the GM, `team` for the Thai birthday
  agent and the Chalong manager, `mine` for the coordinator.

### W1 — the complaint hand-over read cold

An angry parent and "my daughter cried and nobody helped her" both received
"Thank you for letting us know. Please hold on — our reception team will be
with you right away." The two complaint hand-overs — the only hand-over lines
that said "right away" — now open with one line of empathy and say "shortly"
(nobody is there right away on a phone), in all three languages:

| Key | en | th | ru |
|---|---|---|---|
| `handover_complaint_onsite` | I'm really sorry to hear that. Thank you for telling us — a member of our reception team will be with you shortly. | ต้องขออภัยอย่างยิ่งที่เกิดเรื่องแบบนี้ขึ้นนะคะ ขอบคุณที่แจ้งให้เราทราบค่ะ ทีมต้อนรับของเราจะมาดูแลคุณในอีกไม่นานค่ะ | Нам очень жаль, что так произошло. Спасибо, что рассказали нам — сотрудник ресепшена скоро свяжется с вами. |
| `handover_complaint_online` | I'm really sorry to hear that. Thank you for telling us — a member of our team will be with you shortly to look into this. | ต้องขออภัยอย่างยิ่งที่เกิดเรื่องแบบนี้ขึ้นนะคะ ขอบคุณที่แจ้งให้เราทราบค่ะ ทีมงานของเราจะติดต่อกลับเพื่อดูแลเรื่องนี้ในอีกไม่นานค่ะ | Нам очень жаль, что так произошло. Спасибо, что рассказали нам — сотрудник нашей команды скоро свяжется с вами, чтобы разобраться в ситуации. |

What a deployed operator gets, under the never-overwrite rule:

- The **English** rows are never rewritten: staging's two English complaint
  lines keep the old wording until an admin pastes the new one (the table
  above is the paste).
- The **Thai and Russian** rows that still carry the OLD English complaint
  line, flagged `needs_translation`, are back-filled all the same: the old
  lines are kept in `INBOX_TEMPLATE_FORMER_BODIES`, and a flagged row equal
  to a former wording this file laid is as untranslated as one equal to the
  current source. A flagged row equal to nothing the platform ever laid stays
  for an admin to word.
- Pin: the i1 back-fill test — a flagged TH row with the former complaint
  wording takes its translation; a flagged TH row with an unknown English
  wording stays; the English complaint row is untouched.
- The demo conversations (`inbox-demo-fixtures.ts`) quote the old line as
  message history and stay as they were: a sent message does not change
  because its template did.

### Ownership on the night

Three lanes touch the inbox at once. This lane's hunks, for the rebase:

- `apps/api/src/services/inbox/read.ts`: `dashboardScopeOf` and
  `inboxDashboard` only (the dashboard block); nothing in the conversation
  detail, where the AI lane adds `aiState`.
- `apps/api/src/services/inbox/ai-engine.ts`, `ai-turns.ts`, `ai-runtime.ts`,
  `ai-knowledge.ts`: **untouched** — R6 changed nothing (above).
- `apps/api/src/services/inbox/ai-settings.ts`: `setAiPaused` (R5),
  `createExample` and `checkIntent` (R7), the imports.
- `apps/api/test/inbox-ai-engine.test.ts`: one fixture hunk in "a Thai
  complaint: the Thai template still needs translation …" — the test now sets
  that premise itself, since the seed lays Thai in its own words.

### Landing note

Another lane regenerates `@oto/api-types` too; the generated-file conflicts
are resolved by regenerating at landing (`pnpm api-types:generate`), never by
hand.
