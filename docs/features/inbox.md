# Inbox — unified customer messaging

**Status:** imported 2026-09-20 from Replit (project `oto-asset-manager`); the
client's own work in progress; milestone 4 of the platform; not yet on the
platform. Per `OWNER_DIRECTION.md` its data pillars are laid in the central
database now and a mockup shell, styled per the client's design, sits on the
launcher.

> **Confidential.** This page summarises the client's internal staffing and
> routing rules and reviews an unbuilt system. It is here because this
> repository is private. The export itself stays in `imports/` and is never
> committed; no customer data, message content or secret values are
> reproduced here — structures, counts and variable names only.

## What it is for
One inbox for every customer message the park receives — WhatsApp, Instagram,
Facebook and later a web form — where an AI assistant answers first and a
person takes over only when the request needs one: booking a birthday,
confirming a deposit, a custom event, a complaint, a lost item. It exists so
that the birthday sales team, the two reception desks and marketing each see
only their own queue, every conversation has a named owner, and management
can see what is waiting, unanswered and handled. Today staff read the park's
WhatsApp on shared phones.

## Intake
- **Source:** `imports/oto-asset-manager/` — Replit export received
  2026-09-20. The owner calls the project "asset manager"; the Replit artifact
  is named `oto-org-chart` and titled "Birthday Sales & Events Structure". It
  grew in three steps, all visible in `attached_assets/`: a responsibility
  chart and a routing-flowchart brief (22–23 April 2026), then the
  unified-inbox brief, its assignment-logic addendum and three design
  screenshots (11 May 2026), then an in-app "IT Brief" tab (marked v2.0) that
  revises the earlier briefs.
- **Real or mockup:** **prototype on sample data.** Front end only, by the
  client's own instruction ("no backend is needed yet"). Not in use by staff.
- **Stack:** pnpm workspace in the Replit house style.
  `artifacts/oto-org-chart` — React 19.1 + Vite 7 + Tailwind 4, `lucide-react`
  icons, Inter from Google Fonts, `@dnd-kit` for the editable org chart; a
  full shadcn/ui component set is installed but none of the views use it;
  `wouter` is installed but there is no router. `artifacts/api-server` —
  Express 5 skeleton with a pino logger and one route, `GET /api/healthz`.
  `lib/db` — Drizzle + `pg` client whose schema file is the empty template.
  `lib/api-spec` — OpenAPI 3.1 with that one path, and Orval codegen into
  `lib/api-client-react` and `lib/api-zod`. `artifacts/mockup-sandbox` is
  Replit's component canvas, not product. No tests, no auth, no persistence
  beyond `localStorage` for the org-chart text edits.
- **Its tables:** none. The database schema is empty and the front end never
  calls the API.
- **Export vs production:** not applicable — there is no production system.
- **Shared entities it touches:** none in code yet. By design it needs staff
  accounts and teams, the two branches, and customers by phone number.
- **Replit-specific dependencies to replace:** three Replit Vite plugins; the
  `pnpm-workspace.yaml` overrides that strip every native binary except
  linux-x64 (the export cannot install on Windows, macOS or a Pi);
  `scripts/post-merge.sh`, which runs `drizzle-kit push`.
- **Secrets found in the export:** none. No `.env` files, tokens or keys.

## What the briefs specify
Four pasted briefs plus the in-app IT Brief. Where they disagree the IT Brief
is the client's latest word and is taken as the target; the differences are
listed under "Where the briefs disagree" and raised in the open questions.

### Channels and first response
- Channels: WhatsApp, Instagram, Facebook; the IT Brief adds a web form. The
  platform brief (`PROJECT_CONTEXT.md` §10) adds LINE, and the POS prototype
  offers Telegram. The client wants the code structured so it can later
  connect to the WhatsApp API, Respond.io, Bitrix "or another CRM".
- Every message lands in one central queue. The AI answers first, in the
  language it detects (English, Russian, Thai; unclear or mixed handled), and
  never asks the customer to choose a language (IT Brief — the earlier
  flowchart and the demo data still show a language menu).
- No rigid menu at the start: a bare greeting gets a welcome line and the AI
  waits; a message with a clear intent is classified immediately.
- The AI handles end to end: greetings, opening hours, address, directions
  and parking, standard ticket prices, age rules, socks policy, "what is OTO
  Play Park", basic FAQ, and sending the birthday packages brochure. For
  general enquiries it asks which branch (Central Floresta or Chalong) after
  the first answer so replies stay branch-specific; for birthdays it must not
  ask the branch at first, so sales can offer either park.
- The AI must hand over, with a holding line only: birthday and party sales,
  events / corporate / school groups, discounts and negotiation, custom
  requests, complaints, unclear or emotional messages, anything outside the
  approved FAQ, influencer and marketing requests, nanny booking, lost items,
  special event tickets. It may not quote custom prices, confirm or hold a
  date, promise refunds, compensation or free entries, argue or explain a
  complaint, describe lost items, or send the events brochure automatically.
  Handover lines are sent as normal messages the customer sees.
- Audio: customers can send voice notes on every channel; the AI transcribes
  them, detects the language from the transcript and treats them as text.
  Staff see the audio player and the transcript and can send audio replies.
- Reception out of hours: the reception phones work 10:00–20:00; outside
  that the AI sends the working hours in the customer's language and the
  conversation stays active until reception is back — no action overnight.
- Translation: reception and marketing receive the message in the original
  language, with a "translate both ways" button in the chat header (customer
  messages for staff, staff replies for the customer); never forced. Thai
  birthday enquiries are never auto-translated.

### Categories, teams and intents
Three categories, each owned by a team, with the intents the briefs list:

| Category | Team(s) | Intents |
|---|---|---|
| Birthdays & Events | Birthdays & Events | birthday enquiry, birthday follow-up, event booking, school events, workshops, camp enquiries, existing event coordination, special event tickets |
| General | Reception · Central, Reception · Chalong | opening times, pricing, location, lost items, nanny / drop-off, on-site complaints, general customer support |
| Marketing | Marketing | influencer requests, partnerships, media, brand collaborations; online / brand-level complaints (IT Brief) |

Reception is two physical phones in two parks — never one shared queue and
never tied to a person's name. Events, corporate and school groups have no
fixed rule: they are parked with Birthdays & Events and a manager decides.

### Ownership and assignment
- Each conversation has up to three slots: one primary owner (required,
  responsible, decides the team) and up to two support people, from any team,
  who can read, reply and mark handled and are shown as avatar chips in the
  list and in the chat header. Managers add or remove support; a person can
  hold only one slot per conversation.
- The category of a conversation follows its primary owner. Moving the
  primary to someone in another team moves the conversation, after a
  confirmation ("Changing primary owner will move this conversation to the
  new department. Continue?"). Support people never change ownership.
- Default routing (IT Brief): the AI always routes a new conversation to the
  same default primary per category and language — the EN/RU birthday
  manager, the Thai birthday manager, the marketing owner, or the reception
  phone of the branch — and automatically adds the matching backup as
  support from the first message (the EN/RU birthday backup, the Thai
  birthday backup, the GM on every marketing and complaint chat). Fixed
  pairs; the owner can reassign anywhere. Once a birthday's branch is
  confirmed, the birthday manager who hosts at that branch is added.
- Divert: when the primary is off they tap "Divert" and the backup becomes
  primary. No schedule, no calendar, no ON/OFF toggles — this replaces the
  May addendum's availability toggles, weekly CSV / Excel schedule upload and
  "No available staff" queue, which are still in the code.
- Manual-only people: the programme / entertainment coordinator is never
  auto-assigned, has no department inbox and sees only conversations she is
  added to. The GM sees everything, overrides any assignment, reopens handled
  chats, moves conversations between teams and approves exceptions (refunds,
  special requests, sensitive complaints).
- Moving a conversation to another team clears the support slots and the AI
  picks a new primary for the new team and branch; choosing a reception team
  also sets the branch. A system note is logged for the audit trail.
- The briefs and the code refer to staff by first name. On the platform these
  are role assignments, so a change of staff is a Console edit, not code.

### Status, tabs and visibility
- Statuses (IT Brief): **Active** and **Handled** only. "Do not introduce
  extra states like Unassigned, Needs Manager, Waiting for customer or
  Waiting for staff — they create ghost states where no one feels
  responsible." The May brief's five statuses are withdrawn; no conversation
  is ever without an owner.
- Mark as Handled: a clear button in the chat; confirmation "Mark as handled
  for everyone?"; the conversation leaves Active for the whole team and
  returns only when the customer writes again (automatic) or a manager
  reopens it from the same status picker.
- Tabs (IT Brief): My Inbox (I am primary or support), Team Inbox (active for
  my team), Handled (archive). Tabs respect access. The May brief's six tabs
  (adding Unassigned, Needs Manager, All Messages) are withdrawn.
- Visibility: primary, support 1, support 2, GM / admin, and anyone in the
  same team. Roles with an inbox view of their own: Owner (everything),
  Birthdays & Events, Reception · Central, Reception · Chalong, Marketing.
  The GM and the entertainment coordinator are staff-only — they work through
  the conversations they are on and have no tab. The May brief's seven-role
  switcher (Owner, GM, Branch Manager, Birthdays & Events, Reception,
  Marketing, Staff) is superseded.
- No staff-only notes inside a conversation: every message is visible to the
  customer and the thread stays WhatsApp-style.

### Conversation record, filters, dashboard, templates
- Each conversation shows primary, support, category and intent, branch,
  language, status and last message time; the list row adds the channel,
  unread count and a one-line preview.
- Filters: category, branch (Central / Chalong / all), status, language;
  search across customer, intent and last message; an "unanswered only"
  toggle; in the archive, a date range, "resolved by AI or human" and an
  export button (stubs today).
- Manager dashboard (May brief, screenshot 1): new today, unassigned, needs
  manager, handled today, average response time, messages by category. The
  current build shows unanswered, BEOs created this month and average
  response; reporting proper is phase 2.
- Templates the briefs define: the welcome line; standard handover lines per
  category (birthdays, events, complaint online, complaint on-site, lost and
  found, marketing) in the customer's language; the out-of-hours reply; the
  birthday packages brochure per branch as an attachment.
- There are no free tags — category and intent are structured fields — and
  no SLA targets, only the average response metric.

### Birthday actions and POS integration (must-have)
- "Book Date": the birthday manager blocks the date from the conversation; in
  production the slot must be created in the POS in real time so the floor
  and other channels see it.
- "Create BEO": an AI-prefilled, editable Banquet Event Order (customer,
  contact, language, branch, date, time, kids, adults, package, animator,
  cake and theme, allergies, special requests, estimate, sales rep, internal
  notes; the final field list is to be confirmed with OTO). A saved BEO must
  sync to the POS as the source of truth, and POS changes (deposit received,
  date moved, package upgraded) must show in the conversation timeline.
- The sales-structure brief adds the operating rules behind this: sales and
  hosting are separated (sales sells, a birthday manager per branch hosts and
  contacts the parent before the day); a mandatory BEO review call before
  every birthday; the programme coordinator is involved whenever
  entertainment is included and an entertainer is required above five
  children; kitchen, reception and barista are aligned before the day.
- Out of scope per the IT Brief: billing and deposit logic, BEO document
  content, reporting dashboards, voice calls.

### Where the briefs disagree
| Topic | April–May 2026 briefs | IT Brief (later) |
|---|---|---|
| Statuses | New, Waiting for customer, Waiting for staff, Needs Manager, Handled | Active, Handled |
| Tabs | six, incl. Unassigned, Needs Manager, All Messages | My Inbox, Team Inbox, Handled |
| Role views | Owner, GM, Branch Manager, B&E, Reception, Marketing, Staff | Owner, B&E, Reception · Central, Reception · Chalong, Marketing |
| Availability | ON/OFF toggles, weekly schedule upload, "no available staff" queue | fixed primary + backup pairs, Divert, nobody unassigned |
| EN/RU birthday primary | the head of sales, a birthday manager as backup | reversed: the birthday manager is primary, the head of sales backup |
| Language | AI offers EN / RU / TH | auto-detect, never ask |
| Complaints | under General (reception) | online / brand → Marketing; on-site → reception by branch |
| Branch question | ask after the first general answer; not at first for birthdays | not restated |

## Design language (from the screenshots and the code)
This is what the launcher mockup shell should match.
- **Feel:** a premium internal operations tool, "not a WhatsApp clone": white
  cards on a faint slate gradient, 1 px `slate-200` borders, generous radii
  (12–16 px; 36 px on the phone frame), soft shadows, Inter with tight
  letter-spacing on headings, small type (11–13.5 px) and uppercase,
  letter-spaced eyebrow labels in grey. Desktop-first, usable on a phone.
- **Page:** a rounded header card with the eyebrow "Unified Customer Inbox ·
  Prototype", a title, a role switcher (segmented pill group, dark active
  state), a "Phone preview" toggle (the same UI inside a 390 px dark bezel)
  and a "Handled" toggle; the metric cards below it.
- **Metric cards (screenshot 1):** a 3 × 2 grid; each card has a small icon
  in a tinted rounded square, an uppercase grey label and a large bold
  value; "By category" shows a stacked violet / sky / pink bar with an
  icon-and-count legend.
- **Workspace:** one rounded card in three columns — a 220 px left rail on
  `slate-50` ("Viewing as" avatar and role, the tabs with count pills, the
  four filter selects), a 360 px conversation list (search, "n
  conversations", rows) and the chat panel.
- **List row (screenshot 3):** a 40 px initials avatar in a pastel tint with
  a channel dot (green WhatsApp, Instagram gradient, blue Facebook); name ·
  channel; handle · intent · language; a one-line preview; category and
  status pills with the unread count; then the assignee chips.
- **Chat panel (screenshot 2):** header (avatar, name · channel, handle ·
  intent · language, category badge, status badge with a dot, more menu); an
  assignment strip ("PRIMARY" chip, dashed "+ Add support" pill, "SUPPORT"
  chips, branch select, amber "Book Date", violet "Create BEO"); the timeline
  (customer bubbles white with a ring on the left; staff bubbles dark slate
  on the right under a name chip; AI bubbles indigo-tinted under an "AI
  Assistant" chip; centred grey system pills with a robot icon for routing,
  assignment and status events; read ticks); a composer (emoji, attachment,
  text, round dark send button — disabled with a "Reopen" link when
  handled); a green "Mark as Handled" button.
- **Colour code:** violet = Birthdays & Events, sky = General / reception,
  pink = Marketing, blue = Active, emerald = Handled / on shift / WhatsApp,
  amber = unassigned and Book Date, indigo = AI, `slate-900` = primary
  actions, the GM chip and staff bubbles, rose = unanswered. Each staff
  member has a fixed pastel tint for their chip.
- **Modals:** centred, `rounded-2xl`, an icon in a tinted circle, a title,
  one paragraph, Cancel and a coloured confirm ("Yes, mark as handled";
  "Yes, move to …"). The BEO modal is a two-column form in sections
  (Customer, Event, Package & add-ons, Notes) with toggle rows.

## What exists in the export, and what is missing
Present (`artifacts/oto-org-chart/src`):
- `App.tsx` (1,529 lines) — page shell and view switch, plus an editable
  responsibility chart (`workflow` view) with drag-and-drop ordering and
  `localStorage` persistence. Only "Unified Inbox" and "IT Brief" are
  reachable from the UI; the org chart and the routing flowchart
  (`CustomerFlowView.tsx`, 867 lines) remain in the bundle without a button.
- `WhatsAppDemo.tsx` (2,326 lines) — the inbox. Types `Role`, `Category`,
  `Branch`, `Slot`, `Status`, `Channel`, `Lang`, `Staff`, `Msg`,
  `Conversation`, `BeoData`; a `STAFF` table of ten entries with team,
  branch, language preference and a manual-only flag; 17 demo conversations
  (12 WhatsApp, 3 Instagram, 2 Facebook; 8 birthdays, 7 general, 2
  marketing; 9 EN, 4 RU, 4 TH; 12 active, 5 handled) holding 77 messages
  and 22 system events. Working logic: role scoping, tab membership, filters
  and search, "unanswered" detection, the AI assignee pick (team, branch,
  language preference, availability; manual-only excluded), slot assignment
  with the category-follows-primary rule and its confirmation, move-to-team
  with re-routing, availability toggles and the schedule-upload stub, mark
  handled with confirmation, reopen, Book Date, and a BEO modal prefilled by
  regular expressions over the customer's messages.
- `Brief.tsx` (494 lines) — the IT Brief, twelve sections including a
  backend checklist.
- Everything else is Replit template: an Express health endpoint, an empty
  Drizzle schema, a one-path OpenAPI file and its generated clients.

Missing: any backend, database schema, authentication, channel connection,
webhook, AI call, transcription, translation, sending, notifications, the
Divert button, the translate button, audio messages, the out-of-hours reply,
the web form, the POS link behind Book Date and BEO, real timestamps (times
are display strings), pagination, tests. The composer does not send.

## Proposed placement on the platform
Consistent with `PLATFORM_PLAN.md`: one central Postgres with a schema per
app, `core` for identity and audit, `crm` for customers, one launcher, one
sign-on.

- **Deployables:** `apps/inbox` — a static site on its own subdomain, styled
  as above, at first the mockup shell on sample data; the platform `api`
  serves its routes; a `messaging` role in the worker process runs webhook
  ingest, AI runs, transcription and outbound sends, each as a job with an
  `ops_run` record. Channel adapters (WhatsApp Cloud API; Instagram and
  Messenger via the Meta Graph API; LINE Messaging API; web form) sit behind
  one interface with a simulator, as `PROJECT_CONTEXT.md` §14 step 6 asks.
- **Launcher tile:** "Inbox", shown by `app:inbox:access`; "coming soon"
  until the shell is live.
- **Sign-on:** the platform session via the signed hand-off; staff are
  `core.account`. Teams map to departments in `core` (Birthdays & Events,
  Reception per branch, Marketing); membership and rights are role
  assignments scoped to the department or branch:
  `inbox:conversation:read`, `inbox:conversation:reply`,
  `inbox:conversation:assign`, `inbox:conversation:move`,
  `inbox:conversation:handle`, `inbox:conversation:reopen`,
  `inbox:template:manage`, `inbox:channel:manage`, `inbox:dashboard:read`.
  The owner and the GM hold them operator-wide.
- **Customers:** `inbox.contact` is the per-channel identity (a WhatsApp
  phone, an Instagram-scoped id, a Messenger PSID, a LINE user id). A
  WhatsApp contact joins `crm.member` by the normalised E.164 phone within
  the operator (`member_phone_unique`); other channels link when staff
  confirm a match or a phone is captured in the chat.
  `crm.member.preferred_channel` and the per-channel handles the POS
  reconciliation asks for (C16) resolve to `inbox.contact` rows. Children,
  allergies and bookings then show beside the conversation from `crm` and
  `pos` — soft links, no foreign keys across schemas.
- **Audit:** assignment, move, handle, reopen, template and channel changes
  go through `audit.record` with before / after; sends are audited as an
  action with the message id, never the body.
- **Idempotency:** provider event ids make ingest replay-safe; outbound sends
  and every mutating route take `Idempotency-Key`.
- **Files:** inbound media, audio and transcripts, brochures and attachments
  are `core.file_object` rows; a signed URL is issued only after the
  conversation permission check. Objects are never public.
- **Ops and Console:** webhook receipts, AI classification, transcription,
  translation and sends are `ops_run` kinds under `inbox:*`; failures reach
  the Console's Failures page, channel health (token expiry, webhook
  silence) its Health page, and volumes and response times roll up into
  `analytics`.
- **POS and OTO App:** "Book Date" creates or holds a `pos.booking`; the BEO
  links by soft key to the event order in `oto_app` (which already has event
  orders and packages) or its platform successor — which system masters BEOs
  is an open question. POS-side changes appear in the timeline as
  `inbox.event` rows.
- **AI:** one provider behind an interface with a simulator: language
  detection, intent classification, FAQ answers from a knowledge base the
  marketing role maintains, BEO extraction, transcription, translation.
  Every call is an `ops_run` with a redacted payload.
- **PDPA:** message bodies are personal data. Retention per the central-data
  review (open conversations migrate; the rest archived under the 12-month
  rule), an erasure path that anonymises contacts in place, and audit rows
  that never copy bodies.

### Core tables (schema `inbox`)
All tables carry `operator_id`, `created_at` and `updated_at`; ids are
UUIDv7; enumerations are text with CHECK constraints.

- **`channel_account`** — `branch_id` (null = operator-wide), `channel`
  (whatsapp, instagram, facebook, line, webform), `provider` (meta_cloud,
  meta_graph, line, respond_io, webform, simulator), `external_id`
  (phone-number id, page id, LINE channel id), `display_name`,
  `credential_ref` (the secret's name, never its value), `opening_hours`
  (jsonb; 10:00–20:00 for the reception phones), `out_of_hours_template_id`,
  `status`, `archived_at`.
- **`contact`** — `channel`, `external_handle`, `display_name`,
  `avatar_file_id`, `phone` (E.164 when known), `member_id` (soft link to
  `crm.member`), `language`, `first_seen_at`, `last_seen_at`,
  `opted_out_at`; unique (`operator_id`, `channel`, `external_handle`).
- **`team`** — `key` (birthdays, reception, marketing), `branch_id` (null
  except reception), `department_id` (soft link to `core`), `name`, `colour`.
- **`routing_rule`** — `team_id`, `category`, `language` (null = any),
  `branch_id` (null = any), `primary_kind` (account, team_phone),
  `primary_account_id`, `backup_account_id`, `auto_add_backup`, `priority`,
  `active`.
- **`conversation`** — `contact_id`, `channel_account_id`, `team_id`,
  `branch_id` (null = org-wide), `category`, `intent`, `language`, `status`
  (active, handled), `handled_at`, `handled_by_kind` (account, ai),
  `handled_by_account_id`, `reopened_at`, `first_response_at`,
  `last_customer_message_at`, `last_staff_message_at`, `last_message_at`,
  `member_id` (denormalised), `booking_ref` and `event_order_ref` (soft keys),
  `ai_summary`; indexes on (`operator_id`, `status`, `team_id`),
  (`contact_id`), (`last_message_at`).
- **`message`** — `conversation_id`, `direction` (inbound, outbound),
  `author_kind` (customer, staff, ai), `author_account_id`, `body`,
  `body_language`, `translated_body`, `translated_to`, `media_file_ids`,
  `audio_file_id`, `transcript`, `template_id`, `external_message_id`
  (unique per channel account), `provider_status` (queued, sent, delivered,
  read, failed), `error`, `sent_at`, `delivered_at`, `read_at`.
- **`participant`** — `conversation_id`, `account_id`, `first_seen_at`,
  `last_read_message_id`, `muted_at`: per-viewer read state, the basis of
  unread counts.
- **`assignment`** — `conversation_id`, `slot` (primary, support),
  `assignee_kind` (account, team_phone, ai), `account_id`, `team_id`,
  `assigned_by_kind` (account, ai, system), `assigned_by_account_id`,
  `reason` (auto, manual, divert, move, reopen), `assigned_at`,
  `released_at`; partial unique indexes: one active primary, at most two
  active support, one active row per person per conversation.
- **`template`** — `key` (welcome, handover_birthday, handover_events,
  handover_complaint_online, handover_complaint_onsite, handover_lost_found,
  handover_marketing, out_of_hours), `language`, `channel` (null = any),
  `body`, `attachment_file_ids` (the packages brochure per branch),
  `provider_template_name`, `approval_status`, `active`,
  `updated_by_account_id`.
- **`tag`, `conversation_tag`** — `name`, `colour`; (`conversation_id`,
  `tag_id`). Optional: the briefs use structured category and intent, not
  free tags.
- **`sla_policy`** — `team_id`, `first_response_target_s`,
  `follow_up_target_s`, `business_hours` (jsonb), `alert_channel`, `active`.
  Proposed; the briefs only ask for an average response metric.
- **`event`** — `conversation_id`, `kind` (received, ai_replied, classified,
  routed, assigned, released, diverted, moved_team, branch_set, handled,
  reopened, date_booked, beo_saved, translated, pos_update, sla_breached),
  `actor_kind`, `actor_account_id`, `payload` (jsonb, never message bodies),
  `created_at` — the inline system pills and the Console feed.
- **`note`** — `conversation_id`, `author_account_id`, `body`. Reserved: the
  IT Brief forbids staff-only notes inside the thread, so it stays unused
  unless the owner changes that rule.
- **`webhook_receipt`** — `channel_account_id`, `provider_event_id`
  (unique), `received_at`, `payload` (jsonb, short retention),
  `processed_at`, `error`.

Not tables: staff availability and schedules (the IT Brief dropped them;
Divert is an `assignment` row with reason `divert`) and the BEO itself (it
lives with the event order, linked by `event_order_ref`).

## Environment variables
Found in the export, names only: `DATABASE_URL`, `PORT`, `BASE_PATH`,
`NODE_ENV`, `LOG_LEVEL`, and `REPL_ID` (Replit's own). None relate to
messaging and none carry over. The briefs imply what will be provisioned
later — names we will define, listed as kinds, not values: a Meta app id,
secret and webhook verify token, with a WhatsApp phone-number id and access
token per number and Instagram / Facebook page ids and tokens; LINE channel
id, secret and access token; an AI provider key for classification, FAQ
replies and BEO extraction; a speech-to-text and a translation provider;
Respond.io or Bitrix credentials only if the client keeps those tools. All
live in the hosting dashboard and are named, never shown, on the Console's
Integrations page.

## Status
| Area | State | Notes |
|---|---|---|
| Review of the export and the briefs | done | 2026-09-20 |
| `inbox` schema in the central database | not started | milestone 4 pillars; after the named-schema migration |
| Launcher tile and mockup shell (`apps/inbox`) | not started | sample data, styled per the screenshots |
| Channel adapters and simulator | not started | WhatsApp first; LINE per `PROJECT_CONTEXT.md` |
| AI first responder, transcription, translation | not started | provider choice open |
| Book Date and BEO links to POS / OTO App | not started | depends on the BEO master decision |

## Open questions
- The in-app IT Brief revises the May briefs (two statuses, three tabs, five
  role views, fixed backup pairs and Divert instead of availability toggles
  and a weekly schedule). Confirm it is the target and that "Needs Manager"
  and "Unassigned" are gone for good.
- Who is primary for English and Russian birthday enquiries: the flowchart
  brief and the IT Brief put the same two people in opposite roles.
- Language: auto-detect only (IT Brief), or offer EN / RU / TH as the demo
  conversations do?
- Channels at launch: WhatsApp directly through the Cloud API or through
  Respond.io; Instagram and Facebook; LINE (the platform brief says yes, the
  inbox briefs do not mention it); Telegram (POS prototype); the web form.
  Does the park have Meta Business verification, and is there one WhatsApp
  number per branch or one for the company?
- The reception "phones": two WhatsApp numbers (one per park) or one number
  with branch routing? Who signs in on a shared reception phone — a shared
  account or the person on shift?
- Where BEOs and birthday bookings are mastered: OTO App's events module
  already holds event orders and packages; the POS will hold bookings. Which
  one does "Book Date" block, and which one owns the BEO?
- The AI: provider, the FAQ knowledge base and who maintains it, whether its
  replies must be reviewed before it answers customers live, and the budget
  for transcription and translation.
- Should staff reply from their phones with push notifications (the
  prototype has a phone preview; the brief says desktop-first)?
- Response targets: an SLA with alerts (first reply within n minutes in
  opening hours), or only the average on the dashboard?
- Retention of conversations and media, the consent wording for marketing
  follow-ups, and whether existing WhatsApp history is to be migrated.
- The manager dashboard: the six-metric version in the screenshot or the
  three-metric one in the current build?
