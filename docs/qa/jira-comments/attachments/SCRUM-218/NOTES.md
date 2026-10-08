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

---

# Closing retake, steps 2 to 6, 8 Oct 2026, about 06:25 to 06:50 Bangkok time

Staging on `c6194664`; the api now carries the benefit QR key, so the first
pass's blocker is gone. Demo Branch 2 only, signed in as the seeded platform
admin (Khun Anan, Owner). One card was issued (Khun Lek, Manager) and it was
REVOKED at 06:38; `revokedAfter` is true (text read-back, API:
`GET /benefits/credentials?employeeId=<Khun Lek>` answered one credential,
`status: "revoked"`, with `revokedAt` set). No other card was issued. The card
string is never drawn readable in any picture: in the two QR-dialog pictures the QR
and the code printed under it were blurred by me (CSS filter on the page before
the screenshot) and the typed field in the refusal picture was blurred the same
way. A QR decoder was run over every picture of this folder before it was listed.
The first pass's pictures stay; the ones it could not take are the ones below.

## Shots (file names start `SCRUM-218-staging-`)

Wording: a picture is a real screen unless the line says READ-BACK CARD (text
read from the API and drawn on a card, not a screen).

| File | What the viewer sees | What was done |
|---|---|---|
| `2-qr-dialog-before-issue-key-now-set.png` | Khun Lek (Manager)'s dialog: "No benefit QR has been issued." and an Issue QR button. | Admin > Staff Benefits > QR on Khun Lek's row (the Admin pages name no park; staff roles are operator-wide). |
| `2-qr-dialog-after-issue-qr-and-code-blurred.png` | The same dialog at normal zoom after Issue QR: a blurred QR square, a blurred band of text where the code is printed, "Valid until 10/8/2027" and a Revoke QR button. The blur is mine; nothing under it is readable. | Pressed Issue QR once. The audit row for it is `benefit.credential_issue` at 06:27. |
| `3-fnb-order-before-scan-three-items-290.png` | F&B guest order at Demo Branch 2: ZZ TEST Toastie 1 (฿90), ZZ TEST Espresso 2 (฿120), ZZ TEST Latte 1 (฿80), VAT included ฿18.97, "Charge ฿290", the customer display mirroring the order, a "Scan staff benefit" button. | Guest order, items tapped. |
| `3-fnb-first-scan-preview-free-items-120-plus-staff-credit-170.png` | The same order after the card was typed into "Scan staff benefit" and Apply was pressed: a green "Staff benefit -฿290" card, "Scanned: Khun Lek (Manager)", "Free item(s) -฿120", "Staff credit -฿170", the button now "Charge ฿0", the display "Discount - ฿290 off, Total ฿0". | First scan, from a run that made no sale (see problem 1 for the unfinished sale a later run left). The file time is 06:37, after the 06:31 and 06:32 runs; by this file's own problem 1 a scan made after 06:31 would price credit only (as the second charging run's did), so this picture, which still shows a free-item line, was captured before 06:31 and the file written or copied later. The picture carries no clock, so the capture time itself is not shown. The card was typed as a scanner burst would type it; no camera was used. |
| `3-fnb-first-sale-no-payment-needed-screen-before-complete-order.png` | "Amount due ฿0, Pick-up code 57, No payment needed - This order is fully covered - nothing to collect. Tap below to send it to the kitchen.", a Complete Order button and Back. | Said to be the screen the first charging run stopped on (Complete Order was NOT pressed in that run, problem 1). CORRECTION from the independent check: this file is BYTE-IDENTICAL to `3-fnb-no-payment-needed-covered-by-benefit.png` (same md5, file times 06:37 and 06:32). The screen has no clock and shows pick-up code 57 in both runs, so two runs could draw the same pixels, but the folder holds ONE picture twice and it cannot show which run it came from. Do not read it as a separate capture of the first run. |
| `3-fnb-second-sale-scan-preview-staff-credit-only-free-coffees-used-up.png` | The second charging run's order after the scan: "Staff benefit -฿290", "Scanned: Khun Lek (Manager)", one line "Staff credit -฿290" (no free-item line this time), "Charge ฿0". | Same three items, scan again. The two free coffees of the day were already counted by the first charging run's application, so the preview is credit only. |
| `3-fnb-pickup-code-step-total-0.png` | The Pick-up Code dialog over the order, "Continue to Payment - ฿0" greyed until a code is keyed. | Charge pressed. |
| `3-fnb-no-payment-needed-covered-by-benefit.png` | The "No payment needed" screen, Pick-up code 57, said to be from the second charging run. | Pick-up code keyed, Continue to Payment. BYTE-IDENTICAL to `3-fnb-first-sale-no-payment-needed-screen-before-complete-order.png` (see that row): one picture, filed twice. The order panel behind the pick-up-code dialog in `3-fnb-pickup-code-step-total-0.png` does show a credit-only staff benefit card, which is what ties the second run to the closed sale D2-000017, not this screen. |
| `3-fnb-sale-closed-success-screen.png` | "Order Confirmed - Nothing for the kitchen or bar - Order #0001 - Guest - Receipt D2-000017", Pick-up code 57, the three items, a green "Staff benefit -฿290 / Scanned: Khun Lek (Manager) / Staff credit -฿290" card, Total ฿0, New Order; the customer side "Thank you!" with the same items and Total ฿0. | Complete Order pressed. This is the closed sale (receipt D2-000017, finalised 06:32:21). |
| `5-discounts-comps-demo-branch-2-staff-benefit-row-tiles-zero-before-rollup.png` | Admin > Reporting > Discounts & Comps, 10/08/2026 to 10/08/2026, Demo Branch 2, taken between 06:33 and 06:35 (file time 06:35, before the 06:36:57 rollup): every tile ฿0.00, yet "Transactions (1)" lists `fnb/D2-000017`, 10/8/2026 6:32:21 AM, Fixed, "Staff benefit - Scanned: Khun Lek (Manager) (manager)", applied by Khun Anan (Owner), ฿290.00. | Filters set by hand. |
| `5-discounts-comps-demo-branch-2-staff-benefit-row-8-oct.png` | The same screen at about 06:41 (file time 06:41; the read-back card made right after says captured 06:41:06): Manual discounts ฿290.00, Total impact ฿290.00, "By operator" Khun Anan (Owner) 0 comps, 1 discount, ฿290.00, and the same Transactions row. Total comps and the free-item tile still ฿0.00. | Same filters, re-read after the 23:36 UTC rollup (see the card below). |
| `5-read-back-card-benefits-report-non-zero-one-application-credit-290.png` | READ-BACK CARD: `GET /analytics/reports/benefits` for Demo Branch 2, 8 Oct: applications 1, creditCount 1, creditSatang 29000, totalReliefSatang 29000, byRole manager 1, byBeneficiary Khun Lek (Manager) 1, one day row for 2026-10-08 marked provisional, lastRolledUpAt 2026-10-07T23:36:57Z; and `GET /analytics/reports/benefits/transactions`: D2-000017, finalised, credit 29000. | The report has no screen (first pass, problem 4). |
| `6-audit-log-benefit-credential-issue-row.png` | Console > Activity with Action `benefit.credential_issue`: one row, 8 Oct 06:27, entity `benefit_credential`, by Khun Anan (Owner). | Typed the exact action name. |
| `6-audit-log-benefit-apply-row.png` | Action `benefit.apply`: two rows, 06:32 and 06:31, entity `benefit_application`, by Khun Anan (Owner), Demo Branch 2. | Same. |
| `6-audit-log-benefit-apply-row-opened.png` | The 06:32 row opened (Changes tab, top of the drawer only): allocations of 9000, 12000 and 8000 satang to the three cart lines, the application id, "applied satang 29000", benefit role manager and the box id. TEXT READ-BACK (below the fold, not pictured): credit 29000, comp 0, free items 0, discount 0 and a usage entry for credit, monthly, 2026-10, limit 50000. | Clicked the row. Reading it is recorded as `audit.read_sensitive` (the page says so). |
| `4-qr-dialog-revoke-confirm-qr-and-code-blurred.png` | The dialog with the text "It stops working on the platform at once, and on each box from its next update." and Keep and Revoke buttons; QR and code blurred by me. | Pressed Revoke QR. |
| `4-qr-dialog-after-revoke-no-qr-in-use.png` | The dialog reading "No benefit QR has been issued." with an Issue QR button again. | Pressed Revoke. Audit row `benefit.credential_revoke` at 06:38. Word for word, the same dialog as `2-qr-dialog-before-issue-key-now-set.png` (only a focus ring on the close button differs there), so this picture alone cannot tell "revoked" from "never issued"; the difference is the `benefit.credential_revoke` row at 06:38 and the counter's refusal wording below (and the text read-back of the credential's status, which is not pictured). |
| `6-audit-log-benefit-credential-revoke-row.png` | Action `benefit.credential_revoke`: one row, 8 Oct 06:38, entity `benefit_credential`, by Khun Anan (Owner). | Typed the action name. |
| `4-fnb-revoked-card-refused-at-counter-typed-code-blurred.png` | The "Scan staff benefit" dialog over an order of one ZZ TEST Toastie: the typed field blurred by me, and in red "Benefit revoked: Khun Lek (Manager)'s QR no longer applies a staff benefit." with the grey line "Look up the staff member's QR in Admin -> Staff Benefits." | The revoked card typed and Apply pressed. Nothing was charged. |
| `4-read-back-card-signin-api-answer-for-revoked-benefit-qr.png` | READ-BACK CARD, not a screen: `POST /api/auth/sign-in` with the revoked card string as the phone answered 400 `BENEFIT_NOT_A_SIGN_IN` "That is a staff benefit QR. It applies a benefit at the F&B order station and signs nobody in." The string itself is not shown on the card. | Sent from the lock-screen page. The lock screen cannot carry a card (first pass, problem 2), so this is a read-back; it does not say "revoked". It is the same answer the made-up string got in the first pass (`BENEFIT_NOT_A_SIGN_IN`), so it is no evidence of revocation: the card's title says REVOKED, which is the capturing script's label, not the API's answer. The revoked state rests on the audit row, the credential read-back and the counter's refusal. |
| `6-staff-benefits-panel-audit-log-one-application-khun-lek.png` | The bottom of Staff Benefits: "Audit log (1) - Khun Lek (Manager) (Manager) - 290 relief - processed by Khun Anan (Owner) - 10/8/2026, 6:32:21 AM - order #D2-000017". | Scrolled to the bottom. |

## Gate and booth refusal: not reachable

Demo Branch 2 has no gate station, and its booth station has no device and no
box online. The Console's scanner simulator on the Demo counter box takes a band-style
code (its field's placeholder reads T1-0000-0000-0000); the revoked string was
sent through it once and no command appeared in the box's command history
(text read-back), so nothing reached a scanner. No picture of a gate or booth
refusal is claimed.

## Problems and observations

1. **The first charging run left an unfinished sale.** Pressing "Continue to
   Payment - ฿0" put the order into `tendering` (sale `01a118b5-07c6`, no
   receipt) and wrote a `benefit.apply` row at 06:31 that used the day's two free
   coffees (usage `free:coffee 2 of 2`); that run's browser was closed before
   Complete Order. The order the shots show closed (D2-000017) therefore priced
   credit only. The unfinished sale was left as it is and is not in the benefits
   report (1 application, not 2).
2. **The Discounts & Comps tiles lag the rows.** At about 06:33 to 06:35 the tiles read ฿0.00
   while the Transactions row existed; after the next rollup (23:36 UTC, five
   minutes after the previous one at 23:31) Manual discounts and Total impact read
   ฿290.00. The benefits report reads the same rollup: all zero at 06:33
   (applications 0) and one application afterwards (text read-back).
3. Staff credit is counted under "Manual discounts" on that screen, and the
   free-item tile stays ฿0.00 (a prototype rule's side effect, noted, not
   changed).
4. The gate/booth and the lock-screen sign-in paths cannot carry a card (above).
5. Left on staging: the revoked card, the unfinished `tendering` sale above, and
   the three ZZ TEST menu items from the first pass. The audit usage of D2-000017's
   application records 29000 satang of credit against the 50000 satang monthly
   limit; the unfinished sale's application row records 17000 satang of credit
   (audit text read-back, not pictured).

## What is readable in the closing-retake pictures (independent check, 8 Oct, every new PNG opened)

- **The benefit card is never readable.** The QR and the code line under it are blurred in `2-qr-dialog-after-issue-qr-and-code-blurred.png` and `4-qr-dialog-revoke-confirm-qr-and-code-blurred.png`; enlarged 2x and contrast-stretched they are still shapeless smudges with no module structure and no legible character. The typed field in `4-fnb-revoked-card-refused-at-counter-typed-code-blurred.png` is enlarged 3x to five blobs of colour, no characters. The read-back card says "199 characters, not shown". The scan dialog is closed in every other picture. A QR decoder over all 111 PNGs in the five folders found nothing in this folder.
- **Even a perfect recovery would be a dead card**: it was revoked at 06:38 (audit row `benefit.credential_revoke`, 06:38), and both blurred QR pictures were taken before the revoke completed (06:27, and the 06:38 confirm dialog just ahead of the press).
- **Revocation and the refusal agree**: revoke row 06:38, then the counter's refusal "Benefit revoked: Khun Lek (Manager)'s QR no longer applies a staff benefit." (file time 06:39). The dialog after revoke reads "No benefit QR has been issued." (see its row for why that alone proves nothing).
- No password, token or key value is drawn: the read-back card shows the dummy password `x`. The variable NAME `BENEFIT_QR_PRIVATE_KEY` (never a value) appears in the first pass's refusal dialog and in a SCRUM-217 Failures picture. Box ids and application ids appear in the opened audit row; they are identifiers, not credentials.
- The figures agree across pictures: 90 + 120 + 80 = 290; allocations 9000 + 12000 + 8000 = 29000 satang; the report card, the Discounts & Comps row, the audit row and the panel's "290 relief ... order #D2-000017" all say 290 and the same receipt.
