# SCRUM-838 — staging proof

**Ticket:** A deposit payment link stays payable after its party is deleted or archived in the Events module.

**When / where:** 11 November 2026, 18:55–19:02 Bangkok, staging. Headless Chromium, the staging administrator through the launcher. Two fresh ZZ TEST parties booked from ZZ TEST simulator threads on "Demo WhatsApp · Central Floresta". Nothing was paid.

**Commits live.** The run began with api, OTO App and inbox on `3410a7344834cdd6e383e25c2cb02ed14a670f6b`. Other work was deployed to staging while this ticket's steps ran, each a later commit of main that contains `3410a734` (the fix's own files are unchanged in them, except the inbox's `view.ts`, which gained unrelated lines):

| Service | Until (Bangkok) | Then |
|---|---|---|
| OTO App | `3410a734` until 18:56:37 | `51c558bd` |
| api | `3410a734` until 18:57:55 | `51c558bd`, then `33e54e3f` from 19:02:00 |
| inbox | `3410a734` until 18:58:00 | `33e54e3f` |

So: the second party's request, archive and the job's close (18:57:06) ran on the api at `3410a734`; its thread picture and link were taken within seconds of the switch; the third party's steps (19:00) ran on app/api `51c558bd` and inbox `33e54e3f`.

## Result: every step passed

### Second party — "ZZ Test Child's 6th Birthday", Sun 20 Dec 2026

| Step | What happened | |
|---|---|---|
| Request deposit 2500 (not paid) | 200, `requested`; the link in the chat is a full address. Thread: 3 messages, pill "Deposit requested ฿2,500". 18:56:06 | Pass |
| Archive through the app's admin route (`POST /api/admin/events/:id/archive`) | 200, archived 18:56:10 | Pass |
| Wait for the follow-up job | The request read `cancelled`, close reason `party_removed`, closed 18:57:06 — 56 seconds after the archive. | Pass |
| The thread | Pill "Deposit request closed · the party was removed in the Events module · ฿2,500" (actor: system). Still 3 messages: nothing new was said to the family. The thread also carries the chip "Party removed in the Events module". `838-01` | Pass |
| The link opened exactly as posted, no session | 404 "No such payment page": no amount, no Pay button, no form. A POST of "pay" at the same address: 404 too. `838-02` | Pass |

### Third party — "ZZ Test Child's 8th Birthday", Sat 26 Dec 2026

| Step | What happened | |
|---|---|---|
| Request deposit 2000 | 200, `requested`. 19:00:47 | Pass |
| Archive | 200, 19:00:50 | Pass |
| Resend pressed at once in the BEO panel | **409 `DEPOSIT_PARTY_REMOVED`** — "This party was removed in the Events module, so its deposit request was closed and nothing was sent to the family." shown in red in the panel. `838-03` | Pass |
| Read back | The request `cancelled` / `party_removed`, closed 19:00:52 (by the press itself, before the job's next tick). Thread: pill `deposit_cancelled` by system, still 3 messages — no second link was posted. | Pass |
| The archived party's BEO loaded afresh | Panel: "Request closed · ฿2,000 — This party was removed in the Events module, so the payment link was closed. Nothing was said to the family." `838-05` | Pass |

## Seen on the way

1. **The closed link shows raw text.** The family who opens the link after the party is removed sees the server's bare answer `{"error":{"code":"NOT_FOUND","message":"No such payment page"}}`, not a worded page. Nothing can be paid, which is what the ticket asks; the wording a family sees is rough.
2. **The panel is stale after the refused Resend.** Right after the 409 the panel still reads "Requested" with Resend, Cancel request and "The payment link" above the red line (`838-03`); it reads "Request closed" only after the BEO is loaded again (`838-05`).

## Not shown

- A party **deleted** (not archived): only archive was pressed.
- Request deposit pressed afresh on an already-archived party with no open request.
- Money landing on a closed link (the gateway's late payment path), and the reminder / hand-over not going out for a removed party: covered by the api tests.

## Pictures

- `838-01-thread-deposit-request-closed.png` — the thread: "Deposit requested ฿2,500", then "Deposit request closed · the party was removed in the Events module · ฿2,500"; no new message.
- `838-02-link-after-archive-nothing-to-pay.png` — the link as posted, after the archive: nothing to pay.
- `838-03-resend-refused-party-removed.png` — Resend refused in the BEO panel.
- `838-05-panel-after-reload-request-closed.png` — the panel after a reload: "Request closed · ฿2,000".

Names, initials, numbers and the link's path are covered; the conversation list is not in the picture.

## Clean-up (the whole run, all three tickets)

- The three ZZ TEST parties this run made (19, 20 and 26 December) are archived, each read back.
- The four ZZ TEST threads are marked handled.
- Every session signed out (read back 401); the driver stopped.
- Not touched: "ZZ Test Child's 7th Birthday" on 28 November (somebody else's, still open) — and nothing else.

`receipt.json` holds every read and status.
