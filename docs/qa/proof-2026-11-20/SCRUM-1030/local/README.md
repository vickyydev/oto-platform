# Fetch from chat's Kitchen Notes, in a local build (SCRUM-1030)

20 November 2026, lane `lane/beo1029b-20261120`. Not staging: nothing of this
stage is deployed. The Fetch from chat dialog was built for a browser from the
lane's own source (esbuild and the app's Tailwind CSS) and opened in Chromium
on a ZZ TEST party whose chat answer was local: no server, no database, no
model, no real party. The form holds the typed Kitchen Notes "ZZ TEST cut
everything small (typed by staff)"; the chat says "No chilli in any of the
food please".

Taken at 768 x 1024, 820 x 1180, 1024 x 768, 1133 x 744, 1366 x 1024 and
1920 x 1080, looked at and measured (the dialog is 672 px wide at every
size): nothing wider than the dialog, nothing cut off, no sideways scroll.

- `fetch-768-kitchen-notes.png`: the Kitchen notes row: the typed text
  struck through as what the form holds, then the same text with the chat's
  line under it, as accepting would leave it; the chat's words, whose line
  they are and when. The rows above are the expected extra guests and the
  socks of SCRUM-1031.
- `fetch-768-long-note-touch.png`: the same on a touch screen with a long
  socks note: every row wraps inside the dialog.
