# SCRUM-218 staff benefits walkthrough on staging - capture notes

Captured 8 Oct 2026, about 04:36 to 05:25 Bangkok time. The trading day at
Demo Branch 2 rolled from 2026-10-07 to 2026-10-08 at 05:00 during the run:
the benefit setup below counts from 2026-10-07, the sales made later (SCRUM-484
notes) are on 2026-10-08. All six staging services were read back from
`render.mjs status` as live on `c6194664` at the start.

How it was driven: Playwright scripts (kept in the session scratchpad, not
committed) signed in as the seeded platform admin (Khun Anan, Owner; the
account the repo seed defines). No secret is printed or stored in this folder.
Nothing was committed and Jira was not touched.

## The result in one paragraph

Walkthrough steps that need a staff benefit QR card could NOT be done: the
staging api has no benefit signing key, so no card can be issued, so no card
can be scanned, applied, revoked or refused. The dialog says so itself (shot
2). What was captured is everything that does not need a card: the templates,
the staff list, the override dialog, the From-date chip and history, the
counter's refusal of a code that is not a card, the audit rows of the benefit
saves, and the empty report and Audit log. No card was ever issued, so there
was nothing to revoke: no revoke was attempted, and no picture or request in this folder shows a revoked state (the Activity filter for `benefit.credential_issue` finds nothing, shot 6).

To finish the walkthrough: set `BENEFIT_QR_PRIVATE_KEY` on `oto-api-staging`
(an ed25519 key in PKCS#8 PEM, `openssl genpkey -algorithm ed25519`; the
`.env.example` says it is deliberately not generated at boot), redeploy the
api, then issue Khun Lek's and Khun Anan's cards from Admin > Staff Benefits >
QR and run the F&B sale, the revoke and the refusals. The templates, the roles
and the ZZ TEST menu at Demo Branch 2 are already in place, so only the card
steps remain. I did not set the key: it is deployment configuration, outside
what this run was allowed to change.

## What I had to set up first (staging had none of it)

`GET /benefits/templates` answered `current: null` for all three roles and
every employee read "No benefit configured": the full seed that writes the
benefit data has not run on staging (the api pre-deploy is migrate plus
platform-sync). So, before the shots:

| What | How | State left |
|---|---|---|
| Three role templates, effective 2026-10-07: Owner = Full comp; Manager = 2 free coffees a day (Coffee), 500 baht a month credit, 30 percent off F&B; Staff = 2 free coffees a day, 30 percent off F&B | The page's own `PUT /benefits/templates/:role` (the amounts are the plan's Q2 defaults and the seed's) | In force, left as set |
| Manager credit 600 baht from 2026-12-01 (the date the demo seed uses) | Typed in the Manager card and saved with its own Save button | A scheduled version, left (the "From 2026-12-01" chip) |
| Benefit roles: Khun Anan (Owner) = Owner; Khun Lek (Manager) = Manager; Nok (Reception) = Staff with a personal override of 4 free coffees a day | The page's own `PUT /benefits/profiles/:employeeId` | Left as set. These three are existing staging staff, shared by every park of the operator |
| Three ZZ TEST menu items at Demo Branch 2 (it had no menu): ZZ TEST Espresso 60, ZZ TEST Latte 80, ZZ TEST Toastie 90 | The page's own `POST /branches/:id/menu/products` | Left in place |

Everything above was written with the signed-in page's session through the
same endpoints the screens call (not through the forms), except the Manager's
scheduled version. Audit rows exist for each (shot 6).

## Shots

Wording: a picture is a real screen. A "read-back card" is text read from the
API and drawn on a card, not a screen. File names all start
`SCRUM-218-staging-`.

| File | What the viewer sees | What was done |
|---|---|---|
| `1-templates-owner-manager-staff-at-amounts.png` | Admin > Staff Benefits (the Admin pages name no park; the page's own text says "per-operator overrides", so templates and staff roles here are operator-wide, not Demo Branch 2's): Owner with Full comp on; Manager with "Free coffee - Coffee - 2 - per day", credit 500 per month, 30 percent off All F&B; Staff with Free coffee 2 per day and 30 percent. Each card has Effective from 10/07/2026 and Save (greyed: nothing changed). | Opened the panel. |
| `1-manager-from-date-chip-and-history.png` | The Manager card with an amber chip "From 2026-12-01" and "2x Free coffee / day, 600 credit (Whole order) / mo, 30% off All F&B", and its History open: "From 2026-12-01 Scheduled" and "2026-10-07 - 2026-11-30 In force", each "Changed by Khun Anan (Owner)" with a time. | Typed 600 and 2026-12-01 in the Manager card, pressed Save, opened History. |
| `1-staff-list-roles-and-override-chip.png` | The Staff list (21): Khun Anan with chip Owner and "Full comp"; Khun Lek with Manager and "2x Free coffee / day, 500 credit (Whole order) / mo, 30% off All F&B"; Nok (Reception) with chips Staff and Override and "4x Free coffee / day, 30% off All F&B"; everyone else "None - No benefit configured". Override and QR buttons on each row (QR greyed for people with no role). | Scrolled to Staff. |
| `1-override-dialog-nok-reception.png` | "Nok (Reception) - benefit override": Benefit role Staff, Custom override on, a Free coffee row at 4 per day, standing 30 percent, Effective from, and a History entry "From 2026-10-07 In force - Staff - Override: 4x Free coffee / day - 30% off All F&B". | Pressed Override on Nok's row. Nothing saved. |
| `2-qr-dialog-before-issue.png` | Khun Lek's dialog: "No benefit QR has been issued." with an Issue QR button. | Pressed QR on Khun Lek's row. |
| `2-qr-dialog-issue-refused-no-key-on-deployment.png` | The same dialog after Issue QR, with the red text "This deployment has no benefit QR key: set BENEFIT_QR_PRIVATE_KEY to an ed25519 private key in PKCS#8 PEM. Until it is set, no benefit QR can be issued or shown; QRs already printed still work." | Pressed Issue QR once. A refusal; nothing was issued. THIS IS THE BLOCKER. |
| `3-fnb-scan-modal-unknown-code-refused.png` | F&B guest order at Demo Branch 2 with ZZ TEST Toastie, Espresso x2 and Latte (฿290, customer display mirroring it) and the "Scan staff benefit" dialog showing the typed text "ZZ TEST NOT A CARD" and the red line `No staff benefit found for "ZZ TEST NOT A CARD".` | Typed a made-up string, NOT a card, and pressed Apply. The order was never charged, so no sale was written. It shows the counter's refusal wording only; it is not the revoked-card refusal. |
| `4-signin-benefit-qr-typed-in-phone-field.png` | The POS lock screen after typing `OTO-BEN:v1:ZZ-TEST-not-a-real-card` key by key into the phone field and a dummy password: the phone field reads "1" with "Stored as: +661", and the red line "Request does not match the schema". | Fresh signed-out browser. NOT a card (a made-up string with the header). See problem 2. |
| `4-read-back-card-signin-api-refuses-benefit-qr-string.png` | READ-BACK CARD. `POST /api/auth/sign-in` with that same made-up OTO-BEN: string answered 400 `BENEFIT_NOT_A_SIGN_IN`: "That is a staff benefit QR. It applies a benefit at the F&B order station and signs nobody in." | Sent directly from the lock-screen page. Not a screen, and not a card. |
| `5-discounts-comps-demo-branch-2-no-staff-benefit-row.png` | Reporting > Discounts & Comps for Demo Branch 2, 10/07/2026 to 10/07/2026: Total comps 0.00, Manual discounts 100.00, Promo codes 100.00, Free-item benefit 0.00, Total impact 200.00, one manual row by Som (Reception) "Loyalty" and one promo row. No "Staff benefit" row. | Set the filters as a person would. The demo day has no benefit sale, and none could be made (blocker). |
| `5-read-back-card-benefits-report-empty-no-applications.png` | READ-BACK CARD. `GET /analytics/reports/benefits?branches=<Demo Branch 2>&from=2026-10-07&to=2026-10-08` answered 200 with every total 0, `byRole` [], `byBeneficiary` [], `days` []; `/benefits/transactions` rows []; `/benefits/applications` []. | The report has no screen (problem 4). "Totals and by-person" are therefore empty here. |
| `6-audit-log-benefit-template-update-rows.png` | Console > Activity with Action = `benefit.template_update`: four rows (three at 04:38 and one at 04:42), entity `benefit_role_template`, by Khun Anan (Owner). | Typed the exact action name in the filter. |
| `6-audit-log-benefit-template-update-row-opened.png` | The 04:42 row opened: Changes tab, Effective from was 2026-10-07 / now 2026-12-01, Closed from now 2026-12-01, and the Profile before and after with the credit 50000 then 60000 satang. | Clicked the row. Reading it is itself recorded as `audit.read_sensitive` against the account (the page says so). |
| `6-audit-log-benefit-profile-update-rows.png` | Action = `benefit.profile_update`: three rows at 04:38, entity `benefit_profile`. | Typed the action. |
| `6-audit-log-benefit-credential-issue-none.png` | Action = `benefit.credential_issue`: "Nothing matches" (no date range set, "Every branch"; the action name is the one the issue service audits, `benefit-credentials.ts`). | Shows no audited card issue exists (the refused press wrote no audit row). The Console nav badge in this picture and in the other three Console Activity pictures reads Failures 3 (as does the SCRUM-503 Devices picture), where the SCRUM-217 Console pictures at 04:19 read Failures 2; the third group was not opened, so what it is is not known. |
| `6-staff-benefits-panel-audit-log-none-applied.png` | The bottom of Staff Benefits: "Audit log (0) - No staff benefits applied yet." | Scrolled to the bottom. |

## Not captured, and why

- Shot 2 with a real QR, shot 3 "card scanned, preview amounts, applied Staff
  benefit row linked on the order", shot 4 "revoked card refused at the counter
  and at sign-in", shot 5 with figures, shot 6 with `benefit.credential_issue`,
  `benefit.apply` and `benefit.comp` rows, and the revoke: all need an issued
  card. Blocker: no `BENEFIT_QR_PRIVATE_KEY` on the staging api.
- The Console scanner simulator and the gate/booth badge refusals: also need a card
  (and the Demo Branch 2 has no box, see SCRUM-503 notes).

## Problems

1. **Staging cannot issue a staff benefit QR** (no `BENEFIT_QR_PRIVATE_KEY`), so
   SCRUM-218's walkthrough steps 3-6 cannot be shown until the key is set and the
   api redeployed. See "To finish the walkthrough" above.
2. **The lock screen cannot show the sign-in refusal.** The phone field strips
   everything but digits as it is typed, so a benefit QR typed or scanned there
   reaches the api as a short digit string and the person sees "Request does not
   match the schema". The api's own words (`BENEFIT_NOT_A_SIGN_IN`) are only
   reached by a direct request (the read-back card), although `auth.ts` is written
   for "a scanner held to the lock screen types whatever it reads into the focused
   field". Observed with a made-up string; not seen with a real card.
3. **Console Activity: "Admin log" preset does nothing here.** Pressing it says
   "presets cannot be applied on this deployment: these rows carry no category
   yet. The list is unfiltered". The Action filter is exact: `benefit.` (a prefix)
   matches nothing; the full action name does.
4. **The staff benefits report has no screen.** `GET /analytics/reports/benefits`
   exists, but a search of `apps/pos/src` finds no caller; the only report screen
   that shows benefits is Discounts & Comps (one "Staff benefit" row per order).
   The query parameter is `branches` (plural); my first read used `branchId`, which
   the api ignored and answered for all three parks (also all zero; not pictured).
   The card's own request line omits the filter and names it in its annotation
   ("for Demo Branch 2 only (branches=its id)").
5. **F&B success screen text glitch** (seen in the SCRUM-484 shots): the staff side
   reads "F\&B credit" with a stray backslash; the customer side reads "F&B credit".
6. Staging carries unrelated test staff in the benefits list (21 people including
   "SCRUM-465 ..." probes and "ZZ SCRUM193 ..." admins). They were not touched.

## Left on staging

Benefit templates, the scheduled Manager version and three people's roles (table
above); three ZZ TEST menu items at Demo Branch 2. No card, no benefit
application, no sale was written for benefits.

## What is readable in the pictures (independent check, 8 Oct, every PNG opened)

- No benefit QR is drawn anywhere (none was issued: the QR dialog shows "No benefit QR has been issued." and the refusal), and a QR decoder found no readable QR in any picture of this folder.
- The only `OTO-BEN:` text is the made-up string `OTO-BEN:v1:ZZ-TEST-not-a-real-card` on the read-back card; it is not a card and was never signed.
- No real password appears: the lock-screen picture shows masked dots, and the read-back card shows the dummy value `x`. No session token or key is shown (the dialog names the variable `BENEFIT_QR_PRIVATE_KEY`, not a value).
- Captions and this file agree on revocation: nothing was revoked because nothing was issued; the two refusal pictures (counter: `No staff benefit found for "ZZ TEST NOT A CARD".`; sign-in read-back: `BENEFIT_NOT_A_SIGN_IN`) are refusals of a made-up string, not of a revoked card, and say so.
- The staff written to (Khun Anan, Khun Lek, Nok (Reception)) are the seeded staging staff, shared by every park of the operator; the Staff list also shows unrelated probe and ZZ staff, which were not touched.
