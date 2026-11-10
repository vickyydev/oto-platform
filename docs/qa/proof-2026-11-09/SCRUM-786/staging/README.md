# SCRUM-786 A role word before a team name is not the name: staging proof

Same run as `SCRUM-818/staging` (10 November 2026, 14:23-14:31 Bangkok,
oto-app-staging live at `608e3c0ba23e385a6ffd0eac34421196a57ca6a6`, the
staging administrator, name masked).

A ZZ TEST employee "ZZ GM" was made at Central Floresta in the Event
Department, with no login (`POST /api/employees` 201), and removed after the
run (`DELETE /api/employees/:id` 204, then 404).

| Check | Result | Picture |
|---|---|---|
| Russian paste "… Ведущий: ZZ GM …" on "ZZ TEST 818 party" | Pass: the answer's `partyHost` is `asked "ZZ GM"`, matched to the employee "ZZ GM (ZZ GM)"; after Approve and create, the rest of the fill's Team section reads "Party Host: ZZ GM (ZZ GM) — the message says "ZZ GM". Tick to assign.", unticked | `786-st-01-ru-paste-rest-team.png` |
| Thai paste "ยืนยันวันเกิดน้องมีชา 21 พ.ย. 14:00 เด็ก 10 คน พิธีกร ZZ GM" on a second event "ZZ TEST 818 thai" | Pass: `POST /api/ai/parse-beo` 200 in 8.3 s, the catalogue review opens (no package named); the answer's `partyHost` matches "ZZ GM (ZZ GM)"; "Load into Editor instead" shows the Team section "Party Host: ZZ GM (ZZ GM) … Tick to assign.", unticked; closed without loading | `786-st-02-th-paste-review.png`, `786-st-03-th-paste-preview-team.png` |
| Nothing assigned | Pass: the suggestion is unticked in both; nothing was loaded or saved from the Team section | — |

## Notes

- In both runs the model itself already gave the bare name ("ZZ GM"), as the
  prompt now asks, so the server's clean-up of "พิธีกร"/"Ведущий" was not
  the step that made the match here; the end result is the one asked for.
- The Russian paste's "Аниматор: Zombie game" came back as the Entertainment
  Host "Zombie game", which "matches nobody at this park: choose the host in
  the form" (shown, not assigned).
- The Thai preview shows empty "Setup Plan" and "Kitchen Plan" boxes.

Clean-up: see `SCRUM-818/staging/README.md`.
