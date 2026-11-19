# Unified Inbox: inventory for the redesign

This inventory was made read-only on 19 November 2026. The code was read at `main` 32f6e0136 in `C:/oto-lanes/codex-inbox-feedback-20261116`. Staging was viewed at `https://oto-inbox-staging.onrender.com` between 03:35 and 03:50 UTC as three seeded demo staff:

- **Demo Hana (GM)**: manager, owner view.
- **Demo Anya (Birthdays EN/RU)**: a birthdays-team agent.
- **Demo Mila (Marketing)**: a marketing agent, the fewest rights.

File references are relative to the repository root. The Inbox app is `apps/inbox`, its api is `apps/api/src/services/inbox/` with `apps/api/src/routes/inbox-*.ts`, and the shared rules are `packages/shared/src/inbox.ts`.

The pictures are in `now/` beside this file (index in section 10). Measurements are in `data/gm-results.json` and `data/agents-results.json`, tokens and contrast pairs in `data/tokens.json`, and the scripts in `scripts/`.

---

## 1. People and jobs

### 1.1 Who uses the Inbox, and what each may see and do

**Who sees a conversation.** The api checks this on every read, in SQL, in `apps/api/src/services/inbox/read-visibility.ts`. The pure version is `isVisibleTo` in `packages/shared/src/inbox.ts`. A conversation is visible when any one of these holds:

- (a) the person holds `inbox:conversation:read` at operator scope: they see everything;
- (b) they hold it at the conversation's branch;
- (c) they hold it at the department of the conversation's team, which is what "being in the team" means;
- (d) they hold a primary or support place on the conversation.

On top of that, every read is fenced: same operator, not cleared by a test-line Start over, and inside the account's SCRUM-993 limits (see the end of 1.1). A conversation the person cannot see answers 404.

**Inbox roles** come from `packages/shared/src/permissions.ts` `INBOX_ROLE_BUNDLES`:

| Bundle | Permissions |
|---|---|
| `inbox_agent` | `app:inbox:access`, `inbox:conversation:read`, `…:reply`, `…:handle`, `inbox:dashboard:read`, `assistant:ask:use` |
| `inbox_manager` | agent + `inbox:conversation:assign`, `…:move`, `…:reopen`, `inbox:template:manage` |
| `inbox_admin` | manager + `inbox:channel:manage`, `inbox:routing:manage`, `inbox:kb:manage`, `inbox:ai:manage` |
| `operator_admin` / `platform_admin` | everything through `ALL`, including `inbox:contact:erase`, which has no Inbox screen |

**View roles.** `viewRolesOf` in `apps/api/src/services/inbox/read.ts` turns grants into the prototype's "views", and `tabsForRoles` in `packages/shared/src/inbox.ts` turns views into tabs:

| Person (how granted) | `roles` | Tabs | Sees | May do in the UI |
|---|---|---|---|---|
| Owner, GM: `inbox_manager` or admin, operator-wide | `owner` | Team Inbox, Handled (no My Inbox) | every conversation; dashboard scope `all` | reply, handle, assign primary and support, divert, move team, set branch, reopen, Templates settings, Book Date and Create BEO, request a deposit. Assistant settings only with kb or ai (admin). |
| Branch manager: `inbox_manager` at one branch | `staff` (in no team) | My Inbox, Team Inbox, Handled | that branch's conversations, plus any they hold a place on | as the GM, within the branch (the api re-checks each conversation) |
| Birthdays & Events agent: `inbox_agent` at the team's department | `events` | My, Team, Handled | the team's conversations, plus anything they are on | reply, mark handled, Book Date and Create BEO (`mayBookDate`: birthdays member or assign). Not: assign, add support, move, reopen, request a deposit, branch. |
| Marketing agent | `marketing` | My, Team, Handled | the Marketing team's | reply, mark handled; Divert when they are the primary |
| GM-team agent | `gm` | My, Team, Handled | the GM queue's | reply, mark handled |
| Reception desk agent (one team per park) | `reception` | Team, Handled (no My Inbox, by the ported prototype rule) | that desk's | reply, mark handled |
| Manual-only staff (for example the entertainment coordinator) | `staff` | My, Team, Handled | only threads they hold a place on | reply, mark handled |
| `inbox_admin` | `owner` | Team, Handled | everything | all of the above, plus the Simulator on staging (`channel:manage`), Start over on a test line, and Assistant settings: Numbers (`ai:manage`) and Knowledge, Examples, Rules, Teach (`kb:manage`) |
| Support administrator viewing as someone (SCRUM-648) | that person's | that person's | that person's | a fixed amber banner names both people, read-only or "changes allowed", with a countdown |

**What each control needs in the UI.** These are from `apps/inbox/src/lib/view.ts`, `components/ChatPanel.tsx` and `components/Workspace.tsx`; the api checks every action again.

- **Mark handled** (`canHandle`): the conversation is not handled, and the viewer is in the owner view, holds a place on it, or is a member of its team.
- **Primary picker**: `capabilities.assign`, or the viewer is the primary.
- **Add, change or remove support, and the branch select**: `capabilities.assign`.
- **Divert**: may assign, the primary is a person, and the detail names `divertTo`. The button is hidden otherwise.
- **Team picker** (the category badge): `capabilities.move`.
- **Reopen**: `capabilities.reopen`. Anyone else reads "A manager can reopen this".
- **Book Date and Create BEO**: shown on Birthdays & Events conversations only. They are live for the birthdays team or anyone who assigns. Anyone else sees them disabled with the title "The birthdays team or a manager books the date".
- **Request deposit** (inside Book Date): `capabilities.assign`. Others read "A manager requests the agreed deposit. The birthdays team can book after gateway verification."
- **Paid-deposit line beside Book Date** (SCRUM-996): only for those who may book. The api refuses the deposit read to anyone else (403).
- **Pause or Resume the assistant**: writes on, and the viewer may handle or may assign.
- **Correct the assistant**: anyone with writes, which today is everyone.
- **New contact**: `me.contactChannels` is not empty, meaning the viewer may reply somewhere. **Edit name**: any viewer with writes, for a contact that is not erased.
- **Start over**: conversations on a WhatsApp test line where `testLines[].startOver` is set (`channel:manage` at the line).
- **Settings menu**: Templates (`templates`), Assistant (`kb` or `ai`), "Simulator · test only" (`me.simulator`, which is non-null only on local or staging and with `channel:manage`). The menu is hidden when empty.
- **Dashboard**: `capabilities.dashboard`, which every inbox bundle holds.

**SCRUM-993 category and channel limits.** These are per-account rows in `account_inbox_access`:

- `allowed_categories`: null means no extra limit, `[]` means none. `restrict_channels` comes with a list of channel accounts.
- They are set in the Console on the account's roles screen, `packages/admin-screens/src/roles/InboxAccessControls.tsx`, by holders of `admin:role:assign`. Changes are previewed first and saved against a version.
- Administrators (`admin:operator:all` at operator scope) are exempt.
- The limits only narrow what a person sees; they never grant anything.
- The api applies them to every list, count, detail and action (`inboxPolicyAllowsSql`, `apps/api/src/services/inbox/access.ts`). Each list page returns `access {categories, channelAccountIds, version}`.

The shell then (`hooks/useInboxAccess.ts`, `lib/inboxes.ts`):

- keeps the newest of the list's and the identity's reads, and fails closed when they disagree;
- hides named views, Topic chips, Source chips, test lines, simulator numbers, contact channels and teams outside the limits (a reception team counts as `general`);
- drops rows, the open thread and any linked conversation outside them;
- clears the dashboard on change.

An empty category list (`[]`) shows no channels at all.

**Seen on staging.**

- **Demo Hana (GM)**: `roles ['owner']`, tabs Team and Handled. Capabilities: writes, dashboard, assign, move, reopen, templates. **No kb, no ai, no simulator.**
- **Anya and Mila**: tabs My, Team, Handled. Capabilities: writes and dashboard only.
- **All three**: no limits (`access.categories` and `access.channelAccountIds` null); one test line, five contact channels, and dictation available with a 180 s ceiling.
- **No demo account can open Settings → Assistant**, so Teach and Rules were not visible (section 11).

### 1.2 The jobs and how many steps each takes today

A step is a press, a select, or a page scroll that is needed at 1440×900. The staging counts are as seen.

**1. Answer a waiting customer** (every agent). 5 steps; 3–5 more outside the reply window.

1. The page lands on My Inbox if the viewer holds any active thread, otherwise Team (`landingTab`).
2. Optionally narrow to the queue: the Unanswered tile or the "Unanswered only" pill (1).
3. Scan the list. Rows are 143–169 px tall, so **only one row is fully in the first window at 1440×900**; the list column shows about 4.5 rows after scrolling.
4. Open the row (1).
5. **Scroll the page** to reach the reply box (1). The composer starts at y = 1137 in a 900 px window.
6. Type, then Enter or Send (1).

Outside the channel's reply window the server refuses free text. The refusal lists qualifying templates; choosing one, filling its `{{values}}` and sending adds 3–5 steps. Starting from a template instead: Templates icon → Insert → fill → Send (3+).

On the GM's Team Inbox, **91 of the first 100 rows are "Check-in notices" threads that cannot take a reply**. After the first two rows, only one customer chat appears before row 94, and there is no filter that hides notice threads (the Source chips can pick one number, not exclude one).

**2. Pick up a hand-over from the assistant.** 4–6 steps.

There is no notification, sound or badge for a hand-over, and no filter by next action.

1. Optionally narrow with Unanswered (1).
2. Find an amber "Staff reply needed" chip among the "AI sent · waiting for customer" chips.
3. Open the row (1).
4. Optionally expand the grey summary pill "AI handed over to X — brochure sent, Y primary, Z support" (1).
5. Reply (2). A reply holds the assistant ("AI stopped: a person replied · Resume").

To hand back to the assistant, press "… · Resume" (1). An agent cannot claim the thread; the router seated the primary, and only a manager or the current primary may change it.

**3. Book a birthday date after a paid deposit** (SCRUM-996). About 5–8 steps.

Before payment, a manager only: open the chat (1) → Book Date (1) → type the agreed deposit in baht (1) → Request deposit (1). The family gets a payment link; then wait.

After payment, the birthdays agent or a manager:

1. The chat sits in the teal **"Ready to book"** group pinned above the list.
2. Open it (1). Opening a birthday chat starts the model's reading of the chat for Book Date (SCRUM-821).
3. The teal line beside Book Date reads "Deposit ฿… paid and gateway verified at <time>. Check capacity, then Book Date." Pressing it, or Book Date, opens the dialog (1).
4. The dialog reads the deposit and the chat. Pick between "The chat reads two ways" options where they appear (0–n).
5. Type the date and time if the chat names none (2).
6. Press "Book date" (1). The strip then says "Event: <date> at <park> · tentative in the Events calendar".
7. Create BEO (1) opens the OTO App's BEO form in a new tab, with AI Fill run on the conversation.

Pressing Create BEO before booking runs Book Date first, and its Save is labelled "Book date and open the BEO".

**4. Correct and teach the assistant.** 3–5 steps to propose; 5 to approve; 7 to teach.

- **Propose a correction** (anyone): "Correct the assistant" under an AI line, or under the pill "AI left this one for the team" (1) → "What should it have done?" (1) → edit the customer's words to remove names, phones and children's details → the corrected line → topic and language (0–2) → Propose example (1). That is 3–5 steps.
- **Approve it** (kb holders): Settings (1) → Assistant (1) → Examples (1) → Approve, ticking "contains no personal data" (2). That is 5 steps.
- **Teach** (SCRUM-696, kb holders): Settings → Assistant → Teach (3) → type and Send (2) → Approve on the draft card (1) → confirm (1). That is 7 steps.
- **Rules**: Rules → New rule (2) → form: kind of message, park, instruction, optional "ask first" with condition and EN/TH/RU questions → Save (1) → Approve and confirm (2).

**5. Close or reopen.** 2 steps to close; 1 to reopen.

- **Close**: "Mark as Handled" in the strip (1) → "Yes, mark as handled" (1). The same is reachable from the hover pill on a row, from the status badge's select, and on a phone from Details → Status.
- **Reopen** (manager): "Reopen" in the composer bar, or the status select (1).

**6. Route** (manager, or the current primary). 1–2 steps each.

- Primary picker (1), plus a confirm when the move changes category (1).
- Add support (1); both places taken shows "Support 2/2".
- Divert (1).
- Team badge (1) → "Yes, move to …" (1).
- Branch select (1). On a birthday thread this adds the park's hosting manager as support and says "Host added: …".

**7. Find or start a conversation.**

- Search: type; it applies after 250 ms and matches name, intent and last message.
- New contact: "New" (1) → name, channel, phone or handle (3) → create (1). The new thread opens.
- Rename: pencil beside the name (1) → type → save (1).

**8. Watch the queue** (managers, and agents for their own scope). 1 step each.

The dashboard tiles toggle: Unanswered, Active, Handled today, and the category legend.

---

## 2. Everything on the page today

Each item gives its label, what it does, the data behind it, who sees it, and its states. Below 1024 px the left navigation is hidden.

### 2.0 Before the workspace

These are in `apps/inbox/src/App.tsx` and `components/SignOnPanels.tsx`.

- **Splash**: shown while the session is read.
- **Sign in**:
  - Card: eyebrow, h1 "Sign in", line "Every message from a family in one place, routed to the right team."
  - Fields: "Phone number" (placeholder: a sample local number) and "Password". Button: Sign in.
  - Data: `POST /auth/sign-in`. A launcher hand-off arrives as `#handoff=…` (`auth/handoff.ts`), and a refused hand-off shows its error here.
  - States: busy, refusal.
- **"This session is locked"**: amber icon, password field, unlock (`POST /auth/unlock`). The lock is the shared session's: there is no idle timer in the Inbox.
- **Blocked panel**: shown for "must change password" or "no access".
- **View-as banner** (SCRUM-648, `components/ImpersonationBanner.tsx`):
  - Fixed to the top, 36 px tall, `bg-amber-400`, black 14 px semibold.
  - Text: "<actor> is viewing the Inbox as <subject> — read-only, nothing can be sent or changed", or "— changes allowed", followed by "· ends in m:ss". It cannot be dismissed, and pushes the page down.

### 2.1 Page frame

From `components/Workspace.tsx`: `max-w-[1400px]`, centred, padding `px-4 py-5` (`sm:px-6`), 20 px between cards. The body is a fixed gradient from slate-50 to white (dark: slate-950 to slate-900).

**Simulator side panel** (temporary testing aid): on screens 1280 px and wider, for viewers with `me.simulator`, a sticky aside 420 px wide on the right.

- Title "Simulator · test only"; line "Temporary side panel for testing. Nothing reaches a real customer."; a "Hide" button. The panel is on by default and remembered per browser (`localStorage oto.simPane`).
- When hidden, the header shows "Show simulator" (indigo).
- Body sections (`components/Simulator.tsx`):
  - **Demo conversations**: "Play the demo".
  - **A customer writes**: Channel account, "From (digits, country code first)", "Name (optional)", "Category (instead of the AI)", "Language (instead of the AI)", Message, a voice note file or Record/Stop with a clock, "Send as the customer".
  - **Delivery receipts**: "Push receipts".
  - Status line and refusal.
- Not seen on staging: no demo account has `channel:manage`.

### 2.2 Header card (`<header>`)

White card, `rounded-2xl`, border slate-200, padding 20 px. At 1440×900 it is **433 px tall**.

**Title block.**

- Eyebrow "UNIFIED CUSTOMER INBOX": sparkles icon, 11 px, uppercase, tracking .22em, slate-500.
- h1 "All channels, one queue, role-based access": 20 px semibold, shown at 1024 and up only.
- Subtitle "WhatsApp · Instagram · Facebook, routed to the right team. <name> · <role label>": 13 px slate-500, 1024 and up only. The role label is "Owner view", the team names joined by " · ", or "Staff".

**Controls**, wrapping, right-aligned at 1024 and up:

- **Handled**: archive icon. Toggles the Handled tab, and back to the viewer's first other tab. Pressed: filled slate-900. Shown when the viewer has the Handled tab.
- **Show simulator**: indigo. Only for simulator holders with the side panel hidden, at 1280 and up.
- **Settings**: gear icon and word. Opens a menu (`role=menu`, 192 px card) with entries chosen by capability: "Templates" (file icon), "Assistant" (bot icon), "Simulator · test only" (flask icon; opens the Simulator dialog). Pressed (filled slate-900) while a settings page is open. The menu closes on Escape or a click outside. Hidden when the viewer has no entries, which is all agents.
- **Theme**: an icon only (sun, moon or monitor). It cycles light → dark → system, with the title "Theme: light — switch to dark". **Pressing it saves the preference to the account** (`PUT /me/preferences`; `lib/theme.ts`). Seen: the GM's is light, Anya's is system.
- **Back to the suite**: a link to the launcher, when `VITE_LAUNCHER_URL` is set.
- **Sign out**: logout icon.

All header buttons: `rounded-xl`, border, 12 px medium, padding `px-3 py-2`, height about 34 px.

**Dashboard grid**: shown at 1024 and up only. It is `grid-cols-3` with 7 tiles, so **the 7th tile (BEOs) sits alone on a third row**. Data: `GET /inbox/dashboard`, re-read every 30 s; hidden without the dashboard capability. While loading, values show "—" (`aria-busy`). On error the whole grid is replaced by a rose error line, "The dashboard could not be read."

Each tile: white, `rounded-xl`, a 28 px tinted icon square, an uppercase 10 px label (tracking .16em, slate-500), a 20 px semibold value, and an optional 10 px hint on the right in slate-400.

| Tile | Icon tint | Press does | Hint |
|---|---|---|---|
| NEW TODAY | blue | nothing (read-out) | none |
| UNANSWERED | rose | toggles `unanswered` (leaves the Handled tab); pressed shows a rose ring | "Click to filter list" / "Click to clear filter" |
| ACTIVE | blue | toggles `status=active` and clears unanswered | "Click to filter list" / "Click to clear filter" |
| HANDLED TODAY | emerald | opens Handled with the range Today; again goes back | "Click to open" / "Click to go back" |
| AVG RESPONSE | slate | nothing | whose average: "your average", "the team’s average" or "all" |
| BY CATEGORY | slate | each legend icon filters to that category; pressed is filled slate-900 | a stacked 8 px bar in violet, sky, pink, amber, with the legend's icon and count |
| BEOS CREATED · WEEK | violet | nothing | "Since Monday YYYY-MM-DD" |

Seen on staging: GM "72 unanswered, 189 active, 10m 40s, all"; Anya "15, 18, 4m 33s the team's average".

### 2.3 Settings pages (in place of the workspace card, with the header kept)

**Settings · Templates** (`components/TemplateSettings.tsx`, `?settings=templates`)

- Header: eyebrow "SETTINGS · TEMPLATES"; line "The standard lines the composer offers, per language, channel and park. Outside a channel’s reply window only an approved template can be sent."; "Back to inbox"; "Show archived" checkbox; black "New template".
- Groups by key, each with an eyebrow, for example "WELCOME", "HANDOVER BIRTHDAY", "CLOSING GM", "PARTY DEPOSIT REQUEST". The cards are two columns: EN, RU, TH.
- Each card shows: language pill; "Every channel" or the channel; "Every park" or the park; an approval chip ("No approval needed" slate, "Awaiting approval" amber, "Approved" emerald, "Rejected" rose); "Inactive" and "Archived" chips; "English source, to translate"; the body; brochure attachments ("Birthday brochure attached", "Replace brochure", "Upload brochure", "No birthday brochure yet"); Edit and Archive.
- Editor dialog fields: key (`lower_case_name`), language, channel, park, body, provider template name, approval, active, needs translation.
- Confirm dialog: "Archive this template?"
- Seen: the page is about 6,570 px long at 1440 (picture `gm-1440-settings-templates-light.png`).

**Settings · Assistant** (`components/AssistantSettings.tsx`, `?settings=assistant&section=…`)

Not seen on staging (no demo account has `kb` or `ai`). An older picture is at `docs/qa/proof-2026-10-30/SCRUM-696-1-teach-reply-and-draft-card.png`.

- Header: eyebrow "SETTINGS · ASSISTANT"; line "The assistant answers simple questions from the approved knowledge base and hands everything else to the team. A person replying always takes over."; "Back to inbox"; a segmented tablist.
- **Numbers** (`ai:manage`):
  - Indigo note: "Live means customers hear it. Run a number in Shadow first…".
  - Three explanation cards: Off, Shadow, Live.
  - One card per number, with name, channel and park ("Both parks"), and a radio group "Off / Shadow / Live". Live is filled indigo-600 when chosen.
  - Turning a number live asks "Put the assistant live on this number?" → "Yes, customers hear it".
- **Knowledge** (`kb:manage`):
  - Explanation; "Show archived"; "New entry".
  - Grouped by topic. Each entry shows a mono key, language, park, status chip (Draft amber, Approved emerald, Archived slate), "English source, to translate", the question, and the answer (4 lines). Buttons: Edit, Approve (drafts), Archive, each with a confirm.
- **Examples** (`kb:manage`, operator reach): tabs "To review / Approved / Rejected"; proposals with edit, approve (with the no-personal-data tick) and withdraw ("Yes, withdraw"). A 403 shows a polite amber "not on your access" line.
- **Rules** (SCRUM-696):
  - Explanation: "How the assistant handles a kind of message… cannot grant a price, a discount, a refund, a date or a booking."
  - Tabs "Drafts / Approved / Archived"; "New rule".
  - Each card: kind of message, park, status chip, instruction, "Ask first: <question> · <condition>", "Taught from: “…”", and Approve, Edit, Archive.
  - Editor dialog: kind of message, park, instruction, "Ask first" toggle, condition, questions in English, Thai and Russian. It says plainly when the kind never asks first: "The assistant never asks first on this kind of message (a complaint, a refund, a request for a person, an upset or unclear message, a child in our care, the birthday flow, a greeting, a thank-you, a bot question or spam)…".
- **Teach** (SCRUM-696):
  - An intro line; a 60vh chat box with the example "If someone says they lost something, first ask which park they visited."
  - User bubbles are slate-900 on the right; assistant bubbles slate-100 on the left; "Thinking…" while busy.
  - Draft cards ("Fact" or "Rule", Draft or Approved, the full draft, Approve, "Open in Knowledge" or "Open in Rules").
  - Dry-run card: "Dry run · what the assistant would do now", outcome, intent, "A rule fired", the would-be lines.
  - Textarea "Tell it a fact, a rule, or ask what it says today when…", Send, and "Enter sends; Shift+Enter starts a new line."
  - The chat stays mounted while another tab shows.

### 2.4 Workspace card (three columns)

White, `rounded-2xl`, border, shadow `0 12px 40px -16px rgba(15,23,42,.18)`. The grid is `220px 360px minmax(0,1fr)` at 1024 and up, and one column below.

- **Height**: `min(82vh, 860px)` at 1024 and up, which is 738 px at 900 tall. Below 1024 it is `100dvh − 2rem`, with a minimum of 520 px.
- **Position**: the card sits under the header card, so **the page itself scrolls**.

#### 2.4.1 Left navigation (rail): 220 px, `bg-slate-50/60`, at 1024 and up only (`components/Rail.tsx`)

1. **"VIEWING AS"** block (eyebrow 10 px slate-400):
   - a 28 px avatar: slate-900 for the owner view, otherwise the person's fixed pastel;
   - the name, 13 px semibold, truncated (Anya's reads "Demo Anya (Birthday…");
   - the role label, 11 px.
2. **Tabs** (`nav aria-label="Tabs"`, buttons with `aria-current=page`):
   - Entries: "My Inbox" (inbox icon), "Team Inbox" (users icon), "Handled" (archive icon).
   - Counts for the working tabs only (`tabCounts`, counted before filters). The pill is filled slate-900 when active, slate-200 when not. Handled shows no count.
   - Active style: white with a ring and shadow.
   - Data: `GET /inbox/conversations` → `tabCounts`.
3. A scrolling region holding:
   - **"INBOXES"** heading (layers icon) and the named views (`nav aria-label="Inbox views"`, `lib/inboxes.ts namedViews`):
     - "All conversations" (clears every chip);
     - "General" (`inbox=general`: general questions held out of the park inboxes while the assistant answers them);
     - "Birthdays & Events" (party icon) and "GM" (briefcase), each only when the operator has that team;
     - one entry per park, named after its reception desk. On staging: Central Floresta, Robinson Chalong, Demo Branch 2, ZZ TEST Print Bare;
     - one entry per WhatsApp test line (flask icon), for example "WhatsApp test line".
     - The active view is read back from the chips. A chip changed by hand lands on All, marked with the italic "Filtered" and the title "Filtered by hand — press to clear the filters".
     - **No counts on any view.**
     - Agents see every view even when it can only be empty for them: Mila (Marketing) sees General, Birthdays & Events and GM, which can never hold her threads. The park views show her branch-less marketing threads in every park, because "no branch" matches every park.
   - **"FILTERS"** heading (filter icon), then chip rows (`FilterFields`). Each row has a 10 px label with an icon and `role=group`. The chips are pills: 11 px, ring; pressed is filled slate-900; some carry a colour dot.
     - **Branch**: the parks (same values as the park views).
     - **Source**: each channel number by display name, with a channel-colour dot. Sources are learned from the rows read so far, plus `GET /inbox/ai/channel-accounts` for `ai` holders. On staging: "Check-in notices (WhatsApp)", "Demo WhatsApp · Central Flo…", "WhatsApp test line", "Check-in notices (Telegram)". Longer names are truncated; the full name is in the title.
     - **Topic**: Birthdays & Events (violet dot), General (sky), Marketing (pink), GM (amber).
     - **Status**: Active (blue dot), Handled (emerald dot).
     - **Language**: English, Russian, Thai.
     - One value per row at a time; rows combine.

At 1440×900 the rail's end (Language) is reachable only by scrolling the rail (picture `gm-1440-rail-scrolled-to-end-light.png`).

#### 2.4.2 Conversation list: 360 px (`components/ConversationList.tsx`), `section aria-label="Conversations"`

**List head**, 91 px at 1024 and up; 164 px below:

- **Below 1024 only**:
  - a segmented tablist (`role=tablist/tab`, filled slate-900 when active, with counts); "Team Inbox" truncates to "Team In…" at 390 for three-tab users;
  - the dashboard strip `DashboardStrip`: a rose chip "Unanswered N" (toggle; filled rose-600 when on), "Active N · Avg response 10m 40s".
- **Search**: `aria-label="Search"`, placeholder "Search customers, intents…" (truncated at 390). Debounced 250 ms, sent as `q`.
- **New**: a person-plus icon and "New" (icon only below 640). Opens the New contact dialog; shown when the viewer has contact channels.
- **Filters**: below 1024 only. Opens the Filters dialog, with a count badge of the applied filters.
- **Applied-filter pills**: one per applied chip, removable ("Clear <label>"); a topic's pill wears its colour.
- **"N conversations"**, or "50+ conversations" while there is a next page, plus the **"Unanswered only"** pill. The pill is rose when on and shown on every tab except Handled. When the phone strip is shown, the pill only appears at 1024 and up.
- **Handled tab only**, the "ARCHIVE FILTERS" box:
  - **Export**: disabled, title "Export is not built yet".
  - **"Handled in the last"**: Today, 7 days, 30 days (default), 90 days, All time.
  - **"Resolved by"**: Anyone, AI, Human.

**Body** (it scrolls; 647 px tall at 1440):

- Loading: a spinner. Error: a rose box, "The conversations could not be read." Empty: "No conversations", "Try a different tab or filter."
- **"Ready to book" group** (SCRUM-996), `data-testid="ready-to-book"`:
  - teal-50 header bar "Ready to book", 11 px semibold, with a teal-700 count pill and a 2 px teal-300 bottom border;
  - holds the rows whose deposit signal is `paid` or `paid_date_passed`, newest activity first, from the first page;
  - those rows do not repeat below.
  - Not present on staging today; seen in `docs/qa/proof-2026-11-19/SCRUM-996/02-paid-ready-to-book-group.png`.
- **Rows**, in last-activity order.
- **"More conversations"**: a cursor button for the next page of 50.

**A row** (`Row`):

- **Container**:
  - `role=button`, `tabIndex 0`, Enter and Space open it;
  - `aria-label "<name>, <n> unread for you, <next action>, <deposit label>"`;
  - `aria-current` when selected.
- **Row states**: unread shows a 4 px indigo-600 left bar and an indigo-50 ground; selected shows emerald-50 with a 2 px inset emerald-700 ring; hover is slate-50; keyboard focus is an emerald outline.
- **Avatar**: 40 px, the contact's initials in a fixed pastel (by contact id), with a 14 px **channel dot**. The dot's colour is per channel (title = channel name): WhatsApp emerald-500, Instagram a gradient, Facebook blue-600, LINE green-600, Telegram sky-500, Web form slate-400.
- **Line 1**: the name (13 px semibold; the display name or else the handle; "Erased contact" when erased) + " · " + **source** (the channel number's display name; plain) + **time** on the right (11 px): "14:05" today, "Yesterday", a weekday within the week, otherwise "12 Oct" (Bangkok clock).
- **Line 2** (11 px slate-500): the **intent** as the raw key (for example `birthday_details`, `faq`, `influencer_marketing`) · the **language** in capitals (EN, RU, TH, or "—") · the **branch** ("All" when none; a general thread with no branch takes its desk's park).
- **Line 3**: the **preview**, one line, 12.5 px; darker when unanswered.
- **Line 4** chips, all 11 px `rounded-full` with a ring:
  - the **category badge** (its title explains "Topic: … — what the conversation is about. Team: … — who handles it.");
  - the **status badge** (a dot and Active or Handled);
  - the **next-action chip** (SCRUM-992), hidden when handled;
  - the **deposit chip** (SCRUM-996);
  - the **unread count** on the right: an indigo-700 circle, 20 px, white 11 px; `aria-label "<n> unread messages for you"`.
- **Line 5**:
  - the **primary chip**: a person in their pastel with initials; a team in its colour; the AI indigo "AI Assistant"; the GM and other operator-wide people in slate-800. With nobody, an amber **"Unassigned"**.
  - **support chips**: initials only, name in the title.
  - **"Mark handled"**: an emerald pill, invisible until hover or focus. It opens the "Mark as handled for everyone?" confirmation.

#### 2.4.3 Conversation pane, `section aria-label="Conversation"`, `bg-slate-50/40`

**Nothing open**: an empty state, "Pick a conversation", "Choose one from the list to read it." A conversation opens only when chosen or linked (`?c=`); the prototype's auto-open of the first row was removed.

**Chat header** (66 px; `components/ChatPanel.tsx`):

- **Back arrow**, below 1024: "Back to the conversations".
- **Avatar**, 40 px, with the channel dot.
- **Name**, 14 px semibold, truncated.
- **Pencil**: "Edit name" (SCRUM-860; any writer, not for an erased contact).
- " · " and the **source**.
- **Line 2** (11 px): the handle, prefixed "Facebook ID" or "Instagram ID" on those channels, else the WhatsApp number · intent · LANG.
- At 768 and up:
  - the **category badge, which is the team picker**: a hidden native select laid over it, `aria-label "Move to team"`. It shows the team name (for example "Reception · Central Floresta") for `move` holders, or "General" when held in General; the category otherwise.
  - the **status badge, which is the status picker**: a hidden select, `aria-label "Set conversation status"`, with Active and Handled; choosing Handled asks for confirmation.
- **Start over**: a rotate icon, test-line chats only.
- **"…"**: "Conversation details".

**Assignment strip** (white/70; 74 px at 1440, 104 px at 1024 and 390, up to 4 rows):

- "PRIMARY" (11 px uppercase), then the primary picker (chip with chevron; native select, `aria-label "Set primary"`, options = people not on the thread, then the reception desks), or a dashed "Assign primary", or an amber "Unassigned" when the viewer may not assign.
- "Support 2/2" (dashed) when both places are taken (title "Both support places are taken. Remove someone first.").
- A dashed "+ Add support" picker.
- A divider, "SUPPORT", and the support chips with pickers ("Remove support").
- **Divert**: repeat icon, title "Divert to <backup>".
- On the right, wrapping:
  - **Assistant state** (SCRUM-590): a slate chip with a bot icon for "Assistant off on this number" or "Assistant in shadow"; or a button: indigo "AI on · Pause", amber "AI paused · Resume", "AI handed over · Resume", or "AI stopped: a person replied · Resume". Pressing Pause withdraws unsent lines.
  - **Branch select** (map-pin icon; `aria-label "Conversation branch"`): the parks and "All Branches", for assign holders. Otherwise "📍 <park>" as text.
- On Birthdays & Events conversations:
  - **Book Date**: filled amber-500 with white text, calendar icon. When booked it becomes a disabled amber-50 "Date Booked" or "Event archived".
  - **Create BEO**: filled violet-600 with white text, file icon. It opens the OTO App BEO form in a new tab, with AI Fill.
  - **Deposit-paid line** (SCRUM-996): teal-50 box with teal-900 text; pressing it opens Book Date.
  - **Event chip**: amber, "Event: 21 Mar 2027 at Central Floresta · Deposit paid ฿3,000"; opens the BEO.
  - **"Party removed in the Events module"**: amber, not pressable.
- **Mark as Handled**: filled emerald-600, check icon, **on its own row**.
- A spinner while an action runs.
- A rose error line with dismiss, the server's words.
- An emerald note line with dismiss, for example "Host added: <name>", "Now with X as primary · Y added as support", or "Event: … · tentative in the Events calendar".

**Timeline** (scrolls; 287 px visible in the first window at 1440×900). The column is centred at `max-w-2xl` (672 px). Older to newer:

- **"Earlier messages"** pill: loads the older page.
- **Customer bubble**: left, white, ring, 13.5 px, `rounded-2xl` with the top-left corner smaller.
- **Staff bubble**: right, slate-900 with white text; above it a person chip (initials and name, uppercase 10 px tracked).
- **AI bubble**: right, indigo-50 with indigo-900 text; above it the chip "AI ASSISTANT" (bot icon). Under it, a "Correct the assistant" link (indigo-500, pencil) and the **open-question line** (SCRUM-831), indigo 11 px: "asked: child's age · answered 8", "asked: the date · waiting for the answer", "asked: the park · not answered".
- **Automatic bubble** (system author: till notices, out-of-hours): right, slate-100; chip "AUTOMATIC".
- **Withdrawn AI line**: dashed, struck through, grey, with "⊘ Not sent: a person replied", "…: a person took the conversation", "…: the conversation was handled", "…: the assistant was paused" or "…: the contact was erased".
- **Shadow bubble**: right, dashed indigo border at 70 % ink. Chip "AI Assistant" and "👁 Shadow suggestion — not sent", or "How the assistant re-read the message — not sent".
- Inside bubbles:
  - **translation**: the language icon, LANG, and the translated text under a rule;
  - **attachments**: paperclip, the name ("Attachment", "Voice note", "Birthday brochure"), and "Open" (asks the files api; images then show inline up to 192 px; audio plays inline);
  - **voice transcript** (SCRUM-824): "🎤 transcribed · Thai" plus the text; "Transcribing…"; "Voice note could not be read"; "Voice note too long to transcribe"; "Voice note — not transcribed";
  - **time** (10 px: "14:05", "Yesterday 14:05", "20 Oct 06:14") and, on outbound lines, **ticks**: clock "Sending"; one tick "Sent"; two ticks "Delivered"; two sky ticks "Read"; rose triangle "Not delivered"; ⊘ "Not sent";
  - "Removed at the customer’s request" (redacted) and "No text".
- **System pill**: grey `rounded-full`, slate-200/70, 11 px, with a bot icon on every pill, even a person's. The texts are in section 4.
- **Pill group** (several pills from one actor within 60 s): one summary pill with a chevron, for example "Language: EN · Routed to Reception · Central Floresta · 1 more" or "AI handed over to GM — GM primary". It expands with `<details>`.
- After an "AI left this one for the team" pill: "Correct the assistant".
- **Handled marker** at the end: emerald pill "Conversation closed · Will reopen if customer replies".
- Loading spinner and error box.

**Composer** (75–83 px; `components/Composer.tsx`):

- **Normal**:
  - a rounded-xl slate-50 bar holding: Emoji (disabled, title "Not in this build yet"), Attach (disabled, same), **Templates** (file icon), **Dictate** (microphone; SCRUM-834; shown when the deployment has dictation), a textarea (1 line growing to 5, placeholder "Reply as <name>…"), and a round slate-900 **Send** (32 px);
  - Enter sends; Shift+Enter adds a line.
- **Dictation**: recording shows "Recording · 0:07 / 3:00" and a stop button; then "Transcribing…"; the words land at the caret. Privacy line: "The recording goes to the transcription provider and is not kept. Nothing reaches the customer until you press Send."
- **Template inserted**: a violet box "Template · <key> · LANG", the "English text — not translated yet" mark when relevant, a ✕, a preview, and one input per `{{variable}}`. The textarea then reads "Sending the template above" and is disabled.
- **Refusal**:
  - Outside the window: an amber box with the server's sentence and the qualifying templates. The thread's language comes first, `follow_up` on top, and "Other languages (n)" is folded. Each has Insert. If no template is in the thread's language: "No template in EN qualifies yet; the other languages are below."
  - Other refusals: a rose box.
- **Handled**: "⚠ Handled — composer disabled", with "Reopen" (manager) or "A manager can reopen this".
- **Cannot reply** (check-in notice threads): "⚠ Notices from the till — this thread cannot take a reply."
- **Writes off** (an api switch, currently always on): a disabled input "Replying is coming with the channel connection", every control disabled with that reason, and the strip line "Assigning, moving, handling and replying are coming with the channel connection."

### 2.5 Dialogs

All dialogs use one house Dialog (`components/Dialog.tsx`): centred, `rounded-2xl`, 448 px wide or 672 px when wide, capped at the window height minus 32 px, and only the body scrolls. The header has a 40 px tinted icon circle, a 15 px title, a subtitle, and a ✕ "Close". The footer is right-aligned. The backdrop is slate-900/40. Escape closes. Focus goes to ✕ on open and is **not trapped and not returned**.

| Dialog | Opened from | Contents | Buttons |
|---|---|---|---|
| **Mark as handled for everyone?** (emerald icon) | strip, row pill, status select, phone details | "This conversation will leave Active Messages for the whole team and move to the Handled tab. It returns automatically only if the customer sends a new message — or a manager reopens it." | Cancel · **Yes, mark as handled** (emerald) |
| **Change primary owner?** (amber) | primary picker, when the api answers 409 `CATEGORY_MOVE_UNCONFIRMED` | "Setting <name> as primary will move this conversation from <category> to <team>. The current support assignees will stay. Continue?" | Cancel · **Yes, move to <X>** (slate-900) |
| **Move to another team?** (amber) | team picker | "…hands it to that team’s routing: its default owner becomes primary and its backup is added as support. Everyone on it now is released." | Cancel · **Yes, move to <team>** |
| **Start over with this number?** (amber) | test-line chat | the test conversation is erased, the number forgotten, "This cannot be undone." | Cancel · **Yes, start over** (amber-600) |
| **Conversation details** (info icon) | "…" | a two-column `dl` with uppercase 10 px slate-400 labels: Contact, Facebook ID/Instagram ID/Handle, Phone, Source, Channel, Language, Category, Intent, Team, Support (+ "Managers add support"), Branch, Status, Member ("<name> · n children" or "Not linked"), Started, First reply, Handled, Reopened. **Below 768 only**: "ACTIONS" with a Team select and a Status select. | ✕ |
| **Templates** (violet icon, wide) | composer file icon | "In EN, the conversation’s language", or "Every language". Cards: key in uppercase tracked letters, LANG pill, translation mark, **Insert**, body. States: loading, "No templates in this language yet.", error. | ✕ |
| **Filters** | below 1024, the Filters button | "INBOXES" (the named views) and "FILTERS" (the chip rows) | **Clear** · **Show conversations** (slate-900) |
| **Book Date — <name>** (amber icon, wide) | Book Date, the paid line, Create BEO | see below | Cancel · **Book date** or **Book date and open the BEO** (amber-500) |
| **Correct the assistant** (indigo pencil) | under AI lines or `ai_silent` pills | subtitle "Proposes an example the assistant learns from once approved. The customer does not see this." Fields: "What should it have done?" (It should have answered like this / hand over / stay silent); "The customer asked (remove names, phone numbers, children’s details) · n/500"; "Its line, corrected · n/800" (or "The reply it should have sent", "(optional)"); "Topic of the question"; "Language". Then "Sent for approval", "Thank you. Approved examples are what the assistant answers from next." | Cancel · **Propose example** (slate-900) |
| **Edit name** | header pencil | "<name> · <channel>"; Name; the profile-name line "Name on <channel>: …" or "The channel has not sent a name for this contact yet."; "Use the profile name"; "Clear the name" | Save |
| **New contact** | "New" | "A record only: nothing is sent to the customer." Name, Channel ("Choose the number or account"), the phone or handle (placeholder by channel). An existing contact shows "Open". When the thread is out of view, it names the team. | Create |
| **Simulator** (wide) | Settings → Simulator | as in 2.1 | ✕ |
| Assistant and Template dialogs | settings pages | Knowledge entry editor, approve and archive confirms, Rule editor and confirms, Live confirm, Example editor and approve/withdraw, Template editor and archive | — |

**Book Date dialog in detail** (`components/BookDateDialog.tsx`):

- **Subtitle**: "Request the agreed deposit first. After gateway verification, check capacity and create the booking. A draft reserves no date."
- **Deposit box**: amber-200 border, `data-testid="prebooking-deposit"`.
  - It may read "Simulator test payment: no real bank deposit has been received.", and for non-assigners "A manager requests the agreed deposit. The birthdays team can book after gateway verification."
  - "Full deposit: Gateway verification required. A payment slip or staff receipt does not unlock booking." The words change by state: paid, needs review, expired.
  - "Agreed deposit (฿)" input: disabled for agents and once requested.
  - **Request deposit** (assign holders only), **Check payment**, and an "Open payment page" link.
  - "Payment never creates the booking automatically. If the date cannot be accommodated, staff must resolve the paid deposit with the family."
- **Reading row**: the chip "✨ READ FROM THE CHAT" (indigo), then "Reading the whole chat…" or "✓ Read the whole chat", and **Fetch from chat** (a model re-read; not pressed in this inventory) with its result line.
- **Fields**, two columns:
  - Date (date input); Start time (time input); Park (select, full width); # of kids; # of adults; Booking name; Phone; Child's name; Turning (age).
  - Under each: "The chat says “…” [from the family / from the team]", "The chat names no date", or the amber "The chat reads two ways: choose one" with option buttons.
- **Save rules**:
  - Save is disabled until the deposit is paid at the chosen park and no choice is pending; the waiting reason shows in the footer.
  - Problems: "Choose the park.", "Choose the date.", "Enter the start time as HH:MM.", "Kids is a whole number.", "Enter who is booking.", "Request the full agreed deposit and wait for gateway verification before booking."
- On staging, Anya's Save was disabled (amber-500 at 60 %) because no deposit was paid.

### 2.6 What does not exist

- **No wallboard, display or TV mode**: no route, component, flag or query parameter. Searched `wallboard|display mode|kiosk|fullscreen` in `apps/inbox/src` and the apps.
- **No notifications**: no sound, browser notification, tab-title badge or favicon badge.
- **No keyboard shortcuts**, other than Enter to send and Escape on dialogs and menus.
- **No conversation-level menu** besides "…", which is the Details dialog.
- **No translation toggle** and no snooze.
- **No internal staff notes.** The thread is WhatsApp-style and has no staff-only notes, by design.

---

## 3. Filters and ways to narrow the list

| # | Control | Where | Request change (`GET /inbox/conversations`) | Notes |
|---|---|---|---|---|
| 1 | Tabs: My Inbox, Team Inbox, Handled | rail at 1024 and up; segmented tabs below | `tab=mine\|team\|handled` | Team = every active conversation the viewer sees, **their own included**; Handled = status handled |
| 2 | **Handled** button | header | `tab=handled`, toggles back | same as #1 |
| 3 | Unanswered tile | dashboard (1024 and up) | `unanswered=true`; leaves Handled | |
| 4 | Unanswered chip | phone strip (below 1024) | `unanswered=true` | |
| 5 | "Unanswered only" pill | list head (1024 and up, or all widths without the dashboard) | `unanswered=true` | not on Handled |
| 6 | Active tile | dashboard | `status=active`, `unanswered` off | |
| 7 | Handled today tile | dashboard | `tab=handled` + `handledFrom` = Bangkok midnight | |
| 8 | By category legend | dashboard tile | `category=…` | |
| 9 | Search | list head | `q` (name, intent, last message; 250 ms debounce) | |
| 10 | Named inboxes | rail and Filters dialog | All: clears 11–15; General: `inbox=general`; Birthdays & Events: `category=birthdays`; GM: `category=gm`; a park: `branchId`; a test line: `channelAccountId` | views are saved chip sets |
| 11 | Branch chips | rail and dialog | `branchId` | a park's inbox never holds General-held threads |
| 12 | Source chips | rail and dialog | `channelAccountId` | the list of numbers is learned from rows read |
| 13 | Topic chips | rail and dialog | `category` | |
| 14 | Status chips | rail and dialog | `status=active\|handled` | |
| 15 | Language chips | rail and dialog | `language=en\|ru\|th` | |
| 16 | Applied-filter pills | list head | clears one of 10–15 | |
| 17 | Archive range | Handled tab | `handledFrom` (today, 7, 30, 90 days, all; default 30) | in the URL as `range` |
| 18 | Resolved by | Handled tab | `resolvedBy=ai\|human` | in the URL as `by` |
| 19 | URL | address bar | `?tab`, `?unanswered=1`, `?c=<id>`, `?range`, `?by`, `?settings`, `?section` | other filters and the search are not in the URL |
| 20 | Paging | list end | `cursor`, `limit=50`; refreshes ask for up to 100 | |
| — | Not exposed | api only | `phone` (SCRUM-648), `handledTo` | |

**Overlaps and duplications.**

1. **"Handled" in three places that do the same thing**: the header "Handled" button (#2), the rail's "Handled" tab (#1), and the phone's "Handled" tab. Beside them sits the "Handled today" tile (#7), the Handled tab with a range. The header button even shows pressed together with the rail tab (`gm-1440-handled-light.png`).
2. **"Handled" again as a Status chip** (#14). On Team Inbox or My Inbox it returns an empty list, because those tabs only hold active conversations. On the Handled tab, Status "Active" does the same.
3. **The Active tile and the Status "Active" chip are no-ops on Team Inbox.** Team is already active only (`inTab`), so the Active tile (#6) and chip (#14) change nothing there. The Team Inbox count (189) equals the Active tile (189).
4. **Unanswered has three controls**: the tile (#3), the phone chip (#4) and the list pill (#5). The code shows one per width on purpose, but at 1024 and up the tile and the pill both show, one above the other.
5. **Parks are offered twice, identically**: the named park views (#10) and the Branch chips (#11) set the same `branchId`. The rail lists Central Floresta, Robinson Chalong, Demo Branch 2 and ZZ TEST Print Bare twice, 200 px apart.
6. **Categories are offered three times**: the "Birthdays & Events" and "GM" views (#10), the Topic chips (#13) and the By category legend (#8) all set `category`. The applied pill (#16) is a fourth display of the same filter.
7. **Two different things are both called "General".** The "General" view (#10) means `inbox=general`: general questions held out of the park inboxes while the assistant answers them. The "General" Topic chip (#13) means `category=general`: everything general, including desk threads. The category badge on a row also says "General".
8. **Test lines are offered twice**: the named "WhatsApp test line" view and the Source chip of the same number.
9. **Mark handled has four entry points**: the row hover pill, the strip button, the status badge select, and the phone Details → Status select. Moving a thread has three: the team badge select, the phone Details → Team select, and a cross-team primary pick.
10. **The viewer's identity is shown three times**: the header subtitle "<name> · Owner view", the rail "VIEWING AS", and the composer placeholder "Reply as <name>…".
11. **Counts disagree in kind**: rail tab counts are before filters; "50+ conversations" is the loaded page; the tiles are dashboard scope. One screen shows "189", "189" and "50+" for the same set.
12. **Rows repeat the view's own facts.** In the Birthdays & Events view, every row says "Birthdays & Events" and "Active". On Team Inbox every row says "Active".
13. **"Waiting for customer"** (next action) and the **unanswered** flag describe the same state from two sides. The list has a filter only for unanswered, not for next action, deposit or language.

---

## 4. States and labels, with today's words and colours

Hex values are Tailwind v4 as installed (`data/tokens.json`). A chip written "bg / ink / ring" gives its background, text and ring colours.

**Status** (`STATUS_*`, `lib/view.ts`):

- Active: blue-50 #eff6ff / blue-700 #1447e6 / blue-200, with a blue-500 dot. Dark: blue-500/15 / blue-300.
- Handled: emerald-50 #ecfdf5 / emerald-700 #007a55 / emerald-200, with an emerald-500 dot.

**Categories** (`CATEGORY_*`):

| Key | Label | Colour family | Badge (bg / ink) | Bar |
|---|---|---|---|---|
| birthdays | Birthdays & Events | violet | violet-50 #f5f3ff / violet-700 #7008e7 | violet-500 #8e51ff |
| general | General | sky | sky-50 #f0f9ff / sky-700 #0069a8 | sky-500 #00a6f4 |
| marketing | Marketing | pink | pink-50 #fdf2f8 / pink-700 #c6005c | pink-500 #f6339a |
| gm | GM | amber | amber-50 #fffbeb / amber-700 #bb4d00 | amber-500 #fe9a00 |

Rings use the -200 shade. Dark is `-500/15` with `-300` ink.

**Teams**: the colour comes from `team.colour` (violet, sky, pink, amber). **The amber GM team has no chip tint** (`TEAM_TINT` lacks amber), so it falls back to slate.

**Channels**:

| Channel | Label | Dot colour |
|---|---|---|
| whatsapp | WhatsApp | emerald-500 |
| instagram | Instagram | a gradient: amber-400 → pink-500 → purple-500 |
| facebook | Facebook | blue-600 |
| line | LINE | green-600 |
| telegram | Telegram | sky-500 |
| webform | Web form | slate-400 |

**Tabs**: My Inbox, Team Inbox, Handled.

**Next action** (SCRUM-992, `lib/list-state.ts`; all chips -100 / -950 / -300 ring, dark -950 / -100):

| Key | Words | Colour |
|---|---|---|
| `staff_reply_needed` | Staff reply needed | amber-100 #fef3c6 / amber-950 #461901 |
| `staff_action_needed` | Staff action needed | amber (same as above) |
| `ai_replying` | AI replying | indigo-100 / indigo-950 |
| `ai_previewing` | Preparing AI preview · not sent | violet-100 / violet-950 |
| `shadow_preview` | AI preview · not sent | violet |
| `ai_sent` | AI sent · waiting for customer | emerald-100 / emerald-950 |
| `waiting_customer` | Waiting for customer | slate-100 / slate-800 |
| `handled` | Handled | not shown on the row |

The api computes it (`inboxNextAction`, `packages/shared/src/inbox.ts`). An older api's row falls back to staff reply needed (unanswered) or waiting for customer.

**Deposit signal** (SCRUM-996):

| Key | Words | Colour |
|---|---|---|
| `paid` | Deposit paid · book the date | teal-100 / teal-950, ring teal-400 |
| `paid_date_passed` | Deposit paid · date passed, needs staff | orange-100 / orange-950 |
| `needs_checking` | Deposit needs checking | rose-100 / rose-950 |

The "Ready to book" group header is teal-50 with teal-900 text and a teal-700 count. The paid line beside Book Date is teal-50 / teal-900 / teal-300, reading "Deposit ฿X paid and gateway verified at 16 Nov, 19:00. Check capacity, then Book Date." It begins "Simulator test payment, no real money: …" for a simulator payment. For a passed date it ends "The party date has passed: staff must resolve the paid deposit with the family."

**Event chip deposit words** (SCRUM-825): "Deposit requested ฿…", "Deposit overdue ฿…", "Deposit paid ฿…", "Simulator test deposit ฿… (no real bank money)", "Deposit link expired". The chip's own text is "Event: <d Mon yyyy> at <park>[ · Archived][ · deposit]".

**Unread**: indigo-700 #432dd7 count, white text; the row gets a 4 px indigo-600 #4f39f6 bar and an indigo-50 #eef2ff ground. Dark: an indigo-300 count with indigo-950 text.

**Selected**: emerald-50 ground with an emerald-700 2 px inset ring. Dark: emerald-950 and emerald-300.

**Assistant state on a thread** (`aiStateLineFor`; the api's `aiState`):

| State | Words | Colour |
|---|---|---|
| off | "Assistant off on this number" | slate chip, no control |
| shadow | "Assistant in shadow" | slate chip |
| ready | "AI on · Pause" | indigo button |
| paused | "AI paused · Resume" | amber |
| left_for_team | "AI handed over · Resume" | amber |
| person_replied | "AI stopped: a person replied · Resume" | amber |

**Assistant mode per number**: Off (slate), Shadow (amber), Live (indigo; the chosen radio is filled indigo-600).

**Assignees**:

- Kinds: a person (fixed pastel from 10: violet, teal, emerald, lime, orange, pink, amber, fuchsia, rose, cyan, -100 / -700); a team (its colour); the AI (indigo-100 / indigo-700, "AI Assistant"); an operator-wide person in no team (slate-800 with white text).
- "Unassigned" chip: amber-50 / amber-700.
- Reasons in the data: auto, manual, divert, move, reopen.

**Delivery** (message `providerStatus`):

| Status | Mark | Words |
|---|---|---|
| queued | clock | "Sending" |
| sent | one tick | "Sent" |
| delivered | two ticks | "Delivered" |
| read | two sky-300 ticks | "Read" |
| failed | rose-400 triangle | "Not delivered" |
| withdrawn | ⊘ | "Not sent", with a struck-through bubble |
| shadow | dashed indigo bubble | "Shadow suggestion — not sent" |

**Voice transcript**: pending "Transcribing…"; done "transcribed · <Thai|Russian|English>"; failed "Voice note could not be read"; too long "Voice note too long to transcribe"; off "Voice note — not transcribed".

**Knowledge, rules and templates**:

- Knowledge and rules: Draft (amber), Approved (emerald), Archived (slate).
- Examples: To review, Approved, Rejected. Verdicts: Should answer, Should hand over, Should stay silent.
- Template approval: No approval needed (slate), Awaiting approval (amber), Approved (emerald), Rejected (rose). "English text — not translated yet" is an amber chip.

**System pill words** (`eventText`, `lib/view.ts`). All are grey slate-200/70 with slate-600 text and a bot icon.

- **Routing and classification**:
  - `classified`: "AI · Language: EN · Intent: <intent>"
  - `routed`: "Language: EN · Routed to <team>[ · from the message][ · needs the local team | · the assistant is not answering]", or "Kept in General · no park inbox"
- **Places and moves**:
  - assigned: "<who> added <X> as primary|support", or "Assigned <X> as …"
  - released: "<who> removed <X> (support)"
  - "Diverted to <X> by <who>"
  - "Moved from <A> → <B> by <who>", "Auto-moved from A → B (follows primary owner)", "Moved from General → <B> by <who> · needs the local team"
  - "Branch set to <park>|all branches by <who>"
- **Assistant pause**: "AI paused by <who>[ · n lines withdrawn]"; "AI resumed by <who>"
- **Closing and reopening**: "Marked as Handled by <who>", "Marked as Handled by AI · Auto-resolved"; "Reopened by <who>", "Reopened · the customer wrote again"
- **Birthday booking**: "Date blocked in the Events calendar by <who> · awaiting confirmation"; "BEO saved by <who>"
- **Other events**: "Translated"; "Updated from the POS"; "Waiting longer than usual" (SLA); "Check-in notice sent from the till"; "Reply not sent[ · <channel refusal>]"
- **Assistant hand-over and silence**:
  - "AI handed over to <team>[ · intent][ · voice note could not be read][ · re-read the message][ · n lines left out][ · manager notified 14:05 | · manager not notified (no contact|ping logged only|sending failed)][ · escalated to GM 14:20 | · GM not notified (…)]"
  - "AI re-read the message before replying"
  - "AI left this one for the team"
  - "AI reply not sent · <why>"
  - "AI in shadow · would have answered|handed over|stayed silent · <intent>"
- **Deposits**: "Deposit requested ฿…[ · resent]", "Deposit reminder sent · ฿… still unpaid", "Deposit paid ฿…[ · after the request was closed]", "Deposit link ran out unpaid · ฿…", "Deposit request cancelled by <who> · ฿…", "Deposit request closed · the party was removed in the Events module · ฿…", "Deposit overdue ฿… · handed to <team>"
- **Menus**: "Menu choice link sent", "Menu choices received from the family"
- **Any other event**: its kind with underscores as spaces.
- **Groups**: "<most telling pill> · n more", or "AI handed over to <team> — brochure sent, <X> primary, <Y> support".

**Error and empty words**: "The conversations could not be read.", "No conversations / Try a different tab or filter.", "Pick a conversation / Choose one from the list to read it.", "The dashboard could not be read.", "This conversation could not be read.", "Earlier messages could not be read.". Every action refusal shows the server's own sentence.

---

## 5. Data a row and a thread carry

### 5.1 Available today (no api work)

**List page** (`GET /inbox/conversations`, `InboxConversationListSchema`):

- `conversations[]`;
- `nextCursor`;
- `tabCounts {mine?, team?, handled?}`, counted over everything visible, before filters;
- `readyToBook[]` on the first page;
- `access {categories, channelAccountIds, version}`.

**Row** (`InboxConversationRowSchema`):

| Field | Meaning |
|---|---|
| `id` | the conversation |
| `channel` | whatsapp, instagram, facebook, line, telegram or webform |
| `channelAccountId`, `channelAccountName` | the number or account it came in on, and its display name ("Demo WhatsApp · Central Floresta", "Check-in notices (WhatsApp)") |
| `canReply` | false on check-in notice threads |
| `contact {id, channel, handle, displayName, phone, language, erased}` | handle is the WhatsApp number or the Facebook or Instagram numeric id |
| `category` | birthdays, general, marketing or gm |
| `intent` | the classifier's raw key, for example `birthday_details` or `faq`; may be null |
| `language` | en, ru, th; may be null |
| `branchId` | the park; null means all parks |
| `teamId` | the team it sits with; null means held in General |
| `status`, `handledAt`, `handledByKind` | active or handled; when, and by a person or the AI |
| `lastMessageAt`, `lastMessagePreview` | the order key and the one-line preview |
| `unanswered` | a person still owes an answer (AI lines do not count) |
| `nextAction` | as in section 4 |
| `depositSignal` | paid, paid_date_passed, needs_checking, or null. Never an amount. |
| `unread` | customer messages after this viewer's own read marker |
| `mine` | the viewer holds a place on it |
| `assignments[]` | `{assignmentId, slot primary\|support, slotIndex 0–2, assigneeKind account\|team\|ai, accountId, teamId, name, reason, assignedAt}` |
| `createdAt` | when the conversation started |

**Detail** (`GET /inbox/conversations/{id}`) is the row plus:

- `teamName`, `firstResponseAt`, `reopenedAt`;
- `member {id, name, childCount}`: no allergy text, which stays on the till;
- `events[] {id, kind, actorKind, actorAccountId, actorName, payload, createdAt}`;
- `divertTo {accountId, name}`;
- `aiMode`, `aiState`, `aiPaused`, `aiPausedAt`, `aiPausedByAccountId`;
- `event {id, title, date, startTime, branchId, branchName, status, statusName, archived, removed, kids, adults, bookedAt, bookedByAccountId, beoPath, deposit {requestId, state, amountSatang, simulator, overdue}}`;
- `handoverNotices[]` (who was told and when, GM escalation, picked up);
- `openQuestions[]` (what the assistant asked, and how it read the answer).

**Message** (`GET …/messages`, 50 per page, oldest first, with an `olderCursor`):

- `id`, `direction`, `authorKind` (customer, staff, ai, system), `authorAccountId`, `authorName`;
- `body`, `bodyLanguage`, `translatedBody`, `translatedTo`;
- `mediaFileIds[]`, `audioFileId`, `transcript`, `transcriptStatus`, `transcriptLanguage`;
- `templateId`, `providerStatus`, `source` (channel, checkin.contact or booking.confirmation);
- `sentAt`, `deliveredAt`, `readAt`, `redacted`, `createdAt`.

**Me** (`GET /inbox/me`):

- `accountId`, `name`, `roles`, `tabs`;
- `teams[] {id, kind, name, colour, branchId, member}`;
- `people[] {accountId, name, teamIds, operatorWide}`;
- `defaultReceptionBranchId`;
- `capabilities {writes, dashboard, assign, move, reopen, templates, kb, ai}`;
- `dictation {available, maxSeconds}`;
- `impersonation`;
- `simulator {channelAccounts}`;
- `contactChannels[]`;
- `testLines[] {id, channel, displayName, branchId, startOver}`;
- `access`.

**Dashboard**: `scope` (mine, team, all), `newToday`, `unanswered`, `handledToday`, `active`, `averageFirstResponseSeconds`, `population`, `byCategory {birthdays, general, marketing, gm}`, `day`, `beosThisWeek`, `weekStart`.

**Other reads**:

- templates `{id, key, language, channel, branchId, body, attachmentFileIds, approvalStatus, needsTranslation}`;
- prebooking (deposit draft: state, amount, paidAt, simulator, paymentLink, booking fields; refused to people who may not book);
- book-date proposal (the model's reading of each field, with the words and whose line);
- contact view (`profileName`, `nameSetByStaff`, `nameSetAt`);
- files (a short-lived URL on request).

**Derivable in the UI without new api work**:

- the park name (from the reception teams);
- the team name on a row (from `me.teams`);
- the waiting age since the last message (from `lastMessageAt`);
- whether the viewer is primary;
- the source list (learned from rows);
- the next action;
- the "Ready to book" group.

### 5.2 Would need new api work

- **Counts per named inbox or view** (unread, unanswered, staff-needed per Birthdays, GM, park, General). The rail shows none today; the code notes no read counts them.
- **A filter by next action or deposit signal**, and **excluding a source** (for example hiding "Check-in notices" threads). The api filters only include one value per dimension.
- **How long the customer has waited.** The row has `lastMessageAt` but not `lastCustomerMessageAt` or `lastRoutedAt`. `sla_breached` exists only as a detail event.
- **On the row instead of the detail**: the assistant's state (`aiState`), the team name, the booked event date, the member link, the hand-over reason.
- **Live updates.** Today a 30 s poll; no push, presence, typing or "someone else is replying".
- **Notifications or sound** for new messages, hand-overs or paid deposits. The deposit's bell rings the birthday manager's phone server-side, not the Inbox.
- **Contact photos or avatars**: the channels' profile pictures are not stored or served.
- **Attachment thumbnails or names on render.** The row carries file ids only; the URL comes on a press, and each read is access-logged.
- **A server-side list of parks** (today read off reception teams) and **a full list of sources for everyone** (today `GET /inbox/ai/channel-accounts`, for `ai` holders only).
- **Search inside threads**; search is name, intent and last message only.
- **Bulk actions** (mark several handled, assign several).
- **A wallboard or display mode** (aggregates by team and age; a display session without a person).
- **Export** of the archive (the button exists, disabled).
- **Emoji picker and attachments in replies.** The reply route takes words and templates only.

---

## 6. Responsive behaviour today

Breakpoints used in the code: `sm` 640, `md` 768, `lg` 1024 (`useIsDesktop` and every `lg:`), `xl` 1280 (simulator panel). Measurements are from staging (`data/gm-results.json`, `data/agents-results.json`; GM unless named).

**At 1440 × 900**

- **Header card**: 433 px (y 20–453). The dashboard has 3 rows; the BEOs tile sits alone on row 3.
- **Workspace card**: starts at y 473 and is 738 px tall; the document is 1233 px. The **work area shows 426 px of the 900 px window (47 %)**.

  | Region | Width | Height visible in the first window |
  |---|---|---|
  | Rail | 220 | 426 |
  | List | 360 | 426: head 91 + rows area 335 |
  | Thread | 770 | 426 |

- **In the thread**: header 66, strip 74, timeline 287 visible of 524. **The composer starts at y 1137, 237 px below the fold**, so replying needs a page scroll.
- **By area**: the list gets 153 k px² (11.8 % of the window) and the thread 328 k px² (25.3 %). The reading timeline alone is 220 k px² (17 %).
- **Rows** are 143–169 px tall; **1 row is fully visible** in the first window; the list's scroll area holds about 4.5 rows.
- **Simulator panel**: when shown (≥ 1280, for channel managers) it takes 420 px of the right side, leaving about 1,020 px for header and workspace.

**At 1024 × 768**

- The **header buttons wrap to two rows**, so the header is taller than at 1440: 453 px.
- **Workspace**: 632 px tall, starts at y 493, **only 275 px visible (36 % of the window)**.
- **Thread**: 394 px wide; header 66; **strip 104** (3 rows: primary/support, the AI chip with the branch, Mark as Handled); **timeline 105 px visible**; composer at y 1048, below the fold.
- **Chat header**: the contact's name shrinks to 1–2 characters ("66…", "S") because the badges and the "…" take the room. The source, handle and intent are each truncated to a few letters (`birthdays-agent-1024-birthday-chat-open-light.png`, `gm-1024-chat-open-light.png`).
- **Rail**: still visible; its chips need scrolling.

**At 768 × 1024**

- **One column.** The rail is hidden; its views and chips move into the Filters dialog. The dashboard grid is hidden and replaced by the one-line strip.
- **Header**: the eyebrow and the five buttons only, 111 px.
- **List head**: 164 px (segmented tabs, strip, search with New and Filters, the count). The list then fills 873 px of the window, with 4 rows fully visible.
- **Opening a chat replaces the list** (back arrow).
- **Composer**: at y 1069, below a 1024 px fold, by the 20 px page padding plus the header card. The card is `100dvh − 2rem` tall but starts 151 px down, so 151 − 32 = **119 px of it always sits below the fold**.
- The category and status badges show (768 and up).

**At 390 × 844**

- **Header**: 155 px, the buttons on two rows (Handled, Settings, theme / Back to the suite, Sign out).
- **List head**: 164 px.
  - The three-tab segment truncates "Team In…"; the counts stay.
  - The strip reads "Unanswered 72 · Active 189 · Avg response 10m 40s".
  - The search placeholder is cut off ("Search customers, inten"); New is icon only.
- **List**: the first row starts at y ≈ 360; **3 rows are fully visible**. Line 1 truncates the source; the chips wrap to 2–3 lines; the unread circle drops onto its own line.
- **Chat**:
  - **Header**: the name truncated ("Sara…", "668123…"); the badges hidden (in "…" → Conversation details → Actions: Team and Status selects); the source, handle and intent truncated.
  - **Strip**: 104–150 px. Anya's has PRIMARY, SUPPORT, the AI chip, the park with Book Date and Create BEO, then Mark as Handled: 5 rows.
  - **Composer**: at y 925 + 83, **below the 844 px fold**.
  - **The bubbles take 80 % width.**
- **No sideways scroll** was measured: document width equals the window (`overflow-x: hidden` on body). Truncated spans are clipped, not overflowing.
- **Dialogs** fit (`max-h 100dvh − 2rem`; body scrolls). The Filters dialog lists 9 views and the chip rows; the Book Date dialog scrolls its fields.

**Dark theme** at every width matches light structurally. In full-page pictures the fixed body gradient shows a seam at the first window's bottom. That seam is a capture effect of `background-attachment: fixed`, not seen when scrolling.

---

## 7. Faults of layout and consistency

**Space and the fold**

1. **The work area starts below half the screen.** At 1440 × 900 the header and dashboard card is 433 px (48 % of the window) and the three columns get 426 px. At 1024 × 768 they get 275 px (36 %).
2. **The composer is below the fold at every size measured**:

   | Window | Composer top |
   |---|---|
   | 1440 × 900 | y 1137 |
   | 1024 × 768 | y 1048 |
   | 768 × 1024 | y 1069 |
   | 390 × 844 | y 925 |

   Replying always needs the page to scroll first. The workspace's fixed height (82vh, or 100dvh − 2rem) plus the header above it guarantees this.
3. **Rows are 143–169 px tall** for 5 lines and up to 6 chips. One row is fully visible in the first window at 1440 × 900; about 4.5 fit in the list's own scroll area.
4. **The dashboard grid leaves an orphan**: 7 tiles in 3 columns put BEOs alone on a third row of 97 px.
5. **The assignment strip wraps unpredictably**: 74 px (2 rows) at 1440, 104 px at 1024 and 390, and up to 5 rows for a birthday chat at 390. "Mark as Handled" always sits alone on its own row.
6. **The contact's name disappears in the chat header at 1024** (1–2 characters) because the category and status badges and the "…" keep their width.
7. **The rail's filters are long**: at 1440 × 900 the Topic, Status and Language rows are only reachable by scrolling the rail.

**Alignment and rhythm**

8. **The unread circle has no fixed place.** It is `ml-auto` in a wrapping chip row, so it lands at the end of the chip line or alone on a new line, with an empty gap (the first rows in `gm-1440-list-light.png`). The "Mark handled" pill and the support chips share line 5 with the primary chip, also `ml-auto`.
9. **Twelve font sizes**: 9, 10, 11, 11.5, 12, 12.5, 13, 13.5, 14 and 15 px, plus `text-sm` (14) and `text-xl` (20). Counts in the code: 95 × 11 px, 76 × 12.5, 53 × 13, 46 × 10, 44 × 12, 22 × 11.5.
10. **Mixed radii**: `rounded-lg` 8 px (88 uses), `rounded-full` (75), `rounded-xl` 12 px (35), `rounded-md` 6 px (14), `rounded-2xl` 16 px (12).
    - Header buttons are `rounded-xl`, strip buttons `rounded-lg`, selects `rounded-md`, chips `rounded-full`, and Book Date and Create BEO `rounded-lg`.
    - On the till, `--radius: 1rem` makes `rounded-lg` 16 px and `rounded-xl` 20 px, so the same class names mean different sizes in the two apps.
11. **Many different chip shapes in one row**:
    - the category badge (ring, no dot), the status badge (ring and dot), the next action (ring, -100 ground), the deposit (ring, -100), the count (solid circle);
    - the primary chip (no ring, initials disc) and "Unassigned" (ring, amber).
    - Chip heights differ by 1–2 px between ring and no-ring chips.
12. **Uppercase tracked eyebrows** are used at four letter-spacings (.14, .16, .18, .2 and .22em) and three sizes (10, 11 px), and for bubble author chips ("AI ASSISTANT", "DEMO ANYA (BIRTHDAYS EN/RU)").

**Colour**

13. **There is no brand colour.** The page is slate with ten accent hues, and none is the OTO coral or mint:
    - amber: Book Date, GM, Unassigned, the AI held, Draft, translation note, "Staff reply needed";
    - violet: Birthdays, Create BEO, the template box, AI previewing;
    - indigo: AI lines, unread, Live, Pause;
    - emerald: Handled, Mark as Handled, selection, "AI sent", Approved;
    - sky, pink, blue (Active, New today), rose (Unanswered, errors), teal (deposit, Ready to book), orange (date passed).
    - **Amber alone carries seven unrelated meanings.**
14. **Primary actions are four colours**: the black Send, Settings and confirm buttons (slate-900), the amber Book Date, the violet Create BEO, the emerald Mark as Handled.
15. **Selected and unread rows** use two different hues (emerald and indigo), and a handled thread keeps its indigo unread bar and count on the Handled tab.
16. **The Book Date deposit box has no dark variant** (amber-200 border, inherited text) and reads as a bright box in dark (`birthdays-agent-1440-book-date-dialog-dark.png`). The GM team chip has no tint (grey "GM GM").
17. **The favicon** is a slate-900 #0F172A square with a white speech bubble, not the OTO mark. The page title is "OTO Inbox".

**Contrast** (WCAG 4.5 : 1 for text under 18.66 px bold or 24 px; computed in-browser over every text node, and from the tokens)

| Pair | Ratio | Where |
|---|---|---|
| white on amber-500 #fe9a00 | **2.13** | "Book Date" button, 12 px medium, both themes |
| white on amber-500 at 60 % | **1.62** | disabled "Book date" save |
| indigo-300 on indigo-50/40 | **1.89** | shadow bubble time |
| slate-400 #90a1b9 on the rail ground #fbfcfd | **2.56** | 10 px eyebrows "VIEWING AS", "INBOXES", "FILTERS" |
| slate-400 #90a1b9 on white | **2.63** | tile hints "Click to filter list", "Click to open", "all", "Since Monday …"; details dialog labels; customer bubble times; placeholders; the "·" separators |
| indigo-400 #7c86ff on indigo-50 #eef2ff | **2.77–2.8** | AI bubble times (10 px) |
| slate-600 at 60 % (disabled controls) | 2.88 | Export, emoji, attach (exempt as disabled, but unreadable) |
| indigo-500/80 on slate-50/40 | **3.23** | open-question line (11 px) |
| white on emerald-600 #009966 | **3.65–3.74** | "Mark as Handled" (12 px), both themes |
| slate-500 #62748e on indigo-50 | **4.26** | the intent · language · park line of unread rows (11 px) |
| indigo-500 #615fff on slate-50/40 | **4.45** | "Correct the assistant" (11 px) |

Dark mode fails only on Book Date (2.13) and Mark as Handled (3.65).

The SCRUM-992 test pins next-action, deposit and unread contrast at 4.5 or better in both themes. Those all pass.

**Note for the new look**: **the OTO coral #f15d27 with white text is only 3.31 : 1**. It passes for large or bold text only. orange-700 #ca3500 gives 5.22 and orange-800 #9f2d00 gives 7.37. The till already uses orange-800 for coral text on cream (`--cd-menu-chosen`, `--cd-badge-new`).

**Keyboard and screen reader**

18. **Dialogs**: focus goes to ✕ on open, but there is no focus trap (Tab walks into the page behind) and focus is not returned to the opener on close.
19. **The Settings menu** is `role=menu` without arrow-key handling, without moving focus into it, and with a full-screen invisible overlay.
20. **Interactive elements are nested**: list rows are `div role=button` holding a real button ("Mark handled"). The row's `aria-label` replaces its content, so a screen reader hears name, unread, next action and deposit, but not the time, preview, category, status or assignees.
21. **"Mark handled" on rows is invisible until hover or focus** (opacity 0), so a touch screen never shows it. When writes are off it is also hidden below 640 px.
22. **Hidden native selects** laid over the category, status and person chips (opacity 0) take focus with **no visible focus indicator** on the chip.
23. **The phone tabs** use `role=tablist/tab` without `aria-controls`, a tabpanel or arrow keys. The rail tabs use `aria-current`, so the same control is two different patterns.
24. **Focus styles are explicit on only about 13 elements** (the row outline, the search, inputs). Every other button relies on the browser default.
25. **Meaning lives in `title` tooltips**, which touch and keyboard users never get. There are 87 `title=` attributes. Examples: category vs team; why Book Date is off; "Divert to <name>"; the support chip names; the channel dots; "Export is not built yet"; "Not in this build yet".
26. **No live region** announces new messages or list changes on the 30 s refresh. Refusals do use `role=alert`, and notes `role=status`.
27. **Headings**: there is no h1 below 1024 (the eyebrow only); the list and thread have no headings; dialogs use h3.
28. **The channel is shown only as a coloured dot** (WhatsApp emerald vs LINE green). The source name sits beside it, but the channel itself is never in text on the row.

**Wording that differs for the same thing**

29. **Park, branch and "All"**: "Branch" (chip row, Details), "Park" (Book Date), "Both parks" (Assistant), "All Branches" (select), "All" (row, Details), "all branches" (pill text), a park's view name ("Central Floresta"), and "Reception · Central Floresta" (team).
30. **Topic, category and team**: "Topic" (chip row), "Category" (Details), "By category" (tile), "Topic of the question" (Correct dialog), and the team badge showing a team name in place of the category for managers.
31. **Handling and closing**: "Mark as Handled" (strip), "Mark handled" (row), "Yes, mark as handled" (confirm), "Handled" (status and tab), "Archive filters" (Handled tab), "Conversation closed" (thread end), "Active Messages" (confirm text, which is no screen's name).
32. **Book Date and BEO**: "Book Date" (button), "Book date" (dialog Save), "Date Booked" (spent button), "Date blocked in the Events calendar" (pill). "Create BEO" vs "BEOs created · week" (which counts booked dates, not BEOs).
33. **The assistant**: "AI Assistant" (chips), "Assistant" (settings, AI state), "AI" (pills, next actions).
34. **Source, channel and number**: "Source" (chip row, Details), "Channel" (Details, New contact), "number" (assistant pages, test line).
35. **Conversation, chat and thread**: "conversation" (list), "chat" (Book Date), "thread" (composer notice "this thread cannot take a reply").
36. **The header copy** names three channels ("WhatsApp · Instagram · Facebook") while LINE, Telegram and the web form exist and staging shows Telegram notice threads. "All channels, one queue, role-based access" describes the build, not the user's job.
37. **Intents show as raw keys** (`birthday_details`, `influencer_marketing`, `faq`) on rows and headers. Pills humanise them ("birthday party"); rows do not.

**Content noise and dead controls**

38. **The GM's queue is flooded with check-in notice threads**: 91 of the first 100 Team Inbox rows. They cannot take a reply, yet they count as Active (189) and wear "Waiting for customer" and "Unassigned".
39. **Dead controls**: Export (disabled), Emoji and Attach (disabled), and the "Writes off" scaffolding (every control rendered disabled, with "Coming with the channel connection"), which is code only today.
40. **Agents see named inboxes that can only be empty for them**: Mila (Marketing) sees General, Birthdays & Events and GM. Her four park views each repeat the same branch-less marketing threads.

---

## 8. The OTO look

**Sources**:

- the till: `apps/pos/src/index.css` (tokens), `apps/pos/src/fonts.css` (fonts), `apps/pos/src/components/ui/{button,badge,card}.tsx`, `apps/pos/src/components/shared/StationHeader.tsx`, `apps/pos/src/components/auth/LockScreen.tsx`;
- the launcher: `apps/launcher/src/index.css` (the till's tokens copied verbatim, plus two washes), `components/AppTile.tsx`, `SuiteHeader.tsx`, `Backdrop.tsx`, `pages/Landing.tsx`.

Pictures: `oto-look-till-lock-screen-1440.png`, `oto-look-launcher-1440-light.png`, `oto-look-launcher-1440-dark.png`, `oto-look-launcher-390-light.png`.

### 8.1 Colour tokens

Tokens are HSL variables used as `hsl(var(--x))` through Tailwind's `bg-primary`, `text-muted-foreground` and so on. The hex values are computed.

| Token | Light | Dark |
|---|---|---|
| `--background` | **#fbf5ef** warm cream (32 56% 96%) | #0f1729 navy (222 47% 11%) |
| `--foreground` | **#3b281c** warm brown (24 35% 17%) | #f8fafc |
| `--card` / `--popover` | #fefdfb (36 70% 99%) | #141f38 |
| `--border` | #e7dbd0 | #1d2839 |
| `--card-border` | #eae0d7 | #1d2839 |
| `--input` | #e8ddd3 | #2b3b54 |
| `--primary` / `--accent` / `--ring` | **#f15d27 coral-orange** (16 88% 55%) | **#3c83f6 blue** (217 91% 60%): the till's dark theme is navy and blue, not orange |
| `--primary-foreground` | #ffffff | #f8fafc |
| `--secondary` | **#d4edea mint** (172 42% 88%) | #2b3b54 |
| `--secondary-foreground` | #234343 deep teal | #f8fafc |
| `--muted` | #f1e9df | #1d2839 |
| `--muted-foreground` | #766456 | #94a3b8 |
| `--destructive` | #ce2222 | #7f1d1d |
| `--sidebar` | #f7f1e8 | #121b31 |
| `--button-outline` | rgba(0,0,0,.10) | rgba(255,255,255,.10) |
| `--badge-outline` | rgba(0,0,0,.05) | rgba(255,255,255,.05) |
| `--elevate-1` / `-2` (hover and press overlays) | rgba(0,0,0,.035) / .07 | rgba(255,255,255,.04) / .09 |

Extra tokens:

- **Customer-display accent inks** (light): `--cd-success` #047857, `--cd-violet` #6d28d9, `--cd-sky` #0369a1, `--cd-amber` #b45309. Deep coral text: `--cd-menu-chosen`, `--cd-badge-new` = oklch(47% .157 37.3), which is orange-800 #9f2d00.
- **Customer-display gradient**: #fff7ed → #ffeede → #ffe2cc (light); #082f49 → #020617 (dark).
- **Launcher washes**: a blurred warm circle rgba(249,115,22,.13) at top left and mint rgba(45,212,191,.16) at bottom right. Dark: blue rgba(56,130,246,.16) and mint .10.

Contrast of the OTO pairs (light):

| Pair | Ratio |
|---|---|
| foreground on background | 12.88 |
| muted-foreground on background | 5.21 |
| muted-foreground on card | 5.54 |
| muted-foreground on muted | 4.68 |
| mint secondary text | 8.72 |
| white on primary | **3.31** (large text only) |
| primary as text on cream | **3.06** |
| foreground on primary | 4.21 |

Dark: white on blue primary 3.64; muted on card 6.36.

### 8.2 Type

- **Till**: **Inter** 400–700, served from the build (latin, latin-ext, cyrillic). Thai is drawn by **'Till Thai'**, which is Noto Sans Thai 400 and 700 from `packages/print/fonts`. `--app-font-sans: 'Inter', 'Till Thai', sans-serif`. Headings are **`font-black` (900) with `tracking-tight`**: "Oto POS is locked" `text-4xl`; the launcher's greeting `text-4xl sm:text-5xl`. Body text is `text-sm` (14 px) or `text-lg` (18 px) for intros. Tab labels are 14 px semibold. Mono is Menlo.
- **Launcher**: Inter **400–900** from Google Fonts.
- **Inbox today**: Inter 400–700 from Google Fonts only, **no Thai face** (Thai falls back to the system), sizes 9–15 px, headings 15–20 px semibold.

### 8.3 Radii, spacing, elevation

- **Till base radius**: `--radius: 1rem` gives `rounded-sm` 12 px, `rounded-md` 14 px, `rounded-lg` 16 px and `rounded-xl` 20 px (overridden). `rounded-2xl` stays 16 px and `rounded-3xl` 24 px. The lock hero icon is `rounded-[2rem]`, 32 px.
- **Inbox today**: Tailwind defaults (`rounded-md` 6, `lg` 8, `xl` 12, `2xl` 16).
- **Spacing**: the Tailwind 4 px scale in both apps.
  - Till: cards `p-5` and `p-6`; the header bar `h-16` (64 px) with `px-6`; tab band padding `p-1`; tabs `h-9 px-3`; buttons `min-h-9 px-4` (sm `min-h-8 px-3`, lg `min-h-10 px-8`, icon 36 × 36); inputs `h-12` or `h-14`.
- **Elevation**:
  - Till cards (`Card`): `rounded-xl border bg-card shadow`. Launcher tiles: `rounded-2xl border bg-card p-5 shadow-sm`, `hover:shadow-md`, plus the `hover-elevate` overlay.
  - Lock hero: `shadow-2xl shadow-primary/30` (a coral glow).
  - Header bars: `border-b bg-card/30`.
  - Inbox today: a custom card shadow `0 12px 40px -16px rgba(15,23,42,.18)`, menus `0 12px 40px -16px rgba(15,23,42,.28)`, dialogs `shadow-xl`.

### 8.4 Components

- **Till button** (`cva`):
  - base `inline-flex gap-2 rounded-md text-sm font-medium`, focus `ring-1 ring-ring`, disabled `opacity-50`, plus hover-elevate;
  - `default`: `bg-primary text-primary-foreground border-primary-border`;
  - `secondary`: mint with a secondary border;
  - `outline`: `border [var(--button-outline)] shadow-xs`;
  - `ghost`: transparent border;
  - `destructive`;
  - `link`: `text-primary underline`.
- **Till badge**: `rounded-md border px-2.5 py-0.5 text-xs font-semibold`. Variants: default (primary), secondary (mint), destructive, outline (`--badge-outline`).
- **Launcher status pill**: `rounded-full border px-2.5 py-0.5 text-xs font-semibold border-primary/25 bg-primary/10 text-primary` ("Open"); amber `border-amber-500/40 bg-amber-400/10 text-amber-600` ("Coming soon", "Maintenance").
- **Tab band** (till header): `rounded-lg bg-muted p-1`; the active tab is `bg-background shadow`, idle tabs `text-muted-foreground`; each tab is `h-9 px-3 rounded-md text-sm font-semibold` with a 16 px icon.
- **Launcher tile**: a 48 px `rounded-xl bg-primary/10 text-primary` icon square, title `text-lg font-bold`, purpose `text-sm text-muted-foreground`, and the action "Open Inbox →" `text-sm font-semibold text-primary`.
- **Launcher header**: the OTO logo (`assets/logo-oto.png`: coral "O", violet "t", teal "o"), the word "Suite", and an account pill `rounded-full border bg-card/60 h-9` with a `bg-primary/15` disc.
- **Notices** (till): `rounded-2xl border border-amber-500/30 bg-amber-400/10 text-amber-700` (amber), `border-destructive/30 bg-destructive/10` (error), and dashed secondary actions `rounded-2xl border-dashed border-foreground/20 text-foreground/60`.

### 8.5 The Inbox's own tokens beside them

| Aspect | Inbox today | OTO look |
|---|---|---|
| Ground | slate-50 #f8fafc → white gradient; dark slate-950 #020618 → slate-900 #0f172b | cream #fbf5ef; dark navy #0f1729 |
| Card | white, slate-200 #e2e8f0 border, `rounded-2xl` 16 px | #fefdfb, #eae0d7 border, `rounded-xl` = 20 px |
| Ink | slate-900 #0f172b; secondary slate-500 #62748e; tertiary slate-400 #90a1b9 (2.63 : 1) | #3b281c; muted #766456 (5.2 : 1) |
| Primary action | slate-900 black buttons; plus amber, violet and emerald for specific actions | coral #f15d27 (dark: blue #3c83f6) |
| Secondary | white with a slate ring | mint #d4edea with deep teal #234343 |
| Chips | `rounded-full` 11 px with -50 ground, -700 ink, -200 ring | badges `rounded-md` 12 px semibold; status pills `rounded-full` primary/10 |
| Type | Inter 400–700, 9–15 px, headings 15–20 px semibold | Inter to 900; headings `font-black tracking-tight`; body 14 px |
| Icon | lucide 12–16 px | lucide 16–24 px |

---

## 9. Constraints a redesign must respect

**Rules pinned by tests or recorded decisions**

1. **List order is newest activity first** (`coalesce(lastMessageAt, createdAt)` desc, then id), with no re-sorting by urgency. SCRUM-992 kept it on purpose (`docs/progress/plans/tom-feedback-20261116/deposit-paid-notice.md`). It is pinned in `apps/api/test/prebooking-notice-996-review.test.ts`: "while the list keeps its last-activity order".
2. **"Ready to book"** (SCRUM-996, owner choice 1):
   - the group is pinned above the list and holds only `paid` and `paid_date_passed`, newest first, from the first page; "needs checking" is never in it;
   - each conversation appears once;
   - the label goes after Book Date, a refund, or archiving.
   - Pinned by `apps/inbox/test/deposit-notice-996.test.ts` (`data-testid="ready-to-book"`, "Ready to book") and `apps/api/test/prebooking-notice-996-review.test.ts`.
3. **Who sees what about a deposit** (SCRUM-996 choice 3):
   - the row's deposit words show to everyone who sees the chat, never with an amount;
   - **the amount and the verified time** (the line beside Book Date, `data-testid="deposit-paid-line"`) show only to people who may book, and the api refuses the deposit read to others with 403;
   - nothing is requested for people who may not book.
   - Pinned in `deposit-notice-996.test.ts` (the tests at lines 173, 184 and 193).
4. **Unread and next action stay separate** (SCRUM-992): the indigo unread marker and count are per viewer; the next-action chip is the api's; selection, focus and unread keep separate markers in both themes. Every next-action, deposit and unread text must keep **4.5 : 1 or better in both themes**, and the selected ring 3 : 1. Pinned in `apps/inbox/test/list-state-992.test.ts` and `apps/api/test/inbox-next-action-992-review.test.ts`.
5. **Visibility and SCRUM-993 limits are server truth.** The UI must hide views, chips, sources, test lines, simulator numbers, contact channels and teams outside the limits, and drop rows and threads, with access state kept across polls. Pinned in `apps/inbox/test/access-993.test.ts`, `workspace-access-993.test.ts` and `apps/api/test/inbox-access-993-review.test.ts`.
6. **No auto-open**: nothing opens a conversation the person did not choose or link, because opening one moves their unread marker (test night U8). Landing on My Inbox when the person holds threads is pinned in `view.test.ts`.
7. **Opening and the unread marker**: the marker moves only when the thread is on screen and has unread lines (`POST …/read`, which also writes the day's read audit).
8. **The assistant's guards and hand-overs are server-side** (`packages/assistant/src/guards.ts`, `gate.ts`, `apps/api/src/services/inbox/ai-engine.ts`). The UI must keep showing what they did:
   - withdrawn lines struck through with their reason;
   - "AI left this one for the team" with "Correct the assistant" in view, never collapsed into a group (`collapsePills`);
   - shadow rows labelled "not sent";
   - the hand-over pill with who was told (SCRUM-823).
   - A person's reply or action holds the assistant until Resume.
   - Rules can never grant a price, discount, refund, date or booking.
   - Ask-first never fires on complaints, refunds, a request for a person, upset or unclear messages, a child in care, the birthday flow, greetings, thanks, bot questions or spam.
   - Owner rulings: the guard blocks commitments, not words; Tom's playbook outranks the WhatsApp history; the assistant's own chat is a popup on the launcher, not this page.
9. **Confirmations required** (pinned in `ui-round.test.ts`, `view.test.ts` and confirms): mark handled ("for everyone"), team move, a primary change that moves category (api 409 `CATEGORY_MOVE_UNCONFIRMED`), turning a number Live, Start over, and the Knowledge, Rule and Example approvals (with the no-personal-data tick).
10. **Book Date** (SCRUM-775, 814, 821, 826, 947, 955, 987):
    - Save stays disabled until the full agreed deposit is gateway-verified at the chosen park and every "reads two ways" choice is resolved; a typed field is never overwritten by a fetch;
    - the event id is minted once per opening (idempotent);
    - Create BEO opens the OTO App through a checked hand-off;
    - the dialog's test ids (`prebooking-deposit`, `book-date-reading`, `book-date-read`, `button-fetch-from-chat`, `book-date-fetched`, `book-date-waiting`, `data-choice`) are pinned in `apps/inbox/test/book-date-*.test.ts` and `prebooking-987.test.ts`.
11. **Reply**:
    - the reply window is never guessed in the UI; the server's 409 offers templates, the thread's language first with `follow_up` on top;
    - a template still in English is always marked "English text — not translated yet";
    - each draft carries one UUIDv7 message id, so a retry is never a second send;
    - Enter sends and Shift+Enter makes a new line;
    - the box grows from 1 to 5 lines;
    - dictation never sends.
    - Pinned in `composer-837.test.ts`, `dictation.test.ts`, `voice-transcript.test.ts` and `view.test.ts`.
12. **Test ids and markup the tests rely on** (`apps/inbox/test/*`, 34 files):
    - `data-testid`: `ready-to-book`, `deposit-paid-line`, `event-chip`, `event-chip-removed`, `prebooking-deposit`, `book-date-*`, `button-fetch-from-chat`, `open-question`, `voice-transcript`, `dictation-start`, `dictation-stop`, `dictation-line`, `impersonation-banner`, `created-line`, `name-set-line`, `profile-name-line`, `simulator-*`;
    - data attributes: `data-chip="<dim>:<value>"`, `data-view`, `data-next-action`, `data-deposit-signal`, `data-ai-state`, `data-ai-action`, `data-pill-group`, `data-shadow`, `data-withdrawn`, `data-attachment`, `data-phone-actions`, `data-choice`, `data-slot`, `data-state`, `data-teach-chat`;
    - accessible names: "Search", "Filters", "Clear <label>", "Move to team", "Set conversation status", "Conversation branch", "Set primary", "Set support", "Templates", "Reply", "Send", "Conversation details", "Back to the conversations", `role="menu"` "Settings";
    - labels and strings pinned by text: "Unanswered only", "Ready to book", "Show <category> only", "Click to clear filter", "Simulator · test only", and the next-action and deposit words.
    - **`dark-theme.test.ts` asserts exact Tailwind classes** (`dark:bg-slate-950/40`, `dark:bg-slate-900`, `dark:bg-emerald-950`, `dark:bg-amber-950`, `bg-white dark:bg-slate-800`, …), so a new palette will need those pins rewritten, not deleted.
    - The Console e2e tests (`apps/console/e2e/*`) do not drive the Inbox. There is no Inbox Playwright suite; the Inbox's tests render markup with Vitest.
13. **URL contract** (SCRUM-591, `lib/url.ts`, `test/url.test.ts`): `?c=`, `?tab=`, `?unanswered=1` (and the legacy `?tab=unanswered`), `?range=`, `?by=`, `?settings=templates|assistant`, `?section=numbers|knowledge|examples|rules|teach` (with the legacy `tab=` read under assistant). Back returns from a chat to the list; the phone's back arrow uses history.
14. **Theme**: light, dark or system, saved on the account (`PUT /me/preferences`), applied as the `dark` class on `<html>` (`lib/theme.ts`, `test/theme.test.ts`). The view-as banner offsets every full-height region by 2.25 rem (`index.css`).
15. **The prototype's design was ported on purpose.** `apps/inbox/src/index.css` says "Inter, slate inks, white cards… Tailwind's own palette carries the colour code… so there are no tokens of our own". The owner's request supersedes this for the redesign, but the colour code (violet = birthdays, sky = general, pink = marketing, amber = GM) is referenced in `docs/features/inbox.md`.
16. **Languages**: the Inbox UI is **English only**, with no i18n. Customers write in English, Russian and Thai (filters, templates, Rules questions in EN/TH/RU). Thai text needs a Thai face; the till ships 'Till Thai' and the Inbox does not.
17. **Live updates are polling only**:
    - every **30 s** while the tab is visible, the list (up to 100 rows), the dashboard and the open thread are re-read;
    - every **3 s** while the simulator pane, a test-line inbox or a test-line chat is open;
    - the search is debounced 250 ms;
    - the Book Date reading re-runs when the newest message changes;
    - there is no websocket or push, and a dialog survives a refresh without losing focus.
18. **Deployment**: a static Vite site (`apps/inbox`, port 25746). `/api` is proxied on the same origin, which keeps the session cookie. There is no router; it is one screen.

---

## 10. Pictures (`now/`)

All are full page unless named "first-window", which is the 1440 × 900 (or other) viewport only.

**GM (manager, owner view)**:

- `gm-{1440,1024,768,390}-list-{light,dark}.png`
- `gm-{1440,1024,768,390}-list-light-first-window.png`
- `gm-{1440,1024,768,390}-chat-open-{light,dark}.png` (a GM-queue chat)
- `gm-{1440,1024,768,390}-chat-open-light-first-window.png`
- `gm-{1440,1024}-rail-scrolled-to-end-{light,dark}.png`
- `gm-{768,390}-filters-dialog-{light,dark}.png`
- `gm-1440-settings-menu-open-light.png`, `gm-1440-settings-templates-light.png`
- `gm-1440-handled-{light,dark}.png`, `gm-390-handled-light.png`
- `gm-1440-details-dialog-light.png`, `gm-390-details-dialog-with-phone-actions-light.png`
- `gm-1440-templates-dialog-light.png`, `gm-1440-checkin-notice-thread-light.png`

**Birthdays agent (Anya)**:

- `birthdays-agent-{1440,390}-list-my-inbox-{light,dark}.png`
- `birthdays-agent-{1440,1024,768,390}-birthday-chat-open-{light,dark}.png`
- `birthdays-agent-1440-book-date-dialog-{light,dark}.png`, `birthdays-agent-390-book-date-dialog-light.png`
- `birthdays-agent-1440-correct-the-assistant-dialog-light.png`

**Marketing agent (Mila, the fewest rights)**:

- `marketing-agent-1440-list-light.png`, `marketing-agent-390-list-light.png`
- `marketing-agent-1440-chat-open-{light,dark}.png`, `marketing-agent-390-chat-open-light.png`

**OTO look references**:

- `oto-look-launcher-1440-{light,dark}.png`, `oto-look-launcher-390-light.png`, `oto-look-till-lock-screen-1440.png`

**Earlier pictures in the repository**, for the states staging did not show:

- `docs/qa/proof-2026-11-19/SCRUM-996/02-paid-ready-to-book-group.png`
- `docs/qa/proof-2026-11-19/SCRUM-996/03-paid-chat-line-and-received.png`
- `docs/qa/proof-2026-10-30/SCRUM-696-1-teach-reply-and-draft-card.png`, `SCRUM-696-2-rules-tab-draft.png`

## 11. What could not be seen, and what was touched

**Not seen live, described from the code instead**:

- **Teach, Rules, Knowledge, Examples and Numbers** (Settings → Assistant): no seeded demo account holds `inbox:kb:manage` or `inbox:ai:manage`, and the brief allows demo accounts only.
- **The Simulator side panel and dialog**: needs `inbox:channel:manage`.
- **Start over**: needs `channel:manage` at the test line.
- **The "Ready to book" group, deposit labels and the paid line**: no paid, unbooked deposit exists on staging today; the earlier proof pictures show them.
- **The wallboard**: does not exist.
- **The native select menus** (status, team, people): not captured, because headless browsers do not draw native menus. Their options are listed from the code.
- **Request deposit**: the GM would see it, but opening a GM birthday chat would have started a second model read and moved the GM's unread marker, so it was skipped.

**Chats opened: 4.**

| Viewer | Chat | Unread before | Effect |
|---|---|---|---|
| GM | a check-in notice thread | 0 | none |
| GM | a GM-queue customer chat | 1 | moved the GM's own unread marker and wrote that day's sampled read audit row (inherent to opening) |
| Anya | one birthday chat | 0 | **started one model reading of the chat for Book Date (SCRUM-821); the only model call** |
| Mila | one marketing chat | 0 | none |

**Opened and closed without saving**: the Book Date dialog (once, Cancel; it read the deposit draft with a GET), Correct the assistant (✕), Details (twice), Templates, Filters (twice), the Settings menu, and the Template settings page.

**Not pressed**: Save, Send, Request deposit, Check payment, Fetch from chat, Create BEO, Divert, any picker, Mark handled, and the theme toggle. Dark pictures were made by adding the `dark` class to `<html>` in the page, because the toggle saves the account's preference.

**Sign-ins**: 3 to the Inbox in the recon read, 3 more for the pictures, and 1 to the launcher. Each created an ordinary session row.
