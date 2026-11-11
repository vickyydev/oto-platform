# Codex lane — the till and platform defect round (from 11 November 2026)

**Owner's direction (11 November 2026, 04:40 Bangkok):** a second agent (Codex) takes a batch of
Sprint 2 defects that sit apart from the inbox/BEO round the planner session is landing, works
them one unit at a time through the same protocols, and keeps Jira current at every step.

This file is the brief. `AGENTS.md` holds the absolute rules; the newest resume note at the top
of `docs/handover/CODEX_HANDOVER.md` points here. The planner session's live state is the newest
block of `docs/progress/STATUS.md` — read it before every landing.

## 1. Surfaces: yours and not yours

**Yours (this round):** the till web app `apps/pos` (counter and phone layouts), the platform
api's sale / station / display / screen-presence / app-identity services and routes
(`apps/api/src/services/{sale,stations,display,screen-presence,otoapp-provision,otoapp-lifecycle*}.ts`,
`apps/api/src/routes/{stations,display,app-identities}.ts` and their tests), the Console's
station form (`apps/console`), the OTO App's login-lifecycle and employee-login code
(`apps/oto-app/server/lib/platformLifecycle.ts`, the login/employee routes in
`apps/oto-app/server/routes.ts`, `tests/legacy-password-doors.check.ts`), the OTO App's SOP
extraction call and model helper, the OTO App's checklist upload queue.

**Not yours — another lane is changing them now; do not touch, do not "tidy":**
`apps/inbox/**`, `packages/assistant/**`, `apps/api/src/services/inbox/**`,
`apps/api/src/services/party-*.ts`, `apps/api/src/services/otoapp-events.ts`,
`apps/api/src/routes/otoapp-party-billing.ts`, `apps/oto-app/client/src/components/beo/**`,
`apps/oto-app/server/{beo-routes,pdf,ai-routes,party-billing-routes,party-menu-routes}.ts`,
`apps/oto-app/server/lib/{beo*,aiFill*,partyQuote,tillBilling,partyMenuItem,beoPdfMoney}.ts`,
`apps/oto-app/shared/{kitchenAdults,tillBilling}.ts`, `packages/shared/src/party-*.ts`,
`docs/progress/plans/beo-inbox/**`, `docs/qa/proof-2026-11-09/**`. If a fix truly needs a line
in one of those, stop and write it on the ticket as a question for the planner session.

**Migrations:** platform `packages/db/migrations` is at **0114**; the OTO App at **0047** with
**0048 reserved** by SCRUM-829 (landing today). Build under a provisional number, read the
journals at landing, renumber, regenerate the snapshot, diff the SQL identical.

## 2. The units, in order

Work one unit at a time: build → review test → gates → land → deploy by name → staging proof →
Jira. Never start the next unit's landing while the previous one's proof is open.

### Unit 1 — SCRUM-801 (High) + SCRUM-800 (Medium): the phone till's payment step
- **801:** on the phone layout, Back then Cancel on the payment step resets the screen
  (`resetSale` in `apps/pos/src/components/mobile/MobileTill.tsx`) but sends nothing to the
  platform: the sale stays open and unpaid. The counter till's Cancel voids the sale. Wanted:
  Cancel on the phone till voids the unpaid sale exactly as the counter does, and a reload
  shows nothing left to resume. Reuse the counter's void path; do not write a second one.
- **800:** at 375 px the payment column measures 446 px, "Confirm Payment Received" ends at
  462 px and the PromptPay label is cut off (the phone till's `StepPayment` bottom bar). Wanted:
  the tender grid, the amount lines and the Confirm button fit the phone width.
- **Tests:** the pos vitest for the mobile till (a Cancel after Pay calls the void route and
  leaves no resumable sale), a Playwright pass of the phone till at 375 px asserting the
  payment column's width ≤ viewport (the existing `apps/pos/e2e` runner: `pnpm --filter
  @oto/pos e2e e2e/<spec>`).
- **Proof on staging:** a ZZ TEST till (never a named park till), a sale on the phone layout,
  Pay → Back → Cancel; the platform shows the sale void (GET the sale), reload shows nothing
  to resume; the 375 px payment screen picture with nothing cut off.

### Unit 2 — SCRUM-809 (High): a reused receipt prefix
- The station form accepts a prefix an archived till at the same park used; the first payment
  is refused 409 "That value is already taken" because receipt numbers are unique per park and
  the new till's counter starts at 1. Wanted (both halves): the station form refuses a prefix
  any till at the park has EVER used, archived ones included, naming the till that used it
  (`apps/api/src/services/stations.ts` prefix uniqueness + the Console's station form); and the
  payment screen names the cause ("receipt prefix in use …") rather than the generic refusal
  (`apps/api/src/services/sale.ts` finalise, the till's error wording).
- Do not make the counter continue from the old till's highest number unless the owner rules
  it; the refusal at the form is the fix, the clear message at the till is the safety net.
- **Tests:** api integration (a prefix of an archived station at the same park → 409 with the
  till's name; another park's prefix → allowed), the sale finalise test for the named cause.
- **Proof:** Console › Stations: a ZZ TEST till with a prefix a ZZ TEST archived till used →
  refused with the name; the SCRUM-772 picture set shows the old failure for comparison.

### Unit 3 — SCRUM-802 (Medium) + SCRUM-783 (Low): History and the shown number
- **802 (1):** History's "Bracelet code" box (`apps/pos/src/pages/History.tsx`) keeps a pasted
  code and waits for Find; SCRUM-790 made a pasted or scanner-paced code load the tab by itself
  in the F&B/Shop box (`apps/pos/src/components/fnb/ScanWristband.tsx`). Wanted: the same
  immediate load in History — reuse that component or its hook, no second implementation.
  **(2):** after an Add time charge is paid, the History list shows the new receipt only after
  leaving and reopening History. Wanted: the list refreshes on its own.
- **783:** a Thai number typed with a leading 0 on the customer screen is shown back as
  "+660897620002" in three places (the till's "New member?" offer, the customer screen's
  details step, the drop-off and nanny agreements step) while every stored value is the
  correct +66 89 762 0002. Display only: format the shown number the same way as the stored
  one (`formatPhone` from `packages/shared`). Never store or log a real number: ZZ TEST numbers
  only in tests and proofs.
- **Tests:** pos vitest for History (paste → load; the list after a payment event), a unit test
  of the formatting in the three components.
- **Proof:** History with a pasted ZZ TEST band code; an Add time payment then the list; a
  ZZ TEST number typed with a leading 0 shown as +66 … in the three places (pictures).

### Unit 4 — SCRUM-807 (Medium): drop-off from a Golden Ticket
- After the Drop-Off form on the customer screen and "Continue to payment", the payment screen
  read Amount Due ฿1,315 while the order read Total ฿0 and the voucher box said "The platform
  is still pricing the voucher — press again in a moment"; no sale was written and Confirm
  stayed off. The till moved to payment before the re-priced total came back and did not
  re-read it. Wanted: the payment screen waits for the voucher pricing (or re-reads the total
  when it arrives) so the amount shown is the amount due. Pictures 05e/05f in
  `docs/qa/proof-2026-11-09/SCRUM-798/staging` (05e/05f; verified path on 11 November).
- **Tests:** pos vitest with a delayed pricing answer: the payment screen shows the re-priced
  total and Confirm enables only then.
- **Proof:** a ZZ TEST Golden Ticket drop-off on a ZZ TEST till; the payment screen's amount
  equals the order's total before Confirm is offered.

### Unit 5 — SCRUM-819 (Medium): the just-paired display's false Offline
- `claimDisplay` (`apps/api/src/services/display.ts`) sets `pairedAt` but not `lastSeenAt`;
  a watchdog run between pairing and the display's first call raises `display.offline` and the
  next run closes it; a real silence inside the 300 s flap window reopens the same row, which
  by the alert rules is not sent again. Wanted: pairing records the display as seen at the
  pairing time (or a short grace after pairing before it can be judged); a real silence after
  that is a new alert and is sent. Read `apps/api/src/services/screen-presence.ts` and the alert
  flap rule before choosing; keep the alert tests' invariants.
- **Tests:** the api watchdog test: pair → run within 2 s → no alert; silence after the grace →
  one alert, sent.
- **Proof:** pair a ZZ TEST display on staging and watch the Console's alerts for ten minutes
  (none), then cut it and see one alert (a labelled test-run card is acceptable where a screen
  cannot show it).

### Unit 6 — SCRUM-778 + SCRUM-781 + SCRUM-810 (Medium): the login-lifecycle retry storm
- One root: when a platform account is switched off, the OTO App queues a "deactivate"
  lifecycle event back to the platform; if that login is then deleted, the platform refuses
  (`NOT_FOUND` / `PLATFORM_HTTP_REFUSED`) and the app retries every 30 s for ever
  (`apps/oto-app/server/lib/platformLifecycle.ts`); each attempt writes an
  `app_identity.lifecycle_deactivation.failed` audit row (`apps/api/src/routes/app-identities.ts`,
  `consumeLifecycleDeactivation` in `apps/api/src/services/otoapp-provision.ts`), burying the
  Console's Activity log. Wanted: the platform settles an event for a login it no longer knows
  as superseded (not an error); the app drops a login's pending events when the login is
  deleted; the retry has a ceiling and backs off, parking the row with a reason; one audit row
  per failure cause, not per attempt. Close all three tickets with one unit (one lane, three
  Jira comments, each saying what changed for that ticket's symptom).
- **Tests:** api (a lifecycle event for an unknown login → settled, one audit row), app
  (the retry ceiling and the drop-on-delete; the app's `tests/*.check.ts` style, wired into
  CI's oto-app job).
- **Proof:** Console › Activity on staging for ten minutes shows no such rows; the two
  parked staging rows named in SCRUM-810 are settled (read back through the app's own route).

### Unit 7 — SCRUM-784 + SCRUM-785 (Medium): two OTO App checks
- **784:** `apps/oto-app/tests/legacy-password-doors.check.ts` fails at Create Login (POST
  `/api/employees/:id/enable-login` → 400 "Invalid login request") on main and is not in CI.
  First press Create Login on a ZZ TEST employee on staging and record what a manager sees;
  then either bring the check to the route's current request shape, or fix the route; add the
  check to CI's oto-app job.
- **785:** the SOP extraction call (`apps/oto-app/server/routes.ts`, "extract structured SOP
  steps") sends `temperature: 0.3` to the default model, which refuses sampling settings.
  Reproduce on staging with a ZZ TEST document; remove the setting as the BEO fill did; check
  the other callers of the model helper on the default model; add a check that no call on the
  default model sends a sampling setting. Never spend the real model key in tests (the fakes).
- **Proof:** a ZZ TEST employee given a login from the screen; a ZZ TEST document turned into
  SOP steps.

### Unit 8 — SCRUM-748 (High): checklist photo/video upload from the browser
- The editor sends the file straight to the staging bucket, which refuses the browser's
  preflight (no CORS header). Two ways: the owner adds the bucket rule (owner action 2 in
  `docs/progress/OWNER_ACTIONS_AND_NEXT_BUILD.md`, not done as of 11 November), or the upload
  queue falls back to the app's own `POST /api/checklist-media/upload` when the direct upload
  is refused (the POS already routes uploads through the api). **Build the fallback** (always
  through the server route is acceptable if the fallback is fragile), keep the direct path for
  when the rule exists, and say on the ticket that the bucket rule is still the owner's.
- **Proof:** a photo added to a ZZ TEST checklist item from the browser on staging.

### Later (not in this round unless the owner says so)
SCRUM-780 (the "Unlock this till on its box first" line needs a box agent at hand), SCRUM-705
(gate station slots: a schema and box-config design, needs the owner's ruling on roles),
SCRUM-733 (the till Messages tab: a design decision), SCRUM-811 (wording).

## 3. How every unit ships (the protocol, unchanged)

1. **A lane worktree of your own**, never the main checkout:
   `git worktree add -b lane/codex-<topic>-<yyyymmdd> C:/oto-lanes/codex-<topic>-<yyyymmdd> origin/main`,
   then `pnpm install --frozen-lockfile --prefer-offline` and, for the app, `cd apps/oto-app && npm ci`.
2. **Build**, then the adversarial review in the house style (`apps/api/test/<unit>-review.test.ts`
   or the app's `tests/<unit>.check.ts`): passing pins plus `it.fails` FINDINGs with severity and
   a prescribed fix; apply the fixes, flip the pins.
3. **Gates, unpiped (or `set -o pipefail`), each to its own log:** typecheck of every touched
   package through its own script (the api prints zero lines; the OTO App's ratchet
   `npm run check:ratchet` holds at **418/418** errors — the count may never rise), the touched
   packages' tests, `pnpm api-types:check` when a route changed (`pnpm api-types:generate` and
   commit), eslint on every touched platform file, and — whenever anything under
   `apps/oto-app/server/` changed — `apps/api: pnpm exec vitest run test/s217b-r6-review.test.ts
   test/s660-beo-confirmation-review.test.ts` (text pins on the app's files; repin with a comment
   naming your ticket, never weaken the invariant). Never `vitest -t` on serial suites. No Docker:
   the embedded Postgres (leave `TEST_DATABASE_URL` unset).
4. **The slot.** Before landing, `git fetch origin` and read the newest block of
   `docs/progress/STATUS.md`: if it says a landing + proof is in progress on another lane, wait
   and poll every ten minutes; otherwise prepend your own block ("SLOT CLAIMED by
   lane/codex-… at HH:MM for SCRUM-nnn") and push that docs commit first. Release it in the
   block that records your proof.
5. **Land:** rebase onto `origin/main` (ground-truth the commit list after every rebase),
   subjects ≤ 72 chars in CONTRIBUTING.md's form with `Refs: SCRUM-nnn`, push `HEAD:main`
   (fast-forward only; a rejected push means rebase again; never force-push), then
   `node scripts/agent/render.mjs deploy <service> <full-sha>` for EACH service you changed, by
   name (`oto-api-staging`, `oto-pos-staging` AND `oto-pos-web-staging` for the till,
   `oto-console-staging`, `oto-app-staging`; never "all", never the qa worker), and
   `bash scripts/agent/watch-ci.sh <full-sha> 60` in the background. CI red → stop, fix, report.
6. **Proof on staging** through the screens as a user would (Playwright from `apps/pos`;
   `scripts/agent/evidence.mjs` for sign-in and cards), ZZ TEST records only, masked pictures
   under `docs/qa/proof-<date>/SCRUM-nnn/staging/` with a README and a `receipt.json` (routes,
   statuses, ids; no name, no phone, no key). Clean up what you made; sign out and read back 401.
7. **Jira, in the same turn as every push:** a comment written for a person at the park (what
   they can now do), the pictures attached and named; walk To Do → In Progress at the start,
   → Testing when the proof passes, → Deployed only with the pictures attached and CI green on
   the landed SHA; **never Done** (the owner moves tickets to Done). A finding you cannot fix in
   the unit becomes a progress comment with a plan, or its own ticket in sprint 3 via
   `createInSprint` — never silence.
8. **Checkpoint:** after every landing and every proof, prepend a block to
   `docs/progress/STATUS.md` and refresh the resume note at the top of
   `docs/handover/CODEX_HANDOVER.md` (what landed, what is next, anything half-done); commit by
   explicit file list; push. A session that dies must be resumable from those two files alone.

## 4. Questions for the owner (collected here as they arise)

- SCRUM-809: refuse the reused prefix at the form (built) — or continue the counter from the
  old till's highest number? Default: refuse.
- SCRUM-748: the bucket's browser rule (owner action 2) — still wanted, or is the server route
  the permanent path?
