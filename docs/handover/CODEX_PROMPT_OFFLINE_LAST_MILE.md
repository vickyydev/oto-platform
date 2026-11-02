# The prompt for Codex — the POS forwarder's trace (SCRUM-721) and the counter selling offline (SCRUM-713, first stage); 2 November 2026

For the Codex chat that delivered SCRUM-710 and SCRUM-718. The planner re-measured its result and read the forwarder: the speed target is met and writes are never replayed. This brief is the next unit.

## Why this is next

The box side of the offline plan is built, and SCRUM-717 and SCRUM-708 have closed its rule gaps. The till on an iPad still cannot use it: `setBridgeOrigin` in `apps/pos/src/api/bridge.ts` has no caller, the installer publishes no bridge, and staging has no staff signing key. So when the mall's link drops, the counter stops. This is the largest remaining risk on the POS.

## Order

1. **SCRUM-721**, small, landed and Deployed first.
2. **SCRUM-713, first stage:** everything that does not need the owner's domain or a real Pi. It ends at Testing, not Deployed, because the ticket's "done when" is a real counter with the internet cable pulled.

Post your plan on SCRUM-713 before writing code: what you will build, what you will prove locally, and what would make you stop.

**Dependencies:** SCRUM-717 is Deployed. SCRUM-708 is in its final proof; rebase on it. SCRUM-711's code is on main and only its bench proof is open, so it does not hold this up.

## SCRUM-721: the forwarder

`apps/pos/server/server.ts`, nothing else.

- **A trace of upstream failures.** It writes no log today, so a failed sale leaves no trace in the service. Add one structured line per upstream failure: method, path without its query, the error code, and whether the socket was reused. Never bodies, headers, cookies or query strings.
- **A write should not land on a socket about to close.** A reused socket reset on a POST correctly answers 502 and is never replayed, but the till then shows an error for a sale that could have gone through. Choose the cheapest way to make this rare, such as a fresh connection for writes or an idle limit below the API's, and measure what it costs on the private network. The no-replay rule does not change.
- Tests for both. Prove on staging that a forced upstream failure leaves the line in the service's log and nothing sensitive. Staging's only live user of this service is your own test till, so this is safe to do.

## SCRUM-713, first stage: read first

`docs/progress/plans/offline/PLAN.md` sections 2.1, 2.2, 2.8, OD-1, OD-2, OD-3, OD-10, OD-12 and section 6; `apps/pos/src/lib/lane.ts`; `apps/pos/src/api/bridge.ts`; `packages/box-agent/src/runner/bridge-server.ts`; `packages/box-agent/src/runner/kiosk-server.ts`; `scripts/pi/Caddyfile`; `scripts/pi/install.sh`; `apps/api/src/lib/staff-token-key.ts`; `apps/api/src/services/staff-token.ts`; `docs/ops/POS_WEB_SWITCHOVER.md`; the proof scripts and notes of SCRUM-719 and SCRUM-717 for how a real local agent runs against staging.

## SCRUM-713, first stage: what to build

- **The till finds its box.** The platform records a box's bridge address, an administrator sets it on the box in the Console, and the station view carries it. The till calls `setBridgeOrigin` when it takes a station and clears it when it leaves. A virtual box has none and keeps today's same-origin path, byte for byte. Expand-only schema. The address is validated as an HTTPS origin, with loopback allowed only under an explicit test setting.
- **The staff signing key on staging.** Generate `STAFF_TOKEN_PRIVATE_KEY`, set it on `oto-api-staging` with a single-key write, redeploy the same commit, and confirm the public half reaches `core.signing_key` and a box's bundle. Read first what else starts behaving differently once it is set, and write that on the ticket before setting it. Add it to the production go-live list.
- **The customer display follows the box with no internet.** A display on a Pi must cold-boot and follow the till after a power cut during an outage. Decide between bundling the display page into the box release, as the booth page is, and relying on the installed app's cache. Say why on the ticket, covering what happens when the cache is empty and when the page version and the box version differ. The display reads the bridge on the box with its paired credential and the redacted document. The kiosk server's loopback-only hardening stays. `--kiosk-url` and SCRUM-710's stream, grace and pause keep working.
- **A forwarder failure is a real outage.** With the mall's link up and the API down, the till sees a 502 `UPSTREAM_UNAVAILABLE`, which `lane.ts` does not treat as a reason to move. Decide whether it should move to the box when the till has a bridge address, and test it. Remember that a write's outcome can be unknown at that moment; the ids the till mints are meant to make that safe (OD-12), so prove that for this case.
- **The installer, dark.** `--bridge-host NAME` installs Caddy with the DNS provider module, the Caddyfile and `OTO_BOX_BRIDGE_ORIGINS` naming both POS addresses. Without the option nothing changes. The token lives in `/etc/caddy/env`, never in the repo. It has not been run; label it so. Write the on-site checklist: zone records, router DNS, the iPad's local-network permission.

## Limits (none of these may move)

- **Money:** OD-3 and the capability list stand. Offline tenders stay cash, a card on a terminal with a final answer, and the PAX QR flagged awaiting settlement. Never offline: the 2C2P QR, vouchers, refunds and voids. No new tender, and no change to receipt numbering, sealing or sale safeguards.
- **Who can act:** a box session needs the staff token AND the password (OD-2). The token alone opens nothing. No new credential type, and no weakening of the bridge's origin check or its Private Network Access answers.
- **Online stays as it is:** with the internet up and a bridge address set, the till works through the platform exactly as now. Check this with the existing till journeys on both POS addresses.
- **Offline must never lock out a ready till:** an older bundle or a missing field behaves as today.
- **Other people's work:** `OTO_BOX_BRIDGE_ORIGINS`, the Pi and the park's devices are not switched by this unit.

## Proof for this stage

A real box agent on this machine, registered as a new `ZZ TEST` box against staging as SCRUM-719 did, and the real till page in a real browser with its bridge address on loopback under the test setting. Then, with the browser's route to the API cut:

- unlock with token and password
- sell cash, with the receipt number from the box
- the display follows the box, including a cold start
- a refused tender shows its sentence
- reconnect, and read back from the platform that the sale landed once, with nothing in quarantine

Say plainly what this does not show: a real iPad reaching a private HTTPS address (`PLAN.md` section 6), a real certificate, and a real Pi. Those go on the ticket as the bench list. **Walk SCRUM-713 to Testing with that stated, and stop.**

## Questions that go to the owner

Write them on the ticket and in STATUS, and keep going on whatever does not depend on them. Which domain the box names use is already with the owner. Build the name as configuration, so the answer changes no code.

## Rules (the same as your last unit)

- **Render:** never call the bulk `PUT /services/{id}/env-vars`. Single-key writes only, using `appendEnvList` for lists. Read before you write, print names only, and confirm the count of names afterwards. A saved value reaches nothing until a redeploy of the same commit. The key sees two workspaces. Do not create services without a new yes. `oto-pos-staging` stays as it is.
- **Devices:** do not move staff, iPads or the Pi to any new address. Never "Till 1 (Pi)", never "Till 2 (test)", never the park's Pi or the FWBooth1 box. ZZ TEST records only, no real payments, no SMS, no real person's data. Remove your test settings from staging when you finish.
- **Jira in the same turn:** In Progress when picked, Testing after the push, Deployed only with an image you opened and `node scripts/agent/jira.mjs walk SCRUM-n Deployed`; read it back; never Done. One plain comment per outcome that a non-engineer can follow, and no site visits or commercial talk.
- **Gates** unpiped under `set -eo pipefail`: each touched package's `typecheck`, eslint on changed files, your tests (`pnpm --filter @oto/api exec vitest run --pool=forks test/<file>`, `pnpm --filter @oto/box-agent test test/<file>`), `packages/shared` tests when shared changes, `pnpm api-types:check` when a schema changes. Never weaken a test or a guard.
- **Landing:** rebase; check `gh run list` before pushing code, because a code push supersedes a queued main run; watch CI by the full SHA with `sh scripts/agent/watch-ci.sh <full-sha> 45`; a cancelled run is not a pass; red is fixed in the same session and said on the ticket.
- **Commits** per `CONTRIBUTING.md` with `Refs: SCRUM-n`; no attribution or co-author lines; never commit `imports/` or `.env`; never print a secret.
- **Records:** a STATUS block and both handover notes at every landing, keeping every block on a conflict.
