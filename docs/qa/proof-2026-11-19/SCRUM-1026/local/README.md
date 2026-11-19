# Staff BEO print, rendered locally (SCRUM-1028)

Rendered on a development machine the way the app prints it (`generateBeoPdf`
in `apps/oto-app/server/pdf.ts`, headless Chrome 138), from the ZZ TEST
parties of `apps/oto-app/tests/fixtures/beo-staff-print.ts`. No staging, no
real party.

- `scrum-1028-staff-beo-normal-party-page1.png`: a normal party, page 1 of 2.
  The header, the one timeline, Kitchen on the left (the kids' set menu with
  counts, the additional items, the adults' own list), Setup and Bar on the
  right. Entertainment, Cake and Notes run onto page 2 (each kept whole).
- `scrum-1028-staff-beo-long-order-page2-of-4.png`: a long order, page 2 of 4.
  The timeline ends on page 1; page 2 starts with Kitchen beside Setup, Bar,
  Entertainment and Cake, the kids' dishes running on row by row, and the foot
  naming the party with "Page 2 of 4". (The commit that added these pictures
  says the timeline's head repeats on this page; in this render it does not,
  because the timeline fits on page 1. A table that does run over a page
  repeats its head.)
