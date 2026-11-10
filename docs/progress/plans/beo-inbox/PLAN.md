# The inbox and the BEO: the next round — plan for approval

_Written 10 November 2026 from Tom's eight points and the owner's direction on
the party's money (one place, integrated and synced, nothing removed). Status:
PROPOSED — nothing is built from this until the owner approves. The "today"
lines were read from the code and from staging on 10 November._

## 0. The party's money in one place (SCRUM-822, held)

- **Today.** The till settles the party as one real sale (SCRUM-804: package at
  the day's price, extras, add-ons, free socks off stock, the deposit shown as
  paid in advance, the balance taken, receipt and bands printed, the sale id
  written back to the BEO). The OTO App's billing module (invoice rows,
  "Generate from BEO", Deposit Paid) is not mounted anywhere in the editor and
  its rows feed the Party Details box, which therefore reads "Total 0฿ /
  Outstanding −deposit" under a package worth ฿24,900 (SCRUM-808 fixed the
  package module's own total).
- **Owner's direction.** One place for money and records; do not remove the
  app's billing — integrate and mount it so the two sides talk over the API.
- **Proposal.** The platform's payments are the one ledger. The BEO gains a
  Billing section fed over the API: before the party, expected total (the
  package reading of SCRUM-808 plus entertainment), deposit paid and
  outstanding, from the plan and the payments record; after settlement, the
  sale's lines, payments and receipt number, read live; "Generate from BEO"
  becomes "Refresh from the till". The deposit QR (section 3) writes into the
  same ledger. Nothing typed twice, nothing deleted.
- **Open point.** A quote PDF before the party, from the expected figures: yes
  or no.

## 1. Qualification questions go to a person, who is notified

- **Today.** In Birthdays & Events the assistant answers the opener itself (the
  date-and-park question, owner's rule of 28 October), hands the thread to the
  Birthdays team queue once the basics are in or when the playbook says so; a
  hand-over is a queue entry plus an audit row. No person is notified on a
  phone or in the app.
- **Tom.** Any qualification question (advice on the branch and the like) goes
  to human staff and they are notified.
- **Proposal.** In Birthdays & Events a question asking for advice or a choice
  (which park, what is better, can we…, anything beyond the brochure) is an
  immediate hand-over with the warm holding line, plus a notification to the
  Birthdays team: the OTO App's notifications and a WhatsApp or Telegram ping to
  the on-duty birthday manager (per park, configurable), with a 15-minute
  escalation to the GM when nobody picks it up.
- **Open point.** Does the assistant still ask the date-and-park opener, or
  stop at the greeting and hand everything over?

## 2. Voice input in the inbox

- **Today.** Customer voice notes are stored as audio; the message row has a
  `transcript` column that nothing fills. Staff have no dictation.
- **Proposal.** (a) Inbound voice notes transcribed on arrival in Thai, Russian
  and English, shown under the note and read by the assistant, Book Date and
  the BEO fill like text; (b) a microphone on the reply box for staff dictation
  in the three languages.
- **Open point.** Order: (a) first, since it feeds everything else.

## 3. A deposit QR from the inbox

- **Today.** The deposit is typed by hand in the BEO. Online payment exists on
  the booking site only (2C2P hosted checkout, card and PromptPay QR, webhook,
  a simulator on staging).
- **Proposal.** "Request deposit" on a booked party's conversation: the amount
  pre-filled from the package (or typed), a hosted 2C2P QR / payment link sent
  into the chat, the webhook marks it paid, the deposit lands in the payments
  ledger, the BEO's Billing section and the till's "paid in advance" at once,
  and the chat shows "Deposit ฿3,000 received".
- **Open point.** Staging runs the 2C2P sandbox; production needs the merchant
  credentials and the owner's go.

## 4. Refresh in Book Date

- **Today.** The dialog reads the chat once, when it opens.
- **Proposal.** "Read the chat again": re-runs the reading (with SCRUM-821 the
  AI proposal) and fills only the fields the person has not edited.

## 5. The BEO pre-filled with everything, staff adjust

- **Today.** Create BEO fills the package, the set menu and its choices, the
  entertainment, the add-ons, the counts, the times and the deposit from the
  whole chat, in edit mode (SCRUM-815, 818); the remaining fields (title,
  requests, decoration, timeline, team) open in a second, older preview after
  Approve.
- **Proposal.** One pass: the editor opens fully pre-filled, every field and
  template, each value marked with its source and a "from the chat" chip, one
  Save; the empty-box wording tidied.

## 6. Refresh in the BEO

- **Today.** The fill runs once at Create BEO (and on a paste).
- **Proposal.** "Re-read the conversation" in the editor: the changes since the
  last fill listed (adults 4 → 6, cake time 15:30 → 16:00), each accepted or
  declined; edits are never overwritten silently.

## 7. A new menu item from the BEO, BEO-only on the POS

- **Today.** An item the catalogue lacks stays a free "not in the menu" line;
  the app cannot create till products; products carry `active` only, no
  visibility flag.
- **Proposal.** "Add to menu" on such a line creates a product on the platform
  through a new api door (the credential pattern of presence and lifecycle) in
  a "Party menu" category with `channels: beo_only` and a chosen kitchen or bar
  station; the till's F&B and Shop grids never show it, the party settlement and
  the slips do; the set-menu line receives its code.
- **Open points.** Who may create items (managers only?); whether a price is
  required before the party can be settled.

## 8. The kids' menu as the main selection; the adults' menu mirrors it

- **Today.** Kids' and adults' menus are two independent lists in the kitchen
  plan; the fill extracts both.
- **Proposal.** The adults' section reads "same as the kids' menu" (a copy) with
  a "different for adults" toggle for exceptions; the fill stops splitting them
  unless the chat says so; the kitchen slip prints one food list.
- **Open point.** Portions for adults on the slip, counted separately or not.

## Suggested order

5 and 8 (demo-visible, small) → 4 and 6 (refresh buttons) → 0 and 3 (the
Billing section over the API and the deposit QR) → 7 (BEO-only items) → 1
(hand-over and notifications) → 2 (voice). Each lands through the release slot
with a ZZ TEST staging proof inside its Jira comment.

## 9. The first message decides the queue (owner's screenshot, 10 November)

- **Today.** A new conversation is routed inside the transaction that creates
  it, before any AI runs: the category is the simulator's hint or the channel
  account's default category (the Demo Instagram account defaults to general,
  so "Hello I want to book a Birthday Party" went to Reception · Central
  Floresta). The assistant's turn, seconds later, labelled birthday_party and
  re-routed the untouched thread to Birthdays & Events (the pill's "1 more").
  A thread the AI does not answer is never corrected.
- **Proposal.** Classify from the first message at ingest, before routing: a
  deterministic reader over the text in Thai, English and Russian (birthday
  words, party, package, cake; camps and school groups to Birthdays & Events;
  refunds and complaints to GM; otherwise the channel default), the pill saying
  "from the message". The assistant stays the second opinion. Before shipping,
  run the reader over the first messages of the 249 exported real chats and
  compare with the queue each belonged to; fix the misses it shows.

## Decisions so far (10 November 2026, from the owner's review page)

Review page (screens and decision boxes): https://claude.ai/artifact/MRK5VbmoMKsjaV3UQbTCKS

| Item | Ticket | State |
|---|---|---|
| 0 Money in one place | SCRUM-822 | APPROVED 10 Nov 22:30: integrate and mount the till's billing into the BEO over the API, remove nothing; a quote PDF before the party too — BUILT, reviewed and fixed on lane/money822-20261110 (fixes SCRUM-833 with it); land-prep running 11 Nov 01:20; four decisions on the ticket |
| 1 Advice questions to a person, notified | SCRUM-823 | APPROVED; the date-and-park opener stays — LANDED a80ca2630, proved for the rule (Testing); the opener-on-model-handover gap building on lane/opener823b-20261110; the bell half waits on the owner's key script |
| 2 Voice | SCRUM-824 | APPROVED; part (a) LANDED 405230df0, proved with the provider off (Testing); the speech provider, its key and PDPA are the owner's choice; part (b) later |
| 3 Deposit QR and set-menu link | SCRUM-825 | updated proposal: driven from the BEO, posted by the assistant; the owner says approved in chat (10 Nov 22:40), the page shows no decision — confirming |
| 4 (and 6) Fetch from chat | SCRUM-826 | updated proposal: one refresh button in Book Date and the BEO, warning, accept-or-decline; the owner says approved in chat (10 Nov 22:40), the page shows no decision — confirming |
| 5 BEO pre-filled in one pass | SCRUM-827 | the owner says approved in chat (10 Nov 22:40), the page shows no decision — confirming |
| 7 BEO-only menu items | SCRUM-828 | APPROVED — LANDED a3d87300a, proved, DEPLOYED |
| 8 Adults start from the kids' choice | SCRUM-829 | updated proposal (layout); the owner says approved in chat (10 Nov 22:40), the page shows no decision — confirming |
| 9 First message decides the queue | SCRUM-830 | the owner says approved in chat (10 Nov 22:40), the page shows no decision — confirming |
| 10 Never ask twice | SCRUM-831 | APPROVED — LANDED cd9e42bf1, proved, the "table for 8?" reader fix landed in 9b2bd8bc1 and re-checked; DEPLOYED 11 Nov 00:20 |
| 11 One message per turn, park first | SCRUM-832 | APPROVED 10 Nov 22:35 — LANDED ba3f25bb4 + the bare-park-question fix 4af68aafc, proved and re-checked 11 Nov; DEPLOYED 11 Nov 01:38; four decisions on the ticket |
