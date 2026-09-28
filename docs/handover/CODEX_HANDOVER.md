# Hand-over to the next agent session — 28 September 2026, evening

Written for: the coding agent (OpenAI Codex, or any other) that resumes this repository
in the same working folder, and for the owner setting it up. Everything below was true
when it was written; verify the live state from `docs/progress/STATUS.md` and the newest
STOP POINT block of `docs/progress/SESSION_HANDOVER.md` before acting.

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
  args = ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]
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
