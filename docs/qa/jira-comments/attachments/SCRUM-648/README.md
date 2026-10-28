# SCRUM-648 staging acceptance — 28 October 2026

Source `f5b6d333214e00232e6cc57911352d0dd530c02d`, successful CI run40699675499.
API/Console/POS/launcher auto-deployed; the last completed at14:12:53Z.
The final native walkthrough ran14:18:30–14:19:12Z. Every PNG was inspected.

| PNG | Observed result |
|---|---|
| 03 privileged-subject-refused | Actual403 keeps the refusal and entered subject visible. |
| 04 console-active-banner | Administrator sees the live read-only window and End now. |
| 05 launcher-active-banner | Same actor session carries the banner on the launcher. |
| 06 pos-read-only-banner | Reception subject's settled station picker carries the banner. No station was taken. |
| 07 subject-session-history | Subject sees who opened the current read-only window. |
| 08 window-ended | Console returns to the settled form with no active banner/window. |
| 09 subject-ended-history | Subject history records that the administrator ended it. |
| 10 audit-and-read-only-proof | Labelled evidence card:15 native request rows retain both identities; PATCH/me refused403 and the ended session refused401. |

The bound JSON records exact image hashes, capture/deploy times, source SHA,
window id, native responses and cleanup. The audit query ran in a read-only
transaction on staging; no table was changed to produce the audit proof.
The launcher reused the same actor session through its API proxy, privately
in memory. No cookie, handoff URL, credential or benefit QR was recorded.
All three exact test sign-ins ended with200 and subsequently returned401.

Earlier diagnostics are retained outside the repository. The first two exposed
the refusal bug; a pre-fix diagnostic checked the remaining controls. A first
post-fix capture caught two loading transitions. The final v5 walk replaces
those frames with settled screens and is the sole acceptance set here.

Known gap: Inbox, Radar and the OTO App screens do not display the view-as
banner. This evidence proves only Console, launcher and POS. It does not
claim new lookup sources or the separate OTO scheduling-audit follow-up.
