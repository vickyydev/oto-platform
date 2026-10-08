# SCRUM-502 second press for the last prepaid meal on staging - capture notes

Looked at 8 Oct 2026, about 05:15 to 05:25 Bangkok time. Staging on `c6194664`.
Demo Branch 2 only. Nothing committed, Jira not touched.

## Result: not captured, no pictures

The ticket asks for two presses for the last prepaid meal on the virtual counter
box, the second answered "already served" in the counter's words ("<name>'s
prepaid <item> has already been served."). It could not be driven at Demo Branch 2:

- There is no box at Demo Branch 2 (Console Devices: "No box at this branch yet";
  see the SCRUM-503 shot), and the only virtual counter box belongs to Central
  Floresta, which was out of bounds. The fix being checked is in the box agent's
  store (two presses at one moment), which only a box exercises.
- There is also no prepaid meal to press for: it needs a supervised stay with a band
  (drop-off booking with a signed form, checked in), and the Demo Branch 2 till
  says "No bookings are waiting to be checked in". The prototype demo band Kai
  #1007 names items that are not on this park's menu.

Nothing was written for this ticket.

---

# Closing retake, 8 Oct 2026, about 07:00 to 07:55 Bangkok time

Staging on `c6194664`. Demo Branch 2 only, on the Demo counter box (the
in-process virtual box, slot virtual-1, registered and online) that now exists
there, with Reception Till 1 attached to it. Signed in as the seeded platform
admin. Nothing committed, Jira not touched. This replaces the first pass's "not
captured" (there was no box and no prepaid meal then).

## Result: captured, three times

Two presses for the last prepaid meal on the Demo counter box, the second answered
in the counter's words. Each time one press was served and the other was refused
"<name>'s prepaid ZZ TEST Toastie has already been served." Which of the two won
differed between runs (the first run's first browser won, the second and third
runs' second browser), which is what two presses at one moment should look like.

## How it was set up

| Step | What was done | Reading |
|---|---|---|
| A supervised child with one prepaid item | A registration was made through the API (`POST /checkin/registrations`, not through the screens): guardian "ZZ TEST Meal Guardian 502" (+66999502001), child "ZZ TEST Meal Child 502", age 6 (drop-off), consent ticked with the three default confirmations, food provision "prepaid items": one ZZ TEST Toastie, qty 1, ฿90 | text read-back, the answer echoed `foodProvision.items` with `redeemedQty` 0 |
| The ticket | At the till (Tickets > Skip walk-in > Standard pricing > Add drop-off child) the child was attached, "2 Hours Play" chosen, drop-off service ฿225, total ฿1,205, paid in cash on the till's own screens. The sale is D2-000018 | screens, not pictured in this folder |
| The check-in | `POST /checkin/check-in-now` against that sale (the till's own "Check in the drop-off child?" prompt came up, but the capture script had closed the page before it was answered); the band printed on the box (kids wristband "printed" in the sale) and the child read "in park" with band D2-2YCJ8M | text read-back |
| Go offline | Console > Devices > Demo counter box > Go offline, so the tills work through the box (their banner reads "Working from the box alone - no internet - console") | pictured in the SCRUM-503 folder |
| Two presses | Two browsers (two sessions of the same till) each loaded the band's tab (the entitlement read "1 left"), tapped ZZ TEST Toastie (a PREPAID line, ฿0), pressed Charge, keyed a pick-up code, pressed Continue to Payment, and then pressed Complete Order at the same moment | screens |

The same was repeated twice more with a second and a third child (both named
"ZZ TEST Meal Child 502B", guardian "ZZ TEST Meal Guardian 502B" +66999502002,
bands D2-SZPCJS and D2-F8AKJR; one extra registration of that name was made by
a repeated script call and used for the third). Tickets D2-000020 and D2-000022.

## Shots (file names start `SCRUM-502-staging-`)

| File | What the viewer literally sees | Run |
|---|---|---|
| `first-press-served-receipt-d2-000019-box-lane-first-run.png` | "Order Confirmed - Sent to the kitchen - Order #0001 - ZZ TEST Meal Child 502 - Receipt D2-000019", pick-up code 61, "1x ZZ TEST Toastie PREPAID ฿0", Total ฿0, a kitchen ticket "For ZZ TEST Meal Child 502 - ALLERGY: None (ZZ TEST) - 1x ZZ TEST Toastie PREPAID", Remaining credit ฿0; the banner "Working from the box alone - no internet - 1 thing waiting to sync - console". | 1, the winning press |
| `second-press-already-served-box-lane-first-run.png` | The other browser, about eight seconds after the presses: "Amount due ฿0 - Pick-up code 62 - No payment needed", a greyed Complete Order, and under it a note "ZZ TEST Meal Child 502's prepaid ZZ TEST Toastie has already been served.", a greyed Back; the customer pane "We are checking the payment. Please wait." | 1, the refused press |
| `first-press-served-receipt-d2-000021-box-lane.png` | The same confirmation screen for ZZ TEST Meal Child 502B, Receipt D2-000021, pick-up code 72. The PREPAID badge and the ฿0 on the lilac line are pale on the tint and hard to read here. | 2, winner |
| `second-press-already-served-loser-press-on-box-lane.png` | The refused press at "No payment needed", pick-up code 71, note "ZZ TEST Meal Child 502B's prepaid ZZ TEST Toastie has already been served.", banner "1 thing waiting to sync". | 2, loser |
| `first-press-served-round-3-receipt-d2-000023.png` | Confirmation, Receipt D2-000023, pick-up code 82. | 3, winner |
| `second-press-already-served-round-3-two-seconds-after-both-presses.png` | The refused press two seconds after the presses (pick-up code 81): the note "ZZ TEST Meal Child 502B's prepaid ZZ TEST Toastie has already been served.", "3 in park", banner "1 thing waiting to sync". The same note was still there six seconds later (a second picture at that time was taken and is the same, not kept). | 3, loser |

File names say "first press" for the served press and "second press" for the
refused one: they mean winner and loser, not the order the keys were pressed in.
The pick-up codes in the pictures (winners 61, 72, 82; refused 62, 71, 81) fit the
account above of who won if one browser keyed 61, 71, 81 and the other 62, 72, 82 -
an inference, since nothing in a picture names the browser. Every winner shows the receipt, the PREPAID line (pale, see above) and
"Remaining credit ฿0"; every refused picture shows "No payment needed", a greyed
Complete Order, the "has already been served." note and, on the customer pane, "We
are checking the payment. Please wait."

## What the pictures do not show (text read-back)

- Under the note the page's text also reads "The payment has not been recorded.
  The order itself is saved on the platform, as unpaid and without a receipt
  number. ... Trying again will not help - the platform looked at this sale and
  refused it. Go back, check the order, and call a manager if it still refuses."
  with a sale id. None of it is visible in any picture, on either browser. By the
  platform's own sales list after the box came back (`GET /sales`, 8 Oct), the
  refused presses left no sale at all (no row, no receipt), and the three served
  meals were D2-000019, D2-000021 and D2-000023, all `finalised` once the box was
  switched back online. So the hidden text's "saved on the platform ... as unpaid"
  and "the platform ... refused it" describe something that did not happen.
- The refusal came from the box's lane (inferred, not pictured): the network trace of
  the stale cart in the SCRUM-503 folder shows the box's endpoint answering 409 (a
  different request from the Complete Order presses here). The banner IN THE PICTURES
  does not say "1 thing waiting to sync" on both browsers: it carries that count on
  one browser of each pair only (run 1: the winner's; runs 2 and 3: the refused
  one's) and reads only "console" on the other. All six show "Working from the box
  alone - no internet", which is what places both presses on the box lane; the
  waiting-to-sync count is a moment of polling, not a statement about which press won
  or whether a meal had reached the platform.
- The customer pane of the refused press stays on "We are checking the payment.
  Please wait."

## Problems

1. The box lane found a new child only after the Console's Go online had been
   pressed since the check-in. Three tries: a child checked in while the box was
   online and then the box switched offline ten minutes later (round 3's first
   attempt) was not known to the box; after Go online, a minute and a half online,
   and Go offline again, the same child was found (also the second child). The
   agent's code says it reads the check-in copy every minute while online, which is
   not what was seen; the cause was not found.
2. The hidden "saved on the platform as unpaid" wording above.
3. Left on staging: registrations "ZZ TEST Meal Guardian 502" and two named "502B",
   three checked-in children (still in the park), sales D2-000018 to D2-000023
   (the six listed above), and one unfinished `tendering` sale (`01a118ca-e7f0`,
   the first ticket attempt, no receipt). The Demo counter box was switched back
   ONLINE at 07:47 (see the SCRUM-503 folder) and not archived.
