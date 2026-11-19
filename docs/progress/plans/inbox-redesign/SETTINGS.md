# Inbox settings pages: the design note (SCRUM-1044)

State, 19 November 2026: all six pages are built on lane/inbox1043-20261119:
the frame, the shared parts and Templates first, then Numbers, Knowledge,
Examples, Rules and Teach, which follow the section "The assistant pages" as
corrected below. Layout and look only: no request body,
field order, default, permission or word sent to the server or the model
changes.

## What each page is for, and who may open it

- **Templates** (`capabilities.templates`): the standard lines the composer
  offers, per language, channel and park.
- **Numbers** (`ai`): each number's assistant mode, Off, Shadow or Live.
- **Knowledge** (`kb`): the facts the assistant speaks from.
- **Examples** (`kb` with operator reach): staff corrections to review,
  approve with the no-personal-data tick, or withdraw.
- **Rules** (`kb`): an instruction per kind of message, with an optional
  "ask first" question; the server refuses what a rule may not do.
- **Teach** (`kb`): a chat with the curator, which drafts facts and rules
  and never talks to a customer. `settingsNav` (SettingsFrame) builds the
  list from today's rules.

## One frame

Settings open as their own view inside the Inbox shell. The app bar stays;
the conversations stay mounted underneath, hidden, as before.

- **768 px and up:** a 224 px column on the left (the views column's width
  and look) holds "Back to inbox", the title "Settings" and the pages:
  Templates, then an "Assistant" group. The chosen page has the band ground,
  bold words and `aria-current="page"`. The page fills the rest in a centred
  column of at most 768 px, never stretched across a wide screen.
- **Below 768 px:** a back arrow and "Settings" under the app bar, then the
  pages as one band of segments that scrolls sideways; the chosen one is
  scrolled into view and an end with more to show fades out. No band when
  the viewer has one page. The page is one column.
- **The address:** unchanged, `?settings=templates` or
  `?settings=assistant&section=…`, the old `tab=` still read. Another page
  is a new history entry, as the account menu's was; another assistant
  section replaces the entry, as its tabs did.
- **Density:** the page area is the settings pane (`data-pane="settings"`)
  and follows its own width; the column is `settings-nav`.
- **Teach stays mounted** while any other settings page shows, so a look at
  Templates or Rules keeps the conversation with the curator.

## Shared parts (`components/settings-parts.tsx`)

- **PageHeader:** an optional eyebrow ("Assistant"), the title, one line of
  help, the page's main action on the right of the title.
- **SectionCard:** a small title above a card, a count at its right, an
  optional line of help; the card holds rows or a form.
- **SettingsRow:** the conversation row's rhythm: the main text, a preview
  clamped to two lines, then at most one badge in one flow with quiet meta.
  Its actions sit at its end from 768 px and behind a three-dot menu on a
  phone, from one list so the two never drift apart.
- **MetaLine:** the meta's parts joined by a dot, each kept whole, so a
  narrow row wraps between parts and never strands one word.
- **RowMenu:** a 44 px button; arrow keys, Escape, a press outside, focus
  back to the button; it opens upward when there is no room below.
- **Field:** the label over the control, help under it, an error line in
  the refusal's red, both tied to the control for a screen reader.
- **ActionBar:** a form's Cancel and Save, sticky at the foot of the page
  area; on a phone the main button takes the bar's width.
- **EmptyNote, LoadingNote, InlineNote, InlineError:** an empty state on a
  dashed frame; a three-row skeleton with its words for a screen reader; a
  note in money's green or the assistant's mint; an error in the refusal's
  red or the polite amber of "not on your access". Every control carries
  `hit` and a scale size; every text pair is tested (settings-1044).
- **ControlRow, ViewSwitch, FormRefusal** (the second half): a setting's
  row with its control at the end; a list's switch of pressed segments; a
  form's refusal at its top. The assistant pages' own header, status badge,
  counts and sentence-case kinds of message are in `assistant-parts.tsx`;
  their new text pairs are tested in assistant-pages-1044.

## Templates

- Header: "Templates", the help line word for word, "New template" as the
  main button. Under it the count and "Show archived".
- One SectionCard per key in the shared order, in sentence case ("Handover
  birthday", "Closing GM"), with the count of its variants.
- A row per variant: the language as the main text, the words as the
  preview, one badge (Archived, else Awaiting approval, Approved or
  Rejected), the rest as quiet meta (channel, park, "No approval needed",
  "Inactive", "English source, to translate" in amber words).
- Edit and Archive at the row's end, or in its menu on a phone; none on an
  archived row, as today. The birthday brochure stays on its rows.
- New and Edit open the house Dialog: a full-height sheet with a fixed
  footer on a phone, a centred card from 768 px. The words come first after
  the key, the values helper under them; then language, channel, park,
  approval, the provider name and the two switches. One-line boxes and
  selects share one height. There is no preview today, so none is added.
- Archive keeps "Archive this template?".
- States: the skeleton while reading, "No templates yet." on a dashed card,
  the server's refusal in red, the spinner in Save, and a green "Template
  saved." or "Template archived." note for four seconds.

Edit opens a Dialog, not an in-place form: nine fields read better in a
sheet with its own fixed Save than in a row growing inside a long list.

## The assistant pages (the second half)

Each starts with PageHeader: eyebrow "Assistant", its name, the assistant's
line as today, and its main action (New entry, New rule) on the right. Its
own explanation, word for word, is a mint note under the header, read in
place and never announced.

- **Numbers:** the "Live means customers hear it" note; a section
  "Channel numbers" with a row per number (its name, channel and park) and
  Off, Shadow and Live at its end, under the name on a phone. The three
  modes are explained once, in a section under the numbers ("What each mode
  does"), not again on every row; a row says "Saving…" while its change
  is sent. The Live confirmation is kept.
- **Knowledge:** the count and "Show archived" in the bar under the note;
  a section per topic; a row per entry: the question, the answer with its
  line breaks (four lines), one status badge, the language, park and key as
  meta, "English source, to translate" in amber words. Edit, Approve and
  Archive with their confirmations; none for an entry the person may not
  manage or one archived. The editor asks for the question and the answer
  first, then topic, key, language and park.
- **Examples:** To review, Approved and Rejected as one switch with the
  count beside it; a row per example: the kind of message as its title, the
  customer's words, the good reply in mint, the verdict as its badge, the
  language and who proposed it. Review keeps the no-personal-data tick;
  Withdraw keeps its confirmation.
- **Rules:** Drafts, Approved and Archived as a switch with the count; a row
  per rule: the kind of message, the whole instruction, "Ask first" with its
  condition above the question in mint, the words it was taught from, its
  status and park. The editor keeps every refusal; the "never asks first"
  line under the picker is an amber note.
- **Teach:** laid out as the Inbox lays out a chat. The page area gives it
  its whole height; the briefing opens the thread (in the middle of the page
  until the first line, with the example); the person's lines on the right
  in the staff colour, the curator's on the left in mint under "Assistant";
  drafts and dry runs as cards in the thread with their Approve and Open in
  actions. The message box sits in a bar held at the foot of the page area
  on every width, grows with its words as the reply box does, and keeps its
  words, its Enter and Shift+Enter, and its line about them.

Shared rules the second half added:

- **Actions under the words on a narrow page area.** From 768 px a row's
  buttons sit at its end while the page area is at least 768 px wide; below
  that (a tablet held upright, 544 to 596 px) they sit under the row's
  words, so three buttons never squeeze the words into a column. Templates
  follows the same rule. A phone keeps the three-dot menu.
- **A refusal at the top of the form.** The server's refusal of a save shows
  at the top of the editor, word for word, and is brought into view.
- **Kinds of message in sentence case** on these pages ("Lost item",
  "FAQ", "Any message"); the value sent is the intent, as before.
- **Switches** take the page's width on a phone and stop at 28 rem from
  640 px.

**What stays exactly:** every control, state, message, confirmation and
test id in sections 2.3 and 9 of `INVENTORY.md`; the R8 guarantee; every
request in the same order with the same defaults; English only.
