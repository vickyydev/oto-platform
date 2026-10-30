# Staging proof, 30 October 2026: SCRUM-686, SCRUM-690 to SCRUM-696

Screenshots taken on staging to move these tickets from Testing to Deployed.

- **Staging commit:** `522294a7` was live on oto-api, oto-pos, oto-console, oto-inbox and oto-booth staging at
  capture time (`node scripts/agent/render.mjs status`, checked before and after). It contains every
  commit of these tickets.
- **When:** 30 Oct 2026, 15:19 to 15:40 Asia/Bangkok (08:19 to 08:40 UTC).
- **Who:** the staging admin test account (Inbox, Console) and the staging reception test account (POS).
- **Where:** every POS flow ran on the test station **Till 2 (test)**. Nothing was paid, so nothing printed:
  the three sales rung up have no print jobs.
- **Masking:** none. Staging holds fictional data: demo staff, demo wristbands, `ZZ TEST` records.
- **Composites:** images with captions over several panels were put side by side for this README. Each panel
  is an unedited screenshot from the same run, and the captions are added text.

## Files

| File | Viewport | What it shows |
|---|---|---|
| `SCRUM-686-1-phone-till-one-ticket.png` | 375×812 (2× pixels) | The phone till on Till 2 (test), with one ticket (1 Hour Play, ฿1040) in the order and the bar reading "Display connected: ZZ TEST proof display". |
| `SCRUM-686-2-paired-display-shows-order.png` | 1280×800 | The customer display paired to Till 2 (test) at the same moment, showing "Your Order": 1 Hour Play, Kids ฿690, Adults ฿350, total ฿1040. |
| `SCRUM-690-1-configure-step-768x1024.png` | 768×1024 | The ticket till's "Configure: 1 Hour Play" step on a tablet held upright. The add-on list is taller than the screen. |
| `SCRUM-690-2-configure-scrolled-footer-clear.png` | 768×1024 | The same step scrolled to the bottom of Extras & Add-ons. The last row of add-ons sits fully above the "Add Another Ticket" / "Continue" footer. |
| `SCRUM-691-1-qr-pending-with-cancel.png` | 1280×800 | Left: the till with a PromptPay QR requested ("Payment requested · simulator · ฿1040.00", the QR) and the **Cancel payment QR** button. Right: the paired display showing the same QR to scan. |
| `SCRUM-691-2-after-cancel-sale-voided.png` | 1280×800 | 1: after Cancel payment QR, the till is back at the payment-method choice with the sale still rung up. 2: the display back at "Please pay ฿1040.00". 3: after Cancel on the order, the sale is voided and the till is back at the start. On the platform the QR attempt is `cancelled` and the sale is `voided` ("Cancelled at the till"). |
| `SCRUM-692-1-order-panel-tablet.png` | 1024×768 and 768×1024 | The ticket till's order panel with one ticket and three unpaid-sale notices. The panel scrolls as a column, so Cancel and Pay are reachable at both sizes. |
| `SCRUM-692-2-scan-screen-tablet.png` | 1024×768 and 768×1024 | The F&B "Scan Wristband" screen. Its heading is on screen, and it scrolls down to "No wristband — continue as guest" at both sizes; nothing is cut off. |
| `SCRUM-693-1-after-reload-same-sale-lease-kept.png` | 1280×800 | Left: the till after a full page reload, back on the payment screen of the same ฿1040 sale, with the note "Resumed after a reload: this sale was rung up at this till…". The top bar still reads "Display connected: ZZ TEST proof display" and shows no display-connection refusal, so the station's lease was kept. Right: the paired display after the reload, still on this sale ("Please pay ฿1040.00"). The till read that sale back from the platform (`GET /sales/<id>`) for the sale written before the reload. |
| `SCRUM-694-1-booth-wheel-no-sign-in.png` | 720×1280 (portrait, as the television hangs) | The staging booth page (`oto-booth-staging…/#fake`): the wheel ready to spin, with no sign-in panel, no PIN pad and no input fields. This is the booth page's demonstration wheel, the address the launcher's Lucky Wheel tile opens; no box is behind it (the "DEMO" chip, "Demo staff"). Before SCRUM-694 this same demonstration wheel opened behind the staff sign-in. |
| `SCRUM-694-2-console-todays-staff.png` | 1280×900 | Console → Devices → Booths → FWBooth1. The "Today's staff" card shows the day's roster with Sync now and add-a-person, and says that nobody rostered prints "unattributed". The page has no booth staff list, no PIN and no session-length setting (the page text was checked for these). |
| `SCRUM-695-1-knowledge-approved-entry-edit.png` | 1280×1100 | Inbox → Assistant → Knowledge: approved entries, each with its Edit button. |
| `SCRUM-695-2-editor-live-subtitle.png` | 1280×1100 | The editor open on an approved entry (pb.about, EN), subtitled "Live: saving replaces it at once; the previous words stay in the archive." It was closed with Cancel and nothing was saved. |
| `SCRUM-696-1-teach-reply-and-draft-card.png` | 1280 wide, full page | Inbox → Assistant → Teach, after sending "If a customer says they lost something, first ask which branch they were at.". It shows the assistant's reply and the draft card in full: a lost-item rule for both parks with its instruction, "Ask first · When the park is not known yet", and the question in English, Thai and Russian, with Approve and Open in Rules. |
| `SCRUM-696-2-rules-tab-draft.png` | 1280 wide, full page | The Rules tab (Drafts) holding that draft, with "Taught from" and Approve / Edit / Archive. |
| `SCRUM-696-3-customer-thread-asked-branch.png` | 1280×1100 | The inbox thread of the simulated customer "ZZ TEST Teach" (conversation `01a18981-9bd9-736c-818d-e2039b9cecff`). The customer says "Hi, I think I lost my phone at the park yesterday", and the assistant asks "Which branch were you at: Central Floresta or Robinson Chalong?". This thread was recorded earlier on staging while an approved test rule was live; it was opened here, not re-run. |

## What was created on staging, and cleaned up

- **Inbox:** two draft rules were taught in the Teach tab (`01a18be3…`, `01a18be4…`), one per capture attempt. Both
  were archived through the Rules tab. No draft or approved rules remain. No knowledge entry was saved.
- **POS:** three walk-in sales of ฿1040 were rung up on Till 2 (test): `01a18bf0-e9e4…`, `01a18bf3-1e2f…` and
  `01a18bf5-10b2…`. Each was voided at the till ("Cancelled at the till"). Each had one simulator PromptPay QR,
  now `cancelled`, and none has a print job. Nothing was paid in cash or by card, and the gateway simulator's
  "paid" was never used. Every run ended with the till signed out.
- **Customer display:** one test display ("ZZ TEST proof display") was paired to Till 2 (test) for each run and
  revoked at the end. Till 2 (test) has no display paired now.
- **Booth:** nothing was paired, spun or saved. The Console booth page was only read.

## Seen during the runs

- Three unpaid sales from 29 Oct 2026 on Till 2 (test) (฿60, ฿90, ฿90, by the same reception test account) are
  offered on every sign-in there. They predate this pass and were left as they are; on screen their notices were
  only dismissed.
- Right after a reload, the paired display showed the membership question for a few seconds before the
  payment screen came back.
- In one of three runs, the QR had not yet reached the display about four seconds after it was requested.
  In the run captured here it arrived in about one second.
