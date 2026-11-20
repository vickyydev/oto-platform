# AI Fill's expected extra guests and socks, in a local build (SCRUM-1031)

20 November 2026, lane `lane/beo1029b-20261120`. Not staging: nothing of this
stage is deployed. AI Fill's review and the Fetch from chat dialog were built
for a browser from the lane's own source (esbuild and the app's Tailwind
CSS) and opened in Chromium on a ZZ TEST party whose chat answers were local:
no server, no database, no model, no real party. The proposal the pictures
show is the one the review gets when the family writes "My sister may bring
her 2 kids too", "and the grandparents, 6 more adults" and how the socks are
paid.

Each picture was taken at 768 x 1024 and 820 x 1180 (tablets upright),
1024 x 768 and 1133 x 744 (on their side), 1366 x 1024 and 1920 x 1080 (a desk
screen), looked at and measured: nothing wider than the dialog, nothing cut
off, no sideways scroll. The review is 768 px wide at every size, Fetch from
chat 672 px, so one size of each is kept here.

- `review-768-expected-extra-and-socks.png`: the review's Package part. After
  the package and its add-on, one "Expected extra" row in the editor's words,
  "+ 2 children + 6 adults", each count with its "from the family" mark and
  the chat's words under the row; "Socks" with the editor's options, "Other /
  Custom" chosen and its note in its own box.
- `review-1024x768-dialog.png`: the same part in the whole dialog on a tablet
  on its side, above the POS part and the buttons.
- `review-768-long-socks-note-touch.png`: a long socks note on a touch
  screen: the note's box keeps its width and the chat's words wrap under the
  row. The note here is longer than the 200 characters a party stores, to see
  the wrap; the read refuses such a note.
- `fetch-1366-guests-socks-kitchen-notes.png`: Fetch from chat on the same
  chat, with the form holding 4 extra adults, "Guests Pay Individually" and
  typed Kitchen Notes: each change on its own row to accept or decline, the
  Kitchen Notes with the chat's line under the typed text.
