# The BEO editor's times and Food & Drinks lines, in a local build (SCRUM-1029)

20 November 2026, lane `lane/beo1029b-20261120`. Not staging: nothing of this
stage is deployed. The editor was built for a browser from the lane's own
source (esbuild and the app's Tailwind CSS), inside the Events page's sheet,
and opened in Chromium on the ZZ TEST party of the four sections check
(`apps/oto-app/tests/fixtures/beo-four-sections.ts`). Every answer the editor
asked for was local: no server, no database, no real party. The party's kids'
fries carry the note "ZZ TEST no chilli" and the serving time 13:00 in the
group "ZZ Dessert" for these pictures.

The editor opens as a sheet 672 px wide from 640 px up, so at 768, 820, 1024,
1133, 1366 and 1440 px every section is drawn the same; each width was
pictured, looked at and measured (nothing wider than the sheet, nothing cut
off, no sideways scroll). One width of each is kept here. The touch pictures
are a touch screen's sizes (pointer: coarse).

- `editor-768-event-info.png`: Start Time and End Time, one time box each;
  Kid Turning Age shown and typed as the fields around it.
- `editor-1440-food-drinks-folded.png`: Food & Drinks as the BEO opens it:
  Setup / Table, the kitchen's own fields (No food for this party, the
  slips' time, Kitchen Notes), Kids Menu, Adults Menu, the kitchen's extras
  as the till charges them, the cake, Bar. Each line says what it holds and
  counts it ("2 tasks", "2 dishes", "1 dish", "2 items").
- `editor-1024-food-drinks-open.png`: every line opened: the ready-by, the
  service times and the cake time in their boxes; the fries' note and its
  serving time under the dish's name; the names of a list in one column; no
  "Mark ... Done" anywhere.
- `editor-1024-food-drinks-open-touch.png`: the same on a touch screen: the
  rows' buttons at a finger's size.
- `editor-1024-adults-same-as-kids.png`: a party whose adults eat the kids'
  menu: the Adults Menu line says "Same as the kids' menu · Service 12:00",
  opened to that statement and the kids' dishes, read only.
- `editor-1024-no-food.png`: "No food for this party" ticked: the menus and
  the cake folded away with the sentence that they are kept.
- `editor-1024-one-task.png`: one setup task: "1 task".
- `editor-1024-stored-times.png`: times stored before the boxes in another
  form: "9:30" shows 09:30, and a bar time stored as words ("ZZ TEST
  after lunch") is said beside its empty box and kept until a time is
  typed.
