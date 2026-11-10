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
