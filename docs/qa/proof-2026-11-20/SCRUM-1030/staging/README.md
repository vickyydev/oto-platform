# Kitchen Notes proposed from a chat, on staging (SCRUM-1030)

oto-app-staging, signed in through the launcher as the staging administrator,
on main `f986953f9` (deployed by name at that commit, live 02:28:54 UTC on
20 November 2026). Only the party "ZZ TEST 1028 Staff BEO" was opened;
nothing was approved or saved.

- `scrum-1030-finish-staging-ai-fill-kitchen-notes.png` (02:41 UTC): AI
  Fill's review on a pasted ZZ TEST exchange in which the family asks the
  kitchen to cut the sandwiches into small triangles: the Kitchen notes row
  shows the held notes, the chat's wish under them and "Use the chat's";
  nothing is written until a person takes it. The same press is described in
  `../../SCRUM-1031/staging/README.md`.

"Fetch from chat", which now offers Kitchen Notes the same way (the typed
text struck through, the chat's words under it, kept unless taken), is the
button a party linked to an inbox conversation has. The ZZ TEST party on
staging has no conversation linked, so that dialog is shown in the local
pictures of this ticket (`../local/fetch-768-kitchen-notes.png`) and checked
by `apps/oto-app/tests/beo-fill-guests-socks.check.ts`; the server reads the
chat through the same code for both.
