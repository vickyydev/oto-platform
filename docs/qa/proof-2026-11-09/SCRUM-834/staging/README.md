# SCRUM-834 (staff dictate a reply into the composer) and SCRUM-835 (the simulator records a customer voice note): staging proof

Run on 11 November 2026, 15:28-15:33 Bangkok (08:28-08:33 UTC), on the live
commit `60c378becc9c8272f416298c9820ea74c037f6c4`. Nothing was deployed or
restarted and no setting was read or changed.

| Service | Deploy | Live commit | Live at (UTC) |
|---|---|---|---|
| oto-api-staging | `dep-dbq2cbuk1f9s73ddkqdg` | `60c378be` | 08:28:37 |
| oto-inbox-staging | `dep-dbq2ccbrjlhs73b176p0` | `60c378be` | 08:25:06 |

The run used a headless Chromium at 1440×900, light theme, en-GB, Bangkok
time zone. The staging administrator signed in through the launcher and was
handed into the inbox (owner view). Their name, the other staff names,
avatars, initials and every phone-like number are masked in the pictures, and
the list of other conversations is masked out. The customer was the simulator
account "Demo WhatsApp · Central Floresta", writing from fresh ZZ TEST
simulator numbers, so nothing reached a real phone.

**The microphone was not a person.** Chromium was started with its fake
microphone, fed from a recorded clip: the text-to-speech voice made for the
SCRUM-824 proof (14.6 s, resampled to 48 kHz for the browser), saying "Hi,
this is a ZZ test voice note. We would like to book a birthday party for
twelve kids on Saturday the twenty second of November at two pm at Central
Floresta. How much is the package?". The browser's own permission prompt is
answered by the fake device, so the prompt itself is not pictured. Each
recording ran about 16 seconds (the clip, then a second of silence).

## Checks

| # | Check | Result | Value | Picture |
|---|---|---|---|---|
| 1 | api and inbox live on `60c378be` | Pass | both deploys `live` before the run | — |
| 2 | `GET /api/inbox/me` carries the dictation block | Pass | `dictation: { available: true, maxSeconds: 180 }` | — |
| **SCRUM-835** | **Settings › Simulator · test only › A customer writes** | | | |
| 3 | The field's label and the Record button, beside the audio-file picker | Pass | label "Voice note (optional): an audio file or a recording, played as a WhatsApp voice message"; button "Record" (tooltip "Record a voice note with the microphone, as the customer") | `835-01-simulator-record-button.png` |
| 4 | Record pressed: Stop and the clock | Pass | "Stop", "Recording · 0:03 / 1:00"; at the stop "Recording · 0:16 / 1:00" | `835-02-simulator-recording.png` |
| 5 | Stop pressed: the clip and its × | Pass | "Recorded clip · 0:16" with the discard × | `835-03-simulator-recorded-clip.png` |
| 6 | Send as the customer (Demo WhatsApp · Central Floresta, name ZZ TEST 835, Birthdays & Events, English, Message empty) | Pass | the dialog's own `POST /api/inbox/simulator/inbound` 200 `processed`, 1 message, 1 new conversation; the voice went as `audio/webm;codecs=opus`, about 206 KB; the dialog said "Received: a new conversation, routed." | `835-04-simulator-sent-status.png` |
| 7 | The thread shows a voice-note bubble with its transcript | Pass | "Transcribing…" on first sight, then "TRANSCRIBED · ENGLISH — Hi, this is a ZZ test voice note. We would like to book a birthday party for 12 kids on Saturday, the 22nd of November at 2 pm at Central Floresta. How much is the package?" within 40 s; the assistant then answered from it (the birthday hand-over) | `835-05-thread-voice-note-transcribed.png` |
| **SCRUM-834** | **The composer's microphone, in the ZZ TEST 835 thread** | | | |
| 8 | The composer shows the microphone | Pass | button "Dictate a reply"; tooltip "Dictate a reply — The recording goes to the transcription provider and is not kept. Nothing reaches the customer until you press Send." (read from the button; a browser tooltip does not draw in a headless picture). No take-over was needed: the composer was open | `834-01-composer-microphone.png` |
| 9 | Pressed: the red dot, the clock and the privacy line | Pass | "Recording · 0:02 / 3:00 — The recording goes to the transcription provider and is not kept. Nothing reaches the customer until you press Send."; the button became "Stop dictating" | `834-02-composer-recording.png` |
| 10 | Stop: "Transcribing…" | Pass | caught on the screen; the words came back 2.7 s after the stop | `834-03-composer-transcribing.png` |
| 11 | The words land in the composer | Pass | `POST /api/inbox/conversations/:id/dictation` 200 `{ text, language: "en" }` (the clip sent as `audio/webm;codecs=opus`, no idempotency key); the composer held "Hi, this is a ZZ test voice note. We would like to book a birthday party for 12 kids on Saturday the 22nd of November at 2 pm at Central Floresta. How much is the package?" | `834-04-composer-holds-the-words.png` |
| 12 | Nothing was sent by the dictation | Pass | `GET /api/inbox/conversations/:id/messages` before and after: the same two messages (the customer's voice note, the assistant's line), no new one | `834-04-…` (no new outgoing bubble) |
| 13 | Send pressed once by the person | Pass | `POST /api/inbox/conversations/:id/messages` 200; one new outbound message, author `staff`; the composer emptied; the assistant's line became "AI stopped: a person replied" | `834-05-reply-sent-by-the-person.png` |
| 14 | The record: one audit row, no words | Pass | action `inbox.dictation` on `inbox.conversation`, actor the signed-in account, with a request id. Fields of `after`: `conversationId`, `outcome` (`ok`), `model`, `latencyMs` (1665), `durationSeconds` (25.8), `language` (`en`), `bytes` (206328), `contentType` (`audio/webm`). No text field; the longest string in the row is the conversation id; none of the spoken words appear in it | — |
| 15 | Clean-up | Pass | both ZZ TEST 835 threads marked handled (`POST …/handle` 200, read back `handled`); signed out of the inbox, the Console and the launcher, each read back 401 | — |

## Two passes at the simulator dialog

The simulator Record was run twice, so there are two ZZ TEST 835 threads. In
the first pass the mask over the list of other conversations was drawn across
the dialog and hid the Record button, so the four dialog pictures were taken
again in a second pass, this time of the dialog alone. Pictures `835-01` to
`835-05` are all from the second pass. The dictation (`834-*`) was done in the
first pass's thread, whose voice note read "Hi, this is a zz test voice note.
We would like to book a birthday party for 12 kids on Saturday the 22nd of
November at 2pm at Central Floresta. How much is the package?". Both passes
gave the same result at every step (`receipt.json`, `scrum835`).

## Seen on the way

1. **BROKEN: a dictation is refused as too long well before the clock's
   3:00.** A browser recording (WebM) carries no length in its header, so the
   api estimates it from the bytes at a fixed rate
   (`audioSeconds` in `apps/api/src/services/inbox/transcription.ts`), and
   Chromium records at a higher rate than the estimate assumes. The audit
   row read 25.8 s for the 16 s English recording, 32.4 s for the 16 s Thai
   one and 10.3 s for the 5 s Russian one (1.6 to 2 times long). The api
   checks that estimate against the three-minute ceiling, so the check was
   then tried (see "Extras"): a dictation stopped at **2:05** on the
   composer's clock ("Recording · 2:05 / 3:00") was refused,
   `POST …/dictation` 413 `DICTATION_TOO_LONG`, `durationSeconds: 219.3`,
   1,754,360 bytes, never sent to the provider; the composer said "The
   recording was too long (at most 3:00). Speak the reply in parts."
   (picture `834-long-04-dictation-refused.png`). By the bytes, the refusal
   starts at about 1.44 MB: roughly 1:50 of English speech, about 1:30 of
   the Thai clip. Short dictations are not affected. Not fixed here; raised
   to the main session.
2. **The composer is one line.** A long dictation shows only its end in the
   box (picture `834-04`); the whole text is there and was sent whole
   (picture `834-05`).
3. **The "Show simulator" button sits over the right end of the composer
   row** when the simulator side panel is hidden (staging only; pictures
   `834-02` to `834-05`). It covers the end of the privacy line and part of
   the Send button.

## Not shown, and why

- The browser's microphone permission prompt: the fake device answers it.
- A real person's voice: by rule, never used.
- A refused microphone, the rate limit (20 a minute) and a deployment with
  no provider (the button hidden): not tried on staging; they are covered by
  the build's own tests.

## Extras (15:35-15:44 Bangkok): Thai, Russian, and a long dictation

Each was proved the real way, through the composer's microphone: the clip
was decoded to a WAV inside Chromium, the browser was started again with it
as the fake microphone, a fresh ZZ TEST thread was made with the simulator's
Record (so the same clip is also the customer's voice note in that thread),
the microphone was pressed in that thread's composer, and nothing was sent.

| # | Check | Result | Value | Picture |
|---|---|---|---|---|
| 16 | Thai dictation (Wikimedia Commons, Bangkok's ceremonial name read aloud, 14.7 s) | Pass | 200, `language: "th"`; the composer held "กรุงเทพมหานคร อมรรัตนโกสินทร์ มหินทรายุธยา มหาดิลก ภพนพรัตน์ราชธานีบุรีรมย์ อุดมราชนิเวศมหาสถาน อมรพิมานอวตารสถิต สักกะทัตติยวิษณุกรรมประสิทธิ์"; no message written; audit row `inbox.dictation`, `outcome: ok`, `language: th`, no words | `834-th-04-composer-holds-the-words.png` |
| 17 | Russian dictation (Tatoeba 6885057, 3 s) | Pass | 200, `language: "ru"`; the composer held "Спасибо, что пригласили меня на ваш день рождения.", word for word; no message written; audit row `outcome: ok`, `language: ru`, no words | `834-ru-04-composer-holds-the-words.png` |
| 18 | A long dictation under the clock's ceiling (the English clip looping, stopped at 2:05 of 3:00) | **Fail** | 413 `DICTATION_TOO_LONG`, `details: { maxSeconds: 180, durationSeconds: 219.3 }`; audit row `outcome: TOO_LONG`, `bytes: 1754360`, `latencyMs: 0` (not sent to the provider); the composer's line "The recording was too long (at most 3:00). Speak the reply in parts." See "Seen on the way" 1 | `834-long-04-dictation-refused.png` |
| 19 | Clean-up | Pass | every ZZ TEST thread of the extras read back `handled` (one had been closed by the assistant itself after a 5-second note, and there the composer rightly reads "Handled — composer disabled" with no microphone); signed out after each pass, read back 401 | — |

The simulator's Record also carried Thai and Russian: the customer's voice
notes in those threads read "transcribed · Thai" and "transcribed · Russian"
with the same words.

## Files

- `receipt.json`: every step's values, the requests' statuses, the audit
  row's fields, the clean-up and the sign-out.
- `834-01` … `834-05`: the composer's dictation.
- `834-th-04`, `834-ru-04`, `834-long-04`: the extras.
- `835-01` … `835-05`: the simulator's Record (SCRUM-835; its own folder
  points here).

## Re-check after the length fix (16:00-16:05 Bangkok, 09:00-09:05 UTC)

The length fix (`11cfd3934`: the api reads a browser recording's length from
the WebM itself, its last cluster, instead of estimating it from the size) was
live on oto-api-staging as deploy `dep-dbq2ov3rjlhs73b2e6a0`, commit
`11cfd393`, at 08:55:36 UTC; the run started after a further 90 seconds. Same
harness, same fake microphone, one fresh thread "ZZ TEST 834 long2" on Demo
WhatsApp · Central Floresta made with the simulator's Record (200,
`processed`). Nothing was sent in it.

| # | Check | Result | Value | Picture |
|---|---|---|---|---|
| 20 | A long dictation under the clock's ceiling (the English clip looping, Stop pressed at 125 s; the clock read "Recording · 2:04 / 3:00" a moment before the press) | Pass | `POST …/dictation` 200, `language: "en"`; no refusal line; the words landed in the composer; no message written (the same two messages before and after). Audit row `inbox.dictation`: `outcome: ok`, `durationSeconds: 124.9` (was 219.3), `bytes: 1750496`, `latencyMs: 2440`, no words | `834-long-05-two-minute-dictation-accepted.png` |
| 21 | A short dictation (the clip once, not looping, stopped at "0:16 / 3:00") | Pass | 200, `language: "en"`; audit row `outcome: ok`, `durationSeconds: 16` (was 25.8), `bytes: 206300`, `latencyMs: 1531` | — |
| 22 | Clean-up | Pass | the thread read back `handled`; signed out of the inbox, the Console and the launcher, each read back 401; the driver stopped | — |

One thing to know about check 20: the clip is one 15-second sentence played
eight times over, and the transcription provider gave the sentence back once
(169 characters: "Hi, this is AZZ test voice note. … How much is the
package?"), not eight times. The whole two-minute recording was accepted and
sent to the provider (the audit row's length and bytes say so); the provider
folds exact repeats. A long dictation of varied speech was not tried, since no
real voice is used here.
