# Staging proof, 2 November 2026

Screenshots taken on staging to move the 2 November landings from Testing to Deployed. The `s703-*` files
in this folder are a separate proof for SCRUM-703 (commit `505b272c`); they are not described here.

- **Staging commits:** `8417b720` was live on oto-api, oto-pos, oto-console and oto-inbox staging
  (`node scripts/agent/render.mjs status`, checked at 07:20 before the first capture and at 07:57 after the
  last). It contains every commit of these tickets. The staff app, oto-app staging, was live at `629714f2`,
  the SCRUM-546/673 landing itself. No staff-app change has landed on main since.
- **When:** 2 Nov 2026, 07:28 to 07:57 Asia/Bangkok (00:28 to 00:57 UTC).
- **Who:** the staging admin test account (Console, Inbox, Support), the staging reception test account
  (POS) and the demo manager Khun Lek (staff app, signed on from the platform).
- **Where:** every POS flow ran on the test station **Till 2 (test)**. Nothing was paid and no sale was
  written. The only sale call in the runs was a price quote (`POST /sales/quote`).
- **Masking:** the 2C2P demo secret is masked in the probe output. Nothing else is masked, because staging
  holds fictional data: demo staff, `ZZ TEST` records and simulated customers.
- **Composites:** each image puts several unedited screenshots from one run side by side or one above the
  other, with added captions. Some panels are cropped from a full-window screenshot and nothing else is
  changed. Each image was opened and checked before it was attached.

## Files

| File | Live commit | Captured (Bangkok) | What it shows |
|---|---|---|---|
| `SCRUM-685-1-probe-output-and-green-ci.png` | api `8417b720` | 07:28 to 07:29 | Left: the output of `scripts/agent/probe-2c2p.mjs`. It ran as a one-off job on the staging api (`job-dbjthsjbc2fs73dr1mng`) against 2C2P's public Thailand demo merchant (JT04, key masked). Payment Token answered `0000` (signed). Do Payment answered `1005` in plain form with a RAW PromptPay QR of 203 characters whose EMVCo CRC is valid. Payment Inquiry answered `2001`, pending (signed). Right: CI run 41357325164 on main at `56dd6861`, green. That commit contains the fixes `6604656b` and `153f0bb9`. |
| `SCRUM-699-1-console-sync-and-hand-add.png` | console/api `8417b720` | 07:32 | Console → Drop-off & supervision → Today's nannies, park Central Floresta. 1: after **Sync now**, the card says it read the rota at 07:32 and the log says "Synced from the OTO App · 0 added, 0 removed". The app answered, the rota has no nanny shifts and there were no unmatched names. The four demo nannies are off shift, with the "Nobody is on shift" warning. 2: after **Add a nanny for today**, ZZ TEST Nanny is listed for 07:02–08:47, "Added by hand", On shift. |
| `SCRUM-699-2-till-nanny-pickable.png` | pos/api `8417b720` | 07:35 | Till 2 (test): a drop-off child from a ZZ TEST booking (ZZ TEST Nanny Child 494), with Nanny chosen. Under Assign a nanny, the demo nannies are Off shift and ZZ TEST Nanny is "Available". After she is picked, the order line reads "Nanny · ZZ TEST Nanny". The order was then cancelled before a length or a payment was chosen. |
| `SCRUM-700-1-add-scanner-hid-zebra-defaults.png` | console/api `8417b720` | 07:39 to 07:40 | Console → Devices → Virtual box 1 → Add a device → Scanner "ZZ TEST scanner". The mode is USB keyboard (HID) and the ids are left empty (the hints name Zebra's 05e0 / 1200). A path outside /dev (`/tmp/scanner`) is refused, and Add it stays off. The saved row, opened again, still reads HID with the empty ids, which means the Zebra defaults. |
| `SCRUM-700-2-device-panel-no-health-line-on-virtual-box.png` | console/api `8417b720` | 07:41 | Virtual box 1's device panel with the test scanners saved: ZZ TEST scanner (USB) and ZZ TEST scanner (CDC) (Serial). The CDC row reads USB serial (CDC), and an empty product id means 1701 in that mode. **No health line** shows under either scanner. By design the virtual box never opens a scanner (it runs inside the api, and box readers are on only on a Raspberry Pi). The Pi till box has been offline since 31 Oct on its 29 Oct release. |
| `SCRUM-506-1-health-no-revocation-alert-today.png` | console/api `8417b720` | 07:43 | Console → Watch → Health: the services, the open alerts and the boxes with their conditions (offline, heartbeat age, last sync). No "has not taken a staff benefit card revocation" alert is open. No box is behind today, and nothing was revoked for this check. |
| `SCRUM-676-1-camp-handover-and-thai-food-credit.png` | inbox/api `8417b720` | 07:44 to 07:45 | Inbox → Simulator, sent as customers. 1: "Do you have camp today? And next week?" on Demo Facebook, an account with no park. The assistant sent only "Thanks for your message! A team member will be with you shortly." and handed over to Birthdays & Events. It used no deal word. 2: the Thai Food & Play credit question (the text of golden G21, `e96bae7a`) on Demo WhatsApp · Central Floresta. The assistant answered in Thai from the Food & Play deal that the whole amount is food credit, with no hand-over. |
| `SCRUM-698-1-staff-english-display-russian.png` | pos/api `8417b720` | 07:49 | Till 2 (test) with the customer display panel switched to Русский. The staff ticket grid stays in English (1 Hour Play, All Day + Meal…). On Configure: 1 Hour Play the staff side is in English and the display names the ticket "Игра 1 час". The order was cancelled. |
| `SCRUM-697-1-verify-other-proof.png` | pos/api `8417b720` | 07:50 | Till 2 (test): walk-in → Thai → Verify Thai rate → Other. One word ("licence") is refused and Verify stays off. "licence 1234567" shows "Describe the document, never its number." "Thai driving licence" is accepted with no expiry date field, and Verify is on. The dialog was closed without verifying. |
| `SCRUM-546-1-event-status-edits-own-group.png` | oto-app `629714f2` | 07:53 to 07:54 | Staff app as Khun Lek → Events → board. "ZZ TEST status" is added, renamed, dragged to second place and deleted, and each step worked. After every step the manager's own status list (`GET /api/admin/event-statuses`) was read back: every row is in the same park group `681b18d1…`. |
| `SCRUM-673-1-schedule-history-and-write-window-gate.png` | oto-app `629714f2`, console `8417b720` | 07:56 | Shows only what could be captured: Scheduling → History as Khun Lek has one ordinary entry, with no view-as note. Console → Support → View as with "Changes allowed" says that a second platform administrator must approve the window. Nothing was sent. |
| `SCRUM-702-1-report-summary-on-github.png` | GitHub main `505b272c` (report `98a5b79d`) | 07:31 | `docs/qa/flow-review-2026-11/REPORT.md` as GitHub renders it: the heading, the scope paragraph and the summary table (3 blocking, 3 degrading, 0 cosmetic, 6 findings). |

## Not proven in this pass

- **SCRUM-502:** the new wording appears only after a money press on a till that sells through its box,
  when the box refuses the press or its answer is lost. Till 2 (test) belongs to the Pi box, which has been
  offline since 31 Oct. Using the virtual box would mean taking it offline, and it also carries Reception
  Till 1 and other stations. Getting the wording would also mean pressing a payment. The ticket stays in
  Testing.
- **SCRUM-503:** no child at Central Floresta is in the park with a prepaid meal. The four in-park stays have
  no food provision, and making one needs a paid check-in. With no prepaid line, the new violet labels cannot
  show. The ticket stays in Testing.
- **SCRUM-673:** a view-as window that allows changes needs a second platform administrator's approval, and
  this pass has one administrator account. So no Schedule History entry could be written in a view-as window.
  The screenshot is attached and the ticket stays in Testing.

## What was created on staging, and cleaned up

- **Nanny (SCRUM-699):** Sync now wrote today's sync record for Central Floresta. ZZ TEST Nanny
  (`01a199ab-e875…`) was hand-added with a shift from 07:02 to 08:47 (`01a199ab-e877…`). The shift was taken off
  with the card's remove button at 07:36, which cut it short because it had started. The Console has no
  control to archive a nanny, so the nanny row was archived by id with a one-off job
  (`job-dbjtm48473hc73as9egg`, 1 row). The roster is back to Bow, Jum, Pim and Aor. The audit rows of the add
  and the cut stay.
- **POS:** ZZ TEST Nanny Child 494's booking was attached to an order, and the order was cancelled. The booking
  is still waiting to be checked in. No sale was written, nothing was paid and nothing was printed. Every run
  ended with the till signed out. One run stopped on a script error before it signed out; the next run signed
  in again on the same account and signed out.
- **Devices (SCRUM-700):** ZZ TEST scanner (USB) and ZZ TEST scanner (CDC) were added to Virtual box 1 and
  then archived with Archive it. Neither was assigned to a station.
- **Inbox (SCRUM-676):** two simulated customer threads, ZZ TEST Camp 676 (`01a199b7-1c11…`) and ZZ TEST
  Food credit 676 (`01a199b7-a83c…`), both marked handled. The replies went to simulated contacts only, and
  no channel setting was changed.
- **Staff app (SCRUM-546):** the ZZ TEST status was deleted. After that the four standard columns were left
  with sort numbers 0, 2, 3 and 4. The board's own reorder call set them back to 0 to 3, in the same order.
- **2C2P (SCRUM-685):** the probe asked for one 1 THB QR on 2C2P's public demo merchant. Nobody paid it, and
  no staging payment setting was changed. The till still uses the simulator.
- **Support (SCRUM-673):** the view-as form was filled in but not sent. No window and no approval request
  was made.

## Seen during the runs

- **SCRUM-685:** the probe needs `PGW_MERCHANT_ID` and `PGW_SECRET_KEY` in its own environment. Staging has
  neither, so `render.mjs job "node scripts/agent/probe-2c2p.mjs"` as written stops with "refused: … not
  set". This run set 2C2P's public Thailand demo pair inline. Render's job log echoes the command, but that
  value is the public demo key from 2C2P's documentation.
- **SCRUM-676:** the customer's message quotes the calculator estimate ฿420. The assistant's Thai answer
  quotes 1,300 baht, which is the figure in staging's `pb.deal-food-play` entry. The golden fixture uses ฿420.
  This is a note for the owner about the knowledge entry; the routing works as specified.
- **SCRUM-699:** Sync now counts as the day's sync. Because it was pressed before the park opened, the
  morning job will not read the rota again today. A nanny added to the staff app's rota later today needs
  another Sync now.
- **SCRUM-698:** on the display panel, "Kids", "Adults" and "VAT included" stay in English while the ticket
  name and headings are in Russian. That is the display side, which is outside this ticket. Noted only.
- The Health page still shows three "Anan is viewing pos as Som" alerts from 28 Oct. They were there before
  this pass and were left as they are.
