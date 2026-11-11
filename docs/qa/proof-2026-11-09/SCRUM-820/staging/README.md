# SCRUM-820 — staging proof

**A party deleted in the OTO App keeps its event chip in the inbox conversation.**

Run on staging, 11 November 2026, 17:58–18:10 Bangkok. Landed commit `c60d80e99`.
Result: **passed** (steps A–E, the clean-up and the sign-out).

| Service | Deploy | Commit |
|---|---|---|
| oto-api-staging | dep-dbq4htoae00c73da4adg, live | c60d80e9 (steps A, B) |
| oto-api-staging | dep-dbq4kn6k1f9s73djrdc0, live from 18:03 | 3cf7846e, a later commit on main that contains c60d80e9 (steps C–E) |
| oto-inbox-staging | dep-dbq4hubl550s739i4n70, live | c60d80e9 (all steps) |

Three fresh ZZ TEST threads on the simulator account "Demo WhatsApp · Central Floresta",
the staging administrator in the inbox and in the OTO App. Values, routes and status codes are in `receipt.json`.

| Step | What was done | What showed | Result |
|---|---|---|---|
| A | Thread "ZZ TEST 820", a birthday line (5 December, 2pm, 10 kids, 3 adults), Book Date | "Date Booked", Create BEO and the chip "Event: 5 Dec 2026 at Central Floresta" — `820-A-live-chip.png` | Pass |
| B | That party archived in the OTO App (`POST /api/admin/events/:id/archive` → 200), the thread loaded again | The chip reads "Party removed in the Events module"; it is plain text (a press does nothing: no request, no new tab); Book Date is offered again. `open-beo` from the page → **409 EVENT_REMOVED** — `820-B-removed-after-archive.png` | Pass |
| C | Book Date again with a new date (6 December, 10:00), then Create BEO | A new party, a new live chip "Event: 6 Dec 2026 at Central Floresta"; Create BEO opened the new party's BEO in the OTO App (6 December '26 at 10:00); left without saving — `820-C-rebooked-live-chip.png`, `820-C-new-party-beo.png` | Pass |
| D | Second thread "ZZ TEST 820 second", Book Date, then the party deleted (`DELETE /api/admin/events/:id` → 204, read back 404) | The same "Party removed in the Events module" chip, Book Date offered; `open-beo` → 409 EVENT_REMOVED — `820-D-removed-after-delete.png` | Pass |
| E | Control thread "ZZ TEST 820 control", its party untouched | "Date Booked", Create BEO and the normal chip "Event: 13 Dec 2026 at Central Floresta" — `820-E-control-live-chip.png` | Pass |

Notes
- In step C the BEO's AI Fill said it did not run (409): this test chat has no confirmation from the team to read. That is the
  fill's own rule and not part of this ticket; the BEO opened on the new party.
- The api moved to a later commit (3cf7846e) while the run was under way. It contains the landed commit; steps D and E repeat
  the removed-chip and live-chip checks on it with the same result.

Clean-up: the three ZZ TEST parties still standing were archived through the app's archive route (read back archived; the fourth
was the one deleted in step D); the three ZZ TEST threads were marked handled; every session signed out (401 read back).

Pictures: the signed-in person's name and initials, the conversation list and phone numbers are masked.
