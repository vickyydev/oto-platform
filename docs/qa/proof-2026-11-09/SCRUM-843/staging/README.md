# SCRUM-843 — AI Fill approval can write the chat's deposit figure over a deposit the family paid after the review was opened

Staging proof, 11 November 2026, 21:08 to 21:12 Bangkok. **Result: passed.**

## What was live

- `oto-app-staging` deploy `dep-dbq757qjnfac73evcht0`: **live** at commit `e9bdd4bc`, finished 20:52:34 Bangkok.
- `oto-api-staging` deploy `dep-dbq757lg1s2s739mall0`: **live** at commit `e9bdd4bc`, finished 20:54:58 Bangkok.
- Established by the host's control API (each deploy read by its id, one request every 90 seconds). The run began
  after both read live and 90 seconds more.

## How it was run

One headless Chromium, the staging administrator signed in through the launcher. A ZZ TEST family wrote to
"Demo WhatsApp · Central Floresta" through the inbox's Simulator: Book Date (27 Dec, 13:00, 10 kids, 3 adults),
Create BEO. The party had a linked chat and no deposit. The review was opened by the pasted-message path:
AI Fill, this ZZ TEST team confirmation pasted, Parse with AI:

> ZZ TEST team confirmation. Confirmed: ZZ Test Child's 9th birthday party on Sunday 27 December 2026, 13:00 to
> 15:30, 12 kids and 4 adults, booking name ZZ TEST, decoration: balloon arch. Deposit 1,000 THB received. (ZZ TEST)

## Steps

| Step | What | Result |
| --- | --- | --- |
| 1 | AI Fill with the pasted confirmation | The ONE review opened (one dialog): 12 kids, 4 adults, 13:00 to 15:30, the same day, Decoration "balloon arch", **Deposit paid 1000, Received ticked**, marked "from the team". The review was read with the party's deposit at 0. Left open (`843-01`) |
| 2 | A second page of the same session: Billing, Request deposit 3000; paid on the simulated page in a separate browser | Stored deposit **3000**, dated 2026-11-11 (event prepayment 3000, `oneDeposit` 3000); the request reads paid |
| 3 | Back on the open review: **Approve and create** | **Pass.** The approval sent deposit 1000 received, read with a deposit of 0. Answer: deposit not written, reason `moved`. Toast: "BEO created from the pasted message — Saved: the event's name and details, the counts, the times, the date when ticked, the package, the kitchen plan, the bar, the entertainment, the setup plan, the POS box, the timeline's steps and the team you ticked. **Not written: the deposit — it changed while this review was open (now ฿3,000).**" The other reviewed fields were written: kids 10 → 12, adults 3 → 4, end time 15:30, Decoration "balloon arch". Stored deposit still **3000**, dated 2026-11-11 (`843-02`) |
| 4 | AI Fill again (a fresh review, read with the deposit at 3000), deposit set to 5000, Received ticked | The review shows "This BEO already has its deposit: approving replaces what the review fills." (`843-03`) |
| 5 | Approve and create | **Pass.** Answer: event and deposit written, nothing "not written". Toast: "Saved: … the team you ticked and the deposit." Stored deposit **5000** (event prepayment 5000, `oneDeposit` 5000, billing record 5000) (`843-04`) |

## Pictures

- `843-01-review-open-deposit-1000-received.png` — the review open with Deposit paid 1000 and Received.
- `843-02-approved-deposit-kept-at-3000.png` — after Approve and create: the toast with "Not written: the deposit".
- `843-03-fresh-review-deposit-5000-received.png` — the fresh review with 5000 and Received.
- `843-04-fresh-review-approved-deposit-5000.png` — after its approval: the deposit among what was saved.

The events board behind the BEO sheet is hidden; the grey boxes cover the ZZ TEST simulator number and name
matches on the form behind the dialog.

## To know

- Create BEO on the thread answered "AI Fill did not run: no message from the team in this conversation names the
  date, the time and the party details yet." (no team line was written in the thread), so the review came from the
  pasted-message path; the inbox path was not needed.
- After step 5 the stored deposit carries no day (5000, day empty; before it: 3000 on 2026-11-11). The review's
  day field was empty: the pasted message names no day.
- Not shown: the inbox (conversation) origin of the review; a lowering below what was paid through the chat; a
  page from before this rule.

## Clean-up

The ZZ TEST party is archived and its thread marked handled (read back); its request is paid, none open. Every
session signed out (401 read back).

`receipt.json` holds the readings, the requests and answers, and the stored figures.
