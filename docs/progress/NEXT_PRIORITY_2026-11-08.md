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

---

## A. Drop-off and nanny flow

### A1. Care details: the family takes the photo

- **Owner's note.** In the care details section the customer takes the photo
  themselves with a button, instead of reception taking it.
- **Our reading.** The photo button sits on the customer display. Reception no
  longer takes the picture.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### A2. Care details: the two phone numbers

- **Owner's note.** The first number comes from the POS membership. The second
  number is shown but the family is specifically asked to confirm it is their
  WhatsApp or Telegram; add an API check if possible.
- **Our reading.** Number one is pre-filled from the member record. Number two
  is shown with a confirmation that it is a WhatsApp or Telegram number. If
  the messaging API can tell us the number is registered, we check and show
  the result.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### A3. No staff confirmation at the end

- **Owner's note.** It does not need a verification from staff. When the
  customer clicks Done after filling in the information with all checks, they
  proceed without receptionist confirmation.
- **Our reading.** Done on the customer display completes the registration by
  itself once every field and every confirmation is in. The till step that
  confirms it is removed.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### A4. Live sync of the forms

- **Owner's note.** Sync the child drop-off and nanny forms live on both the
  staff and the customer screen, in real time.
- **Our reading.** What is typed on either screen appears on the other at
  once, for both the drop-off and the nanny form.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### A5. Drop-off in the unified inbox

- **Owner's note.** Do we need drop-off in the unified inbox?
- **Our reading.** An open question. The likely use is messaging the guardian
  from the inbox while the child is in care.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### A6. Non-members check in right away

- **Owner's note.** An auto check-in right away option for non-members, just
  like members.
- **Our reading.** A walk-in family without membership gets the same check in
  now option that members have.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

## B. Tiers and ticket types

### B1. Registered members see only their own ticket type

- **Owner's note.** Already registered members do not need to see other
  ticket types. Show only the relevant one until the document expiry is
  reached.
- **Our reading.** A member with a verified tier sees only that tier's prices.
  The other tiers are hidden until the tier document expires, then the full
  list comes back.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### B2. Thai rate: a two-button verification, no documents

- **Owner's note.** For the Thai rate we do not need to show document options
  or an expiry date. Just a verification modal with two buttons, and record
  staff logs.
- **Our reading.** The Thai tier has no document type and no expiry. Staff see
  a small confirmation with two buttons. Who confirmed and when is recorded.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

## C. Customer display

### C1. The payment screen shows the full order

- **Owner's note.** The payment screen for the customer display needs to show
  the full order details rather than just the final number.
- **Our reading.** Every line with quantity and price, discounts, then the
  total.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

## D. Unified inbox

### D1. Book now does not read dates from Russian chats

- **Owner's note.** When we create a booking with the Book now button, it does
  not read the dates from the chat, for Russian especially.
- **Our reading.** Dates must be picked up from the thread in every language
  the inbox handles, Russian included.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### D2. Audio speech in the unified inbox

- **Owner's note.** An audio speech function in the unified inbox.
- **Our reading.** Open: voice notes from customers transcribed to text, staff
  dictating replies, or both.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### D3. Create and edit contacts from the inbox

- **Owner's note.** Should be able to create contacts and update or edit a
  contact name from the unified inbox.
- **Our reading.** New contact from a thread, and the contact's name editable
  from the inbox.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

## E. Kitchen, bar and wristband printing

### E1. Cancelled order or cancelled item in a birthday package

- **Owner's note.** When an order is cancelled, or an item is cancelled from a
  birthday package, a void receipt and an updated items receipt are sent to
  the kitchen and the bar.
- **Our reading.** Two prints at each destination: a void slip for what was
  cancelled, and a fresh slip with what remains.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### E2. Separate wristbands and printer for drop-off children

- **Owner's note.** Separate bracelets for drop-off kids and for everyone
  else. Two printers, with a specific printer for drop-off.
- **Our reading.** The till picks the printer from the child's service. No
  manual choice.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

### E3. Right print, right place, right person

- **Owner's note.** When a drink order is placed or updated it goes to the
  bar; food to the kitchen; kids get an update on the kids bracelet, adults on
  their own. Careful selection for each operation for the right person, type
  and category.
- **Our reading.** Routing by category (drink, food) and by person (child,
  adult) for every new or changed order and every band update.
- **Details from the owner.** _(to be given)_
- **How it works today.** _(to be checked)_
- **Ticket.** none yet

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
- **Ticket.** none yet

---

## Working order

Not set. The owner gives the details topic by topic; the order and the
grouping into tickets follow from that. Each topic is checked against the code
and staging before anything is filed, so the "How it works today" line is a
fact and not a guess.
