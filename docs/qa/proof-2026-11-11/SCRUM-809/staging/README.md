# SCRUM-809: Console screen proof

Passed on 11 November 2026 on source
`acb096f723131ffbc3b9b2b461193242f70a79ce`. API, Console and both till
services were live at this exact SHA before and after the proof; their
deploy IDs are in `receipt.json`. Main CI 42965931065 was running. The full
green candidate gate 42922557530 has identical runtime, tests and workflow.
Deployed waits for the landed-SHA main gate.

In the real Edge browser, signed in through Console:

1. Created and archived an isolated ZZ TEST till on Virtual box 1.
2. In Devices > Stations > New station, submitted that prefix for a second
   ZZ TEST till. HTTP 409 returned `STATION_CODE_PREFIX_TAKEN`. The visible
   refusal named the earlier till and explained that archiving does not free
   its receipt numbers. A readback confirmed no replacement had been saved.
3. Changed only the prefix in the same form. HTTP 200 saved the replacement,
   and its new prefix appeared on the station card.
4. Archived both exact test records, read back both archives, signed out and
   verified `/me` returned 401. No payment was taken or real station changed.

Inspected pictures, with the signed-in badge masked when in view:

- `s809-archived-prefix-refused.png`: the named refusal and reused prefix.
- `s809-corrected-prefix-saved.png`: the replacement saved with a new prefix.

The replacement is intentionally an incomplete setup draft, without payment
terminals; its readiness warning is expected. This proof checks prefix
assignment, not a sale on that draft. The local API review proves that a
legacy receipt collision returns the named cause, rolls back the cash
tender and allocator, and lets the same sale finish after prefix correction.
No duplicate receipt was manufactured on staging.

Two earlier harness attempts stopped at the branch selector: an exact label
match did not include the native select's option text. The harness now uses
the same non-exact label match as the existing Console browser helper.
`attempt-1.json` and `attempt-2.json` retain their failures and successful
cleanup (one own archived till and `/me` 401 each); `attempt-2.png` shows the
screen where selection timed out. No test fixture from these attempts is
left active. The successful `receipt.json` is separate and complete.
