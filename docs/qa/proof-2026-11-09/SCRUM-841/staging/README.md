# SCRUM-841 — Deposit request: a closed payment link shows raw code to the family, the BEO panel stays stale after a refused Resend, and the summary says Overpaid with no invoice

Staging proof, 11 November 2026, 20:58 to 21:12 Bangkok. **Result: passed (A1, A2, A3).**

## What was live

- `oto-app-staging` deploy `dep-dbq757qjnfac73evcht0`: **live** at commit `e9bdd4bc`, finished 20:52:34 Bangkok.
- `oto-api-staging` deploy `dep-dbq757lg1s2s739mall0`: **live** at commit `e9bdd4bc`, finished 20:54:58 Bangkok.
- Established by the host's control API (each deploy read by its id, one request every 90 seconds). The run began
  after both read live and 90 seconds more, so every payment link of this run was made after the api's restart.

## How it was run

One headless Chromium, the staging administrator signed in through the launcher. Three ZZ TEST families wrote to
"Demo WhatsApp · Central Floresta" through the inbox's Simulator; each thread: Book Date (the time typed in the
dialog), Create BEO, then in Billing "Request deposit". The family's side was a separate browser context with no
session, on the link exactly as the assistant posted it in the chat (the same link the panel holds). Payments were on
the simulated payment page only. Stored figures were read through the app's API by a second session.

## Steps

| Step | What | Result |
| --- | --- | --- |
| A1 | Party 1 (6 Dec): Request deposit 2500, link taken from the chat, **Cancel request** pressed (panel: "Request cancelled · ฿2,500"), link opened as posted in a separate browser | **Pass.** HTTP **410**, a plain page: "This payment link is no longer active." / "Please contact the park and we will send you a new one.", then the same two lines in Thai and in Russian, "OTO Play Park". No Pay button, no form, no JSON, no id or amount (`841-01`) |
| A1 | A made-up id on the same path, in a browser | **Pass.** HTTP **404**, the same words (`841-02`). The link with its last six characters cut off: 404, the same words |
| A1 | The same asks with `Accept: application/json` | Recorded. Made-up id: **404** JSON `{"error":{"code":"NOT_FOUND","message":"No such payment page"}}`, as before. The cancelled link: **200**, the simulator's own page ("This payment is cancelled.", no Pay button), as before while the api still holds that page in memory; it is not JSON |
| A2 | Party 2 (20 Dec): Request deposit 2000; the party archived through the app's admin route; **Resend** pressed 66 ms after the archive answered | **Pass.** The press was refused (409). With no reload and no navigation the panel read **"Request closed · ฿2,000"** — "This party was removed in the Events module, so the payment link was closed. Nothing was said to the family." — within 1.2 s; no Requested badge, no Resend, no Cancel request, no link; the red line stays: "This party was removed in the Events module, so its deposit request was closed and nothing was sent to the family." Stored request: cancelled, reason `party_removed` (`841-03`) |
| A3 | Party 3 (26 Dec, no invoice lines, no billing record): Request deposit 3000, paid on the simulated page, BEO loaded again, Billing | **Pass.** Financial Summary badge **DEPOSIT HELD**, under Outstanding **"Deposit held: ฿3,000 · 11 Nov 2026"**; no PAID, no Overpaid; Deposit Paid 3000, Date Paid November 11th, 2026. Stored deposit 3000 dated 2026-11-11, 0 line items, no billing record (`841-04`) |
| A3 | The paid link opened again in the separate browser | **Pass.** HTTP **410**: "This payment link is no longer active." / "This payment has already been received. Thank you.", with Thai and Russian lines; no Pay button (`841-05`) |

## Pictures

- `841-01-closed-link-plain-page.png` — the cancelled link as the family's browser shows it.
- `841-02-made-up-link-plain-page.png` — a made-up id on the same path.
- `841-03-resend-refused-panel-closed.png` — the Billing panel right after the refused Resend, no reload.
- `841-04-financial-summary-deposit-held.png` — the Financial Summary with DEPOSIT HELD.
- `841-05-paid-link-plain-page.png` — the paid link opened again.

The link pages are headless pictures: there is no address bar in them, so no link or token shows. In the BEO
pictures the events board behind the sheet is hidden.

## To know

- A2: 400 ms after the refusal the panel still read "Deposit requested" beside the refusal line, while its own
  re-read was in flight; by 1.2 s it read "Request closed". The page sent one read of the request and one of the
  till's figures right after the refused press.
- A3: the chat panel above the summary keeps its own "Deposit paid · ฿3,000" with a Paid badge: that is the chat
  request's state, not the Financial Summary.
- Not shown: the page for a link that ran out by time; the real gateway's page (the link is then 2C2P's own);
  the summary's wording with invoice lines present.

## Clean-up

The three ZZ TEST parties are archived and their threads marked handled (each read back). No request was left
open (party 1 cancelled by the step, party 2 closed with its party, party 3 paid). Another ZZ TEST party on
28 November, not of this run, was not touched. Every session signed out (401 read back).

`receipt.json` holds the readings, the requests and answers, and the stored figures.
