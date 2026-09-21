# Handover — where this is, and what to do next

_Written 2026-09-21 at the end of a long session. Read this, then
`SPRINT_2_PROGRESS.md` → Status, then `POS_GAP_REGISTER.md`._

**The one rule that matters most here:** establish what is built from the
**code** and from **driving staging**, never from a document. A stale line in
`CLAUDE.md` §11 cost this project a week — it said a member's tier had no UI
to change it, which was false, and the owner's real problem was a *bug* that
nobody looked for because the document said the feature did not exist. Every
claim below carries a commit or a measurement. If you find one that does not
match the code, the document is wrong and fixing it is part of your work.

---

## 1. Where the code is

| | |
|---|---|
| Branch | `main`, and everything is on it — no open branches |
| HEAD | `0abc9ea` |
| Deployed to staging | `fdcf99e` on all five services; `0abc9ea` was still building at wind-up |
| Tests | 577 api · 209 print · 197 shared · 167 box-agent · 36 telemetry |
| Migrations | `0013_box_local` is the latest; apply twice from empty to an identical catalogue |

**Check before you trust this table:** `git log --oneline -1`,
`gh run list --branch main --limit 3`, and the Render status helper described
in §6. The deploy state in particular will have moved on.

---

## 2. What was delivered this session

Twenty commits from `6440761` to `0abc9ea`. In order of what matters:

**S2-06 (SCRUM-197) finished and Deployed.** The device half — printer
adapters and simulators, the print queue, scanning, the signed staff badge,
the offline shell, the simulator panel. Ten defects were found by two review
rounds and a merge gate, three of them security, and every one was reproduced
before it was fixed. Evidence with six screenshots is on the ticket.

**S2-07a (SCRUM-199) built, merged, Testing.** The Lucky Wheel booth: the box
draws the outcome, records the spin *before* the wheel turns, mints the
voucher, prints it and syncs it. Migration 0012 (booth and promo schema, the
signing keyring, credentials) and 0013 (the box-local tables). It is
**Testing rather than Deployed for exactly one reason** — see §4.

**Five POS defects fixed and Deployed** (SCRUM-225 to 229), including the one
the owner reported himself: a member's tier change was discarded on Save.

**Five more fixed and in Testing** (SCRUM-235, 236, 237, 239, 240): the admin
gate, eleven screens that saved nothing, roles that could not be given back,
branch creation, and the temporary-password dead end.

**The OTO App** no longer errors on save, and is seeded from the park's own
rows rather than invented ones.

**`POS_GAP_REGISTER.md`** — every POS capability classified from the code and
from driving staging: **33 work, 15 are broken, 36 are not built**, 84 items,
with SCRUM-225 to SCRUM-241 raised from it. This is the most useful document
in the repo for planning; read it before you pick anything up.

---

## 3. The two most serious things found, and why they hid

Both were found sideways, while doing something else. Assume there are more.

**An invitation could give away the whole platform.** Inviting an
`operator_admin` from the POS panel sent a null scope id, and a null operator
scope means *every operator there is*. Somebody invited to help run one park
became an administrator of the platform. It stayed hidden because of **who**
it happened to: the only account that could successfully send that invitation
was already platform-wide, so nothing looked wrong; anybody else had it
refused outright. Fixed in `0abc9ea`.

**The test that guarantees no route is unguarded accepted a promise as
proof.** A route may declare `dynamicPermission: true`, meaning "I check in my
own handler". The test counted that declaration as evidence. It installs
nothing, and authentication is not global here — so a route that declares it
and forgets answers **anyone, with no session**. Proved with a route written
to do exactly that: 200, anonymously. The test now drives every non-public
route with no cookie. Fixed in `0abc9ea`.

The pattern behind both: **a guarantee asserted rather than enforced.** That
is also the shape of the recurring defect below.

---

## 4. Blocked, and on whom

| What | Blocked on | Detail |
|---|---|---|
| **The booth is not reachable** | the session that owns `render.yaml` | Its platform side is live, but `apps/booth` has no Render service, so there is no address to open. About five lines of blueprint. This is the only thing between SCRUM-199 and Deployed. |
| SMS: no code can be delivered | the owner | Twilio 422 error `572002` — the trial account owns no number and has no verified recipient. And Thailand has required a registered sender since Oct 2025, so buying a US number will not help. Twilio **Verify** is the route that avoids a 10-day registration. |
| Photo upload from a browser | the owner | The storage token now writes; the bucket still has **no CORS policy**. The exact rule to paste is in `OWNER_ACTIONS_AND_NEXT_BUILD.md`. Separately, nothing in any front end calls `POST /files` and `PATCH /me` has no caller either — there is no profile-editing screen. |
| `VITE_HR_APP_URL` unset on the OTO App | the owner | Declared in the blueprint with a value, absent from the live service. Unset, three screens send people to an old Replit address. It is a build argument, so it needs a **deploy, not a restart**. |
| `STAFF_TOKEN_PRIVATE_KEY` unset on the api | the owner | `openssl genpkey -algorithm ed25519`. Nothing visible fails without it; the till simply cannot be unlocked with no internet. |

`docs/progress/OWNER_ACTIONS_AND_NEXT_BUILD.md` is the list written for the
owner. `docs/qa/STAGING_READINESS.md` is what he can try today.

---

## 5. What to pick up next, in order

1. **Finish what is in Testing.** SCRUM-235/236/237/239/240 need staging to
   pick up `0abc9ea`, then a look, then Deployed with evidence.
2. **The booth's Render service**, so SCRUM-199 can be Deployed and the wheel
   can be opened in a browser. Coordinate with the `render.yaml` session.
3. **SCRUM-203 — the ticket cart and the sale ledger.** This is the biggest
   real gap: admission works end to end up to "Pay ฿1,440" and **nothing
   after Pay exists**. No `sale` row is ever written and no tender recorded.
   `sale`/`sale_line` are still Sprint 1 placeholders in `future.ts`.
4. **SCRUM-229's sibling — one pricing engine.** The tested engine in
   `packages/shared` (~1,600 lines, 1,694 lines of tests) has **one caller**:
   the public booking quote. The till prices in the browser from the
   prototype's copy. They agree today because both are ports of the same
   rules. They are two engines, and the one under test is not the one taking
   money. SCRUM-226 is what that costs.
5. **SCRUM-232 — the product tables cannot hold the park's menu.** `product`
   is a five-field placeholder with no write path anywhere. Every catalogue
   ticket lands on this, and the menu import/export the owner asked for
   arrives *with* the menu's first real persistence, not after it. The
   spreadsheet template is already specified column by column in the workflow
   output referenced from `OWNER_ACTIONS_AND_NEXT_BUILD.md`.
6. **S2-07b (SCRUM-200)** — the booth admin panel.
7. Then the register's remaining BROKEN items: SCRUM-230, 231, 233, 234, 238.

---

## 6. How to work on this

**Ultracode is on.** Use workflows for substantive work; several agents can
share the tree if — and only if — each slice owns named files and the others
are told not to open them. That worked all session with up to three workflows
running; it works because the file list is explicit in every prompt.

**Commit by explicit file list, never by directory.** Agents share this tree
and a `git add .` sweeps in another workflow's half-written work. It has
happened three times.

**Never switch branches while agents are running.** Committing is safe;
switching pulls the tree out from under them.

**`services/deploy-bot/` and `render.yaml` belong to another session.** Read
them if you must; never edit.

**Jira moves in the same turn as the push.** In Progress when work starts,
Testing when committed, Deployed when live with evidence; *Done* is the
owner's alone. The owner has caught this lapse three times. Verify the
transition landed by re-reading the status — a naive loop stalls at In
Progress, so walk the board's order one step at a time. Comments are for a
non-engineer: what was wrong, what it does now, what it cost, what is open.

**Useful helpers**, written this session, in the session scratchpad (they do
not survive; rewrite from these notes if you need them): a Render service and
env-var lister, a deploy waiter that polls until a commit is live, and a Jira
status walker. Credentials come from the gitignored `.env` and are never
printed.

---

## 7. The recurring defect, stated so it can be checked

Five tickets in a row shipped **a service with no caller**, and each time the
tests passed because each test mirrored **one side of a seam**: S2-04's fleet
API while both front ends called it; S2-05's station-session document; S2-06's
offline unlock and a preview URL no browser could resolve; the anomalies
panel's missing route.

Two rules came out of it and they hold:

- **A service with no caller is not built.**
- **A test that talks to the server directly does not prove a browser can
  reach it.** The booth's seam tests drive the real page, the real outbox and
  the real route, and no envelope is hand-written anywhere — which caught,
  immediately, that the plan named a fact type the box does not send. Every
  real voucher would have been quarantined as an unknown type.

And the related one, which has now been found in **fifteen consecutive
reviews**: a comment or a test asserting a guarantee the code does not give.
Sweep for "never", "cannot", "always", "the same", "only". Measure each.

`POS_GAP_REGISTER.md` §6 proposes rules that can be checked rather than
intentions — an assumption must carry a Jira key or a closing commit,
verified by a grep in CI, and **no comment may cite a document as a reason
not to build something**; cite a ticket, which has a status. The comment that
left a live member form wired to nothing cited `CLAUDE.md` §6.

---

## 8. Known gaps in our own tooling

- **`apps/pos` has no unit-test runner** — no vitest, no `test` script, two
  Playwright specs. And **`apps/pos/**` is in eslint's ignore list**
  (`eslint.config.mjs`, "linted separately later" — it never was). So the
  compiler is the only automated check on the till. That is how a child's
  price sat on the Adults row for a whole sprint. Standing vitest up there
  and covering `lib/pricing.ts` and `lib/pricingMode.ts` first is cheap and
  overdue.
- The lifted OTO App carries ~586 pre-existing typecheck errors. Establish
  the baseline before and after any change there; do not try to fix them.
- CI has twice been red for a reason nobody noticed: a lockfile that was
  never committed, and a rasterising test hitting vitest's 5s default. Check
  `gh run list` after pushing, not only the local suite.
