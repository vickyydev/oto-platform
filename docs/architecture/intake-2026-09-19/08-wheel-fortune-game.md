<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **Lucky Wheel game** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

# OTO Lucky Wheel ("Spin & Win") — codebase analysis for re-platforming

I read the code and docs only; nothing was run, built or modified. Root `W` = `imports/oto-wheel-fortune`. HEAD = `3458840` "Published your App" (17 Sep 2026), `BUILD_TAG = "v25"`. **(V)** = verified by reading code, **(I)** = inferred.

**`W/replit.md` is stale and will mislead.** It describes 5 prizes, phone-number claims, a staff "balloon" redeem and 24h expiry. The voucher flow was rewritten on 17 Sep 2026 (commit `1325076`, `VoucherPage.tsx` cut by ~1,800 lines). At HEAD there are 6 prizes, no phone capture, no expiry and 4-digit Radar codes. Trust `W/.agents/memory/oto-analytics-bridge.md:8-35` and the code.

---

## 1. Structure

| Package | Role | Status |
|---|---|---|
| `W/artifacts/spin-win` | The real game. One Vite/React SPA routed by pathname in `src/main.tsx:17-47`: `/` is the TV kiosk game, `/v/<prizeId>` the guest phone voucher page, `/staff` the reception list | Live |
| `W/artifacts/api-server` | Express 5 API. Records wins, bridges to Radar, heartbeat, legacy claims | Live and used |
| `W/lib/db` | Drizzle + Postgres, tables `spin_wins` and `prize_claims`. Schema applied by `drizzle-kit push`; no migration files | Live |
| `W/lib/api-spec`, `W/lib/api-zod` | OpenAPI 3.1 → Orval → Zod; used by the server | Live |
| `W/lib/api-client-react` | Generated react-query client | Dead: listed in `spin-win/package.json:54`, never imported; the app uses raw `fetch` |
| `W/artifacts/mockup-sandbox` | Replit "Canvas" preview server, one mockup (`HowToGoThere.tsx`) | Scaffolding |
| `W/scripts` | Puppeteer tests plus `post-merge.sh` (`pnpm install` and `db push`) | TV tests useful; voucher/claims/booth tests target removed UI **(I)** |

- **Variants:** there is only one game app. The original mobile-first version (guest spins on their own phone, one spin per device) is this same code's past. `W/exports/spin-win-qr.png` still encodes the old `wheel-fortune-mobile.replit.app` domain (`.agents/agent_assets_metadata.toml:4-9`); production is `spingame.replit.app`. The layout is a fixed 480px portrait design, rotated and scaled to the TV.
- **Stack (V):**
  - Core: pnpm workspaces, Node 24, TypeScript 5.9, React 19.1.0, Vite 7.3, Express 5, drizzle-orm 0.45, zod 3.25 (`zod/v4`), pino.
  - Browser: `@vitejs/plugin-legacy` 7 with targets `chrome>=47, samsung>=4` (`vite.config.ts:38-40`), `cssTarget: chrome61` (`vite.config.ts:68`), qrcode.react, canvas-confetti. Tailwind 4 is installed but unusable on kiosk screens.
  - Deploy: Replit autoscale; static SPA with `/*→/index.html`; API on 8080 under `/api`.
- **Dead weight in spin-win:**
  - Code: 55 shadcn/ui files; `not-found.tsx` (unrouted); all kiosk-enrollment and claim client functions in `claims.ts` except `registerWin`, `flushUnsentWins`, `listAllClaims`, `fetchPrizeStats`, `redeemClaim`.
  - Dependencies: framer-motion, wouter, react-query, recharts, jsbarcode, qrcode.
  - Config: `LIMIT_ONE_SPIN_PER_DEVICE`, `STORAGE_KEY` and `?dev=1` (`config.ts:289-295`) are defined and never read.

## 2. Game mechanics

All hard-coded in `W/artifacts/spin-win/src/config.ts:57-112` **(V)**:

| # | id | Wheel label | Name | Weight % | Colour |
|---|---|---|---|---|---|
| 0 | voucher-100 | `100 ฿` | 100 THB Voucher | 23.5 | #FFE72E |
| 1 | bracelet-making | `Bracelet\nWorkshop` | Free Bracelet Workshop | 27.5 | #FF7BC5 |
| 2 | voucher-150 | `150 ฿` | 150 THB Voucher | 17.5 | #FF8A3D |
| 3 | voucher-200 | `200 ฿` | 200 THB Voucher | 14.5 | #55B9FF |
| 4 | kids-pizza | `Kids\nPizza` | Kids Pizza | 14.5 | #A6E22C |
| 5 | kids-ticket-1-plus-1 | `1+1 Kids\nTicket` | 1+1 Kids Ticket | 2.5 | #CD8CFF |

- **Owner's intended odds:** `attached_assets/Lucky_wheel_Prize_list_…txt` says 23/27/17/14/14/2 plus 3% "Mystery Box — NOT AVAILABLE YET". The missing 3% was spread as +0.5 each. The mystery prize exists only in Radar, as an inactive reward.
- **Expected cash discount:** about 78.75 THB per spin, plus the non-cash prizes.
- **Retired prizes:** `RETIRED_PRIZES` (`config.ts:120-158`) keeps old prizes resolvable on the voucher page.
- **Outcome is client-side** (`App.tsx:84-93`). `Math.random()` weighted pick at the button press; the wheel then animates to it. No server involvement.
- **Slices are equal-sized** (`Wheel.tsx:65`). Weights do not affect slice geometry.
- **Prize list duplicated in this repo** and synced by hand, plus Radar's `shared/spinRewards.ts`, which holds the customer copy:
  - `config.ts` PRIZES.
  - `api-server/src/lib/prize-catalog.ts:16-23`.
  - `api-server/src/routes/spin-wheel.ts:8-15`.
  - `api-server/src/lib/radar-push.ts:57-70`.
- **Spin animation** (`Wheel.tsx:85-207`):
  - An imperative CSS `transform` transition, 5.2 s (4.4 s in lite mode), 6 full turns, `cubic-bezier(0.16,1,0.3,1)`, ±30%-of-slice jitter.
  - Completion by `setTimeout`.
  - Rotation normalised to mod 360 after each spin.
  - Tick sounds pre-scheduled by inverting the same bezier.
  - The wheel is an inline SVG string (`:286-377`). Label font size is a character-count heuristic (`:324-334`) with manual `\n`.
- **Reveal:** pointer bounce, triple-blink wedge, confetti, and after 950/600 ms a fanfare and the result card. Confetti is canvas on PC and 16 CSS-animated spans in lite mode (`App.tsx:137-227`).
- **Sound** (`sound.ts`): Web Audio only. 4 sfx plus a 465 KB music loop with per-clip gains. Mute via a corner div, `#mute`/`#sound`, staff ArrowLeft, or localStorage. Audio is AI-generated in Replit; licence unknown.
- **Assets:** 2 dragon frames, 3 blob PNGs, woff2 fonts (Benzin, Montserrat, Climate Crisis). The logo is live text (`OtoWordmark.tsx`).
- **Idle/attract:** none. The intro video was deleted in commit `4d4b88c`; the wheel is the idle screen. The 21 MB source remains at `attached_assets/Oto_Play_Park_-_15_Sec_-_1080x1920_…mp4`. Ambient CSS animations are disabled during spins and entirely in lite mode. Lite mode is UA-sniffed for Android/Tizen/WebOS (`stageState.ts:26-68`); a Pi's Chromium UA will not trigger it.
- **Languages:** English only (`index.html:2`; copy in `config.ts:213-235`; "Today only" and the title are hard-coded at `App.tsx:688-695`). The only Thai-block character in the app is the baht sign "฿" on the wheel labels, and the owner's memory notes record that even it renders from a system fallback. The brand fonts therefore have no Thai glyphs. **(I)**

## 3. Input

- **Trigger keys:** Space and Enter, plus NumpadEnter, `key==="Select"`, and keyCodes 13/32/23 (`App.tsx:31-44`). Captured at `window` level.
- **Any pointerdown, mousedown or click anywhere also counts as the button** (`:525-527`). This was needed because the venue's Android-stick browser (TV Bro) turns the remote's OK into mouse clicks.
- **Debounce (all constants hard-coded):**
  - 350 ms lockout on the wheel screen, 200 ms on the result screen (`:60-65`).
  - Key repeats suppressed.
  - Keydown/keyup pairing so a swallowed keydown still counts.
  - `inputBurst.ts` treats one physical press as a burst and swallows follow-on event types for 1.5 s, or 0.5 s after release.
- **Flow:** `ready →press→ spinning (presses ignored) → result`. Leaving the result needs **two presses within 1.5 s** (`REPLAY_DOUBLE_MS`, `config.ts:250`), or it returns after 60 s idle (`IDLE_RESULT_MS`, `:244`).
- **Staff controls** (`App.tsx:557-619`, no auth): ArrowUp reloads, ArrowDown exits the result immediately, ArrowRight forces a spin, ArrowLeft mutes. Memory notes say these are dead under TV Bro.
- **Hidden URL hashes** (`OrientationFrame.tsx:27-79`, `sound.ts`, `stageState.ts`):
  - `#debug` shows an on-screen diagnostics box including the last 8 raw input events.
  - `#cw/#ccw/#off`, `#noscale/#scale`, `#lite/#full`, `#clear`, `#mute/#sound`.
  - `#result` boots straight to a result card.
  - `#kiosk-key=…` is the dormant enrolment path.
  - Settings persist in localStorage per `BUILD_TAG`.
- **Kiosk assumptions:**
  - A portrait-mounted TV outputting a landscape signal, fixed with CSS rotate and scale, sized by a 100vw×100vh probe because TV browsers misreport the viewport.
  - Old engine, so plain-CSS `kiosk.css` rules (no `@layer`, vars, `gap`, `inset`, `aspect-ratio`).
  - No on-screen `<button>` elements, to avoid double-triggering.
  - The proxy strips query strings, so hashes are the only URL channel.
  - A site photo shows a portrait TV on a floor stand with a wired USB dome button.
  - Memory notes say TV Bro eats the first Enter after idle but passes Space. The owner was advised to use a Space-emitting button or Fully Kiosk Browser. **Which key the current button emits is unknown.**
- **Conflict for the target:** Enter as a trigger means a USB barcode or QR scanner (which types digits then Enter) would start a spin.

## 4. Identity and limits

**None (V).** There is no phone entry, wristband scan, login or server-side eligibility check, and replays are unlimited by design. The old "one spin per device" flag is unreferenced. Phone capture existed from August to mid-September 2026 but its client code is no longer called, and the owner's final prompt says "Do not collect or require a customer phone number". In practice one spin per person is enforced only by the booth staff standing next to the button.

## 5. Voucher output

1. **TV result card** (`ResultModal.tsx`):
   - Shows "You won!", the prize name, and a 232px QR that appears 620 ms after the card.
   - The QR encodes `<origin>/v/<prizeId>#c=<wonAt base36>&w=<winId>` (`:47-49`).
   - `winId` comes from `newWinId()` (`claims.ts:45-49`): base36 timestamp plus `Math.random` characters. It is not a secret and not signed.
   - It is minted when the card opens, not at spin start.
2. **Guest phone** `/v/<prizeId>` (`VoucherPage.tsx:36-71`): one `POST /api/spin-wheel/issue`. On success it shows Radar's text, a QR whose payload is exactly the 4-digit code (validated at `:55-61`), and the digits. It shows a REDEEMED banner if `redeemedAt` is set. On failure it shows an error and a manual "Try again" button. There is no auto-retry, even for the expected 409 "win not recorded yet" race. **The code is not persisted locally**, so every open needs a live call.
3. **Code format:** a 4-digit numeric string, randomly allocated by **Radar** (`oto-radar/server/spinRewards.ts:182-195`). Issuance is idempotent per `winId`. Codes are single-use, **never expire, and are never recycled**. Capacity is 10,000, shared with legacy numeric codes (`:9`). At 100 spins a day that is about 100 days.
4. **Printing: none (V).** There is no `window.print`, ESC/POS, WebUSB or WebSerial. The owner's prize list, however, says "Each prize is issued as a printed voucher with a unique QR code". No SMS or LINE.
5. **Redemption** happens in Radar's `/redeem` page, not in this repo.

## 6. Backend calls, offline and persistence

**Browser → own API (same origin, no auth headers):**

| Caller | Call | Payload | On failure |
|---|---|---|---|
| Kiosk `claims.ts:212-258` | `POST /api/wins` | `{winId, prizeId, wonAt}` | Queued in localStorage `spin-win:unsent-wins` with a 4 s retry loop, flushed at boot. A 400 drops the entry; 401/503 keeps it |
| Kiosk `heartbeat.ts:16-52` | `POST /api/kiosk-heartbeat` every 5 min and on wake | none | Silent |
| Phone `VoucherPage.tsx:45` | `POST /api/spin-wheel/issue` | `{winId, prizeId, wonAt}` | Error plus manual retry |
| `/staff` | `POST /api/claims/list`, `/claims/stats` (PIN in body, checked against `EXPORT_PIN`) and `/claims/:id/redeem` (**no auth**) | | Legacy data only |

Dormant on the server: `/api/kiosk-enrollment`, `/api/claims`, `/claims/by-win`, `/claims/lookup`, `/claims/:id/rearm`, `/api/spin-vouchers/*`.

**Server → Radar** (base URL `https://oto-app-simple-fork.replit.app`, hard-coded at `radar-spin.ts:1` and `oto-analytics.ts:9`):

| Call | Auth | Notes |
|---|---|---|
| `POST /api/spin-wheel/issue` | `X-API-Key` from env `SPIN_WIN_REDEEM_KEY` (`radar-spin.ts:13`) | 15 s timeout. Allowed only for a `winId` already in `spin_wins` with a matching prize. Radar's body is passed through unvalidated |
| `POST /api/ingest/spin-events` | `X-API-Key` from env `RADAR_INGEST_KEY`; URL overridable via `RADAR_INGEST_URL` | Fire-and-forget event push. Retries at 5 s and 30 s, in-memory queue of 200, lossy. Radar checks it against `SPIN_WIN_REDEEM_KEY` (`oto-radar/server/routes.ts:3469-3484`), so both env vars must hold the same value **(I)** |
| Legacy `/api/public/campaigns/{id}/qr` and `/api/qr/redeem` | none | Reachable only from old claims |

**Radar's contract, corrected:** the endpoints are rewards, issue, redeem, report and ingest/spin-events. There is **no "landing" endpoint**; the wheel's own `/v/` page plays that role.

**Env vars, names only:** `DATABASE_URL`, `PORT`, `BASE_PATH`, `SPIN_WIN_REDEEM_KEY`, `RADAR_INGEST_KEY`, `RADAR_INGEST_URL`, `STAFF_PIN`, `EXPORT_PIN`, `KIOSK_KEY`, `SESSION_SECRET`, `LOG_LEVEL`. The owner's prompt names `OTO_RADAR_BASE_URL` and `SPIN_WIN_API_KEY`; neither is read by the code.

**Own database — used:**
- `spin_wins` (`lib/db/src/schema/spin-wins.ts:17-42`) holds winId, prizeId, wonAt and legacy columns. There is **no booth, device or staff column**, and the Radar response is not stored.
- `prize_claims` is legacy phone claims.

**Local persistence:** localStorage only — win queue, mute, rotation/scale/lite overrides, watchdog markers, dormant kiosk key — plus a sessionStorage boot-retry flag. A service worker (`public/voucher-sw.js`, scope `/v/`, network-first) still caches the phone shell. Since the new voucher page needs a live call for the code, it now only produces a nicer offline error.

**Kiosk offline behaviour:**
- The game keeps running from memory; wins queue locally.
- The guest still needs internet plus both servers.
- A reload while offline fails, by design (no kiosk service worker).
- Self-heal layers:
  - Inline boot watchdog with stall detection (`index.html:46-177`).
  - JS error-storm reload with a 5-minute cooldown.
  - 04:00 nightly reload.
  - 6-hourly `<meta refresh>` that fires regardless of game state (`index.html:12`).

## 7. Configurability today

- **Without a rebuild:** only the per-device URL hashes, the PIN/key env vars, `RADAR_INGEST_URL`, and Radar's per-prize `active` flag (changed directly in Radar's database).
- **Everything else needs a code edit and republish**, with a manual `BUILD_TAG` bump.

**What an admin console must own, and where it lives today:**

| Area | Settings |
|---|---|
| Prizes | id, wheel label and line breaks, name, colours, order, weight, active flag, prize kind (`config.ts:57-112`). Customer title, instructions and terms are in Radar's `shared/spinRewards.ts`. Stock limits, daily caps and budget do not exist. Validity: none (the old rule was 24h) |
| Theme and copy | `kiosk.css` (933 lines of literal hex values and px sizes), `COPY` (`config.ts:213-235`), JSX literals, mascot and blob images, fonts, confetti palette, the 5 audio files and their gains, default mute, language |
| Timing | spin duration, turns, easing, reveal delays, idle-result 60 s, double-press 1.5 s, lockouts, QR defer |
| Per booth | orientation, scale, performance mode, booth id and branch. Branch is the literal `"Floresta"` in every event; the owner's rule is that these events must never reach Chalong reporting. Button key mapping |
| Operations | heartbeat interval and 15-minute stale threshold, nightly reload hour, error-reload thresholds |
| Missing entirely | schedule and opening hours, eligibility rule, staff assignment, idle video or playlist, printer and receipt template |

## 8. Reporting

- **From the kiosk:** only `{winId, prizeId, wonAt}` per shown result. There is no spin log, booth id, staff id, abandoned-spin count or print status.
- **Heartbeat:** one global last-seen value.
- **Radar ingest:** `prize_won` events with a deterministic `eventId`; the redeem, claim and re-arm events are now effectively legacy.
- **Won versus redeemed:** lives in Radar's code ledger and `GET /api/spin-wheel/report` (per-prize won, redeemed, outstanding, plus capacity).
- **`/staff` stats** cover only the legacy phone claims.

## 9. Gap list against the target

| Target | Today | Gap |
|---|---|---|
| Admin-controlled prizes, weights, layouts | Hard-coded in 4 places here, plus the customer copy in Radar | Need a config API, versioned config cached on the box, a wheel preview and a label auto-fit |
| Server-authoritative outcome | Client RNG; open win registration | Decide on the server or box agent; log every spin |
| One spin per wristband or phone | Nothing | Identity step, eligibility service and an offline rule |
| Stock, daily caps, schedule | None | New |
| Pi 5 Chromium kiosk | Tuned for a Samsung or Android-stick browser | Drop the legacy bundle and CSS rotation (rotate at the OS instead); rebase performance assumptions on real hardware |
| USB button as a keypress | Works, but any click also spins and Enter collides with HID scanners | Dedicated key; separate the scanner stream |
| ESC/POS printed voucher | None | Box-local print agent plus a template. Owner's wording ready in `attached_assets/Pasted-Final-update-…txt:88-134`; an ESC/POS-over-TCP-9100 pattern in `attached_assets/oto-hardware-spec__…html` |
| Offline queue with signed codes | localStorage queue of wins. Codes issued online only by Radar, 4 digits, unsigned | Durable store; box-signed codes or pre-allocated blocks; idempotent sync |
| Staff sign-in by QR badge or PIN | None on the kiosk. Shared PINs elsewhere, one of them shipped in the bundle | New; attribute spins to staff |
| Heartbeat and alerts | One global timestamp in memory and a tmp file on autoscale; a status page with no alerting | Per-box heartbeat with version, queue depth, printer state and clock skew; alerting |
| Per-booth reporting | No booth dimension | Add booth, device, staff and campaign to every record |
| Redemption at our POS | In Radar's web page | POS-side voucher lookup and redeem; migrate outstanding Radar codes, since they never expire |

## 10. Reuse assessment

**Carry into `apps/booth`:**

- `Wheel.tsx` — SVG builder, target-then-animate spin, bezier-synced ticks, mod-360 normalisation.
- The state machine and press handling from `App.tsx` — double-press exit, idle return, repeat suppression, keydown/keyup pairing.
- `ResultModal.tsx` layout.
- `sound.ts` and its suspended-context watchdog; on the Pi, add Chromium's `--autoplay-policy=no-user-gesture-required` flag.
- `kiosk.css` — brand palette, keyframes, the "stop ambient animation while spinning" guard, and the transform/opacity-only discipline. It can be modernised on current Chromium.
- The inline boot watchdog idea.
- The `#debug` input-log overlay, which is excellent for remote support.
- The Puppeteer TV tests (`tv-kiosk`, `tvbro-input`, `tv-soak`, `tv-watchdog`, `lite-confetti`, `boot-stress`, `asset-check`).
- Assets: dragons, blobs, woff2 fonts and audio, pending licence checks (Benzin is commercial; audio is AI-generated).
- Hard-won lessons worth keeping:
  - Judge images by their pixel dimensions.
  - Defer the QR encode past the card entrance.
  - Never fire confetti during deceleration.
  - No render-blocking font CDN.

**Rewrite or drop:**

- Outcome selection and win registration.
- `config.ts` as the source of truth.
- `VoucherPage` and Radar's 4-digit scheme.
- The claims routes and `/staff`.
- The heartbeat.
- The rate limiters.
- TV-era workarounds: `@vitejs/plugin-legacy` and terser; the UA-sniffed lite mode; the probe-based viewport sizing; and click-as-button with most of `inputBurst`.
- All scaffolding: shadcn, mockup-sandbox, `api-client-react`.
- Do **not** copy `pnpm-workspace.yaml:77-160`. Its overrides strip every non-linux-x64 native binary (esbuild, rollup, lightningcss, tailwind-oxide), so the repo will not install on Windows, macOS or an arm64 Pi. **(I)**

## 11. Fragile, surprising or undocumented

1. **Voucher minting is open to the public.**
   - The game URL is public and any tap spins.
   - `POST /api/wins` has no auth, by owner decision (`wins.ts:26-41`).
   - `/#result` mints a 100 THB win without spinning (`App.tsx:74-82, 232-234`; `ResultModal.tsx:55-64`).
   - The only limit is 600/h keyed on `X-Forwarded-For`, which a client can spoof (`staff-gate.ts:42-47`).
   - Because codes are never recycled, abuse can **permanently exhaust the 10,000-code space**.
2. **Radar's redeem and report endpoints have no auth in code.** Both Radar's own integration doc and the owner's pasted spec claim an API key or staff cookie is required. In reality (`oto-radar/server/spinRewardsRoutes.ts:108-151`) the rate-limit bucket is a hash of IP plus the client's User-Agent, which the client controls. 4-digit codes can therefore be brute-force redeemed.
3. **Misleading commit.** `82793a6` "Fix radar spin animation timing" actually renames the secret env var `SPIN_WIN_API_KEY` → `SPIN_WIN_REDEEM_KEY`. A production phone screenshot (`attached_assets/WhatsApp_Image_2026-09-17_at_10.32.09_…jpeg`) shows "We couldn't issue this voucher yet" about 20 minutes before that fix. **(I)**
4. **Clock-skew bug.** `wins.ts:72-77` accepts `wonAt` up to one hour in the future, but Radar returns a 400 for any future `wonAt` (`spinRewards.ts:171`). A fast kiosk clock makes vouchers un-issuable. A Pi 5 has no RTC battery by default.
5. **A staff PIN literal ships in the public bundle** (`config.ts:240`), and `replit.md:132-137` says the server's `STAFF_PIN` is "the same value". Treat both as compromised; do not reuse them.
6. **Lost outcomes.** A reload mid-spin loses the outcome with no record, and the win queue dies with localStorage.
7. **Autoscale versus in-memory state.** Heartbeat, rate limiters and the Radar push queue are all per-instance and reset on deploy. CORS is fully open (`app.ts:29`). `/claims/:id/redeem` has no auth.
8. **Schema by push.** `post-merge.sh` runs `drizzle-kit push` on every merge. `backfill-radar.ts` is a one-off script locked to a specific production snapshot.
9. **Misfiled operational data.** `attached_assets/oto-hardware-spec__…html` is the park hardware spec — LAN printer IPs, payment-terminal IDs and serial numbers — sitting in the game repo.

## Unknowns

- What is actually running at the booth now: browser, stick or TV model, and the button's key.
- Whether `RADAR_INGEST_KEY` is set in production.
- Real spin volumes and remaining code capacity (Radar's report endpoint would answer this).
- Licences for the Benzin font, the dragon artwork and the generated audio.
- Whether the Word spec `W/Lucky-Wheel-Voucher-Spec-v2.docx` (reviewed separately; see `docs/features/booth.md`) supersedes the 4-digit, no-expiry, no-phone rules. It does: printed vouchers, expiry per prize and 10-character codes.
- How outstanding never-expiring Radar codes should be honoured after cut-over.
- Which languages are required.

## Key files (absolute)

- `imports/oto-wheel-fortune/artifacts/spin-win/src/` — `config.ts`, `App.tsx`, `claims.ts`, `inputBurst.ts`, `sound.ts`, `watchdog.ts`, `heartbeat.ts`, `stageState.ts`, `kiosk.css`, `main.tsx`
  - `components/` — `Wheel.tsx`, `ResultModal.tsx`, `OrientationFrame.tsx`
  - `pages/` — `VoucherPage.tsx`, `StaffLookupPage.tsx`
- `…/artifacts/spin-win/index.html`, `vite.config.ts`, `public/voucher-sw.js`
- `…/artifacts/api-server/src/`
  - `routes/` — `wins.ts`, `spin-wheel.ts`, `kiosk-heartbeat.ts`, `claims.ts`, `spin-vouchers.ts`, `kiosk-enroll.ts`
  - `lib/` — `radar-spin.ts`, `radar-push.ts`, `prize-catalog.ts`, `staff-gate.ts`, `oto-analytics.ts`
  - `app.ts`
- `…/lib/db/src/schema/spin-wins.ts`, `prize-claims.ts`; `…/lib/api-spec/openapi.yaml`
- `…/docs/oto-radar-ingest.md`; `…/.agents/memory/spin-win-kiosk.md`, `oto-analytics-bridge.md`, `spin-win-tv-performance.md`
- `…/attached_assets/` — `Lucky_wheel_Prize_list_1789526280547.txt`, `Pasted-Final-update-OTO-Lucky-Wheel-prizes-and-Radar-redemptio_1789616345460.txt`, `Pasted-OTO-Spin-Wheel-integration-…_1789613017506.txt`, `Pasted-We-are-redeveloping-the-spin-wheel-game-…_1782722793875.txt`, `Pasted-Prompt-for-Fable-5-Spin-Win-TV-Kiosk-Redesign-…_1785912416067.txt`
- Radar side: `imports/oto-radar/server/spinRewardsRoutes.ts`, `server/spinRewards.ts`, `shared/spinRewards.ts`, `server/routes.ts` (3465-3557), `docs/spin-wheel-integration.md`
