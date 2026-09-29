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

## Payment checkpoint - 29 September 2026

SCRUM-391, SCRUM-388 and SCRUM-382 are implemented on
main at `b02f7e0` and are Deployed. The till-facing API now routes QR
through the station's saved gateway/terminal setting and returns QR/expiry
metadata. The common writer reserves unresolved amounts under the sale lock;
new payments using configured disabled or archived methods refuse. Existing
accepted attempts still settle, and refused offline facts remain replayable in
quarantine. Seven existing API files pass 196 tests, API typecheck and
changed-file lint pass, and main CI is green. The release is live on staging.
All 21 scoped staging behavior checks passed and reviewed evidence is attached
to the tickets. The replay follow-up SCRUM-387 is also Deployed on `5fb8525`,
after six complete-response staging checks and 147 affected existing-file tests.

SCRUM-206 online Slice F source `0468c38` is live after green CI 36547262414.
The till, handheld till, food station, shop and mobile food-station
caller share cash received/change, real QR, terminal/manual and split-payment
collection. Pending or partial money blocks cart, context and navigation changes;
uncertain answers retain stable retry identities. Completion follows the
finalised platform sale, with local ticket-completion retry avoiding a second
charge. Unsafe pasted money cannot display a value different from the accepted
state. All 53 affected writer checks, POS typecheck, lint and build pass.
Native cash/change, handheld split/manual, food QR/reconnect and shop terminal
approval/decline pass; recovery and checkout cases remain under verification.
The inquiry follow-up adds optional `PaymentAttemptView.inquirySupported`,
derived from the attempt's frozen terminal protocol, tender and reference.
The UI uses it to hide and refuse unsupported inquiry, including simulated GHL
cards; old API replies keep the provider rule and require a reference. Shared
contract names are unchanged. Existing affected suites pass 104 checks; API,
POS and shared typecheck and full package lint pass. This follow-up is pushed
separately and is not live: Actions billing/spending availability blocks new
CI jobs before execution. Device reconfiguration during an attempt can still
cause a safe server refusal; changing the hardware does not authorise payment.
The checked partial-reversal follow-up reserves the original amount while its
saved reversal is pending, failed or unvoidable. Sale void and zero-balance
close refuse, and the UI keeps polling until explicit `reversalPending:false`;
an omitted flag cannot release a known pending reversal. Existing affected
terminal/cash/sales/writer/shared-payment files pass 189 checks, and touched
API/POS/shared typechecks and full lint pass. This follow-up is not live.
Six native online cases pass; the partial case remains BROKEN in the staging
run because its final report did not reach the cloud attempt. Its isolated
inventory is retained. That callback cause remains unresolved; GHL confirmation,
QR-disabled and zero-price native proof are still pending. Full offline
browser-to-box transport needs SCRUM-269/285; independent customer-display
acceptance needs SCRUM-201 (S2-08). The full story stays In Progress.
Real 2C2P sandbox confirmation remains separate from simulator verification.
Read the newest STOP POINT in `../progress/SESSION_HANDOVER.md`.

## Historical Sprint 1 status

The table below is the original baseline, not the current Sprint 2 inventory.
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
| Events, parties, camps, kiosk | **mock** | Sprint 2 — S2-20: events stay mastered by the OTO App (C10); the POS reads platform views and writes attendance back through its API; attendee records, passes, party tabs, event check-in, self-service kiosk |
| Staff benefits | **mock** | Sprint 2 — S2-21: HR-linked role templates and person profiles, benefit QR, application at checkout |
| Messages tab | **mock** | Sprint 2 — S2-19: the Inbox works end to end; a live WhatsApp/Instagram/LINE account is connected when the business accounts exist |
| Station setup, devices, printing | **mock** | Sprint 2 — S2-04..S2-06: stations, virtual box, adapters and simulators on the park's real devices (`docs/architecture/DEVICE_INVENTORY.md`) |
| Messages | **mock** | Sprint 2 — messaging |
| PWA / offline shell, box transport | not started | Sprint 2 |

## Open questions
See `docs/progress/SPRINT_1_REPORT.md` (Q1–Q5) and `docs/briefs/OWNER_DIRECTION.md`.
