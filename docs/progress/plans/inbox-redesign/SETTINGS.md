# Inbox settings pages: the design note (SCRUM-1044)

State, 19 November 2026: the frame, the shared parts and Templates are built
on lane/inbox1043-20261119. Numbers, Knowledge, Examples, Rules and Teach are
the second half and follow this note. Layout and look only: no request body,
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
line as today; its own explanation moves into a note or a section's help,
its New button into the header.

- **Numbers:** the "Live means customers hear it" note in mint; Off, Shadow
  and Live explained once; a row per number with its three-way switch at
  its end (under the name on a phone); the Live confirmation kept.
- **Knowledge:** "Show archived" and the count under the header; a
  SectionCard per topic; a row per entry (question, answer as preview, one
  status badge); Edit, Approve and Archive with their confirmations.
- **Examples:** the To review, Approved and Rejected switch under the
  header; a row per example; Review keeps the no-personal-data tick;
  Withdraw keeps its confirmation.
- **Rules:** Drafts, Approved and Archived as a switch; New rule in the
  header; a row per rule (kind of message, instruction, ask-first in mint);
  the editor keeps every refusal and the "never asks first" line.
- **Teach:** a chat like the Inbox's: the thread fills the page area, the
  message box fixed at its foot, cards keeping their words and actions.

**What stays exactly:** every control, state, message, confirmation and
test id in sections 2.3 and 9 of `INVENTORY.md`; the R8 guarantee; every
request in the same order with the same defaults; English only.
