# SCRUM-793 on staging: sessions a page at a time, each with what it is now

**Result: passed.** Every check below held on staging on 9 November 2026, 19:38 to 19:46 Bangkok time.

## What was tested

- **Code:** main at `ed6e092d848efc164190e8800489865c2794264c`.
- **Services:** the api, launcher and Console staging services were all live at that commit before the first step (deploy ids are in `receipt.json`).
- **Account:** the staging administrator, which is the owner's own account. When the test started it held **3,284 sessions**, which is exactly the case this ticket is about.
- **Browser:** a headless Chromium window, 1440 × 900, set to Bangkok time.
- **Masking:** the name and phone number are blacked out in every picture.
- **Clean-up:** every browser that signed in was signed out at the end, and each one was then refused. This proof added three sessions to the account, and all three now read Ended.

## What each picture shows

| # | Picture | What it shows |
|---|---|---|
| 1 | `01-account-page-sessions-page-1-full.png` | Your account page. The Sessions panel shows 10 rows and "Showing 1–10 of 3284". Previous is greyed out and Next is enabled. Only the top row, the browser reading the page, carries "This device". |
| 1 | `01b-sessions-panel-page-1.png` | The same panel on its own, easier to read. |
| 2 | `02-sessions-panel-page-2.png` | After Next: rows 11 to 20, "Showing 11–20 of 3284". Previous and Next are both enabled. |
| 2 | `02b-sessions-panel-last-page.png` | The last page after 328 clicks of Next: "Showing 3281–3284 of 3284". Next is greyed out. |
| 2 | `02c-sessions-panel-previous-from-last.png` | Previous from the last page goes back one page: "Showing 3271–3280 of 3284". |
| 3 | `03-ended-on-7-nov-page.png` | The page (61–70) holding the sessions that ended on 7 November. Rows 3, 4, 5 and 7 read "Ended … ended 7 Nov, 03:53 / 03:53 / 03:45 / 00:40". None reads Active. |
| 3 | `03b-ended-on-7-nov-row.png` | One of those rows close up: "Ended, last used 7 Nov, 01:24, ended 7 Nov, 03:53". It ran out of time. |
| (extra) | `03c-locked-session-row-launcher.png` | The account's only Locked session, a till that locked at 13:33. It reads "Locked … ends 9 Nov, 23:56", which is a time still in the future. |
| 4 | `04-second-browser-signed-in.png` | A second browser signed in, then the first one reloaded. The total went from 3284 to **3285**. The new session is row 1, "Active", with no pill. "This device" stays on the first browser's own row, now row 2. |
| 4 | `04b-second-browser-signed-out.png` | The second browser signed out, then the first one reloaded. Row 1 now reads "Ended … ended 9 Nov, 19:42", the time of the sign-out (one second after it). The total is still **3285**, so the row stays on the list. |
| 6 | `06-console-accounts-page.png` | Console, People & access, Accounts (the Login Users list), searched down to the owner's own account. Names, phones, the search text and the Recent denials list are masked. |
| 6 | `06a-console-sessions-dialog-page-1-top.png` | That account's Sessions dialog, page 1, top half. Ended sessions carry an "ended" chip and "ended &lt;time&gt;". The live one says "expires &lt;time&gt;". |
| 6 | `06b-console-sessions-dialog-page-1-controls.png` | The bottom of the same dialog: "Showing 1–10 of 3286". Previous is greyed out and Next is enabled. |
| 6 | `06c-console-sessions-dialog-page-2.png` | After Next in the Console: "Showing 11–20 of 3286", with Previous and Next both enabled. |
| (extra) | `06d-console-sessions-dialog-locked-row.png` | The Console dialog on the page holding the locked till session. It shows the amber "locked" chip and "expires 09/11/2026, 23:56". |

The Console total is 3286 because the second test run signed in once more before it opened the Console.

## Checks behind the pictures (point 5, the api)

- **A request for more than 50 rows is refused.** `GET /accounts/<own id>/sessions?limit=51` answers **400** (VALIDATION). `offset=-1` also answers 400. `limit=50` answers 200 with 50 rows.
- **The plain request gives the first page.** The answer carries `total` (3284), `limit` 10, `offset` 0 and 10 rows. Every row has `status`, `endedAt` and `current`.
- **The whole list was read, 50 rows at a time.** That came to 3,284 rows, equal to the total. The status counts were:
  - **Active:** 9
  - **Locked:** 1
  - **Ended:** 3,274. Of these, 2,486 ran out of time and 788 were signed out. 4 ended on 7 November (Bangkok time).
- **No status is wrong.** No row is Active or Locked with its end already past. Every Ended row has an end time, and no live row has one.
- **The order is right.** The list runs newest sign-in first across all 3,284 rows.
- **"This device" appears once.** Exactly one row in the whole account is marked as the caller's own.
- **The screen matches the api.** All 329 pages were clicked through on the launcher. Every row's word and pill matched what the api sent for that page. The screen counted 9 Active, 1 Locked and 3,274 Ended, the same as the api, and showed "This device" on one row only.

## Notes for the owner (not failures)

- **The panel's heading line is now out of date.** It still says "Every device where this account is signed in right now.", but most of the rows under it read Ended. The lane already asked you about this wording.
- **The order can look jumbled.** The list is in order of when each session signed in, but the screen shows only "last used". So the "last used" times are not always in order. For example, on page 51–60 a session last used at 19:24 sits under one last used at 11:48, because it signed in earlier.
- **The two apps write times differently.** The Console dialog writes "09/11/2026, 19:42" where the launcher writes "9 Nov, 19:42". The Console dialog also shows no chip on a live session and does not mark "This device". Neither was asked for.

## Files

- **`receipt.json`:** every reading, the deploy ids and the sign-out results. It holds no phone, name or password.
- **The proof scripts** (kept outside the repository):
  - `C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/s793p/run.mjs`
  - `C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/s793p/run2.mjs`
  - `C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/s793p/lib.mjs`
