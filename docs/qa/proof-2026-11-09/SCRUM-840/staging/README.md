# SCRUM-840 — BEO Save can clear a deposit the family paid through the chat while the BEO was open

Staging proof, 11 November 2026, 20:28 to 20:47 Bangkok. **Result: passed (steps 1 to 6).**

## What was live

- `oto-app-staging` deploy `dep-dbq6nr6i0phs73bg2ekg`: **live** at commit `266830f9`, finished 20:24:28 Bangkok.
- `oto-api-staging` deploy `dep-dbq6np2jnfac73etva9g`: **live** at commit `266830f9`, finished 20:26:13 Bangkok.
- Established by the host's control API (each deploy read by its id, one request every 90 seconds; it answered
  normally, in under two seconds). Behaviour agrees for the app: the BEO's read and every Save answer carry
  `oneDeposit`, and a Save that kept the deposit carries `depositSave`.

## How it was run

One headless Chromium, the staging administrator signed in through the launcher. Three ZZ TEST families wrote to
"Demo WhatsApp · Central Floresta" through the inbox's Simulator; each thread: Book Date (the time typed in the
dialog), Create BEO, then in Billing "Request deposit" 3000. The BEO was then loaded again so the form held
Deposit 0, with Party Details / POS open and Billing closed. The family's payment was made in a separate browser
context with no session, on the link exactly as the assistant posted it in the chat, on the simulated payment page
(no real money). Stored figures were read through the app's API by a second session.

## Steps

| Step | What | Result |
| --- | --- | --- |
| 1 | Fresh party, deposit of ฿3,000 requested, BEO open with Deposit 0 and Billing closed | Pass. Form: Deposit `0`; stored deposit 0 (`840-01`) |
| 2 | Link from the chat opened in a separate context, Pay pressed | Pass. Stored deposit **3000** (event prepayment 3000, `oneDeposit` 3000, dated 2026-11-11) about 2 s after Pay; the open form still showed `0`, no notice |
| 3 | In the still-open BEO, no reload, no window switch: Decoration typed, Save | Pass. The Save sent `depositChanged: false`, `expectedDeposit: 0`. Answer: `depositSave` reason `moved`. Toast: "BEO saved. The deposit was not changed — The deposit changed while this BEO was open (now ฿3,000). Your other changes were saved." Deposit field now **3,000**; Decoration saved ("ZZ TEST 840 balloons"); stored deposit still **3000** (`840-02`) |
| 4a | On the fresh form, 4000 typed, Save | Pass. Saved: toast "BEO data saved successfully", stored deposit **4000** (`840-04`) |
| 4b | 2000 typed, Save | Pass. Kept: stored deposit stays **4000**, field back to 4,000. Toast: "BEO saved. The deposit was not changed — ฿3,000 of this deposit was paid through the chat, so Save does not lower it below that (it stays ฿4,000). Your other changes were saved. A paid deposit is corrected in the BEO's Billing section (Deposit Paid)." (`840-05`) |
| 5 | Third party, same set-up; after paying, the BEO window brought back (no Save, no reload) | Pass. The form read the BEO again once; Deposit field **3,000**; notice "Deposit updated — The deposit changed while this BEO was open (now ฿3,000)."; no Save sent by the page; stored deposit 3000 (`840-03`) |
| 6 | The till's reading for party 1 (`GET /api/events/:id/beo/till-billing`) | Pass. Expected total ฿20,900, **Deposit paid ฿4,000** (`depositSatang` 400000), Outstanding ฿16,900 (`840-06`) |

## Which party shows which step

- **Party 1** (12 December): steps 1 and 2, the server side of step 3, steps 4 and 6.
- **Party 2** (13 December): steps 1 to 3 in full, with the toast and the field (pictures `840-01`, `840-02`).
- **Party 3** (19 December): step 5 (picture `840-03`).

## To know

- **Step 3 was run twice.** On party 1 the server kept the deposit and saved the Decoration (the Save's answer and
  the stored figures are in the receipt), but the page went blank at that Save: the picture taken before it had
  rewritten text on the page, which broke the form's next render. That was the test harness, not the product. The
  step was repeated on party 2 with pictures that only lay boxes over the page; the form stayed up and showed the
  toast and the field. No page error was recorded on party 2 or 3.
- **Step 6 needed a package.** A party with no birthday package has no quote at the till ("No quote from the
  till"), so the till names no deposit for it. The park's birthday package was applied on party 1 and the till
  then read the deposit. The pictures of steps 3 to 5 show the tiles before a package was applied.
- The once-a-minute till read of the open BEO can also bring the new deposit into the form on its own. For step 3
  the payment was made right after one of those reads so that Save went out with the form's old 0, which is the
  case this ticket is about. That was timing only; nothing on the page was held back.

## Pictures

- `840-01-beo-open-deposit-0-billing-closed.png` — party 2's BEO before the payment: Deposit 0, Billing closed.
- `840-02-save-kept-paid-deposit.png` — party 2 after Save: the toast, Deposit 3,000, the Decoration saved.
- `840-03-window-back-deposit-updated.png` — party 3: the window came back, Deposit 3,000, "Deposit updated".
- `840-04-raised-to-4000-saved.png` — party 1: the raise to 4,000 saved.
- `840-05-lowering-to-2000-kept-at-4000.png` — party 1: the lowering to 2,000 kept at 4,000, with the reason.
- `840-06-till-reading-party-1-deposit.png` — party 1: the till's figures with Deposit paid ฿4,000.

In every picture the events board behind the BEO is hidden and the contact number is covered.

## Clean-up

The three parties are archived, the six threads of this run are marked handled, every session is signed out (each
read back as signed out) and the browser is closed. The 28 November ZZ TEST party made by someone else was not
touched.

## Not shown

- The Events page's own form (the same rule with the words "this event") was not driven.
- A Save from a page loaded before this rule (the "out of date" wording) and the case where the till cannot be
  asked were not driven.
- A deposit typed in the Billing section's Deposit Paid field was not driven.
