# SCRUM-789 staging proof: general questions stay out of the park inboxes

Run on 11 November 2026, 19:03 to 19:09 Bangkok, on staging at `33e54e3f` (api `dep-dbq5g4v13mps73f3u76g`,
inbox `dep-dbq5g53l550s739kn0e0`, both live; first line sent 110 s after the api went live). Owner view, through
the inbox's own simulator into "Demo WhatsApp · Central Floresta". Every thread is a ZZ TEST contact
("ZZ TEST 789") on its own simulator number, no category hint. Full record: `receipt.json`.

Precondition: the assistant on that number is `live`; every line came back with no closed-hours reply and got an
assistant turn (inside opening hours). The number's stored hours could not be read directly.

| Step | Result | What was seen |
|---|---|---|
| 1. "how much is a ticket for one child?" | Pass | Asked visitor or resident, then gave Central Floresta's prices (690 baht a child for an hour). Pill "Kept in General · no park inbox". Listed under All conversations and General; not under Central Floresta, Robinson Chalong or the other park views (the UI's request and the same query through the API agree). |
| 2. "do you have drop-off for a six year old?" | Pass | Answered (225 baht a visit). Pills "Moved from General → Reception · Central Floresta by AI · needs the local team", "Routed to Reception · Central Floresta", "Assigned Reception · Central Floresta as primary". Listed under Central Floresta and All; not under General. |
| 3. thread 1: "I think I left my bag there yesterday" | Pass | Left General, listed under Central Floresta with the same moved pill. The assistant stayed silent by policy and handed over (no message to the customer). |
| 4. a third price question, opened as the owner | Pass | The badge reads "General"; the move picker offers Reception · Central Floresta. Nothing was moved. |
| 5. control: a birthday line | Pass | Routed to Birthdays & Events from the message, as before. |

Pictures:

- `789-1-general-view.png`: the General view with the two price threads
- `789-1-all-conversations.png`: All conversations with all three threads
- `789-1-robinson-chalong-view.png`: Robinson Chalong, none of them
- `789-2-central-floresta-view-dropoff.png`: Central Floresta with the drop-off thread only (no price thread), its moved pill
- `789-3-central-floresta-view-lost-bag.png`: Central Floresta now also lists thread 1 (lost bag)
- `789-3-general-view-after-bag.png`: General now holds one thread
- `789-3-lost-bag-moved-pill.png`: thread 1's pills after the lost-bag line
- `789-4-held-thread-move-picker-badge.png`: a held thread, the badge reads General
- `789-4-held-thread-move-picker.png`: the same with the picker's options drawn as an open list (a copy made for
  the picture; a headless browser cannot draw a native drop-down)

Other people's rows, names, initials and numbers are masked.

Notes: the birthday control thread also shows under the Central Floresta view, as a park's birthday
conversations did before. Clean-up: all four threads marked handled, sessions signed out, driver stopped.
