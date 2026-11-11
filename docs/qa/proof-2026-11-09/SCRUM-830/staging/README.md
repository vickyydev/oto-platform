# SCRUM-830 — staging proof: the first message decides the inbox queue

**Verdict: FAILED** — steps 1 to 6 passed; step 7 failed on both of its lines
(an edge word routed a plain question away from the channel's default). The
ticket was not walked to Testing.

## When and what was live

- Run: 11 November 2026, 12:49–12:58 Bangkok (05:49:23Z – 05:58:19Z).
- Main at `3ac4658cdd5f00a965c004db027cfac775495a19`.
- `oto-api-staging` deploy `dep-dbq00eou01pc739e56q0`, **live** at `3ac4658c`
  (finished 05:46:29Z) — read as `liveBefore` and again as `liveAfter`,
  unchanged.
- `oto-inbox-staging` deploy `dep-dbq00f6k1f9s73d6j4l0`, **live** at
  `3ac4658c` (finished 05:43:11Z) — `liveBefore` and `liveAfter`, unchanged.
- `oto-console-staging` `dep-dbpvpt8ae00c73cs8bm0` at `acb096f7` (no Console
  code in this change; recorded as found).

## How

One headless Chromium (Playwright, 1440×900, Asia/Bangkok). The staging
administrator signed in through the launcher and was handed into the inbox
(`POST /api/auth/handoff` → `/api/auth/handoff/exchange`). Every customer
line went through the inbox's own **Settings › Simulator · test only** dialog
into the simulator account **Demo Instagram** (no park; its default category
is General, which seats Reception · Central Floresta), each thread from its
own fresh ZZ TEST number, the Category field left on **"As the channel routes
it"** (no hint — the request carried no `hint` at all) except step 5, where it
was set to **General**; the Language field left on **"Not given"** on every
thread. The dialog's own `POST /api/inbox/simulator/inbound` was read.

Right after each POST (about one second later, before the assistant's turn —
every at-send read shows `0` assistant pills) the thread was read through
`GET /api/inbox/conversations/:id` and `/messages`: the category, team and
language, and the `routed` event's payload (`source`, `cue`, `cueLanguage`).
The audit rows were read through
`GET /api/audit?entityType=inbox.conversation&entityId=:id`. Then the
assistant's turn was waited for and the thread read again. The routing pill's
words were read from the inbox's own thread view, with the pill groups opened.
The assistant is live on Demo Instagram (`GET /api/inbox/ai/channel-accounts`
→ `aiMode: live`); its replies were expected and nothing it wrote was pressed.

## Results

The pill's exact words are as the thread view renders them: the language
prefix and, on the collapsed line, the count of the seat pills grouped under
it (`· 2 more` = the two seats, opened below). The words the brief asks for
are in every line as given.

| Step | Line (ZZ TEST) | At send: category · team | Routed `source` / `cue` / `cueLanguage` | Thread language | Pill (exact) | Audit at send | After the assistant | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | I want to book a birthday party | `birthdays` · Birthdays & Events | `message` / `birthday` / `en` | `en` | "Language: EN · Routed to Birthdays & Events · from the message" (collapsed: "… · 2 more", the two seats) | `inbox.conversation.create` `categorySource: message`; `inbox.conversation.classify` `cue: birthday, cueLanguage: en` | `ai_replied` (birthday_party); no `moved_team`; still Birthdays & Events | **Pass** — picture 01 |
| 2a | I want a refund, the staff were rude | `gm` · GM | `message` / `refund` / `en` | `en` | "Language: EN · Routed to GM · from the message" (collapsed "… · 1 more", the GM seat) | create `categorySource: message`; classify `cue: refund` | `ai_handover` (refund_request, destination gm, no re-route); still GM | **Pass** — picture 02 |
| 2b | The birthday party yesterday was terrible, your staff were rude | `gm` · GM | `message` / `rude` / `en` | `en` | "Language: EN · Routed to GM · from the message" | classify `cue: rude` (the complaint cue won over "birthday party") | `ai_replied` + `ai_handover` (complaint_onsite, destination gm); still GM | **Pass** |
| 3 | What time do you open? | `general` · Reception · Central Floresta | `default` / — / — | `en` | "Language: EN · Routed to Reception · Central Floresta" — **no "from the message"** | create `categorySource: default` only; **no classify row** | `ai_replied` (hours); unchanged | **Pass** — picture 03 |
| 4a | สวัสดีค่ะ อยากจัดวันเกิดให้ลูกชายค่ะ | `birthdays` · Birthdays & Events | `message` / `birthday` / `th` | **`th`** | "Language: TH · Routed to Birthdays & Events · from the message" (the TH rule's seats) | create `language: th, categorySource: message`; classify `cue: birthday, cueLanguage: th` | `ai_replied` in Thai (birthday_party); unchanged | **Pass** — picture 04 |
| 4b | Хотим отметить день рождения сына у вас | `birthdays` · Birthdays & Events | `message` / `birthday` / `ru` | **`ru`** | "Language: RU · Routed to Birthdays & Events · from the message" | create `language: ru`; classify `cue: birthday, cueLanguage: ru` | `ai_replied` in Russian (birthday_party); unchanged | **Pass** |
| 5 | I want to book a birthday party — **hint: General** | `general` · Reception · Central Floresta | `hint` / — / — | `en` | "Language: EN · Routed to Reception · Central Floresta" (collapsed "… · 1 more", the reception seat); **no "from the message"** | create `categorySource: hint`; **no classify row** | first turn `ai_replied` (birthday_party, asked date / people / branch — no hand-over yet); after the answer "Saturday 22 November, 12 kids, Central Floresta (ZZ TEST)": `ai_handover` (birthday_details) → `moved_team` Reception · Central Floresta → Birthdays & Events by AI, pills "AI handed over to Birthdays & Events — … primary, … support", "Moved from Reception · Central Floresta → Birthdays & Events by AI", "Language: EN · Routed to Birthdays & Events" (a re-route: no source) | **Pass** — picture 05 |
| 6 | Hi there! then, same number, I want to book a birthday party | `general` · Reception · Central Floresta | `default` / — / — | `en` | "Language: EN · Routed to Reception · Central Floresta" | create `categorySource: default`; no classify row; the second line added **no** classify row and the thread stayed `general` (only the first message is read) | the greeting: `ai_replied` (greeting); the birthday line: `ai_replied` (birthday_party), still `general`; after the answer line: `ai_handover` (birthday_details) → `moved_team` to Birthdays & Events by AI | **Pass** |
| 7a | What happens in the event of rain? | **`birthdays` · Birthdays & Events** | `message` / **`event`** / `en` | `en` | "Language: EN · Routed to Birthdays & Events · from the message" | classify `cue: event` | `ai_handover` (birthday_advice, destination birthdays, "manager not notified (no contact)"); stays Birthdays & Events | **FAIL** — expected the default |
| 7b | Is the deposit refundable? | **`gm` · GM** | `message` / **`refund`** / `en` | `en` | "Language: EN · Routed to GM · from the message" | classify `cue: refund` | `ai_handover` (refund_request, destination gm); stays GM | **FAIL** — expected the default |

Every thread was a new conversation (`conversationsCreated: 1`, the dialog
said "Received: a new conversation, routed."); the later lines of steps 5 and
6 went "into the existing conversation" (`conversationsCreated: 0`).

## Findings

1. **Step 7 fails: two edge words route a plain question away from the
   default.** The reader's English `event` cue is the whole word
   `events?`, so "in the **event** of rain" is read as an event enquiry; its
   `refund` cue is `refund\p{L}*`, so "refund**able**" (a deposit-policy
   question) is read as a refund request. Both decided the queue at ingest
   with a `classify` row, and both are sticky: the assistant then handed over
   *inside* the queue the reader chose (birthday_advice; refund_request), so
   neither thread was corrected. Reproduced locally against the same commit
   with `firstMessageCategory()` before the run (same cues). A fix wants the
   idiom "in the event of / that" in `NOT_THE_SENSE` and the refund cue
   narrowed to the request forms (not "refundable" / "non-refundable").
2. **The assistant's move only comes with its hand-over.** On the hinted
   thread (step 5) and the greeting-first thread (step 6) the first birthday
   turn is a reply that asks the date, the headcount and the branch; the move
   to Birthdays & Events came with the hand-over after a ZZ TEST answer. The
   line the brief calls "… · 1 more" reads, on these threads, "Language: EN ·
   Routed to Reception · Central Floresta · 1 more" (the seat) and the move
   itself sits under the "AI handed over to Birthdays & Events — …" group as
   "Moved from Reception · Central Floresta → Birthdays & Events by AI". Not
   a defect of this change; recorded so the words are known.
3. The collapsed routing line carries the language prefix and the seat count
   ("Language: EN · Routed to Birthdays & Events · from the message · 2
   more"); the brief's words are a substring of every line. Not a defect
   (the W7 pill grouping).
4. Step 7a's hand-over pill says "manager not notified (no contact)": the
   Birthdays & Events hand-over notice on Demo Instagram has nobody to
   notify. Outside this ticket; noted.
5. The Thai opener seated the TH rule's people at ingest (test night D2) and
   the assistant answered in Thai; the Russian opener likewise with RU seats.

## Clean-up and sign-out

- All ten ZZ TEST threads were marked handled through the inbox's own
  `POST /api/inbox/conversations/:id/handle` (200 each) and read back
  `handled` (05:57:48Z – 05:57:56Z).
- Sign-out: `POST /api/auth/sign-out` on the inbox, the Console and the
  launcher, 200 each; read back `GET /api/inbox/me` 401, `GET /api/me`
  (Console) 401, `GET /api/me` (launcher) 401 (05:58:19Z).
- Nothing else was read or changed; the simulator account is internal, so
  nothing reached a phone or a page.

## Files

- `receipt.json` — routes, statuses, ids, the exact lines, the at-send and
  final reads with the `routed` payloads, the assistant's pills, the pill
  words, the audit rows as read, the clean-up and the sign-out. No name of a
  real person, no phone number, no key (checked for digit runs of nine or
  more outside git SHAs and for "+66").
- `01-step1-birthday-routed-from-the-message.png`
- `02-step2-refund-rude-routed-to-gm.png`
- `03-step3-plain-question-default-no-from-the-message.png`
- `04-step4-thai-birthday-routed-from-the-message-language-th.png`
- `05-step5-hint-general-stays-then-assistant-moves-it.png` (scrolled to the
  move; the top line's words are in `receipt.json` → `threads.S5.pillWords`)

Names, initials and the list of other conversations are masked in every
picture; the seats shown are the seed's demo people.
