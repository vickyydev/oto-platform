# The prompts for Codex — the box lane's rules (SCRUM-717, 708) and the POS's path to the API (SCRUM-718); 2 November 2026

Codex works in this same folder with the same environment and credentials as the planning agent. Two chats, two independent units. Chat A continues from SCRUM-710, whose routing question SCRUM-718 answers. Chat B continues from SCRUM-712 in the box agent. The planner owns `scripts/pi/**` today (the SCRUM-712 installer handoff), and neither block edits it.

**Rules for both chats**

- Read `AGENTS.md`, `CONTRIBUTING.md` and the newest blocks of `docs/progress/STATUS.md` first. The ticket description on the board is the specification; the block adds the decisions.
- Rebase before every push. A code push on main supersedes the run before it, so check `gh run list` and wait for a running main run to finish before pushing code. A docs-only push runs no CI and supersedes nothing.
- Gates unpiped under `set -eo pipefail`: each touched package's own `typecheck`, eslint on changed files, the test files you wrote or touched (`pnpm --filter @oto/api exec vitest run --pool=forks test/<file>`, `pnpm --filter @oto/box-agent exec vitest run test/<file>`, never `test -- run`), `packages/shared` tests when shared changes, `pnpm api-types:check` when a route or schema changes.
- Never weaken or skip a test or a guard. Every mutating route keeps zod in and out, its permission and target, an audit row and idempotency.
- Commits per `CONTRIBUTING.md` with `Refs: SCRUM-n`; no attribution, co-author or generator lines; never commit `imports/` or `.env`; never print a secret; write about the system only, in neutral words.
- CI watched by the exact full SHA: `sh scripts/agent/watch-ci.sh <full-sha> 45`. A cancelled run is not a pass. A red run is fixed in the same session and said on the ticket.
- Staging proof is timestamped after the deploy, opened and checked before you claim it, saved under `docs/qa/proof-2026-11-02/` and attached. Use only a new `ZZ TEST` virtual box and `ZZ TEST` station; the owner has said the park Pi and its stations stay untouched. That means never "Till 1 (Pi)", never "Till 2 (test)", never the FWBooth1 box. No real payments, no SMS, no real person's data.
- Jira the same turn, one plain comment per outcome: In Progress when picked, Testing after the push, Deployed only with proof (`node scripts/agent/jira.mjs walk SCRUM-n Deployed`, which refuses without an image and adds the commit links itself). Never set Done. A STATUS block per landing, committed and pushed; on a rebase conflict keep every block.

---

## Chat A — SCRUM-718

Hi Codex. Your SCRUM-710 routing question has an answer, and it is this unit: **SCRUM-718, the POS reaches the API on a path that can stream and adds no delay.** The planner measured your gap independently and got the same result: about 0.55 s per call through the static site's rewrite, about 0.12 s direct. Follow the rules above in `docs/handover/CODEX_PROMPT_BOX_LANE_AND_POS_PATH.md`.

**Read**: `docs/architecture/ARCHITECTURE.md` section 16, which stands and which you must not change; `render.yaml` ~L270-320 (`TRUST_PROXY`, `TRUST_PROXY_ADDRS`), ~L340-360 (`ALLOWED_ORIGINS`), ~L418 (the hand-off audience list) and the `oto-pos-staging` block ~L775-815; `apps/pos/vite.config.ts` (the prefix strip); `apps/pos/src/api/client.ts`; `apps/pos/src/lib/scanChannel.ts` ~L196-214; your `docs/qa/proof-2026-11-02/s710-results.md`.

**The decisions (final; build these, do not reopen them)**
- **One origin stays.** Same relative `/api`, same host-only `SameSite=Lax` httpOnly cookie, no CORS, no new credential, no change to the POS's client code unless a test shows it is needed.
- **A small Node server with no framework** (`node:http`), in `apps/pos/server/`, deployed as one Render web service in the API's region. It serves the same `apps/pos/dist/public` files with the same client-side routing fallback the static site has, and forwards `/api/*` to the upstream named by an `API_UPSTREAM` variable, stripping `/api` exactly as `vite.config.ts` and the rewrite do. `API_UPSTREAM` is the API's internal address on Render's private network, and a public URL also works.
- **It forwards streams unbuffered**, ends the upstream request when the client goes away, and keeps upstream connections alive, because reusing them is where the saved time comes from.
- **It forwards what the API relies on**: `Origin`, `Cookie`, `Authorization`, `Accept`, every `Set-Cookie` separately, `x-forwarded-for` (appended, so the per-IP sign-in limit still sees the real client) and `x-forwarded-proto`. Read how the API uses these before writing it. If `TRUST_PROXY_ADDRS` must name the new hop, say so in the switch-over list.
- **Static file caching matches what the static site serves today**: hashed assets long-lived, `index.html` and the service worker not. Read the live headers first and include the service worker path. The PWA must keep working.
- A `/healthz` of its own that does not touch the API. An upstream failure answers in the API's error envelope with a 502, so the till's `NetworkError` and lane logic behave as they do now. Read `apps/pos/src/lib/lane.ts` before choosing the status.
- Other static sites (Console, launcher, inbox, booth) are not part of this unit.

**What is yours**: `apps/pos/server/**`, a package script to run it, a commented-out service block for it in `render.yaml` (no blueprint is linked, so this documents it and creates nothing), `docs/ops/POS_WEB_SWITCHOVER.md`, and tests: prefix strip, an event stream arriving unbuffered chunk by chunk, client disconnect ending the upstream, `Set-Cookie` kept separate, `x-forwarded-for` appended, the upstream failure envelope, the SPA fallback never swallowing `/api`, and asset and service-worker headers. Run it locally in front of a local API and record the added latency; state plainly that this is local.

**`docs/ops/POS_WEB_SWITCHOVER.md`** holds the exact list for going live and for going back: `ALLOWED_ORIGINS`, the hand-off audience list, `TRUST_PROXY_ADDRS`, `VITE_*` values, the iPads' installed-app address, re-pairing displays because a display's credential lives per origin, the Pi's `OTO_BOX_BRIDGE_ORIGINS`, and SCRUM-711's `--kiosk-url`.

**STOP before creating the Render service.** It costs money and needs the owner's explicit yes, which the planner will write on SCRUM-718. Until then, land the server dark: nothing live changes. When the yes is on the ticket, create the service beside the old static site with both origins allowed, measure the same path, re-run your SCRUM-710 harness against the new address, and attach the results. A POS call must add under 50 ms over the direct API, and SCRUM-710's two directions must each be under 500 ms. If they are not, report the real numbers and do not mark anything Deployed. Do not switch the park's iPads or the Pi over; that is the owner's step.

**Not yours**: `packages/box-agent/**` and `apps/pos/src/api/checkin.ts` (Chat B), `scripts/pi/**` (planner).

Write in STATUS that you have started, walk SCRUM-718 to In Progress, and start. SCRUM-710 stays at Testing until its numbers pass.

---

## Chat B — SCRUM-717, then SCRUM-708

Hi Codex. Your storage unit is finished. Two units next, in this order: **SCRUM-717, the box lane follows the station's payment routing and readiness**, then **SCRUM-708, offline booked check-in keeps a freshly acknowledged guardian consent.** Both must land before the counter's box lane goes into daily use (SCRUM-713). Follow the rules above in `docs/handover/CODEX_PROMPT_BOX_LANE_AND_POS_PATH.md`. Take 708 only once 717 is Deployed with its proof.

**SCRUM-717: read** `packages/shared/src/station-readiness.ts` as SCRUM-715 left it; `apps/api/src/services/payments/routing.ts` ~L105-131; `packages/box-agent/src/station-bridge.ts` (`claim` ~L1448, the tender ~L4074-4085); `BoxConfigStation` in `packages/box-agent/src/protocol.ts`, which already carries `paymentRouting`; `apps/api/src/services/fleet.ts` (`assertStationReady`); `docs/architecture/ARCHITECTURE.md` section 17 (the offline capability list).

**The decisions (final)**
- One rule, not two. The box uses the helpers in `@oto/shared`, which it already depends on. It does not get its own copy.
- The box lane does what the platform does for each routing value, with the same sentences. QR `none` is refused as the platform refuses it; QR `gateway` keeps the box's existing refusal because minting needs the server; an unset QR goes to the terminal. For card, read how the platform and the till treat `manual` and match it. Do not invent a behaviour; if the platform's depends on a server call, keep the box's existing sentence and say so on the ticket.
- The box's lease refuses a not-ready till, as the platform's bridge lease now does.
- **An outage must never stop a ready till.** A box that cannot tell, because its bundle is older and lacks a field or the field does not parse, allows the lease and behaves as it does today. It refuses only on a known not-ready fact. A test pins this. The bundle stays expand-only, so an older agent still parses a newer bundle.
- No change to sale safeguards, numbering or sealing.

**Tests**: per routing value on the box lane, in step with the platform's cases; lease refused and allowed; the older-bundle case. **Proof**: a new ZZ TEST virtual box and till with the station forced offline by the Console's switch: the sentence on screen for QR none and for a not-ready till, and a ready till selling cash.

**SCRUM-708: read** finding D3 in `docs/qa/flow-review-2026-11/REPORT.md` with its evidence: `apps/pos/src/components/dropoff/CheckInBookedModal.tsx:93-112`; `apps/pos/src/pages/DropOff.tsx:743-756`; `apps/pos/src/api/checkin.ts:726-763`; `apps/api/src/services/checkin.ts:1893-1917`; `packages/shared/src/checkin-offline.ts:185-215,281-297`; `packages/box-agent/src/checkin-desk.ts:1381-1519`; `apps/api/src/services/sync-checkin.ts:555-629`.

**The decisions (final)**
- Carry the acknowledgement and its time through the offline client, the bridge schema, the box's fact, the durable overlay and the replay, with the same validation as online.
- The time is when it was acknowledged at the counter, not when the replay ran.
- The replay writes consent only where the registration has none. It never overwrites an existing timestamp, and it records an audit row naming the box's fact.
- Expand-only: an older fact without the field replays exactly as it does today, and a test pins this.
- The prototype's dialog does not change.

**Tests**: offline check-in with a fresh acknowledgement reaches the registration after reconnect; an existing consent is untouched; replaying twice writes once; the older-fact case. **Proof**: a `ZZ TEST` registration with no consent on a forced-offline virtual box till, before and after reconnect.

**Not yours**: `apps/pos/server/**` and `render.yaml` (Chat A), `scripts/pi/**` (planner). If you think you need a change there, write the question in STATUS and on the ticket and keep going on what does not depend on it.

Write in STATUS that you have started, walk SCRUM-717 to In Progress, and start.
