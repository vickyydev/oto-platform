# Handover — where this is, and what to do next

_Written 2026-09-21 at the end of a long session; updated 2026-09-22 and
2026-09-23. Read this, then `SPRINT_2_PROGRESS.md` → Status, then
`POS_GAP_REGISTER.md`, then `ARCHITECTURE_CONFORMANCE_REGISTER.md`._

> ## Status on 2026-09-23 14:14 — `main` is `3ba0840`; staging is `7b746f1`; CI green through `b458650`
>
> **Since 13:41:** landed the 204 panel fixes (`bbf1792` — its gate was DO NOT
> MERGE for one line: the scanning test now reads the seeded socks row), **328**
> (`e977b49` — an offline box polls for go_online only), **325** (`b458650` —
> every refusal costs one argon2 verification), **329** (`3ba0840`).
> **Deployed with staging evidence:** 331 (one registration, zero refusals
> across a real ~61 s two-instance overlap), 253, 255, 327. Raised: 347
> (codes stored as plain SHA-256 of six digits — building), 348 (unlock
> route timing, after 347), 349 (the phone sheet prices itself).
> **SCRUM-206 tenders:** the read-only planning fan-out produced
> `scratchpad/plan-206/PLAN.md` (eight slices, five waves — A → B/C1/E →
> C2/D → F/G); the plan and the owner decisions (2C2P sandbox, offline
> scope, vendor questions) are on the ticket; **Slice A is building**
> (`wf_60563353`: migration 0019, payment_attempt/notification/method,
> shared vocabulary, seed:demo-day).
>
> **Running:** gates — 333/334 (`wf_e70284a0`); builds — 337/338
> (`wf_438d7369`), 342 (`wf_eb99843a`), 346 (`wf_d83140b5`), 341
> (`wf_6eb93633`), 347 (`wf_5543a1c8`), 206-A; evidence — 335
> (`wf_af70868e`). A watcher waits for Render at `3ba0840`; then evidence
> for 328, 325, 329, the 204 fixes and 341 when they land.
>
> **Next:** 343/344 after 333/334 free `sale.ts`; tenders wave 2 (B, C1, E)
> after A lands — B must follow 333 (both in `sale.ts`); 348 after 347.
> Owner decisions outstanding: 206's three (above), 254's two, 306's
> read-only staff, 327's retried pairing, 345, 326, the "HKT Central"
> app-only row (268), the deploy-bot paid service.

> ## Status on 2026-09-23 13:41 — `main` is `96523cd`; staging is `adff73c` (Render is deploying `b7d7b67` → `7b746f1`); CI green through `adff73c`
>
> **Since 13:12:** landed the branch clone R-03 (`2740291` + the two
> `app.ts` lines), **331** (`adff73c` — advisory-lock lease, refusal
> back-off; a failed box start gives the lease back, statement timeout on
> the probe), **253/255/327** (`b7d7b67` — archived tenancy stops trading,
> record scope and foreign file owners refused, the code-minting routes
> declare secretResponse; 327's premise — an ERROR line per pairing — was
> false and the comments now say what was true), **335** (`7b746f1` — the
> rate-limit builder now raises an AppError, so a capped request answers
> 429 not 500). **Deployed with staging evidence:** 233, 306; 204's three
> landed halves are evidenced and commented (ticket stays In Progress).
> Raised: 345 (codes unique per operator block cloning coded items — owner
> decision), 346 (Discounts panel styled for a dark screen). Left on
> staging by the passes: member +66800000233 with one child and a draft
> visit, one unpaid `tendering` sale, booking OTO-734160-3268 redeemed,
> product "Grip socks M" 8850000000017, sales T1-000006/7.
>
> **Running:** gates — 204 panel fixes (`wf_7d83497d`); builds — 337/338
> (`wf_438d7369`), 328 (`wf_384ce931`), 333/334 (`wf_e70284a0`), 329
> (`wf_3d5b8bf8`), 325 (`wf_27963949`), 342 (`wf_eb99843a`), 346
> (`wf_d83140b5`); planning — SCRUM-206 tenders read-only fan-out
> (`wf_66f5e63a` → `scratchpad/plan-206/PLAN.md`); evidence — 331/253/255/
> 327 waiting for Render at `b7d7b67` (`wf_969f6625`). Watchers wait for
> Render at `b7d7b67` and `7b746f1`.
>
> **Next:** land each on its gate; 341 after the 204 fixes free
> `api/menu.ts`; 343/344 after 333/334 free `sale.ts`; then the tenders
> slices from PLAN.md (206), 207, 208. Owner decisions outstanding: 254's
> two calls, 306's read-only staff, 327's retried pairing minting a second
> credential, 345, 326, the "HKT Central" app-only row (268), the
> deploy-bot paid service.

> ## Status on 2026-09-23 13:12 — `main` is `2a9dd25`; staging is `deaf34d` (Render is deploying `849bc17`); CI green through `fa3785a`
>
> **Since 12:30:** landed 252/254 (`6ea6220`), 330 (`deaf34d`), 233
> (`3d0cfb6` — the supervision gate writes through the member API), the
> 204 barcode + admin panels (`fa3785a`), 306 (`28d2e65` — the booking
> permission pair), the **204 carts** (`849bc17` — F&B and shop orders
> through the sale ledger, priced on the platform, pick-up code before the
> tender) and their evidence. **Deployed with staging evidence:** 318, 319,
> 304, 332, 336, 252, 254, 330. Raised: 337–340 (233's follow-ups: no
> child-archive route, the review's stale "held in memory" note, two draft
> visits, the mock drop-off lookup), 341 (F&B item form still tab-only),
> 342–344 (carts follow-ups: Charge stays enabled after a refusal,
> sales_channel always "till", promo scopes miss F&B lines).
>
> **Running:** gates — tenancy 253/255/327 (`wf_0532c182`), branch clone
> R-03 (`wf_70c3b1f2` — the parent adds its one `app.ts` line), 331
> (`wf_0cb720ff`); builds — 337/338 (`wf_438d7369`), 204 panel fixes
> (`wf_7d83497d`: localOnly flags, merch-under-F&B category, seed barcode),
> 335 (`wf_e175b9c5`: the 21st booking answers 429). Watchers wait for
> Render at `849bc17`; then one evidence pass for 233, 306 and the two 204
> halves.
>
> **Next:** 341 after the 204 fixes free `api/menu.ts`; 333/334 now that
> `sale.ts` and the staff panel are free; 328 after 331 frees `agent.ts`;
> then tenders (206), 207, 208. Owner decisions outstanding: 254's two
> judgement calls (docs gated everywhere; branch managers can read it),
> 306's read-only staff losing the arrivals list, 326's fix choice, the
> stale "HKT Central" app-only row (268), the deploy-bot paid service.

> ## Status on 2026-09-23 12:30 — `main` is `1875f56`; staging is `16c621a`; CI green
>
> _(The two banners below are labelled 12:00 and 13:00 but were written about
> an hour earlier than they say; times from here on are the machine clock,
> Asia/Bangkok.)_
>
> **Since the previous banner:** landed 257 (`69af2fb`), 309 (`cc686cc`), 318/319
> (`16c621a`), the claim-refusal ordering (`77080e9`), **304** (`c6338d6` —
> `pos.booking_redemption`, migration 0018 with a backfill) and the 336 hint
> (`1875f56`). **Deployed with staging evidence:** 322/305/323, 316 (+311's
> live refusal), 257, 309. Raised: 331 (the virtual box re-registers in a
> storm around every deploy — 637 refusals a day), 332 (**every staging
> deploy re-ran the full demo seed** — Render's pre-deploy was
> `db:seed`, not the `db:platform-sync` render.yaml documents, with
> `SEED_PROFILE=staging`; changed on Render to `pnpm db:migrate && pnpm
> db:platform-sync` at 12:20, verified by the next deploy's log line), 333
> (sale read lacks the claim id), 334 (Subtotal ฿0 beside a real Total),
> 335 (21st booking in a minute answers 500), 336. New Bugs go under
> SCRUM-324 by default (`createInSprint` in the scratchpad).
>
> **Running:** builds — 233 (`wf_f769bf02`), carts 204 (`wf_cde4e3cd`),
> tenancy 253/255/327 (`wf_0532c182`), barcode + admin panels
> (`wf_344f565a`), 330 (`wf_b892a282`), branch clone R-03 (`wf_70c3b1f2`),
> **331** (`wf_0cb720ff` — advisory-lock lease + refusal back-off); gate —
> 252/254 (`wf_effd34f0`); evidence — 318/319 (`wf_22423a2a`). A watcher
> waits for Render at `c6338d6`; then an evidence pass for 304, 332 (the
> "Platform sync only" log line) and 336.
>
> **Next:** land each on its gate; 306 after 304 (redeem's own permission);
> 333/334 after the carts slice frees `sale.ts` and the staff panel; then
> tenders (206), 207, 208.

> ## Status on 2026-09-23 13:00 — `main` is `b9438cd`; staging is `d1d0bd7`; CI green again
>
> **Since 12:00:** the box slice landed (`d1d0bd7`, 322/305/323 Testing;
> its first gate answered the monitoring question instead — re-run and
> MERGE); the till slice landed (`a872d9d`, SCRUM-316 Testing) and its
> finding is fixed on the platform (`77080e9`: a spent claim answers as
> itself, not as the price mismatch it causes); the booth is **Deployed
> with staging photographs** — SCRUM-199, 244, 278 and the **S2-07 story**
> — one screen paired to Booth 1 on staging by design, one spin. Raised:
> SCRUM-328 (Go online cannot reach an offline box), 329 (phone cart
> sheet). The Defects epic is SCRUM-324.
>
> **Running:** Round B builds — 257 (spin cap, `wf_88a379f8`), 309 (holiday
> rename, `wf_1a4a0748`), 318/319 (`wf_aad4bc77`), 304 (redemption table,
> `wf_fe4ec6dc`), 252/254 (public surface, `wf_effd34f0`); evidence passes
> for the seven Round A tickets (`wf_890979a3`) and the box (`wf_77dec1e1`).
> Watch with `node scripts/workflows-status.mjs`.
>
> **Next:** land those on their gates; 233 (supervision-gate child — Till.tsx
> is free now); 306 after 318/319 releases `permissions.ts`; 255; then the
> carts (204) and tenders (206).

> ## Status on 2026-09-23 12:00 — `main` was `6f266d0`; staging was `0da5441` (CI was red for four pushes, fixed; deploy pending)
>
> **Owner decisions this morning:** every Bug/Task lives in the sprint
> (88 moved into "Sprint 2 – Complete build", id 3); defects sit under the
> red-ish epic **SCRUM-324** (`dark_orange` — Jira's palette has no red) with
> `defect`/`gap`/`ci-check` + area labels; GitHub is linked to Jira and
> **`scripts/jira-walk.mjs` links the shipping commits on the ticket when it
> reaches Deployed** (`--link-only` backfilled 132 links on 68 tickets); parent
> stories get a status paragraph whenever a child moves; the other session is
> paused and `render.yaml`/Render are ours now (its deploy-bot block stays
> uncommitted — a paid service is the owner's call).
>
> **Landed since 08:00:** the booth's Render service
> **https://oto-booth-staging.onrender.com** (created through the API — no
> blueprint is linked; `1a6ba2b` carries the yaml entry; the api's
> `ALLOWED_ORIGINS` on Render now includes it); the television frame ported
> from the prototype (rotate/scale, `#cw/#ccw/#off/#lite`) and **screen
> pairing** closing SCRUM-244 (`451c7b3` — 199/244/278 Testing); handheld
> History (`482912e`, 320); auth hardening 251/298 (`23edaf8`, `26bd73b`);
> members fields 231/321/317/315 (`8bcbd0f`); walker + monitor scripts.
> Raised: SCRUM-325 (timing side-channel), 326 (result card 36px over a
> 16:9 stage), 327 (station pairing route's secretResponse).
>
> **Running:** the till slice (`wf_b8035d08`: SCRUM-316 + the refusal on the
> till) and the re-run box gate (`wf_e9a9d2b3`: SCRUM-322/305/323 — its first
> gate answered an unrelated question). Monitor with
> `node scripts/workflows-status.mjs [--watch]` (`/workflows` is not in this
> editor). **A Stop key or a declined permission prompt cuts every running
> subagent at once** — five slices died that way at 10:15 and were relaunched
> with a resume preamble.
>
> **Next:** CI green on `6f266d0` → Render → booth staging photographs
> (rotation on the live URL, a real pairing) → 199/244/278 Deployed and the
> S2-07 story with them; land the till and box slices; then Round B
> (233, 257, 304/306, 309, 318/319), the carts (204), tenders (206).

> ## Status on 2026-09-23 08:00 — `main` was `0a669f0`; staging was `0a669f0`; the tree was clean
>
> **Since 06:00:** SCRUM-268 Deployed with its Console Branches page on
> staging; SCRUM-275's last two halves landed (`b673948` — `edge.box_cache`,
> migration 0016; the receipt mark from `pos.receipt_series`); SCRUM-311
> landed (`0a669f0` — `pos.sale_tier_claim`, migration 0017, single-use
> claims, the sale names its claim, the demo reset cuts the cycle). Both in
> **Testing**; an evidence pass (`wf_bcf526b9`) is putting their staging
> screenshots on and walking them to Deployed. Raised: **SCRUM-322** (the
> receipt mark moves the bundle etag, so a selling box pulls its whole
> bundle each minute — plan on the ticket).
>
> **Next, in order:** SCRUM-322 (split the mark out of the etag);
> SCRUM-320 (handheld History); SCRUM-316/317/321/315 (each under an
> hour; 316 should also show `tierClaimRefusal` on the counter till);
> SCRUM-304/305/306 (bookings follow-ups); SCRUM-204's carts (S2-09b);
> S2-10a tenders (SCRUM-206). SCRUM-199 stays blocked on the booth's
> Render service; the stale "HKT Central" app row awaits the owner
> (SCRUM-268 comment).

> ## Status on 2026-09-23 06:00 — `main` was `9bcf46e`; staging was `1634f82`
>
> **Everything launched tonight has landed.** Since 04:30: SCRUM-268 branch
> mapping (`6e7d557`, Testing — staging reconciled, Central Floresta and
> Robinson Chalong mapped, Head Office app-only, plus a stale app-only
> "HKT Central" row that needs the owner's decision); the seed writes the
> demo menu (`3dc0359`) and the F&B category carries a code (`178567a`);
> the four menu fixtures that collided with the seeded menu (`1634f82`,
> CI red for two commits, fixed the same hour); History reads the ledger
> (`a21d12d`, SCRUM-238). **Deployed with staging screenshots:** 232,
> 230, 292, 302, 310, 312, 241 — on top of the thirteen at 03:30. Raised:
> SCRUM-318 (operator-wide by role name), 319 (no unique on
> core_branch_id), 320 (handheld History still sample rows), 321 (admin
> Members dialog writes a WhatsApp channel nobody chose).
>
> **Running:** one evidence pass (`wf_dd187784`) — SCRUM-268's Console
> Branches page and History on staging; 268 walks to Deployed on it.
>
> **Staging:** the seed was run once from this machine (the database's
> temporary IP allow-list entry now points at this machine's address —
> `scratchpad/db-allow.mjs`; it is the same single "remove after" entry
> as before, re-pointed). Staging holds sales T1-000001/T1-000002 (expat),
> T2-000001/T2-000002 (tourist), booking OTO-1590237-7290 (redeemed), the
> renamed holiday, the archived evidence menu rows; James is back on Expat.
>
> **Next, in order:** SCRUM-275's two remaining halves (edge.box_cache
> table; receipt high-water mark from the ledger); SCRUM-311 (claim table
> + `sale.tier_claim_id`); SCRUM-320 (handheld History); SCRUM-316/317/
> 321/315 (each under an hour); SCRUM-204's carts (S2-09b); then S2-10a
> tenders (SCRUM-206), which the ledger's Pay → Confirm flow is waiting on.
> SCRUM-199 stays blocked on the booth's Render service (other session).

> ## Status on 2026-09-23 04:30 — `main` was `de069c1`; staging was `d26e21c`
>
> **Since the 03:00 banner:** the menu slice passed its second gate and
> landed (`d26e21c` — SCRUM-232/230, SCRUM-204's catalogue half, the
> SCRUM-292 schema-shape test with its lockfile, SCRUM-302); CI green,
> migration 0015 applied on staging, the menu routes answer there. The
> Deployed-evidence pass put staging screenshots on 296/297/299/300/301/
> 200/307/228/308/313/234/238/314 — all **Deployed**. POS round 3 landed:
> the phone till's tier claim (`d16b27f`, SCRUM-310), the visitor display
> dashes (`b9c9584`, SCRUM-312), revoking a verified tier (`dd54c79`,
> SCRUM-241) — all Testing with images; SCRUM-308's last piece
> (`de069c1`). Raised: SCRUM-315 (member route's free-text evidenceType),
> 316 (staff-half ฿0), 317 (register's revoked shape).
>
> **Running:** SCRUM-268 branch mapping (`wf_884722ad`; owns
> `routes/{branches,app-identities}.ts`, `services/oto-app-*.ts`,
> `packages/db/src/{seed/index,schema/otoapp}.ts`, Console `Branches.tsx`),
> History reading the ledger (`wf_a242658f`; owns `pages/History.tsx`,
> `components/history/**`, `api/history.ts`, `listSales`'s select),
> the menu evidence pass on staging (`wf_3a89e172`; SCRUM-232/230/292/302
> → Deployed). **After 268 lands:** add `await seedMenu(db, { operatorId,
> branchId })` to `packages/db/src/seed/index.ts` after the branch tax
> config (the demo menu is dead code until then — staging holds one item).
>
> **Staging holds from tonight's evidence:** sale T1-000001 (expat, ฿973)
> at Central Floresta, booking OTO-1590237-7290 (redeemed), the renamed
> holiday; the evidence tier was removed. The other session's
> `render.yaml` and `services/` are still uncommitted in the tree.

> ## Status on 2026-09-23 03:00 — `main` was `b8029f2`
>
> **Landed since the banner below:** SCRUM-308 (chip and receipt agree on
> the trading day, `155a251`); the box pulls whole after an outage
> (`72e97fd`); the five ledger items 296/297/299/300/301 (`bcf32d5`,
> assembled hunk-by-hunk from a tree three slices shared); the tier claim
> 307/228/203 (`b8029f2`). All in **Testing**; they move to Deployed when
> Render has `b8029f2` and a screenshot is on each. SCRUM-303 is Deployed
> (the eight tenancy tickets carry images). Follow-ups raised from the
> gates: **SCRUM-310** (phone till still cannot sell an Expat walk-in),
> **311** (claim table + `sale.tier_claim_id`), **312** (visitor display
> ฿0), **313** (epoch guard on `handleVerified`), **314** (etag vs a bad
> local bundle while online).
>
> **The menu slice is NOT on main.** Its gate said DO NOT MERGE; the slice
> is saved at `wip/menu-catalogue` (`d79038e`) and a fix round
> (`wf_cf412d0b`) is working in the tree on: Apply refused (POS sends
> `{previewToken}` only), the POS Export as a second writer, `sale.ts`
> reading the now-nullable `taxable_category` raw, re-import with
> `action=archive` refused, modifier-group archive leaving links. When it
> lands: commit by explicit list, then `packages/db/{package.json,
> tsconfig.json,test/**}` with the lockfile (SCRUM-302), then the one-line
> `setBranchDayStart(active.businessDayStart)` in `catalogBridge.ts`
> (SCRUM-308's last piece, held back because the menu owns that file).
>
> **Mixed-file discipline that worked:** `scratchpad/hunks.mjs list|pick`
> splits `git diff` by hunk; a temp index (`GIT_INDEX_FILE` + `read-tree
> HEAD` + `git apply --cached <picked>` + hand-built blobs via
> `hash-object` + `update-index --cacheinfo`) makes a commit that carries
> one slice's hunks and leaves the shared working copy untouched; then
> `git reset -q` aligns the main index. Never `git checkout -- <file>` to
> "restore" — it restores HEAD, and it wiped a fix once tonight.

> ## Status on 2026-09-23 (early hours) — `main` was `0662fcb`
>
> **Landed since the 22nd banner, in order:** the two-branch park with its
> branch managers and the eight leaks it exposed (SCRUM-248–250, 263–267,
> Deployed); the tenancy leaks and the three conformance tests that keep them
> closed (280–284, 289–291, Testing); bookings found and redeemed at the
> counter (234/238, Testing); screenshots on the 22 tickets that had none;
> the booth admin panel driven against a live box (SCRUM-200, **Testing**,
> `388b7c8`); and **the box now refreshes its cache on a timer** (`72a1c48`,
> SCRUM-275 In Progress) — until then a published wheel, a withdrawn booth
> PIN or a dismissed employee's revocation reached a running box only at its
> next restart, and "Apply config" on the Console reported success while
> changing nothing.
>
> **CI note:** `05beeca` was red — it carried `import { menuRoutes }` while
> `routes/menu.ts` is still the menu slice's uncommitted file. `0662fcb`
> drops the import from `main` without touching the shared working copy of
> `app.ts` (built from HEAD's blob through a temp index). When the menu
> lands, its `app.ts` re-adds the import together with the file.
>
> **In flight at the moment of writing — three workflows at their gate
> stage, all with explicit file ownership, none committed:**
> - **tier-claim** (`wf_72cfced7`): SCRUM-307/228/203 — `services/sale-tier.ts`,
>   `routes/sale-tier.ts`, one call site in `services/sale.ts`, till gaps in
>   `StepPayment/StepConfirmation/OrderSummary/TicketCard.tsx`, `lib/pricing.ts`,
>   `lib/tierProof.ts`, `MobileTill.tsx`, `VerifyTierModal.tsx`.
> - **cheap-fixes** (`wf_5694e79e`): SCRUM-296/297/299/300/301 —
>   `routes/{auth,files,sales,ops}.ts`, `services/{auth,handoff,ops,access-control}.ts`,
>   `plugins/session.ts`, `console/src/lib/reach.ts`, `pages/{Failures,Health}.tsx`,
>   `test/{auth-handoff-files-tx,sales-reach}.test.ts`.
> - **menu** (`wf_25c76908`): SCRUM-232/230/204 — migration `0015_menu_catalogue`,
>   `packages/shared/src/menu-shapes.ts`, `services/{menu,menu-sheet}.ts`,
>   `routes/menu.ts`, `packages/db/src/seed/menu.ts`, `pos/src/api/menu.ts`,
>   `pos/src/components/admin/menu/*`, `apps/api/package.json`, `pnpm-lock.yaml`.
>   **After it lands:** commit `packages/db/{package.json,tsconfig.json,test/**}`
>   with the reconciled lockfile (SCRUM-302).
>
> Each result is read in full, its files committed by explicit list (never
> `git add -A`), the commit checked against its message, Jira moved in the
> same turn, and nothing reaches Deployed without a screenshot on the ticket.
> If a gate says DO NOT MERGE, the slice goes to a `wip/` branch through a
> temp index BEFORE any fix round.
>
> **Raised this turn:** SCRUM-309 (a holiday that has priced a sale can be
> neither removed nor renamed — the staging test holiday was renamed directly).
> **Staging:** the "zz-shot evidence" holiday at Robinson Chalong is now
> "Weekend pricing test (22 Sept)"; it priced one sale on the 22nd, so the
> platform correctly refuses to delete it.
>
> **Still blocked on the other session:** SCRUM-199's Render service for
> `apps/booth` (`render.yaml` and `services/deploy-bot/` are theirs — the
> working tree shows both modified; leave them).

> ## Status on 2026-09-22 — the banner below it is RESOLVED
>
> Everything that banner asked for is done and live. SCRUM-242, 243, 245,
> 247, 259 and 260 are **Deployed**; 246 is Deployed on the api. Every kiosk
> path now requires a device credential, stays inside its own park, and
> refuses with one uniform answer. Two small kiosk findings remain as
> tickets: SCRUM-261 (anonymous image upload) and SCRUM-262 (unthrottled
> failure log).
>
> **The park's real staff rows ARE on staging** — 10 staff, 959 clock-ins,
> 59 tasks. The workflow stopped on the 21st had reached the load step
> before the stop landed, and its report never returned, so they were there
> about a day with the kiosk findings open. **Ten rows carried face
> enrolment, which was cleared directly**: the mock matcher clocks anyone in
> as the first enrolled person, so an enrolled row was an impersonation.
> The seed (`e5649ad`) no longer carries face enrolment for anybody.
>
> **Also on 2026-09-22:** the sale ledger (SCRUM-203) is on `main` and
> **Deployed** — a real sale was rung through staging, receipt `T2-000001`.
> The booth admin panel (SCRUM-200) is on `main`, In Progress pending its
> first browser run against a live server. `main` is **`e5649ad`**; §1 and
> §8 below describe the 21st and are superseded by this.
>
> **Next, in order:** the booth's Render service (still the other session's
> blueprint); S2-07b's first integration run; S2-09b (SCRUM-204), the F&B and
> shop carts; SCRUM-232, the product tables, which the menu import lands on;
> then the register's remaining broken items (230, 231, 233, 234, 238).

> ## ⚠ READ THIS BEFORE ANYTHING ELSE — as written on the 21st; resolved above
>
> **Staging is not safe to leave on the public internet with the park's real
> staff rows on it.** An authorization sweep at the end of this session
> confirmed fourteen findings (SCRUM-242 to SCRUM-255, all Bugs under epic
> SCRUM-181, labelled `security` + `authz-sweep`).
>
> The one that decides it is **SCRUM-242**: the OTO App's kiosk
> clock-by-phone endpoint takes an **anonymous** request with no device
> credential, and its only rate limit sits *inside* a branch that is skipped
> when no credential is presented. A number that belongs to staff comes back
> naming the employee and files a clock event; one that does not says so.
> Reproduced live — fifteen malformed numbers, fifteen refusals, no throttle.
> Against invented rows that is harmless. Against real phone numbers it is a
> staff directory and a time-clock anybody can drive.
>
> **So the seed was deliberately NOT loaded onto staging** and the deploy was
> not triggered. The work is committed at `fb07411`; the load is the step
> that was stopped. The seed is find-or-create and re-runnable, so nothing is
> lost by waiting.
>
> **Do these before running that seed against staging or telling the owner to
> look:**
> 1. Put `oto-app-staging` behind access control, or take it off the public
>    internet.
> 2. **SCRUM-242** — move the rate limit outside the credential branch and
>    require the device credential.
> 3. **SCRUM-247** — the kiosk device id is currently a 30-day bearer token:
>    `refreshKioskSession` matches the id and `active` only, never the secret
>    hash.
> 4. **SCRUM-245** — the null-scope invite fix is committed but the *deployed
>    POS bundle still contains the old code*, and staging's only
>    administrator is platform-wide, so the server accepts the null. Ship it.
> 5. **SCRUM-246** — `GET /members` with no search term returns the whole
>    register with every child's allergies and medical notes, on the same
>    permission that looks up one member. One shared till session is the lot.
>
> Two things the sweep did **not** find, which is worth knowing: no
> cross-operator escalation has any live reach on staging today (one operator,
> one branch), and **the pay figures in the seed are not exposed by any
> defect** — that is purely a question of who holds the admin password.
>
> Full detail, reproductions and what was touched on staging (read-only, two
> sign-ins, nothing created) are in the sweep's own report referenced from
> the tickets.

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

0. **The five security items in the banner at the top**, before anything
   else and before the owner is told to look at staging again. Everything
   below assumes those are done.
1. **Finish what is in Testing.** SCRUM-235/236/237/239/240 need staging to
   pick up `0abc9ea`, then a look, then Deployed with evidence. Shipping that
   build also closes SCRUM-245, because the null-scope fix is in it.
2. **The booth's Render service**, so SCRUM-199 can be Deployed and the wheel
   can be opened in a browser. Coordinate with the `render.yaml` session.
3. **SCRUM-203 — the ticket cart and the sale ledger.** Was the biggest real
   gap: admission reached "Pay ฿1,440" and **nothing after Pay existed**.
   **All three parts are now built in this tree and none is committed or
   deployed** — migration `0014_sales_ledger`, the till's quote-and-write
   path, and `apps/api/src/services/sale.ts` + `routes/sales.ts` behind
   `POST /sales/quote`, `POST /sales`, `POST /sales/:id/finalise`,
   `GET /sales` and `GET /sales/:id`. The next step is the one neither half
   can claim: commit, deploy and **drive it from a browser**. Tenders are
   S2-10a.
4. **SCRUM-229's sibling — one pricing engine.** Was one caller (the public
   booking quote) while the till priced in the browser from the prototype's
   copy. Now three: the booking quote, the till through `@oto/shared`
   directly, and `POST /sales/quote`, which is what the till asks and what
   the sale is written from. The two-engines problem is closed in the tree;
   it is closed *in production* on the day the above is deployed. SCRUM-226
   is what it cost.
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

## 8. Work in flight when this session ended — READ BEFORE TOUCHING THE TILL OR THE BOOTH

Two workflows were building when the session wound up, and **their code is
on disk, uncommitted, and may be half-written.** Nothing of theirs is
committed, so `main` is clean and green — the working tree is not.

**First thing to do: find out what state it is in.** `git status`, then
`pnpm turbo run typecheck` and `pnpm turbo run test`. If it does not build,
the fastest honest route is `git stash` (never `git checkout --`, you would
lose the lot) and rebuild from the design below, which is complete.

### Where the real record is

Both workflows persist to disk and **survive this session**:

| | |
|---|---|
| Their scripts, carrying the full brief and every design decision | `~/.claude/projects/C--Users-waqar-OneDrive-Desktop-Projects-oto-pos/317fcfce-2754-44c9-bec5-9a762ab18d03/workflows/scripts/s2-09a-sale-ledger-wf_62d14e91-eb9.js` and `…/s2-07b-booth-admin-wf_a761b608-c23.js` |
| What each agent actually did and returned | `~/.claude/projects/c--Users-waqar-OneDrive-Desktop-Projects-oto-pos/317fcfce-2754-44c9-bec5-9a762ab18d03/subagents/workflows/wf_62d14e91-eb9/journal.jsonl` and `…/wf_a761b608-c23/journal.jsonl` |

**Read the journals first.** One `{"type":"result"}` line per completed
agent, carrying its whole report — what it built, what it measured, what it
could not do. That is worth more than re-deriving from the diff. The scripts
can be re-run with `Workflow({scriptPath, resumeFromRunId})`, but **resume is
same-session only**, so in a new session treat them as documentation, not as
something to replay.

### SCRUM-203 — the ticket cart and the sale ledger (the biggest gap)

**What it is for.** The till reaches "Pay ฿1,440" and nothing after Pay
exists: no sale recorded, no tender recorded. `sale` and `sale_line` were the
empty Sprint 1 placeholders in `future.ts`; the POS's `recordSale` pushed
into an in-memory array and a refresh lost it. **The park could take money
and the platform would hold no record of it.**

**The design, decided and not to be relitigated:**

- **Migration 0014** replaces the placeholders. A sale must carry, on day
  one, the things that cannot be added cheaply later: operator, branch,
  station, box; the **business date** resolved from the branch's
  `business_day_start` (a sale at 00:30 belongs to the day that is
  finishing, not the calendar day); the pricing mode that applied and which
  holiday if any; **the member's tier at the time of sale**; totals split
  into net, VAT and service charge rather than one number, so a receipt is
  reproducible years later from the row alone; the account that rang it up;
  the receipt number; and a lifecycle column so a void or refunded sale is
  distinguishable from one that never happened (refunds themselves are
  S2-11 — build the column, not the feature).
- A line carries what was sold, quantity, unit price, the tier, **the
  adult/child split and free-adult allowance that produced it**, any
  discount with its reason, and the tax for that line.
- **The till mints the sale id**, so Pay pressed twice through a dropped
  connection is one sale. The constraint must say so.
- **One pricing engine.** The quote endpoint prices with
  `packages/shared` — the same engine the booking site uses. Before this, the
  tested engine (~1,600 lines, 1,694 lines of tests) had exactly **one**
  caller and the till priced in the browser in baht floats from the
  prototype's copy. They agreed because both are ports of the same rules;
  they were still two engines and the tested one was not the one taking
  money. SCRUM-226 is what that cost.
- **The price charged is the price the platform quoted.** If the till sends
  its own totals, compare and refuse on a mismatch. A server that trusts a
  client-supplied total is a discount anybody can give themselves.
- **The tier is resolved server-side** from the member, never taken from the
  body.
- **A ฿0 sale finalises like any other** — an acceptance criterion, not an
  edge case: a fully comped visit still leaves a record.

**Out of scope, deliberately:** how it was paid (S2-10a), the receipt print
and refunds (S2-11).

**The seam to prove:** a sale rung up through the built till lands as a row
with every column right. A test that posts to the route and asserts a row is
only half of it — five tickets here shipped a service with no caller.

**Where to resume: check out `wip/s2-09a-sales-ledger` at `4a34037`.** All
three slices are there — schema, till, service+routes — and nothing of it is
on `main`. Answer blocker 1 with S2-10a's tender design in hand, fix 2 and 3,
then merge; they are the only things between this and deployable.

What is already proved: the arithmetic (69/69 carts on the till's own check),
28 api tests driving the real routes with a real session and reading the rows
back, the till's payload shape accepted as it is actually sent, and migrations
twice from empty.

**The sync and box changes that were sitting beside it in the tree are now on
`main`** at the commit after `14201bc` — they were the booth's two PIN fixes,
described in `14201bc`'s message but missing from its file list, which turned
CI red until they were committed separately. If you diff the branch against
main and see them missing there, that is why.

**CHECKPOINTED, so none of it can be lost: branch
`wip/s2-09a-sales-ledger` at `4a34037`, pushed to origin.** It carries the
whole slice — migration 0014, the schema, the service, the routes, the till,
the tests and these documents — and **only** that slice: the sync and box
changes still in the working tree belong to another workstream and
`render.yaml` and `services/` to a third, so they were left for their owners.
It is a branch and not `main` on purpose: `CONTRIBUTING.md` says main is
always deployable, and a till that refuses every paid sale is not. The
working tree was not touched and `main` still points at `14201bc`, so the
other two workflows carried on undisturbed. Continue on that branch.

**An integration check then drove a real server on a real port with the till's
own commit body and read the rows out of Postgres. It found the seam, and it
is one boolean wide. FIX THESE THREE FIRST — do not deploy this as it stands:**

1. **A paid sale cannot be recorded.** The till sends `finalise: true` on every
   commit (`apps/pos/src/api/sales.ts:802`); the service refuses to finalise a
   sale that still owes money (`services/sale.ts:1169`, because `outstanding()`
   returns the gross until tenders land in S2-10a). Live: the till's verbatim
   body for a ฿1,440 admission → **409 `SALE_NOT_PAID`, zero rows**. The same
   cart with `finalise: false` → one row, two lines, audited. Only a ฿0 comp
   goes through. And the panel tells staff *"Trying again will not help… go
   back, check the order, call a manager"*, because `isRetryable()` reads a 409
   as a judgement about the cart. The comment at `api/sales.ts:170` claims
   "฿0 comps and paid sales both finalise here"; they do not. **Decide which
   side moves** — the till sends `finalise: false` and the sale waits in
   `tendering` without a receipt number, or `outstanding()` counts the till's
   `paymentMethod`. It is a decision about when a receipt number is allocated,
   so it belongs with S2-10a's design, not to whoever is fastest.
2. **After any refusal the cart can only be sold by discarding it.** The sale
   id, and the idempotency key `sale:<id>` derived from it, are minted once per
   Pay press and cleared only by `reset()`; `handlePaymentBack`
   (`Till.tsx:1672`) does not clear them. So *Back to the order* → fix the
   order → Pay → **409 `IDEMPOTENCY_MISMATCH`**, for ever, and Cancel is the
   only way out. Mint a new sale id whenever the cart changes after a refusal.
3. **A branch-scoped account can write a sale at another branch.** `POST
   /sales`, `POST /sales/quote` and `POST /sales/:id/finalise` declare their
   permission with **no `target`**, so the scope is never checked against
   `cart.branchId`. Driven as seeded reception (HKT Central only) against a
   second branch: quote 200, commit 200, row written at the other branch on its
   own station — and then `GET /sales/:id` refuses the same account 403, which
   is the proof the write should have been refused too.

Smaller, from the same run: `sale_line.revenue_category` is NULL on every row
(S2-09a's own acceptance criterion says the Sale detail view shows it
populated; the schema defers it to S2-09b); and **removing a holiday now
fails** — `sale.holiday_id` is `ON DELETE restrict` while
`DELETE /branches/:branchId/holidays/:id` hard deletes, so once a sale exists
on a holiday date the admin panel raises an unhandled Postgres 23503.

What that run *did* prove, by reading the rows: quote total equals the stored
`gross_satang` on all thirteen shapes (weekday, a holiday range as weekend,
three tiers, free adult, overflow, socks, fixed and percent staff discounts, a
promo code, ฿0 comp); the tier comes from the member even when the body lies;
the business date, day start, timezone, station, box, account, pricing mode,
tax snapshots and the four-way money split all land; two presses make one sale
and an aborted connection makes one; underpaying is refused; no session is
401; the freeze trigger fires; a six-hour clock skew is recorded as `skewed`
and cannot move the trading day.

### SCRUM-200 — the booth admin panel

**What it is for.** The wheel runs on a seeded prize list; this is where a
manager changes prizes, odds, daily caps, expiry, layout, the button key and
who may sign in — and publishes.

**The design, decided:**

- **Publishing is the heart of it, and a published version is immutable.**
  Publishing mints a new version; the box picks it up by version, about a
  minute later, and applies it **whole and only between spins**. Editing a
  published bundle would change what a spin that already happened was drawn
  from — `booth.spin` records its version for exactly that reason.
- **Validate before publishing, not after.** Weights are integer basis
  points summing to **exactly 10000**; every prize needs a voucher
  definition; a prize cannot be active with no expiry. A booth running an
  invalid bundle hands out wrong prizes and cannot tell.
- **Refuse a publish that leaves the wheel unplayable** — every prize
  inactive, or every prize capped. The draw handles that state correctly by
  accident; publishing it deliberately is different.
- **The Console shows real percentages, not basis points**, with the running
  total and what each prize costs at its chance. A manager should never do
  that arithmetic, and "what does this wheel cost me a day" is the first
  question the owner will ask.
- **Show what is about to change before Publish takes effect.** It is a live
  change to a machine in a public place.
- **A PIN must never travel on the box command queue** — its payload is
  stored and rendered on a Console screen. That is why S2-07a deliberately
  left badge and PIN out of the simulator panel. Any PIN management here
  needs a path that does not store what it carries.
- It registers its routes **inside `apps/api/src/routes/booth.ts`**, not in
  `app.ts`, to stay clear of the sale work.

**The seam to prove:** change a weight in the Console, publish, and watch a
**real** box pick that version up and draw from it. Asserting a row landed is
not the ticket.

### File ownership these two were working to

Keep it if you resume both; it is what let them run together.

| Workflow | Owns |
|---|---|
| Sale ledger | `packages/db/migrations`, `schema/{sales,future,index}.ts`, `apps/api/src/services/sale.ts`, `routes/sales.ts`, `app.ts`, `apps/pos/**`, `packages/shared` cart code |
| Booth admin | `apps/api/src/services/booth-admin.ts`, `routes/booth.ts`, `apps/console/src/pages/Booth*`, `components/booth/**` |

## 9. Known gaps in our own tooling

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
