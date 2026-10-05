# End of Day round-2 staging proof - 6 October 2026

API deploy dep-db20cp17lnhs73d5641g and POS deploy dep-db20e9mi0phs73cqos50
are live at 33681345. Earlier source-identical round-2 CI 37356476121 passed.
Main CI 37368987245 could not obtain a hosted runner; retried, not green.

Actual signed-in staging screens and simulator output were reviewed and
attached to SCRUM-215 as 11265, 11266 and 11267. See the three named cards
under docs/qa/jira-comments/attachments/SCRUM-215.

## Observations

- Controlled outbox depth and low clock trust made the day provisional;
  UI close disabled and POST close returned 409. Normal box heartbeat
  cleared both reasons.
- Two synthetic children checked in through controlled fixture data still
  blocked close. Left without scanning resolved only the chosen child.
- A manager reason allowed close over the other row and survived read-back.
  Its closed-day history remains visible; no occupancy was silently erased.
- Cash count 6050 against float 6000 showed a 50 difference. Corrected to
  6000 before closing; other entered actuals were zero.
- Second close returned 409. Closed snapshot was read-only.
- First 5 October print skipped because the QA device address was missing.
  Assigned sim://zz-eod-receipt through normal device settings. Reprint
  printed; a separate 4 October close then printed its original receipt.
  These were simulated outputs, not physical printer proof.
- Audit read-back contains gate.manual_resolution, end_of_day.override,
  end_of_day.close and print_job.reprint.
- Phone 390x844 displayed the closed day/Reprint without horizontal overflow.
- Found: queued receipt text needed a refresh to show printed. Local hook
  repair passes 11 existing checks; requires deployment and staging retest.

## Isolated fixtures retained for round-3 proof

All data belongs to ZZ TEST End of Day 1006 (code zz-eod-1006).
No real park day, park stock or FWBooth1 was changed or reseeded.

- Branch: 01a10dbf-2133-7be5-9599-e367f94523fe
- Box: 01a10dbf-8cfb-7ee4-ab6f-5fb89bd659d1
- Receipt device: 01a10dbf-8eca-7b40-9dad-9185e5466808
- Station: 01a10dbf-90b3-7a8f-b0e4-fcc615af38a1
- Fixture job: job-db20hch7lnhs73d5ln10
- Closed dates: 2026-10-04 and 2026-10-05

The active local box uses in-memory SQLite and credentials; never save its
claim or secret. Temporary fixture.json contains only row IDs and date.
After settlement proof, stop the simulator and archive these QA objects,
preserving their audit and immutable closed-day history.
