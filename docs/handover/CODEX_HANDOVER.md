# Hand-over to the next agent session — 28 September 2026, evening

## Resume note - 13 October 2026 - round-7 release checks

**13 October 2026, R7b landing gate complete:** Full hosted run38303168097 passed all six jobs on2b84a5afdc3fd2ced31e2df05f1d7b153ab6b1ab. Whole workspace typecheck is clean, API has zero diagnostic lines, touched review lint passes and the current-chain replay proof passes with required document ownership. Rebase on origin/main d18d3fd8 was a no-op and all six candidate commits remain. Subsequent changes are staging evidence and checkpoint documents only; application, migration and test source are identical to the green candidate.

This landing carries app0010 after the new owning document writer was observed on staging. Main's landing run must be watched by full SHA; staged0010 verification is still owed. The last observed app remainsd18d3fd8 through0009. R8b4fa425d also passed all six jobs in38303242637, including the genuine eleven-migration restore and457/61/120 compiler baseline; land it after the R7b main gate. Combined feature PR10 is separately checking142cc3dd. Feature acceptance, one authorized SMS test and exact broader cleanup remain. Local databases stay off; SCRUM-223 stays paused.

**13 October 2026, private-file release evidence:** On stagingd18d3fd8, all four existing synthetic payroll CSVs and the payslip PDF returned own200/foreign403/anonymous401. The Fix image and test drop-off signature returned own200/foreign404/anonymous401. The event PDF returned own302/download200 with a49106-byte PDF, foreign404 and anonymous401; its exact object fingerprint is refreshed for cleanup. The inspected r7-private-files-release-rechecks-20261013.png and module page record these results. The recorded R7 module rechecks are complete; exact broader fixture/object cleanup and final acceptance reconciliation remain.

Combined features are published in PR10 atb4265ee1; all matching ticket statuses were checked and commented. Final presence recovery outside both live tabs is committed at07a99a9f but not yet published. The combined candidate's hosted workspace compiler identified two nullable fixture accesses in the historical R6 review; that bounded correction is in progress. R7b2b84a5af and R8b4fa425d gate jobs continue; their workspace/API typechecks are clean, and R8's full app compiler is exactly457/61 files/120 buckets. Hosted restore counts repeat exactly across both restores:184 source tables/1108 rows,187 app tables,5 views and11 migration entries; cleanup complete. Do not claim a full candidate pass until every job finishes. Local databases remain stopped; main stays green.

**13 October 2026, administration and voucher staging evidence:** The isolated person was created201 in the expected park, read200, assigned a selected-branch policy200 and updated through own bulk permission control200 (one update). Foreign person/policy reads, policy writes, deletion and Data Admin read/update/delete each returned404; a foreign branch replacement returned403. Foreign bulk update reported zero updates/one skipped and left the policy unchanged. Exact person/policy cleanup returned200 and both reads404. All seven legacy voucher mutation routes returned409/vouchers_moved; no voucher was issued or redeemed. The inspected r7-administration-voucher-rechecks-20261013.png records these controls. Remaining R7 work is final private-file rechecks and guarded fixture/object cleanup; the shared practice park is still retained. R7b2b84a5af and R8b4fa425d are published with their corrected historical expectation; hosted gates continue. Combined feature integration and presence recovery checks continue separately. Main remains green atd18d3fd8; no additional release is claimed. Local databases remain stopped.

**Newest checkpoint, 13 October:** main d18d3fd8 is green and observed live. Camp attendance, payroll access and actual form save/reload rechecks pass with two inspected frames. R7b3c8 and R8 973 each have one historical complete-chain nullable assertion corrected at84829a82; five other jobs passed, including R8's final eleven-migration restore. Combined candidate da21a661 has cumulative0011..0015 migrations and employee-history/current-access delivery controls; hosted runtime checks and two presence display/retry follow-ups remain. Read newest STATUS. Keep local databases/heavy checks off. One coordinator publishes; isolated agents work in parallel. Land R7b then R8, finish staged checks/cleanup and feature acceptance, then the fix block. No feature/SMS delivery is claimed.

**Live prerequisite now verified:** app7402a8da is deployed, migrations through0009 are observed, all four document tables have zero unplaced rows, and the new Data Admin writer returned201/own200/foreign404. Its disposable row was removed204/read404; an inspected staging card records the gate. Continue R7b/0010 and then R8. SMS service configuration is active; the returning-family feature is built in PR8/cb27d078 with23 controls, but not deployed and no SMS sent. A controlled test recipient is in local env only. PR4-7 have their R7 integrations; newest STATUS gives exact commits. Docker/local database checks are unavailable while the owner uses the workstation: all completed DB fixtures are removed and native15433 was shut down. Use hosted CI and lightweight development; do not restart local databases until authorized. Continue the combined feature candidate and SCRUM-516 consistency work; reserve final app0011 SOP/0012 attendance/0013 presence/0014 SMS after0010, regenerating combined snapshots at landing.

**Latest checkpoint:** R7a is on main at7402a8da2614214c41085277a86b0c4637abff66 and PR1 is merged. CI38294258814 passed every job. App deployment dep-db6j2btg1s2s739gqjcg is running on that full SHA. Staging remains633cae41 until observed. Observe the new owning writer before R7b/0010. PR3-7 hold import, Fix preview, SOP history, attendance evidence and inbox delivery; all five tickets are Testing, with release integration and staging proof owed. SCRUM-522 SMS development continues: three Twilio settings are validated and saved on staging but the running instance has not activated them. Six-digit provider configuration is verified without sending. The owner authorized one test to local TWILIO_TEST_RECIPIENT when supplied; never print or publish the number. Existing review/movement actions meet normal item7 scope, with staged acceptance and bounded consistency work under516. Read newest STATUS, OPEN_ITEMS and the delivery board; do not repeat completed broad checks for these documents.

**R7a release checkpoint:** full CI38291346882 passed on67eadb261f8220444dc2cfa336339aff0003425c; subsequent changes are documentation only. Final API output is zero bytes and the six historical reruns passed228 controls. The older local full batteries were stopped after equivalent-source CI passed; preserve their partial logs without claiming a local pass. The source rebase preserved all44 commits against a81fcb89. This checkpoint carries the R7a main landing: watch its actual full SHA, then observe the new owning document writer on staging before R7b/0010. Current app633cae41 remains the last observed deployment. Continue the isolated feature batches while main CI runs; no staging action if main is red. Read newest STATUS for gate evidence and next source checkpoints.

**Latest published work:** draft PR1 is R7, PR2 R8, PR3 import presentation (SCRUM-518, Testing), PR4 Fix recipient preview (SCRUM-517, In Progress pending R7 canonical-person integration). Preserve individual commits at landing and use frequent PRs; one coordinator remains the publisher. SOP history SCRUM-519 and attendance attachments SCRUM-520 are locally built in isolated lanes and in focused review. Presence delivery SCRUM-521 is building after the owner answered feature Q3: staff in-app inbox. Read the newest STATUS and DELIVERY board for source commits, checks and limitations. These are development checkpoints, not staged releases. Do not restart broad checks for progress documentation.

**Newest steering, 13 October:** prioritize completing development in visible feature batches. Read the [delivery board](../progress/plans/otoapp-lift/DELIVERY.md). Use focused checks while building; consolidate the broad checks at each final release gate. Preserve the checks already running and their results rather than restarting them. Work on independent approved development while those checks complete. R7 source is built, R8 tooling and its measured 457 ceiling are being finalized, and SCRUM-194's original seven requirements are being reconciled for implementation. This changes the work sequence below: completing existing checks is not a reason to leave independent development idle. The R7a/new-writer/R7b release dependency and full landing gate still apply.

This note supersedes the history below. Read AGENTS.md, then the newest STATUS block, OPEN_ITEMS and the lift PLAN. The owner approved three isolated preparation/review lanes; one coordinator alone integrates, publishes, handles staging/Jira and assigns final migration numbers.

Rounds 1-6 are landed and live. Round-6 eight-page and round-5 ten-page evidence is committed and attached to SCRUM-191; exact fixture/object cleanup completed. Main a81fcb899e8376dd84bbe0bdf1320d3ce2d52368 has green CI 38240328400. The lifted app still runs 633cae416ff7e4a1c253ec4904cdc22351cf7df1 with migration 0008. The shared ZZ TEST park/user remains for round 7 and final cleanup. Preserve Som's 14 October sick day, the seeded cast and protected payment run 0d008153.

Round 7 is built locally on lane/s217b-r7 and published for review, not landed or deployed. Final payroll review passed24 controls; the recorded form/home-branch corrections passed4 controls. The full release battery, final compiler/build, staged new-reader rechecks and cleanup are still owed. Read the newest STATUS block for current test-workflow state. Ten inspected staged frames and the round-7 index record current actions; camp attendance and another park's payroll export still need the staged release recheck. SCRUM-516 groups finance, administration, camp, permission and payroll ownership delivery. Independent permission/private-photo review has 15 green bounded pins on cf6c21a4. The payroll reviewer records seven parent/context findings across all 45 registered routes; the builder applies them as one batch. R8 tooling has 17 green pins and the genuine 11-migration rehearsal is running separately.

Final compiler is now457 diagnostics/61 files with no bucket increase. DB and POS timeout cases passed their full-file reruns; booth and box passed. Full API battery and historical review-boundary maintenance continue. The new drop-off submission and refusal frame is recorded in STATUS; nanny completion and exact cleanup remain owed.

Frozen API0 lines, appbuild and all39 touched-file lint checks have now passed. The277-file API battery and focused reruns remain open. Nanny assignment/entry/checkout and voucher/Xero unconnected pages are evidenced; exactcleanup remains owed.

Next, in order:
1. Complete the full API battery, historical release-boundary rechecks, final API typecheck, actual touched-file lint and build. Payroll24 and form/home-branch4 controls already pass. API output must be zero lines. The inherited app ceiling is467 per file/code; the whole integrated read is457 with no increase, ready for the explicit R8 ratchet.
2. Land R7a with app 0009, keeping document ownership nullable while new writers ship. Watch CI by full SHA, check/comment Jira in the push turn, and observe the new writer on staging. Then cut R7b from origin/main and apply 0010's document contraction, with its own full gate. Independent four-pin R7b verification already passed against 2c706198; final release/staged verification remains owed.
3. Finish every round-7 module page/action/refusal, attach the inspected proofs, and remove exact ZZ TEST records/objects including the shared practice park/user. No secret capabilities belong in ledgers or screenshots.
4. Land R8: genuine restore against the final 0..10 chain in CI, measured app typecheck ratchet, acceptance index and Decision 25. Walk SCRUM-193 only when its five checks are actually evidenced. SCRUM-191 remains open for its separate SCRUM-194 scope, whose original seven items are the working scope in its coverage plan; do not claim the whole umbrella complete.
5. Follow OPEN_ITEMS section 2 in its worked order before any new story, beginning with SCRUM-276. SCRUM-223 stays paused.

Platform next migration is 0076. App staging is applied through 0008; reserved release sequence is 0009 then 0010. Shared-role Q54, historical-person Q56 and global rate-limit Q57 defaults remain recorded expected-failure pins; Q55 preserves repeated finance report labels. Scheduling Q39 remains BROKEN in its existing fix-block lane. The newest STATUS block always wins.

Written for: the coding agent (OpenAI Codex, or any other) that resumes this repository
in the same working folder, and for the owner setting it up. Everything below was true
when it was written; verify the live state from `docs/progress/STATUS.md` and the newest
STOP POINT block of `docs/progress/SESSION_HANDOVER.md` before acting.

## Resume note - 5 October 2026 - Lucky Wheel park update

The latest task is SCRUM-499/500: editable bilingual slips and six temporary current-POS prize QRs, plus the approved seventh Kids Pizza prize. Staging software is deployed with attached evidence; the owner is at the park installing the verified 7eca661 Pi package. Read STATUS and the newest STOP POINT first. Physical install/publish/print/scan confirmation and Console CI rerun conclusion remain. The exact commands and static/dynamic QR steps are in docs/qa/voucher-slip/update-at-park.md. Preserve the saved draft until the Pi has compatible software.

## Resume note - 1 October 2026 - SCRUM-193 break checkpoint

The owner requested a break after saving all current OTO App work. SCRUM-193
(S2-17b) is still In Progress; it has not met the platform and full-module
release gates. OTO App staging is live at exact source `547532f2` with the
offboarding, Fix and Timekeeping repairs and real screenshots; all disposable
fixtures from those runs were removed. Read the newest SCRUM-193 STOP POINT in
`docs/progress/SESSION_HANDOVER.md`, then the acceptance index and closure plan
before resuming. Do not start the next ticket until the owner asks. The owner
accepted display-only Ask OTO titles and confirmed that no Xero sandbox is
connected yet. Keep the two repository lanes separate.

## Resume note - 30 September 2026 - stop and wait

The break checkpoint is saved. Do not start new work until the next instruction.
The Lucky Wheel bench/demo and the old bench branch are historical completed
work. SCRUM-201 and SCRUM-285 are Deployed with named staging screenshots.
Current SCRUM-206 follow-ups are deployed and verified; its full story remains
In Progress for separate To Do SCRUM-269 offline trading. No subtasks remain
under the current stories, and SCRUM-269 has not been started.

Live POS source is 0683ffd1; API, Console, Launcher and Booth are b31b01b7.
Main also carries the evidence and checkpoint documentation. Manual Render
deployment was authorised while GitHub Actions billing prevents jobs from
starting; CI is not green. No new CI-packed Pi release was produced. The
Desktop still holds the previously verified 0468c38 archive and checksum.
Migration 0033 completed after the old API readers had retired; the earliest
compatible API rollback is 85d35e0. Do not deploy older API code.

Read STATUS and the newest 30 September STOP POINT for exact evidence, current
limits and protected simulated-payment records. Successful public consent Done
is locally proven; staging verified its required real-photo/staff-readiness
guard without fabricating a photo. Physical display acceptance is separate.
Section 4 below is historical; keep its shared contract names unchanged.

## 1. What this is, in five lines

OTO Park is an indoor children's play park in Phuket. This repository is its operations
platform: a POS (the tills), a Console (administration), a public booking site, a suite
launcher, the lifted "OTO App", and a **box** — a program that runs on a Raspberry Pi 5 at a
**Lucky Wheel booth** in the mall. A child presses a red button, a wheel spins on a
television, a voucher slip prints, and the family redeems the slip at the park's till. The
platform, the Console and the box all exist and run on staging; the owner is bench-testing
the booth on a real Pi with a real printer and a real button.

## 2. Where the work stands (28 September, ~18:00 Bangkok)

**Landed on `main` today** (all pushed, CI green or in flight, staging follows CI):

| Commit | What |
|---|---|
| `c34ec17` | Pi installer option `--printer-direct`: the receipt printer plugs straight into the Pi's Ethernet socket; the guide's direct-cable standard |
| `5838eb6` | The printer gets its address from the Pi (dnsmasq on the printer cable), because an Epson asks for one and has no fallback |
| `08ffe66` | The television service tells Chromium the desktop runs Wayland (it looped "Missing X server" before) — **the current Pi release: `oto-box-0.1.0-08ffe66.tgz`** |
| `42564c3` | `GET /boxes/:id/log` — the Console's Box log section reads what the box last handed over (its `collect_logs` command result); the section re-reads every minute, Refresh asks the box first |
| `c416065` | The OTO App's old voucher module switched off; every old address shows "Vouchers have moved to the Console" |
| `8c78042`, `96f7747` | Docs: the first real Pi run's findings; the stop point |

Also done, no code: `VITE_BOOTH_URL` set on the staging **launcher** through the Render API,
so the wheel's tile reads "Open" (render.yaml does not carry it; that file has another
session's uncommitted block and must not be committed).

**The owner's bench Pi** runs `c34ec17` plus the printer-address and television repairs
applied by hand, which equals `08ffe66`. It is claimed as box "FortuneWheelBox" with
booth "FortuneWheelBooth" (prefix FW) on staging, the Epson TM-T82IV on the direct
cable at 192.168.192.168:9100, and the red button (a Tezuo foot-switch board, set to
send Space with its maker's program). He has played the game on it.

**Stopped part-way (token limits) and kept on the branch `wip/bench-round-1`
(`3bd9b06`, two commits on top of `c416065`, NOT merged, none of it typechecks):**

- box side of "print at the reveal": `packages/box-agent/src/booth.ts`, `booth-http.ts`,
  `printing/index.ts`, `printing/queue.ts` — the press no longer waits on the printer and
  the job is held for a later print call; the call, the kiosk route and the page's part
  were not reached;
- migration `0027_booth_pin_expiry.sql` + `meta/0027_snapshot.json` + `_journal.json`,
  `packages/db/src/schema/platform.ts`, `packages/db/src/seed/index.ts` — the PIN expiry
  column (`core.credential.expires_at`);
- the API's half-written PIN rule, generate and expiry (`apps/api/src/routes/booth.ts`,
  `services/booth-admin.ts`), the staff scope's `pinExpiresAt` (`services/sync.ts`), a
  748-line `services/voucher-ledger.ts` draft and a route stub in `routes/vouchers.ts`.

Nothing of the wheel page's button-only sign-in, the kiosk print/staff routes, or the
Console's Vouchers page, Spins panel and set-up checklist was started.

## 3. The immediate next steps, in order

1. Read this file, `docs/progress/STATUS.md`, the newest STOP POINT block of
   `docs/progress/SESSION_HANDOVER.md`, and `docs/ops/PI_BOOTH.md` sections 1–7.
2. Decide: **finish from `wip/bench-round-1`** (check out the branch into a work branch,
   make it typecheck, complete the brief) or **restart from `main`** with the brief below.
   Finishing from the branch saves the box-side and migration work; the API drafts are
   large and unchecked, so read them before trusting them.
3. Build the six changes of section 4 as one round, quickly, without new test suites:
   run only the existing tests of the files you touch (`vitest`, with
   `TEST_DATABASE_URL=postgres://oto:oto@localhost:5433/oto` where a test needs the local
   database), typecheck and lint the packages you touch.
4. Land on `main` in a few commits (one per area), push, watch CI (`gh run list`,
   `gh run watch <id>`), let staging deploy (`node scripts/session/render-deploys.mjs`,
   `node scripts/session/render-wait.mjs <sha7>`).
5. CI packs the Pi release as the artifact `oto-box-<full sha>`: download it
   (`gh run download <run id> -n oto-box-<sha>`), verify `sha256sum -c`, put
   `oto-box-0.1.0-<sha7>.tgz` and its `.sha256` on the owner's Desktop
   (`C:\Users\waqar\OneDrive\Desktop`, one release at a time; older ones go to
   `old-oto-box-releases`), and tell the owner the name and checksum. He updates the Pi
   once: guide section 7, "Update" (the section 3 commands with the new file's name,
   without `--api`).
6. Jira: create one ticket per significant part of the round in the current sprint
   (print at the reveal; button-only sign-in; booth PIN rules; Console vouchers ledger,
   spins panel and checklist) with `createInSprint` from `scripts/session/jira-lib.mjs`,
   linked in the comment to SCRUM-198; a status change and a comment in the same turn as
   each push; small fixes and follow-ups go under the ticket they belong to as progress
   comments; Deployed only with a staging screenshot attached and named in the comment.
7. Checkpoint the docs (`STATUS.md`, the handover's stop block) and push.

## 4. The brief of "bench round 1" (approved by the owner, 28 September)

The owner's rules for it: quick and precise, one deploy, no over-engineering, no new
test suites, existing tests adjusted only where the press path changed.

**Shared contract** (use these exact names): (a) the sync `staff` cache scope item gains
`pinExpiresAt: string | null` (ISO 8601) beside `pinHash` — the platform writes it, the
box reads it; (b) the box's kiosk server gains, under the prefix the wheel page already
uses (`packages/box-agent/src/runner/kiosk-server.ts`), `GET …/staff` answering
`{ staff: [{ accountId, name, code, hasPin }] }` — names only, no secrets — and
`POST …/print` with body `{ spinId }` answering the outcome shape a press answered with
before (printed / queued / failed, the code, the QR payload); (c) a booth PIN is exactly
five digits everywhere.

### 4.1 Box and wheel page (`packages/box-agent/src/**`, `apps/booth/src/**`)

1. **Print at the reveal.** Today `spin()` in `packages/box-agent/src/booth.ts` writes the
   spin, then submits the print and waits up to `printWaitMs` before answering, so the slip
   is out before the wheel moves. Change: the press writes the spin (drawn, recorded, code
   minted, facts in the outbox, the print job built and saved as held) and answers at once
   with prize, code, QR payload and status `queued`. New `POST …/print { spinId }` submits
   the saved job and answers within `printWaitMs` as a press used to (printed / queued /
   failed); idempotent (a second call answers the same outcome, prints nothing more); an
   unknown or foreign spinId → 404 in the page's error style. The page
   (`apps/booth/src/App.tsx`) calls it when the result card opens (`onSpinEnd` → phase
   `result`); `ResultModal` shows the code and QR only when the answer is not `printed`,
   with a short "printing…" state. The once-a-minute retry drain of held jobs must leave a
   job alone until 30 s after its press unless print was asked for, so a page that never
   asks (a crash mid-spin) still gets its slip within about a minute and a half and never
   prints during the animation. Reprint unchanged. Keep the box's offline-first order (the
   spin row is written before the wheel moves; the outbox is the durable record).
2. **Sign-in from the red button alone** (the booth has no mouse or number pad; the button
   sends Space). A gesture layer on the page used only while an overlay is open: one press
   = move the highlight (wrapping); two presses within 400 ms = select; hold ≥ 600 ms =
   keep moving every 250 ms; on the ready wheel with no overlay, hold ≥ 3 s = open the
   staff menu (a single press on the ready wheel still spins at once — add no latency to a
   spin; `src/press.ts` stays the source of key events). With nobody signed in the page
   opens on a **staff pick** overlay (from `GET …/staff`: the staff scope filtered to this
   booth's assignments, as sign-in already does). Pick a name → a **PIN pad** overlay: keys
   0–9 and delete, digits shown as dots, submitted by itself at the fifth digit through the
   existing PIN sign-in (mode `pin` + the account), refusals and back-off shown in the
   overlay. Signed in → the on-duty badge shows name and session end as today; the session
   length comes from Booth settings. The pick overlay steps aside after 30 s without a
   press (the wheel then plays unattributed with today's prompt, as the spec requires); the
   3-second hold brings it back. The **staff menu** (3-s hold when signed in, or the pick
   overlay's last item "More…") lists Reprint last voucher, Change booth (only on a box
   with several booths), Sign out, Close — same gestures; Reprint uses the existing call.
   Keyboard paths (digits open the PIN pad, phone-and-password tab, Tab/Enter/Escape) stay.
   Wording in the page's copy file, plain English, Thai placeholders where it has them.
3. **Expired PINs.** A PIN sign-in on the box with `pinExpiresAt` in the past (by the
   box's corrected clock) is refused with "This PIN has expired — ask a manager for a new
   one"; null means no expiry.

### 4.2 Platform and Console (`packages/db/**`, `apps/api/src/**`, `apps/console/src/**`)

1. **Booth PINs.** Today set through `…/booths/:id/staff/:accountId/pin`
   (`apps/api/src/routes/booth.ts`) as an argon2id hash in the `credential` table (kind
   `pin`, see `pinHashesByAccount` in `services/booth-admin.ts`), withdrawn through the
   DELETE on the same path. Change: (a) exactly five digits, else a clear 400; (b) the set
   call accepts a typed PIN or `generate: true`, in which case the platform mints a random
   five-digit PIN and returns it once, never stored in clear; (c) optional `expiresAt`
   (ISO) stored on the PIN's row (the branch has migration 0027 for it), shown as
   `pinExpiresAt` on `GET /booths/:id/staff` and written into the sync `staff` scope
   beside `pinHash`; (d) the existing withdraw is "Remove PIN". Audit rows as today. In
   the Console (`components/booth/BoothStaffPanel.tsx`, `boothApi.ts`): per person "Set
   PIN" (five-digit field), "Generate PIN" (shown once, copyable, "write it down"), an
   optional "Expires" date-time shown beside "has a PIN", "Remove PIN".
2. **Vouchers in one place.** (a) A Console page **Vouchers** beside Voucher types: a
   ledger of every voucher from every source (booth spins and counter-issued) from a new
   `GET /vouchers` (guarded like the voucher types routes, branch-scoped) with filters day
   (business date in the branch timezone), voucher type, booth/station, issuing staff,
   status (the statuses the ledger really has), paged; columns: issued at, type/prize,
   value handed over, booth or counter, issued by (staff or "unattributed"), last four of
   the code, status, redeemed at / where / by whom / sale; a totals strip per voucher type
   for the filtered range (issued, redeemed, redemption rate, expired, value handed
   over); "Download CSV". (b) On each booth's page (`pages/Booths.tsx`) a **Spins** panel:
   every press for a chosen day (default today) — time, staff or "unattributed", prize,
   last four of the code, printed or not, redeemed or not — from a new
   `GET /booths/:id/spins?date=`. Read from the existing tables (`booth.spin`,
   `promo.voucher`; see `packages/db/src/schema/booth.ts`, `promo.ts`,
   `apps/api/src/services/sync-booth.ts`); no new tables. (c) A **"Set up this booth"**
   checklist at the top of a booth's page: six steps in working order — printer added to
   the box, booth station with its prefix, layout and session length saved, staff with
   PINs, prizes adding to 100 %, published — each ticked from what the page already loads,
   each linking to its panel; panels reordered to match. No restyle beyond that.

### 4.3 Already done from the list

The OTO App's old voucher module is off (`c416065`); the launcher's wheel tile is live.

### 4.4 Not in this round

The analytics dashboard and the Radar revenue feed (SCRUM-216), any change to redemption
itself (SCRUM-207 is Deployed: slips redeem at the ticket and restaurant tills, one per
sale, once, online only, recorded with branch, station, staff and sale), migrating the OTO
App's old vouchers, a wider Console redesign.

## 5. Environment and tools

- **Local:** Node 22, pnpm, Docker. The test database is the Docker container
  `oto-platform-postgres-1` on port 5433: `TEST_DATABASE_URL=postgres://oto:oto@localhost:5433/oto`.
  `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm lint`; per package `pnpm -C apps/api
  run typecheck` etc. The Console has typecheck only (no tsx lint); the api lints from
  inside `apps/api` (`pnpm exec eslint src/...`). The lifted OTO App's own `tsc` was red
  before any of this work (about 583 errors); do not try to fix that.
- **Repository:** `https://github.com/vickyydev/oto-platform`, branch `main`; `gh` is
  installed and signed in on this PC. Commit format per `CONTRIBUTING.md`
  (`type(scope): summary`, bullet body, `Refs: SCRUM-…` footer). This session committed
  through a temporary index so only named files went in:
  `export GIT_INDEX_FILE=.git/tmp-index; git read-tree HEAD; git add -- <files>;
  tree=$(git write-tree); commit=$(git commit-tree "$tree" -p HEAD -F msg);
  git update-ref HEAD "$commit"; unset GIT_INDEX_FILE; git reset -q`.
- **CI:** GitHub Actions `ci.yml` on every push: typecheck, lint, tests against a Postgres
  service, builds, Console browser tests against the built bundle, and it packs the Pi
  release. One Console browser case is flaky (`e2e/booth-setup.spec.ts:224`, a "Save
  settings" click): re-run the failed job (`gh run rerun <id> --failed`), do not chase it.
- **Staging (Render):** five services — `oto-api-staging`, `oto-pos-staging`,
  `oto-console-staging`, `oto-launcher-staging`, `oto-booth-staging` — auto-deploy from
  `main`. The Render dashboard settings are what runs; `render.yaml` only documents. The
  api's pre-deploy runs `pnpm db:migrate && pnpm db:platform-sync`. Scripts:
  `scripts/session/render-deploys.mjs`, `render-wait.mjs <sha7>`, `render-env-names.mjs`
  (they read `RENDER_API_KEY` from `.env`; never print values). Console:
  `https://oto-console-staging.onrender.com`; API: `https://oto-api-staging.onrender.com`.
- **Jira:** project SCRUM, sprint id 3. `scripts/session/jira-lib.mjs` exports `jget`,
  `jpost`, `jput`, `statusOf`, `walkTo`, `comment`, `attach`, `commentWithImages`,
  `createInSprint`; it reads `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` from `.env`.
  Use it from the repo root with `node --input-type=module -e "import { comment } from
  './scripts/session/jira-lib.mjs'; …"`. Transitions in use: In Progress, Testing,
  Deployed (Deployed needs an attached screenshot named in the comment).
- **Secrets:** `.env` at the repo root (ignored) holds `JIRA_*`, `RENDER_API_KEY`,
  MinIO, Twilio and other keys. Never print, log or commit any value. Seeded staging
  passwords and PINs must not appear in any file.
- **The Pi:** `docs/ops/PI_BOOTH.md` is the owner's guide (imaging, install, claim, printer,
  Console set-up, checks, update, damaged store); `docs/ops/BOOTH_SETUP.md` the Console
  side; `docs/ops/COUNTER_VOUCHERS.md` the till side. Releases are named by commit.

## 6. Jira map (what to comment on)

| Ticket | What it is | Use it for |
|---|---|---|
| SCRUM-198 | Story S2-07 — Lucky Wheel booth (Deployed) | the round's booth and Console work; this stop was noted here |
| SCRUM-199 | S2-07a — booth game, spins, vouchers, printing, offline, heartbeat, alerts | booth game behaviour |
| SCRUM-418 | Polish the Pi installer and CLI (Deployed) | anything in `scripts/pi/` and the Pi guide (today's three fixes are noted here) |
| SCRUM-195 | S2-04 — stations, boxes, devices, Console Devices area (Deployed) | the Devices drawer, box log, heartbeats |
| SCRUM-207 | S2-10b — booth voucher redemption inside a sale (Deployed) | redemption at the tills |
| SCRUM-216 | S2-15b — analytics summaries, booth report (To Do) | reports and the Radar feed — not this round |
| SCRUM-423 | test hygiene (In Progress) | undo SQL for 0021/0022 and box/booth/shared test files — after the bench |

Open with the owner, do not re-raise: box theft, member data on boxes, hardware-first
spikes, solo capacity, codes on the box. Waiting on him: SCRUM-443 (branch chip), 407,
428, 434, 405, 410, 426, 447.

## 7. How this session worked, so the next one matches

- **Rounds, not sprawl.** A change was one round: a worker on a bounded file set, a light
  check that read the diff and ran only the touched tests, then a landing by explicit file
  list, a push, CI, staging, a Jira comment, a docs checkpoint. Small defects: one quick
  round each. The owner has said the defect rounds and ticket creation had become endless
  — do not start audits, and do not file every observation as a ticket. His precise rule:
  work that is significant on its own gets its own ticket; small things are handled under
  the bigger ticket with progress comments and tracking there; fix what the bench finds.
- **Proof before "Deployed".** A screenshot from staging attached to the ticket, or a
  test-run card when a screen cannot show it; the comment names the image.
- **Docs are the memory.** `docs/progress/STATUS.md` (one paragraph, first thing read) and
  the STOP POINT block at the top of the newest section of
  `docs/progress/SESSION_HANDOVER.md` carry what a fresh session needs. Update them after
  every substantial step; the owner reads them.
- **Talk to the owner plainly.** He is not a network engineer and has no mouse at the
  booth; give him copy-paste commands and say what each does. When something fails, say
  what you saw, not what you assumed.

## 8. Setting the next agent up (for the owner)

- Codex reads `AGENTS.md` at the repository root by itself; it points here.
- Codex needs network access for `git push`, `gh`, Jira and Render, write access to this
  folder, and the Atlassian connection so it can browse Jira the way the previous session
  did (that session used the Atlassian MCP for reading and searching issues, and the
  repository's `scripts/session/jira-lib.mjs` with `.env` for comments, attachments and
  transitions; both stay available). The complete `C:\Users\waqar\.codex\config.toml`:

  ```toml
  # Codex settings for the OTO platform work.
  approval_policy = "on-request"
  sandbox_mode = "workspace-write"

  [sandbox_workspace_write]
  network_access = true

  # Atlassian's hosted MCP (Jira and Confluence). Opens the browser for the
  # Atlassian sign-in on first use; the token is cached by mcp-remote.
  [mcp_servers.atlassian]
  command = "npx"
  args = ["-y", "mcp-remote", "https://mcp.atlassian.com/v2/mcp"]
  startup_timeout_sec = 60
  ```

  If a Codex version rejects `startup_timeout_sec`, remove that line. Jira writes
  (comments, attachments, transitions, creating a ticket in the sprint) go through
  `scripts/session/jira-lib.mjs`, which reads `JIRA_BASE_URL`, `JIRA_EMAIL` and
  `JIRA_API_TOKEN` from `.env`; browsing and searching can use either.
- First prompt to give the agent: "Read AGENTS.md and docs/handover/CODEX_HANDOVER.md,
  then docs/progress/STATUS.md and the newest STOP POINT block of
  docs/progress/SESSION_HANDOVER.md. Tell me in ten lines where the work stands and what
  you will do first; then finish bench round 1 as section 4 describes, one deploy, no new
  test suites, and hand me the Pi release name and checksum at the end."
