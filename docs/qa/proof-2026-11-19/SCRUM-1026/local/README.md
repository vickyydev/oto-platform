# Staff BEO print, rendered locally (SCRUM-1028)

Rendered on a development machine the way the app prints it (`generateBeoPdf`
in `apps/oto-app/server/pdf.ts`, headless Chrome 138), from the ZZ TEST
parties of `apps/oto-app/tests/fixtures/beo-staff-print.ts`. No staging, no
real party. These are the pictures after the review's repairs; the first
pictures of this print (a normal party on 2 pages, a long order on 4) are
replaced.

- `scrum-1028-staff-beo-normal-party-page1-of-1.png`: the brief's own party
  (11 kids' dishes, 3 adults', 3 drinks, 3 acts, the notes) on one page. The
  header with the facts in pairs and the package box; the one timeline, each
  step with its person and no dish or drink repeated on it; Kitchen on the
  left with the set menu's choices by name (no "(Pizza 1)" labels) and the
  adults' own list; Setup, Bar, Entertainment, Cake and Notes on the right,
  the allergies on the same page as the kitchen. The foot says "Page 1 of 1".
- `scrum-1028-staff-beo-long-order-page2-of-3.png`: a long order, page 2 of 3.
  The kids' dishes run on row by row on the left; on the right the Bar runs on
  from page 1 row by row (no part is held whole any more), then
  Entertainment, Cake and Notes. The foot names the party with "Page 2 of 3".
- `scrum-1028-staff-beo-kitchen-not-needed.png`: a party whose kitchen is set
  to Not Needed: "KITCHEN Not Needed", the words the page printed before; no
  dish and no Cake part (the cake printed only with the kitchen needed, as
  before), while the timeline keeps the cake moment as it always has.
