# Test night, 21 October 2026 — staff working the Inbox (Track C)

Played on staging by an Opus 5.5 tester as Anya (agent), Vera, Hana (GM) and the platform admin.
62 screenshots in this folder; the numbers below refer to them. No ZZ AI / ZZ TEST / ZZ Live
thread was touched; the only customer created was "ZZ STAFF Walkin" on Instagram.

Outside the plan: the tester's approved AI example (ending "(ZZ STAFF test)") was withdrawn
through the api because the screen has no withdraw control; it now sits under Rejected.
Two scripts ran twice by mistake; the state was checked afterwards (Sarah's AI not paused,
no extra example filed).

## Step table

| Persona | Step | Result | Clicks | Clear? | Note |
|---|---|---|---|---|---|
| Anya | Open My Inbox | Works | 1 | Partly | Lands on Team Inbox with the top thread already open; it was another tester's live thread (01) |
| Anya | Read an unread thread (Liam, 2 unread) | Works | 1 | Yes | The unread badge cleared (02, 03) |
| Anya | Reply inside 24h (Liam) | Works | 2 | Yes | (04) |
| Anya | Free text on a thread older than 24h (Dmitri, Russian) | Refused as expected | 1 | Yes | Amber refusal with a list of templates (05) |
| Anya | Pick a template and send | Sent, wrong content | 2 | No | The template marked RU is English text (06, 07) |
| Anya | Add Vera as support | Not available | – | – | Agents have no "Add support"; done as Hana |
| Hana | Third support (cap) | Works on the server, silent on screen | – | No | The button just disappears; the api says "Both support places are taken. Remove someone first." but the screen never shows it (24) |
| Anya / Vera | Divert to the backup and back | Works | 1+1 | Yes | Anya stays on as support; she cannot divert back herself; Vera did (10, 12) |
| Anya | Mark handled, find it in Handled | Works | 2+1 | Yes | The confirmation reads well (16–18) |
| Anya | Reopen | Not available to an agent | – | No | The handled thread says nothing about who can reopen, but the primary picker and Divert still work on it (18). Hana reopened it (22, 23) |
| Anya | Details dialog | Works | 1 | Yes | The Facebook handle is a raw id that looks like a phone number (13) |
| Anya | Insert a template | Works | 2 | Yes | The list is filtered to the conversation's language (14, 15) |
| Anya | Timeline pills | Mostly sensible | 0 | Mostly | "Branch set by …" does not name the branch; AI pause and resume leave no pill |
| Hana | Dashboard vs lists | Mostly adds up | 0 | Partly | Active 12 and Unanswered 8 match the lists; By Category totals 15 because it includes handled threads (20) |
| Hana | Click the Unanswered tile | Works | 1 | Yes | (21) |
| Hana | Move Ploy's primary to Anya | Works | 2 | Mostly | The confirmation says the same thing twice; the thread moved to Birthdays & Events (26, 27) |
| Hana | Move a thread to Marketing via the team badge | Works | 1 | Partly | No confirmation; Mila became primary and Hana was added as support without notice (28). Moved back afterwards |
| Hana | Set a birthday thread's branch (Noon) | No host joined | 1 | No | Both branches tried; nobody added and no reason shown (30). Branch restored to none |
| Hana | Mark handled from the list row (Sarah) | Works | 2 | Yes | (31, 32). Reopened afterwards |
| Hana | Handled tab filters / export | Works / disabled stub | 1 each | Yes | Filters not kept in the URL; Export says "Export is not built yet" (33–35) |
| Hana | Phone width 390 | Works | – | Mostly | No sideways scroll; back arrow works; the dashboard sits above the list every time; team move and status pickers hidden (40–43) |
| Admin | Channels tab | Works | 1 | Yes | Only WhatsApp Central Floresta is Live |
| Admin | Pause and resume AI (Sarah) | Works | 2 | Yes | No timeline event (51, 52) |
| Admin | Correct the assistant (Mike) | Works on the second try | 5 | No | The default topic is refused after pressing Propose, although the thread header shows a topic (53–55) |
| Admin | Approve the correction in Examples | Works | 4 | Yes | Approve stays disabled until the no-personal-data box is ticked (57–59) |
| Admin | KB entry `strollers` | Works | ~8 | Yes | Approved; the dialog warns it applies to every live number (60–63) |
| Admin | Simulator: ZZ STAFF Walkin on Instagram | Works | 6 | Mostly | Routed to Reception Central Floresta with no AI answer; the branch box says "All Branches"; "AI on · Pause" shows although Instagram's assistant is Off (72, 74) |
| Admin | Push receipts | Works | 1 | Yes | (77, 78) |
| Admin | Erase preview via the api | 409 as expected | api | Yes | Would erase 1 conversation and 3 messages; not confirmed |
| All | List refresh | Works | 0 | Yes | A new message appeared in Hana's open list after 17 s (75) |

## Findings, ranked

Defects
1. All 18 Thai and Russian templates are English text; a Russian customer outside the 24-hour window received English (05–07).
2. The 24-hour refusal offers the wrong list: 27 templates in all languages, every one a "please hold" hand-over line; none works as a follow-up after a day (05).
3. An approved AI example cannot be withdrawn on screen; the api can reject it (59).
4. The correction dialog's default topic fails on a thread the assistant never classified, and says so only after Propose (54).
5. The By Category tile counts handled threads, so it does not add up with Active (20).
6. Setting a birthday branch adds no host and the screen gives no reason (30).

Weaknesses
- Agents cannot add support or reopen, and nothing on screen explains it, while the assignment controls stay live on handled threads.
- The support limit is invisible.
- The desktop landing opens the top thread automatically, which clears that person's unread badge; agents land on Team Inbox, not My Inbox.
- "AI on · Pause" appears where the assistant is Off; pausing leaves no timeline record.
- Wording a reception person could misread: "General" on the category badge vs "Reception" on the team; a branch box saying "All Branches" on a thread pinned to Central Floresta; Facebook/Instagram ids that look like phone numbers; "Unanswered" still showing after the AI replied; the average response time differs by viewer (18m 46s for Anya, 37m 31s for Hana) without saying whose.
- Moving to Marketing has no confirmation and adds the GM as support silently.
- On a phone the GM cannot move a thread's team or change its status.
- The Assistant and Templates pages have no "back to inbox" and are not in the URL.
- Two controls are both labelled "Branch" for screen readers.

Suggestions
- Real Thai and Russian templates, one follow-up template per language, the refusal list filtered to the thread's language.
- "Support 2/2" when full; the result of the branch step ("Host added: …" or "No host for this branch").
- A Withdraw control for approved examples; preselect the thread's topic in the correction dialog.

## For the owner before tomorrow
1. The core shift works: read, reply, the 24-hour refusal, divert, handle and reopen, moves, the 30-second refresh.
2. Thai and Russian templates were all English at test time; the 24-hour list only offered "please hold" lines.
3. An approved AI example could not be pulled back on screen at test time.
4. Agents cannot add support or reopen; at test time the screen did not say so.
5. Staging holds 34 active threads, mostly ZZ TEST, so the dashboard shows New 21 and Unanswered 29 unless cleaned first.

## State left behind
Liam: active, Anya primary, plus the test reply. Dmitri: one English template message added. Ploy and Noon: as before.
Sarah: handled then reopened. Mike: the correction withdrawn; AI paused and resumed on Sarah, not Mike.
ZZ STAFF Walkin: handled, not erased. KB `strollers`: English only, approved and live.
