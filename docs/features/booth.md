# Booth — Lucky Wheel voucher game

## What it is for
A spin-the-wheel game at the mall Sales Booth: a child presses a red button, the
wheel spins on a vertical TV, a prize is shown, and the family later redeems it
at the park. It exists to turn mall footfall into park visits, and the client
wants it measurable: which booth, which staff member, which prizes convert.

## Intake
- **Source:** `imports/oto-wheel-fortune/` — Replit export of 2026-09-19 (164
  commits, 16 in the last 7 days), plus the client's
  `Lucky-Wheel-Voucher-Spec-v2.docx` (base spec August 2026, addendum September
  2026). Detailed notes:
  [`08-wheel-fortune-game.md`](../architecture/intake-2026-09-19/08-wheel-fortune-game.md),
  [`07-radar-booths-spin-vouchers.md`](../architecture/intake-2026-09-19/07-radar-booths-spin-vouchers.md).
- **Real or mockup:** **live** at the Floresta booth (`spingame.replit.app`), in a
  TV browser on an Android stick.
- **Stack:** pnpm workspace; `artifacts/spin-win` (React 19 + Vite 7 — `/` TV
  game, `/v/<prizeId>` phone voucher page, `/staff`), `artifacts/api-server`
  (Express 5), `lib/db` (Drizzle; tables `spin_wins`, `prize_claims`) on its own
  Replit Postgres.
- **How it works today:**
  1. Six prizes and their odds are **hard-coded** (and duplicated in four places
     plus Radar). The outcome is chosen **in the browser** with `Math.random()`.
  2. The TV shows a QR code; the guest opens a phone page, which asks the game
     server, which asks **Radar** to issue a code.
  3. Radar allocates a random **4-digit** code — never expires, never recycled,
     10,000 for all time.
  4. Reception redeems on Radar's **public** `/redeem` page; only the time is
     stored — no staff, branch or order.
  5. Nothing is printed. No identity, no limits, unlimited replays. Any click or
     keypress spins; `POST /api/wins` is open, so vouchers can be minted by
     anyone who finds the URL.
- **Its tables:** `spin_wins`, `prize_claims` (own database); in Radar:
  `spin_reward_campaigns`, `spin_reward_code_ledger`,
  `spin_reward_legacy_code_reservations`, `booth_events`, and the older money
  vouchers in `campaign_qrs`.
- **Replit-specific dependencies to replace:** everything server-side. Do not
  copy its `pnpm-workspace.yaml` overrides — they strip every native binary
  except linux-x64, so it cannot install on Windows, macOS or a Pi.
- **Secrets found in the export:** a staff PIN literal in the public client
  bundle; key *names* only otherwise. Also misfiled: a hardware spec with LAN
  printer addresses and terminal ids.

## What the client specified (v2)
- Win → **printed voucher** on an 80 mm ESC/POS printer: logo, prize in Thai and
  English, QR, short code, issue time and booth, expiry per prize, terms.
- **Redemption at park reception**: scan, server-side validation only, single
  use with a hard block showing who / when / where, expiry check, manual entry
  fallback, shows staff what to hand over.
- **Staff attribution**: booth staff sign in by PIN or QR badge; every voucher
  carries their id; nobody signed in → still works, voucher flagged
  "unattributed". A login problem must never take the booth down.
- **Admin-controlled prizes**: name TH / EN, weight, expiry, active, daily cap.
  Outcomes driven by config, not code.
- **Addendum:** Raspberry Pi 5 booth box; printer over Ethernet (port 9100);
  cache-first agent so login, spins, printing and attribution continue offline;
  random **10-character codes with a booth prefix** generated on the box, the
  server rejecting duplicates at sync; booths managed like stations (layout
  templates, prize lists, allowed staff); **inventory-linked prizes** that leave
  the wheel at zero stock; config versions picked up within about a minute; no
  idle video; heartbeat every 30–60 s with alerts (offline, printer, paper,
  unattributed printing, low stock); **every spin recorded**, not only wins;
  reprint is staff-only and never creates a second prize.

Where the brief (`PROJECT_CONTEXT.md` §11) and this specification differ — idle
video, signed vs random codes — the specification's addendum is newer and wins.

## Integration plan
- **Deployables:** `apps/booth` (the game, served by the booth box to its own
  Chromium kiosk); a booth role in the box agent (config cache, outcome, code
  generation, print queue, staff sign-in, spin log, heartbeat); booth management
  in the Console; redemption in the POS.
- **Outcome on the box.** The agent draws the prize from the cached config,
  honouring daily caps and stock, and records the spin before the wheel
  animates; the browser only animates to the result.
- **Codes and redemption.** 10 characters, booth prefix, unambiguous alphabet;
  QR carries the same code. Redeemed inside a POS sale with the staff session:
  who, when, where, which order. "Not found" reads "booth may not have synced
  yet", per the specification.
- **Legacy codes.** Import Radar's spin ledger, the reserved legacy numbers and
  all `campaign_qrs`; the POS redemption box accepts the old formats (4 digits;
  4 characters starting with a letter). They never expire, so they stay valid.
- **Input.** A dedicated key for the button. Today Enter and any click spin,
  which would collide with a USB badge scanner that types digits then Enter.
- **Reuse from the current game:** `Wheel.tsx` (SVG wheel, target-then-animate
  spin, tick sync), the press-handling state machine, `ResultModal`, `sound.ts`,
  `kiosk.css`, the `#debug` input overlay, the boot watchdog idea, the Puppeteer
  TV tests, the artwork (licences for the Benzin font, dragon art and generated
  audio to be confirmed). Dropped: TV-era workarounds (legacy bundle, CSS
  rotation, click-as-button), client-side outcome, the phone voucher page,
  the 4-digit scheme.
- **Reporting:** spins → vouchers printed → redeemed → linked sale, by day,
  booth, staff and prize; prize cost; redemption lag. Feeds `analytics` like
  every other source.
- **Launcher tile:** none for staff at the booth (the box boots into the game).
  Management reaches booth settings and reports through the Console.

## Environment variables
The current game's names, for reference: `DATABASE_URL`, `PORT`, `BASE_PATH`,
`SPIN_WIN_REDEEM_KEY`, `RADAR_INGEST_KEY`, `RADAR_INGEST_URL`, `STAFF_PIN`,
`EXPORT_PIN`, `KIOSK_KEY`, `SESSION_SECRET`, `LOG_LEVEL`. None carry over: the
rebuilt booth has no server of its own and authenticates with its device
credential, issued when the box is provisioned.

## Status
| Area | State | Notes |
|---|---|---|
| Code review of the export and the specification | done | 2026-09-19 |
| Booth agent role, game app | not started | after the box agent core |
| Booth management (Console) | not started | |
| Voucher printing | not started | shares the POS ESC/POS path |
| POS redemption + legacy code import | not started | needs a dump of Radar's database |

## Open questions
- Spin eligibility: the brief says one spin per band or phone; the client's
  latest instruction is not to collect a phone number. Proposed: a per-booth
  setting, off for mall booths (visitors have no band yet).
- What runs at the booth today — TV / stick model, browser, which key the
  button sends?
- Launch prize list: the owner's note lists 23 / 27 / 17 / 14 / 14 / 2 plus a 3%
  "Mystery Box — not available yet"; the code spreads the 3% across the rest.
- Languages on the TV (English only today; the brand fonts lack Thai glyphs).
- Alert channel: LINE OA, Telegram or email.
- Real spin volumes and remaining 4-digit capacity (Radar's report endpoint
  answers this).
