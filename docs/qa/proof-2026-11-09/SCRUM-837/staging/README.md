# SCRUM-837 — staging proof

**Inbox composer: the "Show simulator" button covers the end of the reply row, and a long dictated reply shows only its end.**

- Staging, 11 November 2026, 17:44–17:50 Bangkok. Commit `70cb96d68` live on `oto-inbox-staging` (deploy `dep-dbq4ci6k1f9s73dj4u30`).
- A new browser profile (no cached bundle), 1440 px wide, the owner view, signed in through the launcher.
- One ZZ TEST thread on "Demo WhatsApp · Central Floresta" (simulator), customer name "ZZ TEST 837". The microphone is Chromium's fake microphone playing a text-to-speech clip; no person's voice.

| # | Step | Result | Picture |
|---|------|--------|---------|
| 1 | Simulator side panel hidden: "Show simulator" is in the top bar beside Settings; nothing lies over the reply row, Send is whole (checked at 1440×900 and 1440×1500) | Pass | `837-01-show-simulator-in-top-bar.png` |
| 2 | A long reply typed: the box goes 1 → 3 → 4 → 5 lines (20 → 60 → 80 → 100 px), stays at five and scrolls from there | Pass | `837-02-reply-box-grown.png` |
| 3 | Shift+Enter adds a line; no send request left the page and the thread read through the api is unchanged (2 messages before and after) | Pass | — |
| 4 | Dictation for 16 s: the recording line under the row is whole with nothing over it; after Stop the words landed at the caret (the end), the box scrolled to show them, nothing sent | Pass | `837-03-recording-line-clear.png`, `837-04-dictated-words-at-the-end.png` |
| 5 | Box cleared to a short line, Enter pressed: one new message, the staff member's own, with exactly those words; the box is empty and one line again | Pass | `837-05-enter-sent-box-one-line.png` |

Clean-up: both ZZ TEST threads are handled, every session signed out (read back 401), the driver stopped.

## Notes

- The first ZZ TEST thread held only a greeting, and the assistant auto-resolved it nine seconds later (composer disabled, as designed). The check ran in a second thread with a birthday question, which the assistant handed to the team and left active.
- Small, not part of this ticket's claims: when only the simulator side panel is shown or hidden, the *empty* reply box keeps the height it had (the row's width changes without a window resize). With the panel shown the row is narrow (about 150 px for the box at 1440 px) and the placeholder wraps to two lines; after hiding the panel the empty box can stay two lines tall, or after showing it one line, until the next keystroke or window resize. Measurements are in `receipt.json` under `note`.
- In picture 3 the recording line ends in "…": the sentence is longer than the row at this width and is shortened by its own styling; nothing covers it.

Pictures: names, initials and phone-like numbers are masked; the list of other conversations is masked. Details and measurements: `receipt.json`.
