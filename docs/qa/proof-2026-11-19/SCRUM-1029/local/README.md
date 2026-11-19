# The BEO's new fields, rendered locally (SCRUM-1030, 1031, 1042, 1050)

Rendered on a development machine, 19 November 2026, from ZZ TEST parties
only. No staging, no real party, nothing saved.

- The Staff BEO pictures are the app's own print (`generateBeoPdf` in
  `apps/oto-app/server/pdf.ts`, headless Chrome), each PDF page drawn to a
  picture with pdf.js. The parties are those of
  `apps/oto-app/tests/fixtures/beo-staff-print.ts`, with the new fields set.
- The editor pictures are the real BEO editor (`beo-event-editor.tsx`) built
  for a browser with the app's own styles, in the 672-pixel sheet the events
  page opens it in, on the ZZ TEST party of
  `apps/oto-app/tests/fixtures/beo-four-sections.ts`; every server answer is
  a local stand-in. Pictured at 390, 768, 820, 1024, 1133, 1366 and 1920
  pixels wide; the ones kept are below.

Each picture was looked at before it was kept.

## The print

- `scrum-1030-1031-1042-1050-staff-beo-fields-party.png`: one page. In the
  header's facts, "Socks arrangement: Birthday Parent Pays" across the box,
  then the amber line "Expected extra (add to POS on arrival): +1 child ·
  +6 adults". The Kitchen opens with "Kitchen Notes:" and the notes as
  written, Thai beside English, before the Kids Menu. The set menu's choices
  carry their group again ("Margherita (Pizza 2)"); the package's waffles
  read "Adult Waffles (Sweets x2)"; "French fries x3", "Fruit skewers x2" and
  "Vegetable sticks x2" print with no "1x" in front. "ZZ TEST cupcakes" and
  "ZZ TEST cheese plate" (no price, no till code) and the bar's "ZZ TEST
  punch bowl" carry a small "*" beside EXTRA, and "* Price unresolved - not
  charged" prints once under the Kitchen and once under the Bar.
- `scrum-1031-staff-beo-socks-other-note.png`: "Other / Custom" with its note
  as written, over two lines across the facts box; "+2 children" only (no
  adults expected).
- `scrum-1050-staff-beo-older-party.png`: a party that stores none of the new
  fields prints no socks and no expected extra line; its kitchen note now
  opens the Kitchen; a dish typed by hand as "Mini waffles" keeps its name and
  carries the mark.
- `scrum-1050-staff-beo-long-order-page3-of-3.png`: a long order's last page:
  the words for the mark print once, under the last row of the Kitchen.

## The editor

- `scrum-1031-editor-extra-guests-socks-1024.png` and `-768.png`: Event Info,
  after the package and before POS: "Extra guests and socks", the expected
  extra children and adults side by side in a light amber box, then "Socks
  (payment)" with the choice and "How socks will be charged (not linked to
  POS)" beside it.
- `scrum-1031-editor-socks-other-390.png`: on a phone, "Other / Custom" with
  its note under the choice; nothing runs off the sheet.
- `scrum-1030-1042-editor-kitchen-notes-adult-waffles-820.png`: Food & Drinks,
  the food part: the No food tick, then "Kitchen Notes" with the notes as
  written, then the menus; the package's waffles line reads "Adult Waffles".

Seen while looking, not of this stage: on every width the POS box's line
item note (`input-item-notes-*`, an older row) is 56 pixels wider than its
row, so a long note would be cut at the sheet's edge; and on a phone the
Deposit tile's date runs past its tile.

## People on an activity and a time per dish or group (SCRUM-1032, SCRUM-1033)

Rendered the same way on 19 November 2026, from ZZ TEST parties only: the
print from `generateBeoPdf` with the fixture party of
`apps/oto-app/tests/fixtures/beo-staff-print.ts` given activities with people
and notes and dishes with times of their own; the editor in the 672-pixel
sheet with local stand-in answers. Pictured at 390, 768, 820, 1024, 1133,
1366 and 1920 pixels wide; at every width nothing ran past the sheet's edge
and the page raised no error. The ones kept are below; each was looked at.

- `scrum-1032-1033-staff-beo-activities-times.png`: the timeline names each
  activity's people ("ZZ TEST Bubble show · ZZ TEST Nok, ZZ TEST Ploy, 2 ×
  Animator", "ZZ TEST Treasure hunt · 1 × Host") and makes one short step at
  each dish's own time ("12:15 Kids' menu served", "12:45 Adults' menu
  served", "13:00 Kids' menu served Dessert", "13:30 Drinks Service Coffee &
  tea"). The Kitchen carries a small blue tag beside a dish served at its own
  time ("Dessert · 13:00" beside the Adult Waffles and the fruit skewers,
  "12:15" beside the juice, "12:45" beside the salad); a dish served with its
  menu carries none. The Bar's coffee carries "Coffee & tea · 13:30".
  Entertainment prints each activity's people in their own column and its note
  in grey under its name (one in Thai); an activity with no one prints an
  empty cell. Page 2 holds the Notes only.
- `scrum-1032-1033-staff-beo-older-party.png`: the party of before prints as
  it did: one person per activity, no note, no tag beside any dish.
- `scrum-1032-editor-activities-people-820.png` and `-390.png`: Entertainment
  & Program: each activity a light card with its name, one time box and a bin;
  its people as chips in one box (staff in green, a role in amber reading "2 ×
  Animator" with its own minus and plus); its note under them. On a phone the
  chips wrap and the search box takes its own line.
- `scrum-1032-editor-people-picker-1024.png`: the people box opened: the staff
  list, then the park group's roles ("Role (a number, names later)").
- `scrum-1033-editor-serving-times-820.png` and
  `scrum-1033-editor-bar-serving-1366.png`: Food & Drinks: every dish and drink
  row keeps one line, with a clock the size of its other buttons; the clock is
  tinted on a row with a time of its own, and "Served at 13:00 · Dessert" reads
  under the row, aligned with the row's note.
- `scrum-1033-editor-serving-panel-1024.png`: the clock opened: "Served at"
  with its time box ("Empty: served with the menu at 11:30."), an optional
  group with the list's groups to pick ("Dessert · 13:00"), then Clear, Cancel
  and Done.

Seen while looking, not of this stage: the menus' own service times and the
bar's still show the time chip with a gear and a clear button (one time box
each is part of SCRUM-1029); the Entertainment Host picker in the same section
shows "Unknown" in the preview because its stand-in staff list does not hold
the fixture's backup host.
