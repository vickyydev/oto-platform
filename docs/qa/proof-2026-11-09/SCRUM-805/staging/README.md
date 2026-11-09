# SCRUM-805 staging proof: a party's kitchen and bar slips at its slip time, with a reprint

Run just after midnight on Tuesday 10 November 2026 (Bangkok), on staging at main 9f92a316. This uses the same ZZ TEST till and
the same first party as the SCRUM-804 proof next door. The branch's business day starts at 05:00, so until then the job and the
till treat Monday 9 November as today. Both ZZ TEST parties are dated 9 November.

## What was done, in order

1. **Before any station was named.** The party page's "Kitchen & bar slips" block showed slip time 11:00, with both slips "Not
   printed yet" (**805-st-01**).
2. **The job with no printer.** The party's slip time was moved to 00:06 in the OTO App (PATCH of the package snapshot, the route
   the package module uses). At 00:06:04 the job made run 1 (trigger "schedule") and recorded both slips as no printer. The page
   read "No printer named for this park" for the kitchen and the bar (**805-st-02**).
   - The Console Health page lists job:parties.slips as ok, every minute (**805-st-03**).
   - The run's detail (noPrinter 2) is not shown anywhere: the Health page and its route carry only the last outcome. The no
     printer run is shown by the party's slip records instead.
3. **The till gets a kitchen printer and is named.**
   - The ZZ TEST till was given Virtual box 1's simulated Kitchen Printer as its kitchen printer. Virtual box 1 has no bar printer,
     so none was assigned.
   - In the Console, Branches › Central Floresta › Edit, "Party slips printer station" was set to ZZ TEST SCRUM-804 till, under
     its sentence "The park tags this later…" (**805-st-04**, **805-st-05**). After Save, GET /branches shows partySlipsStationId
     as the ZZ TEST till.
4. **First press of "Print party slips now"** (run 2). The kitchen slip read "Printed 00:08", and the bar slip read "No bar printer
   at ZZ TEST SCRUM-804 till" (**805-st-06**). One kitchen_ticket job printed on the Kitchen Printer.
   - Its printout (**805-st-07**) reads: KITCHEN, BIRTHDAY PARTY, ZZ TEST 804 party, 00:08, Children: 10, READY BY 13:40. Then the
     menu by name: Margherita, Chicken schnitzel, French fries, Waffles, Veggie, Veggie sticks, Fruit skewers, Juice.
   - The Console print record shows the job (**805-st-09**).
5. **A second party printed by the job alone.**
   - "ZZ TEST 805 timed party" was made for the same day with the Floresta package (6 children, 2 adults) and a slip time of
     00:11. At 00:11:04 the job printed its kitchen slip with no press. The page reads "Printed 00:11" (**805-st-11**,
     **805-st-12**), and the printout is **805-st-13**.
   - The bar slip reads "Nothing to print", because this party has no bar plan.
   - The job ran again at 00:12:04 and 00:13:04 and did not print it again: run 1 is the only run.
6. **Second press on the first party** (run 3). This made a new kitchen job whose reprint_of points at run 2's kitchen job. Run 1
   had queued no job, so run 2 has no reprint_of. The block shows the newest run, "Printed 00:09" (**805-st-08**), and the printout
   is **805-st-10**.

## What did not match the brief

- **No "Party starts" line on the slip.** Commit 07ea77fe8 dropped it on purpose.
- **No "Room" line.** The ZZ TEST party has no room, and the slip prints one only when it has a room.
- **No quantities, so no "3x Margherita".** The staging set menu names no portions, so the slip lists dishes without a count.
- **Old runs are worded against today's station.** After the station was named, the old no printer run 1 read "No kitchen printer
  at ZZ TEST SCRUM-804 till" for a moment. The block words an old run against the station named now, not the one named at the time.

## Clean-up, read back

- **The branch:** Central Floresta's party slips station was set back to none (PATCH /branches, read back null).
- **The till:** its printers were unassigned, it was signed out (/me 401) and archived.
- **The parties:** both ZZ TEST parties were deleted in the OTO App and read back 404 (event, package snapshot and the till's
  party read).
- **Sessions:** all sessions were signed out (401).

The runs, jobs and ids are in receipt.json.
