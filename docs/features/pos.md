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
Six native cases pass: cash/change, handheld split/manual, food QR/reconnect,
shop terminal approval, decline/cash fallback and timeout/inquiry/audited staff
confirmation. Partial recovery and the remaining checkout cases are unverified.
The checked payment follow-ups and SCRUM-285 guard are assembled on the
latest main checkpoint as five linear source commits: wording `2899439`,
inquiry capability `4817aa1`, partial reversal `f1b122e`, invoice scope
`c215757` and forced-offline guard `346bfae`. Main release checkpoint `fe9c683` landed that
combined source on origin/main; the original work branches remain preserved.
All **305 affected existing-file checks pass**: API terminal 27, gateway 44,
cash 26, sales 58, station session 35 and guarded routes 9; POS writer 58,
shared payments 22 and database migration 26. One local guarded-route suite
hit a PostgreSQL port collision; its isolated rerun passed all nine checks.
API/POS/DB/shared typechecks and full package lint, POS production build,
database schema verification against 0029 and independent combined review pass.
Temporary verification configs are removed. No new suite or dependency.

Shared contract names remain unchanged. Optional `inquirySupported` hides
unsupported GHL card inquiry; optional `reversalPending` retains the original
reservation and blocks abandonment/zero-close until explicit false after a
successful reversal. Forward migration 0029 permits repeated hardware invoice
numbers, keeps device-less gateway invoices unique and fences all five gateway
reads from hardware attempts. It does not rewrite payment rows. Roll forward
after 0029 rather than reverting behind these matching filters.
The offline guard runs before idempotency and refuses trading only for the
authenticated station's persisted forced-offline virtual box. Reporting,
setup, Go online and box callbacks remain available with original permissions.

Exact-main [CI 36565169997](https://github.com/vickyydev/oto-platform/actions/runs/36565169997)
on `fe9c68374449a867254992c0f0e4d869876b6b34` stopped with zero steps.
Check job 109395214284 explicitly reports failed recent account payments or
an insufficient spending limit. This is an external Actions availability
block, not a source-test failure. Render's normal checksPass gate stays intact;
all five platform services were rechecked LIVE on 0468c38. No corrected source
or migration is deployed yet. Restore Actions billing/spending availability,
rerun 36565169997, then deploy its tested source and complete isolated staging
proof, named Jira screenshots and the new CI artifact delivery. Documentation
checkpoints do not change the tested release source. SCRUM-206 remains In Progress
pending SCRUM-269 local till transport and SCRUM-201 separate display acceptance.
SCRUM-285 remains Testing until named staging screenshot evidence is attached.

The original simulated partial outcome is still **BROKEN/unresolved**:
sale `01a0ecb8-f168-7b26-96e4-9ccaabe14cbf`, attempt
`01a0ecb8-f870-798f-b893-37d9871d4bcd`, run `0d008153` on virtual-1.
Its command reports partial approval, but the cloud attempt remains pending
with no rescue VOID. Eight dedicated inventory rows remain retained. Existing
controls cannot retrieve the lost final result after restart or safely replay
it. Do not repeat SALE, fabricate a callback, confirm no money or archive these
records. The logged invoice unique violation and old-migration regressions
support the corrected callback path; they do not establish recovery of this row.

After corrected source is LIVE, prove fresh partial reversal, GHL confirmation,
QR-disabled refusal and zero-price checkout in an isolated report using
`test-results/payment-stage-native-proof.mts`, `--output-dir` and `--only`.
The helper protects the historical records and original report; completion
applies only to requested cases. Then run `test-results/offline-guard-proof.mts`
on independent disposable fixtures, restoring the forced-offline flag afterward.
These proofs must not change the retained historical failure into a success.

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
