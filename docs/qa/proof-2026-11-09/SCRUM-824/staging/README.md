# SCRUM-824 (a) voice notes: staging proof with no transcription provider

Run on 10 November 2026, 20:08-20:14 Bangkok, on the live commit
`405230df010f8e72a5e6d8bce859f209ef650180`. Nothing was deployed or restarted,
no setting was read or changed, and no transcription provider was switched on.

| Service | When the brief arrived | Run start (13:08 UTC) | Run end (13:14 UTC) |
|---|---|---|---|
| oto-api-staging | `df2334e8` live, `405230df` still deploying (live at 13:03:43 UTC) | `405230df` live | `405230df` live, same deploy |
| oto-inbox-staging | `405230df` live | `405230df` live | `405230df` live, same deploy |
| oto-console-staging | `df2334e8` live | `df2334e8` live | `df2334e8` live, same deploy |

The run used a headless Chromium at 1440×900, light theme, en-GB, Bangkok
time zone. The staging administrator signed in through the launcher and was
handed into the inbox (owner view) and the Console. Their name, the other
staff names, avatars, initials and every phone-like number are masked in the
pictures. The list of other conversations is masked out too. The customer
was the simulator account "Demo WhatsApp · Central Floresta" (assistant
`live`), writing from a ZZ TEST simulator number, so nothing reached a real
phone. The voice note was a 3-second synthetic 440 Hz tone (16 kHz mono
16-bit WAV, 96,044 bytes) made for this run, with no voice and no words.

## What "no provider" does (the build's design)

The owner has not chosen a transcription provider yet, so staging runs with
none. In that case a customer's voice note is:

- stored, and plays in its bubble when Open is pressed;
- marked "not transcribed" the moment it arrives (`transcriptStatus: off`).
  The ingest does this itself (`apps/api/src/services/inbox/ingest.ts`), so
  "Transcribing…" never shows and `job:inbox.transcribe` never sees the note.
  The job's own "off" sweep only catches a note that was filed as pending
  before a provider was switched off;
- left for a person exactly as before: the assistant makes no model call,
  the pill reads "AI left this one for the team" and the turn's reason is
  `NO_TEXT`.

The transcribed path is not tested here. It needs the owner to choose a
provider and staging to be configured with it. That covers the words under
the audio ("transcribed · Thai"), "Transcribing…" while it waits, the
assistant waiting for the words, and the job's done/failed/too long counts.

## Checks

| # | Check | Result | Value | Picture |
|---|---|---|---|---|
| 1 | api and inbox live on `405230df` before and after | Pass | both live on the same deploys | — |
| 2 | Assistant live on Demo WhatsApp · Central Floresta | Pass | `aiMode: live` (`GET /api/inbox/ai/channel-accounts`) | — |
| 3 | Voice note sent from Inbox › Settings › Simulator · test only (Message empty, WAV attached, Send as the customer) | **Fail** | 400 `VALIDATION`: "a message carries words or a voice note". The dialog showed the chosen file, but its request carried no voice (see "Found on the way") | — |
| 4 | Voice note sent with the simulator route through the same session (the brief's fallback) | Pass | `POST /api/inbox/simulator/inbound` 200 `processed`, 1 new conversation | — |
| 5 | Voice note stored | Pass | the message has an audio file and no text | — |
| 6 | "Transcribing…" shown before the job's tick (optional) | Not shown, by design | the api read 1.2 s after the send, before the job's next tick, already said `off`. The bubble's first look read "Voice note — not transcribed" | none (`824-st-01-voice-bubble-transcribing.png` not taken) |
| 7 | Bubble reads "Voice note — not transcribed" | Pass | `data-testid="voice-transcript"`, `data-state="off"` | `824-st-02-voice-bubble-not-transcribed.png` |
| 8 | Pill "AI left this one for the team" | Pass | shown under the voice note | `824-st-02-voice-bubble-not-transcribed.png` |
| 9 | The voice note plays (Open pressed once) | Pass | `GET /api/files/:id/url` 200 `audio/wav`; the audio element loaded (`loadedmetadata`, ready state 4, 3.0 s long) and played muted for 0.6 s | — |
| 10 | A typed ZZ TEST line in the same thread still gets the assistant's normal reply | Pass | "what time do you open tomorrow?" (sent from the Simulator dialog: 200, same conversation). The assistant replied with the opening hours: `ai_replied`, intent `hours`, reply `sent` | `824-st-03-typed-line-still-answered.png` |
| 11 | Console › Health: `job:inbox.transcribe` present and running | Pass | "ok · every 15s · last ran 10 Nov, 20:13"; read twice 20 s apart, its last run moved from 13:13:19 to 13:13:34 UTC, outcome `ok`, no error | `824-st-04-health-transcribe-job-off.png` |
| 12 | The job's last run detail counts `off ≥ 1` | **Not met (by design)** | The ingest already marked the note `off`, so the job had nothing to sweep and its count for this note is 0. Console › Health, `GET /api/platform/jobs` and `GET /api/ops/health` show a job's status, outcome and time, not its run counts | `824-st-04-…` shows the row only |
| 13 | api read: `transcriptStatus: off`, `transcript: null`, `transcriptLanguage: null` | Pass | `GET /api/inbox/conversations/:id/messages` | — |
| 14 | api read: the voice note's turn reason `NO_TEXT` | Pass | `ai_silent` event, turn `01a1c594-6495-70a1-a2e4-f4c8376c425a`, reason `NO_TEXT` (`GET /api/inbox/conversations/:id`) | — |
| 15 | Clean-up | Pass | see below | — |

Conversation: `01a1c594-6485-7c1a-be99-f782e45a2ea6`. Voice message
`01a1c594-6487-7b28-8866-5d0b22423c8a`. Every route, status and value is in
`receipt.json`.

## Found on the way

The Simulator dialog cannot send a voice note. In
`apps/inbox/src/api/inbox.ts` (line 232), `simulateInbound` builds its
request body one field at a time (`channelAccountId, from, name, text, hint`)
and leaves out `voice`. The dialog reads the file and shows its name, but the
file never reaches the api. With Message empty the api refuses the request
(400, nothing created). With Message filled, the text would arrive and the
voice note would be silently dropped. Adding `voice: body.voice` to that
object fixes it. The api route itself takes the voice note, as checks 4-14
show.

## Clean-up, read back

- The ZZ TEST conversation was marked handled:
  `POST /api/inbox/conversations/:id/handle` returned 200. Reading it back
  with `GET /api/inbox/conversations/:id` returned 200, state `handled`.
- Signed out of the inbox, the Console and the launcher. Each sign-out
  returned 200, and each read-back returned 401 (`GET /api/inbox/me`, the
  Console's `GET /api/me`, the launcher's `GET /api/me`).
- No other conversation was opened or changed. The failed dialog attempt
  created nothing.

## Part 2: the provider on (English, Thai, Russian and the too-long case)

Run on 11 November 2026, 13:41-13:49 Bangkok, on the live commit
`7d88e1945f4859144b120a6646e4e7ab111f68cf`. The owner had put the
transcription key on oto-api-staging (with `TRANSCRIPTION_PROVIDER`,
`TRANSCRIPTION_MODEL` and `TRANSCRIPTION_MAX_SECONDS` already set; names
only, no value is recorded here). The api was redeployed at `7d88e1945` so
it started with the key: deploy `dep-dbq0n8jl550s73971ea0`, created
13:30:58, live at 13:34:59 Bangkok. Its start-up log carries the line
"inbox voice-note transcription enabled" (provider `openai-compatible`,
180-second ceiling), read through the Render API. Nothing was deployed or
changed by this run.

| Service | Run start (06:41 UTC) | Run end (06:49 UTC) |
|---|---|---|
| oto-api-staging | `7d88e194` live (the deploy above) | same deploy |
| oto-inbox-staging | `3ac4658c` live (carries the simulator's voice fix `b73433c24`) | same deploy |
| oto-console-staging | `3ac4658c` live | same deploy |

Same set-up as Part 1: a headless Chromium (1440×900; 1440×1400 for the
four thread pictures so the bubble, the assistant's line and the pills fit),
light theme, en-GB, Bangkok time zone; the staging administrator signed in
through the launcher and handed into the inbox (owner view); names,
avatars, initials, phone-like numbers and the list of other conversations
masked in every picture. The three "Transcribing…" pictures were taken
4 to 6 s after each send; the four thread pictures were retaken at the
taller viewport after the clean-up, so they show each thread already marked
handled. Every note went into the simulator account "Demo
WhatsApp · Central Floresta" (assistant `live`) with the Category hint
Birthdays & Events and the note's language as the Language hint, each
thread from its own fresh ZZ TEST simulator number. Each note was sent from
Inbox › Settings › Simulator · test only with Message left empty and the
audio file chosen in the dialog's file input: the dialog's own request
carried the voice this time (the fix `b73433c24` is live), so no fallback
route was needed.

### The recordings

No recording is a customer's or a real person's voice from the park. The
audio files stay in the build machine's scratch folder; only pictures, this
README and the receipt are in the repository.

| Thread | File | What it is | Length |
|---|---|---|---|
| English | `zz-test-824-en.wav` | a text-to-speech voice made for this proof, reading: "Hi, this is a ZZ test voice note. We would like to book a birthday party for twelve kids on Saturday the twenty second of November at two pm at Central Floresta. How much is the package?" (22.05 kHz mono 16-bit WAV, 645,322 bytes) | 14.6 s |
| Too long | `zz-test-824-long.wav` | the local Windows text-to-speech voice (System.Speech) reading a ZZ TEST text nine times, at 4 kHz mono 8-bit so that 192.8 s fits the simulator's 1 MB cap (771,178 bytes) | 192.8 s |
| Thai | `zz-test-824-th-commons.ogg` | Wikimedia Commons, "Th-Bangkok ceremonial name.ogg": Bangkok's full ceremonial name read aloud (Creative Commons licence); Ogg Vorbis mono 44.1 kHz, 152,980 bytes | 14.7 s |
| Russian | `zz-test-824-ru-tatoeba-6885057.mp3` | Tatoeba sentence 6885057 (CC BY): "Спасибо, что пригласили меня на ваш день рождения." MP3 48 kbps mono, 18,533 bytes | 3 s |

A second Thai sentence (Tatoeba 749479, MP3) and a second Russian one
(Tatoeba 2504129) were on hand and not needed: the Commons Ogg Vorbis file
was taken by the simulator and the provider as it was.

### Checks

| # | Check | Result | Value | Picture |
|---|---|---|---|---|
| 1 | api live on `7d88e1945` before and after, the inbox live with the simulator voice fix | Pass | api deploy `dep-dbq0n8jl550s73971ea0` both times; inbox `3ac4658c` | — |
| 2 | Assistant live on Demo WhatsApp · Central Floresta | Pass | `aiMode: live` | — |
| 3 | English: sent from the Simulator dialog with the WAV attached, Message empty | Pass | `POST /api/inbox/simulator/inbound` 200 `processed`, the request carried `voice` (`audio/wav`), 1 new conversation | — |
| 4 | English: "Transcribing…" while the note waits | Pass | the bubble read "Transcribing…" (`data-state="pending"`) 6 s after the send, before the job's tick | `21-en-voice-note-transcribing.png` |
| 5 | English: the transcript under the audio with "transcribed · English" | Pass | api: `transcriptStatus: done`, `transcriptLanguage: en`; transcript "Hi, this is a zz test voice note. We would like to book a birthday party for 12 kids on Saturday the 22nd of November at 2pm at Central Floresta. How much is the package?" (the numbers written as digits by the provider; otherwise word for word). The audit row landed 5.0 s after the message reached us, 8.3 s after the send press | `22-en-transcript-and-handover.png` |
| 6 | English: the assistant answers from the transcript | Pass | 13.6 s after the send: `ai_handover`, intent `birthday_details`, reason `OK`, destination `birthdays`, closing `closing_birthday`; its line "Thank you so much! Our birthday manager will be with you shortly." (`sent`). That is the playbook's birthday path: the party enquiry goes to the birthday manager with the warm closing line. The pill reads "AI handed over to the team · birthday details" | `22-en-transcript-and-handover.png` |
| 7 | Too long: the 192.8 s note | Pass | sent 200, 1 new conversation; 5.1 s after the send the api read `transcriptStatus: too_long`, no transcript; the bubble reads "Voice note too long to transcribe" (`data-state="too_long"`) | `25-long-voice-note-too-long-handed-over.png` |
| 8 | Too long: handed over as `VOICE_UNREAD`, nothing sent to the provider | Pass | 9.9 s after the send: `ai_handover`, reason `VOICE_UNREAD`, rule `voice_unread`, intent `other`, destination `general` (Reception · Central Floresta), closing `closing_unclear`; its line "Thanks for your message! A team member will be with you shortly." The pill reads "AI handed over to Reception · Central Floresta · voice note could not be read". The audit row says `reason: TOO_LONG`, `durationSeconds: 192.8`, attempt 1: the length check in `transcription.ts` answers before the adapter is asked (see "Found on the way" for the ops run it leaves) | `25-long-voice-note-too-long-handed-over.png` |
| 9 | Thai: sent from the dialog (Ogg Vorbis) | Pass | 200 `processed`, `voice` `audio/ogg`, 1 new conversation | — |
| 10 | Thai: "Transcribing…" while the note waits | Pass | seen in the bubble and in the api (`pending`) for about ten seconds; pictured 5 s after the send | `23a-th-voice-note-transcribing.png` |
| 11 | Thai: the transcript with "transcribed · Thai" | Pass | `done`, `transcriptLanguage: th`; transcript "กรุงเทพมหานคร อมรรัตนโกสินทร์ มหินทรายุธยา มหาดิลก ภพนพรัตน์ราชธานีบุรีรมย์ อุดมราชนิเวศมหาสถาน อมรพิมานอวตารสถิต สักกะทัตติยวิษณุกรรมประสิทธิ์" (the ceremonial name, as read). Audit row 12.9 s after the message, 15.4 s after the send | `23-th-transcript-and-reply.png` |
| 12 | Thai: the assistant waits for the transcript, then answers from it in Thai | Pass | one `inbox.ai.turn.wait` row (`TRANSCRIPT_PENDING`) while the note was pending; then, 26.5 s after the send, `ai_handover`, intent `emotional_or_unclear`, reason `OK`, destination `general` (Reception · Central Floresta), closing `closing_unclear`; its line in Thai: "ขอบคุณสำหรับข้อความนะคะ ทีมงานของเราจะมาดูแลคุณในอีกไม่นานค่ะ". A recording of a city's ceremonial name is not a park question, so the hand-over is the right shape; what matters here is that the turn was decided on the Thai words and answered in Thai | `23-th-transcript-and-reply.png` |
| 13 | Russian: sent from the dialog (MP3) | Pass | 200 `processed`, `voice` `audio/mpeg`, 1 new conversation | — |
| 14 | Russian: "Transcribing…" while the note waits | Pass | pictured 4 s after the send (the api had it `done` by the first 5-second read) | `24a-ru-voice-note-transcribing.png` |
| 15 | Russian: the transcript with "transcribed · Russian" | Pass | `done`, `transcriptLanguage: ru`; transcript "Спасибо, что пригласили меня на ваш день рождения." (word for word). Audit row 4.0 s after the message, 6.8 s after the send | `24-ru-transcript-and-reply.png` |
| 16 | Russian: the assistant answers from the transcript in Russian | Pass | 12.3 s after the send: `ai_handover`, intent `emotional_or_unclear`, reason `OK`, destination `general`, closing `closing_unclear`; its line in Russian: "Спасибо за сообщение! Сотрудник нашей команды скоро свяжется с вами." The sentence thanks someone for a birthday invitation rather than asking the park anything, so a hand-over in Russian is the expected shape | `24-ru-transcript-and-reply.png` |
| 17 | Audit: the job's rows, kinds only | Pass | on each voice message: `inbox.message.media` then `inbox.message.transcribe` (`before.transcriptStatus: pending`; `after`: status, language, `durationSeconds`, `attempts`, `reason` — never the words). On each conversation: `inbox.conversation.create`, `inbox.ai.handover`. Read with `GET /api/audit?entityType=…&entityId=…` | — |
| 18 | Clean-up | Pass | see below | — |

Conversations: English `01a1c957-9d85-761b-aaca-8ffcd44decd0`, too long
`01a1c958-8b77-75db-8ad1-c05edf3023a4`, Thai
`01a1c959-532f-7925-9ad0-a6f103940128`, Russian
`01a1c95a-5dfe-7239-bc69-c5acda033577`. Every route, status, id, timing and
transcript is in `receipt-part2.json`, with the full 5-second timeline of
each thread (api state and bubble state side by side).

Audio sent to the provider: 14.6 + 14.7 + 3 = about 32 seconds across three
calls. The 192.8-second note was refused by the length check and never
sent.

### Found on the way

- A too-long note is recorded as a failed adapter run. `voice-notes.ts`
  records every `transcribe()` outcome as an `adapter:inbox.transcription`
  ops run, and the length refusal is one of them: Console › Failures now
  shows a group "adapter:inbox.transcription — TOO_LONG" (one run, 289 ms,
  not retryable) for a note that was never sent anywhere. It is honest, but
  a reader of the Failures page may take it for a provider fault. Whether a
  limit refusal belongs on that page is the owner's call.
- The hint Birthdays & Events routes the thread to Birthdays & Events, and
  the English party enquiry stayed there. A note the assistant could not read
  (`VOICE_UNREAD`), and the Thai and Russian notes whose words were not a
  park question (`emotional_or_unclear`), were handed to Reception · Central
  Floresta instead, moving the thread out of Birthdays & Events. That is the
  playbook's "unclear or not covered" path by the thread's park (by design in
  `voiceUnreadTurn`), noted so the owner is not surprised by the move.
- The "Transcribing…" window is short with this provider: the job ticks
  every 15 s and the provider answered in 1 to 7 s, so the English and
  Russian notes were `done` by the first 5-second read, and the Thai one
  showed "Transcribing…" for about ten seconds. The pictures caught it on all
  three because they were taken within 4 to 6 s of the send.
- The language label comes from the words' script (the model answers in
  `json`, with no language field). English, Thai and Russian were all named
  correctly from their script.

### Clean-up, read back

- The four ZZ TEST conversations were marked handled through the inbox's own
  route: `POST /api/inbox/conversations/:id/handle` returned 200 for each;
  `GET /api/inbox/conversations/:id` read back state `handled` for each.
- Signed out of the inbox, the Console and the launcher (200 each); each
  read-back returned 401 (`GET /api/inbox/me`, the Console's `GET /api/me`,
  the launcher's `GET /api/me`). The driver was opened once more for the
  four thread pictures at the taller viewport and signed out again the same
  way (401 read back).
- No other conversation was opened or changed; no setting was read or
  changed; nothing reached a real phone.
