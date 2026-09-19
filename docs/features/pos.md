# Oto POS

## What it is for
The reception till and everything around it: ticket sales with a customer-facing
display, member and children records, tiered pricing, F&B and shop stations,
drop-off / nanny check-in, events, stock, order history, end of day, a public
booking site (`/book`) and the back-office admin console (`/admin`). Staff use
it on iPads; at the park it will talk to a Raspberry Pi counter box that owns
the printers, card terminals, scanners and gate.

## Intake
- **Source:** `imports/oto-pos/` (Replit project "Oto POS"; app in `artifacts/oto-till/`)
- **Real or mockup:** front-end-only prototype on in-memory mock data (`src/mockApi.ts`). Its UI design is client-approved and is preserved. It is the **only new product** in the programme.
- **Stack:** React 19, Vite 7, Tailwind 4, wouter, shadcn/ui. No backend of its own.
- **Ported to:** `apps/pos/` (UI) with a real backend in `apps/api/`, schema in `packages/db/`, shared logic in `packages/shared/`.
- **Design notes worth reading:** `imports/oto-pos/replit.md`, `imports/oto-pos/.agents/memory/` (print templates, pickup-photo policy, architecture rationale), `imports/oto-pos/attached_assets/` (the original feature prompts), `imports/oto-pos/artifacts/oto-till/BACKEND_REQUIREMENTS.md`.

## Status
| Area | State | Notes |
|---|---|---|
| Sign-in, account setup, password reset, sign-out | done | Phone + password; SMS via console or Twilio adapter |
| Scoped permissions, roles, audit log, idempotency, file storage | done | Known gaps listed in `docs/architecture/design-review-2026-09-19/00-codebase-map.md` |
| Operators, branches, login users (admin) | done | Admin console is sign-in + manager gated |
| Members, children, visits, create-member, lookup via customer display | done | |
| Tier verification (proof, expiry, verifying staff, records tab) | done | Proof types incl. "Other"; LINE/WhatsApp/Telegram contact channel |
| Ticket packages, weekday/weekend/holiday pricing, tax rules | done | Server-side pricing; 5 customer languages |
| Public booking `/book` with server-priced bookings | done (no payment yet) | |
| Selling, payments, receipts, wristbands, history, end of day | **mock** | Sprint 2 — S2-09 (checkout), S2-10 (tenders: cash, EDC simulators in the NEXGO/PAX dialects, real 2C2P sandbox QR), S2-11 (receipts, bands, History), S2-15 (cash, EOD, analytics) |
| F&B, shop, stock, purchasing | **mock** | Sprint 2 — S2-09b, S2-14b |
| Drop-off / nanny check-in, release | **mock** | Sprint 2 — S2-12 (booking, gate on the GE-X2/HX-X1 protocol), S2-13 (supervision, offline release) |
| Events, camps, staff benefits, Messages tab | **mock** | Events stay mastered by the OTO App (S2-17); wiring the tab, benefits checkout and live channels are Sprint 3 unless the owner confirms them (plan: Contract coverage) |
| Station setup, devices, printing | **mock** | Sprint 2 — S2-04..S2-06: stations, virtual box, adapters and simulators on the park's real devices (`docs/architecture/DEVICE_INVENTORY.md`) |
| Messages | **mock** | Sprint 2 — messaging |
| PWA / offline shell, box transport | not started | Sprint 2 |

## Open questions
See `docs/progress/SPRINT_1_REPORT.md` (Q1–Q5) and `docs/briefs/OWNER_DIRECTION.md`.
