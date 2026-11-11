# Next priority: topics to explore and adjust, 8 November 2026

_Written 2026-11-08 from the owner's notes. These are the main topics to work
through together on the evening of 8 November, then fix or adjust. The owner
will give the details for each one. Nothing below is decided beyond the
owner's own words; the "Details" section of every topic is empty on purpose
and is filled only from what the owner says. No ticket is filed until a topic
has its details._

Epics these topics belong under once ticketed: SCRUM-181 (POS, booth and the
money path) for sections A, B, C, E and F; SCRUM-182 (apps on the platform)
for section D. The commit that first added this file carried a footer naming
a ticket key that does not exist; this note and its commit put that right.

How to read each topic:

- **Owner's note.** The request as given, lightly tidied.
- **Our reading.** What we understood, written as the rule the system would
  follow. To be confirmed or corrected by the owner.
- **Details from the owner.** Empty until given.
- **How it works today.** Empty until checked against the code and staging.
- **Ticket.** None until the details are in.

> **State on 12 November 2026.** The evening session of 8 November did not happen: the
> data restore came first (F1), then the BEO and inbox round. Topics D1, D2 and F1 were
> built since under their own tickets. Every other topic is still waiting for the
> owner's details and now has a tracking story on the board so it cannot be lost:
> SCRUM-857 (A, the drop-off and nanny flow), SCRUM-858 (B, tiers), SCRUM-859 (C1, the
> display's payment screen), SCRUM-860 (D3, contacts), SCRUM-861 (E, printing). Those
> stories carry the owner's words only; nothing in them is decided or built.

---

## A. Drop-off and nanny flow

### A1. Care details: the family takes the photo

- **Owner's note.** In the care details section the customer takes the photo
  themselves with a button, instead of reception taking it.
- **Our reading.** The photo button sits on the customer display. Reception no
  longer takes the picture.
- **Details from the owner.** _(to be given)_
- **How it works today.** PARTLY (read from the code, 12 Nov). On the till's own split screen the customer half already has the camera button. On a separate paired display there is no camera: it says "Reception will take the photo" and staff take it in the till's child-details dialog. Missing: a camera on the paired display and a way to carry the picture to the till.
- **Ticket.** SCRUM-857 (tracking story, filed 12 November; details still to be given).

### A2. Care details: the two phone numbers

- **Owner's note.** The first number comes from the POS membership. The second
  number is shown but the family is specifically asked to confirm it is their
  WhatsApp or Telegram; add an API check if possible.
- **Our reading.** Number one is pre-filled from the member record. Number two
  is shown with a confirmation that it is a WhatsApp or Telegram number. If
  the messaging API can tell us the number is registered, we check and show
  the result.
- **Details from the owner.** _(to be given)_
- **How it works today.** PARTLY. The form, the registration and the member each hold ONE number plus a channel choice (WhatsApp, LINE or Telegram), picked on the first screen. There is no second number, no "is this your WhatsApp or Telegram?" question, and no check that a number is reachable anywhere in the code. Today's confirmation is a logged message that staff tick by hand on the board.
- **Ticket.** SCRUM-857 (tracking story, filed 12 November; details still to be given).

### A3. No staff confirmation at the end

- **Owner's note.** It does not need a verification from staff. When the
  customer clicks Done after filling in the information with all checks, they
  proceed without receptionist confirmation.
- **Our reading.** Done on the customer display completes the registration by
  itself once every field and every confirmation is in. The till step that
  confirms it is removed.
- **Details from the owner.** _(to be given)_
- **How it works today.** NOT BUILT. The family's Done is enabled only after a photo exists for each child, and with a paired display staff take that photo. After Done the display says to wait for the team, and staff press "Continue to payment"; registration is written only on that press. After payment staff also choose "Check in now" or "Leave as booked".
- **Ticket.** SCRUM-857 (tracking story, filed 12 November; details still to be given).

### A4. Live sync of the forms

- **Owner's note.** Sync the child drop-off and nanny forms live on both the
  staff and the customer screen, in real time.
- **Our reading.** What is typed on either screen appears on the other at
  once, for both the drop-off and the nanny form.
- **Details from the owner.** _(to be given)_
- **How it works today.** PARTLY (SCRUM-764). The till's changes reach the display within about a second. The family's entries reach the till per step (on Continue or a tab change), not per keystroke. Not mirrored: the photo, the food and drinks choice, waivers, the nanny assignment, the contact channel, and a saved child's care notes. On the split screen both halves are one state and everything is instant.
- **Ticket.** SCRUM-857 (tracking story, filed 12 November; details still to be given).

### A5. Drop-off in the unified inbox

- **Owner's note.** Do we need drop-off in the unified inbox?
- **Our reading.** An open question. The likely use is messaging the guardian
  from the inbox while the child is in care.
- **Details from the owner.** _(to be given)_
- **How it works today.** PARTLY. The check-in notice is copied into the guardian's inbox thread as a read-only record; it is not delivered to any phone (SCRUM-776 waits for the Meta credentials). The assistant answers drop-off service questions and hands a child-in-care message silently to the park's desk. Nothing links a thread to the child's stay.
- **Ticket.** SCRUM-857 (tracking story, filed 12 November; details still to be given).

### A6. Non-members check in right away

- **Owner's note.** An auto check-in right away option for non-members, just
  like members.
- **Our reading.** A walk-in family without membership gets the same check in
  now option that members have.
- **Details from the owner.** _(to be given)_
- **How it works today.** NOT BUILT, and the premise needs the owner: members have no automatic check-in today. Members and walk-ins get the same choice after payment, "Check in now" or "Leave as booked", pressed by staff. An automatic check-in would be new for both.
- **Ticket.** SCRUM-857 (tracking story, filed 12 November; details still to be given).

## B. Tiers and ticket types

### B1. Registered members see only their own ticket type

- **Owner's note.** Already registered members do not need to see other
  ticket types. Show only the relevant one until the document expiry is
  reached.
- **Our reading.** A member with a verified tier sees only that tier's prices.
  The other tiers are hidden until the tier document expires, then the full
  list comes back.
- **Details from the owner.** _(to be given)_
- **How it works today.** NOT BUILT. Every sale shows a card for every tier; a verified member's rate is pre-selected with a "verified" badge but the other cards stay clickable. A passed document expiry does not end a rate today: it only shows a "re-verify" button. The Thai rate has no expiry at all.
- **Ticket.** SCRUM-858 (tracking story, filed 12 November; details still to be given).

### B2. Thai rate: a two-button verification, no documents

- **Owner's note.** For the Thai rate we do not need to show document options
  or an expiry date. Just a verification modal with two buttons, and record
  staff logs.
- **Our reading.** The Thai tier has no document type and no expiry. Staff see
  a small confirmation with two buttons. Who confirmed and when is recorded.
- **Details from the owner.** _(to be given)_
- **How it works today.** WORKS (SCRUM-772, Deployed): the Thai rate is one confirmation with two buttons, Cancel and Confirm Thai rate, no document list and no expiry; who confirmed, the park, the till and the time are recorded. Expat keeps its documents and expiry.
- **Ticket.** SCRUM-858 (tracking story, filed 12 November; details still to be given).

## C. Customer display

### C1. The payment screen shows the full order

- **Owner's note.** The payment screen for the customer display needs to show
  the full order details rather than just the final number.
- **Our reading.** Every line with quantity and price, discounts, then the
  total.
- **Details from the owner.** _(to be given)_
- **How it works today.** NOT BUILT. At payment the customer screen shows "Please pay", the total and the method (for QR: the code, the amount and a timer). The full list of lines with prices is shown one stage earlier, on the order stage. Same on the split screen, the paired display, F&B and the shop.
- **Ticket.** SCRUM-859 (tracking story, filed 12 November; details still to be given).

## D. Unified inbox

### D1. Book now does not read dates from Russian chats

- **Owner's note.** When we create a booking with the Book now button, it does
  not read the dates from the chat, for Russian especially.
- **Our reading.** Dates must be picked up from the thread in every language
  the inbox handles, Russian included.
- **Details from the owner (9-10 November).** Tom: the BEO loads only the "save the date" information from the messages and is not linked to the menu and packages; the agreed package or menu items in the chat should be fetched into the BEO from our menu. Owner: fetching dates and other details for the AI fill does not work well, Russian especially.
- **How it works today (verified 10 November).** Book Date pre-fills the date with the prototype's patterns, which never match a Russian or Thai date and only "21/nov" in English (BROKEN). The BEO AI Fill reads ONE message (the team's final confirmation), returns no event date, and knows no "today", so a year-less date lands on the wrong year (BROKEN); it matches nothing to the park's packages or menu (NOT BUILT). Russian text itself is read well by the model.
- **Tickets.** SCRUM-814 (the dates, building on lane/beodates814-20261110), SCRUM-815 (the whole conversation matched to the catalogue; two owner decisions inside).

### D2. Audio speech in the unified inbox

- **Owner's note.** An audio speech function in the unified inbox.
- **Our reading.** Open: voice notes from customers transcribed to text, staff
  dictating replies, or both.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** DONE without waiting for this file: SCRUM-824 (customer voice notes transcribed), SCRUM-834 (staff dictate a reply), SCRUM-835 (the simulator records a voice note) — all Deployed 11 November.

### D3. Create and edit contacts from the inbox

- **Owner's note.** Should be able to create contacts and update or edit a
  contact name from the unified inbox.
- **Our reading.** New contact from a thread, and the contact's name editable
  from the inbox.
- **Details from the owner.** _(to be given)_
- **How it works today.** NOT BUILT. A contact comes to exist only from an incoming message, a till notice or the simulator. Its name is the channel's profile name, filled once and never changed; no route or screen creates or renames a contact. The only contact action is erase.
- **Ticket.** SCRUM-860 (tracking story, filed 12 November; details still to be given).

## E. Kitchen, bar and wristband printing

### E1. Cancelled order or cancelled item in a birthday package

- **Owner's note.** When an order is cancelled, or an item is cancelled from a
  birthday package, a void receipt and an updated items receipt are sent to
  the kitchen and the bar.
- **Our reading.** Two prints at each destination: a void slip for what was
  cancelled, and a fresh slip with what remains.
- **Details from the owner.** _(to be given)_
- **How it works today.** NOT BUILT. Kitchen and bar tickets print once, when the sale closes. A refund or void prints nothing; there is no void slip. Party slips (SCRUM-805) print once at the slip time; nothing prints when the plan changes or an item is removed.
- **Ticket.** SCRUM-861 (tracking story, filed 12 November; details still to be given). Related: SCRUM-805 (kitchen and bar slips for the day's parties, Deployed).

### E2. Separate wristbands and printer for drop-off children

- **Owner's note.** Separate bracelets for drop-off kids and for everyone
  else. Two printers, with a specific printer for drop-off.
- **Our reading.** The till picks the printer from the child's service. No
  manual choice.
- **Details from the owner.** _(to be given)_
- **How it works today.** PARTLY. A station already has two band printers, but split kids and adults. A drop-off or nanny child's band is an ordinary kids band with a DROP-OFF or NANNY badge, printed on the kids printer. There is no printer role for drop-off.
- **Ticket.** SCRUM-861 (tracking story, filed 12 November; details still to be given). Related: SCRUM-805 (kitchen and bar slips for the day's parties, Deployed).

### E3. Right print, right place, right person

- **Owner's note.** When a drink order is placed or updated it goes to the
  bar; food to the kitchen; kids get an update on the kids bracelet, adults on
  their own. Careful selection for each operation for the right person, type
  and category.
- **Our reading.** Routing by category (drink, food) and by person (child,
  adult) for every new or changed order and every band update.
- **Details from the owner.** _(to be given)_
- **How it works today.** PARTLY. At the sale, food goes to the kitchen and drinks to the bar by each item's category, and one band prints per child and per adult. Nothing reprints when a visit changes (details edited, an extra hour, a nanny change), and an F&B order is never amended on paper: more items are a new sale with its own tickets.
- **Ticket.** SCRUM-861 (tracking story, filed 12 November; details still to be given). Related: SCRUM-805 (kitchen and bar slips for the day's parties, Deployed).

## F. Data

### F1. Feed the real data into the system

- **Owner's note.** Feed the real data to the system.
- **Our reading.** Load the park's real records. Which records, from which
  source, and into which environment are the owner's to say.
- **Details from the owner (2026-11-09).** First, before any other topic: a
  Navicat dump of the OTO App production database restored into staging's
  `otoapp` schema, so the HR app is tested on real data and made ready for
  production. Then the menus and prices from the owner's PDFs seeded for
  the POS. Plan and dry run: `plans/data-restore/PLAN.md`.
- **How it works today.** The restore procedure exists and passed a dry run
  on the 19 September dump (2026-11-09). Staging still holds demo rows.
- **Ticket.** DONE: SCRUM-791 (the OTO App's production data restored into staging, Testing) and SCRUM-792 (the park's real menus, prices and shop items seeded, Deployed).

---

## Working order

Not set. The owner gives the details topic by topic; the order and the
grouping into tickets follow from that. Each topic is checked against the code
and staging before anything is filed, so the "How it works today" line is a
fact and not a guess.
