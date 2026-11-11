# SCRUM-856 staging proof — 11 November 2026

OTO App staging, deploy `dep-dbqb5bt9fdbs73c557ig`, live 18:26:10Z at
`14a7bcdf1e83c371050e70bb5d45a4f962f4a9ca` (`deploy-wait.json`); the signed-in
app reported that version before and after. One run of `proof.mjs` in a new
browser profile, 18:29:02–18:30:24Z, `receipt.json`. Only ZZ TEST records and
synthetic media; a fresh ZZ TEST checklist with one item for every upload.

## The video with its length: five of five

A 6-second 1280×720 synthetic WebM each time (9.9–11.0 MB). The form the
browser sent was read as it left, never changed.

| Run | Form left after the file was chosen | Measures in the form | Answer | Read back (`by-item`) | Label |
| --- | --- | --- | --- | --- | --- |
| 1 | 458 ms | width 1280, height 720, durationSeconds 6 | 200 | 1280 × 720, 6 | 0:06 |
| 2 | 452 ms | 1280, 720, 6 | 200 | 1280 × 720, 6 | 0:06 |
| 3 | 386 ms | 1280, 720, 6 | 200 | 1280 × 720, 6 | 0:06 |
| 4 | 383 ms | 1280, 720, 6 | 200 | 1280 × 720, 6 | 0:06 |
| 5 | 465 ms | 1280, 720, 6 | 200 | 1280 × 720, 6 | 0:06 |

Every form held `file`, `target`, `checklistTemplateItemId`, `width`, `height`
and `durationSeconds`; every answer came from `POST /api/checklist-media/upload`.
Before this change the form left at 168–175 ms with no measure in it
(../../SCRUM-855/staging).

## Once each

| File | Form | Answer | Read back |
| --- | --- | --- | --- |
| Synthetic photo, 320 × 180, 583 bytes | left at 162 ms with width 320, height 180 | 200 | width 320, height 180 |
| Raw recording with no length, 10.43 MB | left at 463 ms with width 1280, height 720, no durationSeconds | 200 | width 1280, height 720, durationSeconds null; no label; plays in the viewer (readyState 4, currentTime 1.91 s, no error) |

## Clean-up

Seven attachments deleted 200, URL read 404; seven checklists deleted 200,
read 404; the one run read 404; app and launcher sign-out 200, read 401.

## Not shown

The waiting limits (1.5 s for a photo, 3 s for a video) and a file whose
measuring fails: no such file was made here; they are in
`tests/s748-upload-queue.check.ts`. CI run 43077349746 for this commit was
still pending at 18:31Z. No in-app view lists an attachment's measures, so
there is no second picture; the read-back is the API's.

## Picture (opened before use)

`856-1-video-length-label.png`: the item's media strip in the editor with the
0:06 label (run 1). A dialog crop; no name, initials or photo of a person.

Jira: picture attached, one comment, In Progress → Testing → Deployed
(`jira-proof.json`).
