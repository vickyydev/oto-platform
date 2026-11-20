# AI Fill reading the expected extra guests and the socks, on staging (SCRUM-1031)

oto-app-staging, signed in through the launcher as the staging administrator,
on main `f986953f9` (deployed by name at that commit, live 02:28:54 UTC on
20 November 2026). Only the party "ZZ TEST 1028 Staff BEO" (Central
Floresta, 10 December 2026, 11:00 to 14:00) was opened. Each picture was
looked at before it was kept; no staff name is on them. Nothing was approved
and nothing was saved by these presses.

## What was done

A short made-up ZZ TEST exchange pasted into the editor's own AI Fill and
"Parse with AI" pressed. The family writes that two more children and one
more adult may come, that they bring their own socks for everyone, and asks
for no nuts in the kitchen; the team's last line offers a second cake for the
adults, and nobody answers. Two presses:

- 02:32 UTC: the exchange as above. The review proposed "Expected extra"
  +2 children and +1 adult with the chat's line under each count, "Socks"
  Other / Custom with the note "We will bring our own socks for everyone.",
  and no second cake (Cake: "Not said"). The nut line was proposed under
  Special requests ("Allergy: ..."), not under Kitchen Notes, which already
  hold "no peanuts anywhere in the kitchen". The model answered after the
  step's four-minute wait, so this review was read and closed by a later
  step; its pictures were not kept.
- 02:41 UTC: the same exchange with one more wish from the family, "could
  the kitchen cut the sandwiches into small triangles for the little ones?"
  (and the team's line repeating it). The review proposed the same guests
  and socks, the sandwich wish for Kitchen Notes beside the held text with
  "Use the chat's", the nut line under Special requests, and no second cake.
  The pictures below are of this review. Closed by its close button.

In the pasted-message mode every value is marked "from the team": the pasted
text is read as the team's confirmation (the review says so at its top).

## The pictures

- `scrum-1031-finish-staging-ai-fill-expected-extra-and-socks.png`: the
  Package part of the review: "Expected extra: + 2 children + 1 adults", the
  chat's words under each, "Socks: Other / Custom" with the chat's words.
- `scrum-1031-finish-staging-ai-fill-kitchen-notes.png`: the Kitchen Plan
  part: the held Kitchen Notes, the chat's sandwich wish under them with "Use
  the chat's", and "Cake: Not said".
- `scrum-1031-finish-staging-ai-fill-review-whole.png`: the whole review,
  with the Special requests rows ("Allergy: no nuts in the kitchen at all")
  and the Timeline ("The chat gives no timed steps").

## What is left on staging

Nothing from these presses: the review was closed without approving, twice.
