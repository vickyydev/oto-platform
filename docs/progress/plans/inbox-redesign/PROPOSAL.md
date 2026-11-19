# Unified Inbox redesign: the proposal (SCRUM-1016)

**State, 19 November 2026: proposed, not approved, nothing built.** The owner
asked on 19 November for a professional redesign of the whole Inbox page,
proposed first as a mock-up that is quick to change. Nothing in `apps/inbox`
changes before his approval.

- The mock-up (private page, eight screens): https://claude.ai/artifact/1eqCbTNo2T9pEEasFN75Rk
- The inventory it is drawn from: `INVENTORY.md` beside this file (everything
  the Inbox does today, its duplications, measurements, the OTO look's tokens
  and the rules a redesign must keep).
- Pictures of today's Inbox were taken on staging and are kept out of the
  repository.

The owner's two answers so far: staff will mostly use the Inbox on their
phones; the statistics stay, shown in a clean and aligned way.

## 1. What is wrong today, in numbers (from the inventory)

- The header and its statistics tiles take 433 of 900 pixels on a desktop.
  The reply box starts below the fold at every screen size, so every reply
  needs a scroll.
- A row is 143 to 169 pixels tall and carries up to six chips; one row fits
  fully in the first window.
- "Handled" is offered in three places, "Unanswered" in three, the parks
  twice, the topics three times. "General" means two different things.
- Ten accent colours on a grey ground, four different colours for main
  buttons, and none of them OTO's. The worst text is 2.1 to 1 against its
  background; 4.5 to 1 is the mark for readable.
- A manager's Team Inbox is mostly till check-in notices that cannot take a
  reply, with no way to hide them.

## 2. The design, phone first

1. **Inbox list.** One switch for Mine, Team and Handled. One slim row of
   four figures (Needs reply, New today, Avg reply, Handled today); the first
   is also the filter. Two quick filters (Needs reply, Unread) and one Filters
   button. "Ready to book" stays pinned on top, as the owner chose. A row is a
   name, the last message, and one label for what happens next, with topic and
   park as quiet text.
2. **Filters, one place.** Topic, Park, Channel, Language, and a switch to
   hide till notices. Each thing is offered once. The separate "named
   inboxes" list goes away, because it repeated these.
3. **A chat.** The reply box is fixed at the bottom and always on screen. The
   header holds the name, where the chat came from, Mark as handled and one
   menu. One line says what the assistant is doing, with Resume beside it.
4. **People and actions** (the three dots): who is primary and support, add
   support, divert, move team, park, the assistant's state, the details, and
   Mark as handled.
5. **A paid deposit.** The chat itself shows one card: "Deposit paid", when
   it was verified, and one main button, Book the date. Create BEO sits
   beside it.
6. **Book the date.** A full-screen form with large fields. Where the chat
   says two different things, the choice is asked plainly before booking.
7. **Dark theme.** The same layout on the till's navy ground.
8. **Desktop.** The same parts side by side: views with counts on the left,
   the list, the chat, and a panel about the customer and the next step. The
   four figures run along the top in one line.

## 3. The look

OTO's own: cream ground `#fbf5ef`, brown ink `#3b281c`, cards `#fefdfb`, the
logo's coral for the one action that matters, teal for the assistant. White
writing on the till's coral `#f15d27` is only 3.3 to 1, so filled buttons use
the deeper coral `#ca3500` (5.2 to 1). Topic colours stay as small dots, so
the existing colour code is kept without colouring whole chips. Inter, with a
Thai face added (the Inbox has none today). Every touch target is at least
44 pixels.

## 4. What the redesign keeps exactly

The list order by last activity; the "Ready to book" group; who may see the
deposit amount; the category and channel limits; no chat opening by itself;
every confirmation; the Book Date rules; the reply window rules; the address
bar contract; the 30 second refresh. See section 9 of the inventory.

## 5. What would need new work on the server

Shown in the mock-up, not available today: counts beside each topic in the
desktop side list; the switch that hides till notices; "waiting 7 minutes"
on a chat. Each is small. The mock-up works without them if the owner prefers.

## 6. Choices for the owner

1. **The labels on a row.** Shorter words are proposed: "Needs reply" for
   "Staff reply needed", "Assistant answered" for "AI sent · waiting for
   customer". Keep today's words, or take the shorter ones.
2. **Dark theme accent.** The till's dark theme uses blue; the mock-up keeps
   coral in the dark as well. Coral in both, or blue as on the till.
3. **The "General" inbox.** Today a separate "General" view holds questions
   while the assistant answers them. The mock-up folds it into the Topic
   filter. Fold it in, or keep it as its own view.
4. **Till notices.** Hide them by default with a switch to show them, or
   leave them in the list.
5. **Statistics.** Four figures in one row as drawn; or add the others
   (active, by topic, BEOs this week) behind a tap.
6. **Settings (templates, the assistant's Teach and Rules).** Not redrawn
   yet. Redesign them in the same pass, or after the main page is approved.

## 7. After approval

Build in steps, each proved on staging: the tokens and the page frame; the
list and filters; the chat and composer; people and actions; Book Date; the
desktop and tablet layouts; then the settings pages. One test file pins exact
colour classes and is rewritten for the new palette, not deleted.
