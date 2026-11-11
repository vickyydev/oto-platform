# SCRUM-850 staging proof — 11 November 2026

OTO App staging, deploy `dep-dbq9odbl550s73fev8i0`, live 16:50:41Z at
`930c4e82c930d71186aec891578d18483ed61a66` (`deploy-wait.json`); the signed-in
app reported that version before and after every run. Only ZZ TEST records
and synthetic media. Final run: attempt 03, `receipt.json`, script `proof.mjs`.

| Step | Result | Values |
| --- | --- | --- |
| 1 ZZ TEST checklist, one item | Pass | 201 |
| 2 Photo from the browser | Pass | bucket PUT refused in the browser, then `POST /api/checklist-media/upload` 200; 583 bytes, 0.7 s; shows on the item |
| 3 Synthetic video | Pass | 10,107,311 bytes (9.64 MB), same route 200, 4.0 s wall (3.8 s request); stored size equals sent size |
| 3 Progress moves | Pass | sampled every 200 ms: 10, 16, 19, 28, 34, 39, 45, 54, 60, 66, 75, 81, 86, 95, then 95 for about 1.3 s while the server passes the file on; 12 values strictly between start and end; picture taken at 22–28 % |
| 4 Playback in the app viewer | Pass | readyState 4, currentTime 1.83 s then 2.07 → 2.78 s, 1280×720, not paused, no error |
| 5 Memory around the uploads | Recorded | `memory.json`, one request, 30 s steps: 181–183 MB before, 196–225 MB across the three runs (peak 225.2 MB). It includes everything else the service did, and 8–10 MB files say little about a 200 MB one |
| 6 Over the limit | Not tried | it would send 200 MB to staging; covered by `tests/checklist-copies.check.ts` and `tests/s748-upload-queue.check.ts`. In CI run 43061998617 those steps were skipped: the `oto-app` job stopped earlier (see ../../SCRUM-851/staging) |
| Clean-up | Pass | both attachments deleted 200, URL read 404; checklist deleted 200, read 404; its run read 404; app and launcher sign-out 200, read 401 |

Attempt 02 passed the same way (9.77 MB, 4.2 s, 11 values between start and
end, playback 1.75 s); its viewer picture is not kept, because the dark viewer
reaches the page's top right corner and attempt 03 covers the user menu there.

## Attempt 01: a recording with no length is refused

The video was the raw browser recording (8.74 MB). The bar moved 10 → 95, then
the route answered **500** and the row read "The upload did not go through.
Try again, or use a smaller file." (`850-5-plain-line-when-refused.png`).
Server line (`attempt-01/server-log-line.json`): Postgres 22P02, `invalid
input syntax for type integer: "NaN"`. A browser recording carries no length:
the browser reports `Infinity`, the client sends it as `durationSeconds`, the
route's `parseInt` makes `NaN` and the attachment row is refused after the
file is already in the bucket. Both lines pre-date this change (present at
`bc528bc3c^`). Attempts 02 and 03 write the 6 s length into the recording's
header, as a file from a phone has, and the browser then reports 6.

Left behind: that one 8.74 MB synthetic object has no row, so no app route can
remove it (under the attempt-01 checklist's item folder). Not fixed here.

## Pictures (each opened before use)

`850-1-photo-on-item.png`, `850-2-video-progress-mid-bar.png`,
`850-3-video-on-item.png`, `850-4-video-playing.png`,
`850-5-plain-line-when-refused.png`. Dialog and panel crops; the video is
canvas noise with a moving colour block and a ZZ TEST caption, no person and
no sound. No name, initials or photo of a person is in frame.

Jira: pictures attached, one comment, In Progress → Testing → Deployed
(`jira-proof.json`).
