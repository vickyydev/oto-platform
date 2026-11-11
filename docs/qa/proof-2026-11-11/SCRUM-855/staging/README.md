# SCRUM-855 staging proof — 11 November 2026

OTO App staging, deploy `dep-dbqarmvf3r2c73c66el0`, live 18:05:33Z at
`545795e2d6183989f7c5028571c5d8dd03a60e1f` (`deploy-wait.json`); the signed-in
app reported that version in every run. Only ZZ TEST records and synthetic
media. Summary `receipt.json`, script `proof.mjs`, raw receipts per run.

## The recording with no length (attempt 01)

The raw in-page MediaRecorder WebM, nothing written into its header: 10,225,147
bytes (9.75 MB) of canvas noise, the browser reports its length as `Infinity`.

| Check | Result | Values |
| --- | --- | --- |
| Upload from the browser | Pass | bucket PUT refused, then `POST /api/checklist-media/upload` **200** in 2.6 s (it answered 500 before the fix); bar 10, 19, 45, 74, 95 |
| Read back through the app | Pass | `GET /api/checklist-media/by-item/…` 200: width 1280, height 720, **durationSeconds null**, size as sent |
| Plays in the app viewer | Pass | readyState 4, currentTime 1.90 s then 2.07 → 2.77 s, not paused, no error; the browser still reports `Infinity` |
| Clean-up | Pass | attachments deleted 200, URL read 404; checklist deleted 200, read 404; run read 404; sign-out 200, read 401 |

Width and height were stored, so the browser had finished measuring the file
before the form left: the length it held was `Infinity`, and it was not sent.

## The video with its length (record only)

Accepted 200 in four runs of four, stored at its sent size. Its width, height
and length were stored as not known each time. Attempt 02 read the form the
browser sent: it left 168–175 ms after the file was chosen with no measure in
it, while the browser needs about 200 ms to measure a file of this kind
(measured locally). The queue does not wait for the measuring; this fix does
not change that, and the SCRUM-850 runs show both outcomes. In attempt 02 the
no-length video also left before it was measured (200, all three not known).

Attempt 01's receipt says `passed: false` only because the script expected a
stored length of 6 here; the brief makes this part record only.

## Not shown on staging

A failed save removing the stored file: it needs the table to refuse a row.
Covered by `tests/checklist-copies.check.ts` (the SCRUM-855 checks at lines
1674 and 1690). CI run 43074022961 for this commit was still pending at 18:13Z.
The object attempt 01 of SCRUM-850 left behind was not touched.

## Pictures (each opened before use)

`855-1-no-length-video-on-item.png`, `855-2-no-length-video-playing.png`:
dialog and viewer crops, the user menu covered, no name, initials or photo of
a person in frame.

Jira: pictures attached, one comment, In Progress → Testing → Deployed
(`jira-proof.json`).
