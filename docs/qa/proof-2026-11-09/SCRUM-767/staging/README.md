# SCRUM-767 — A consent line ticks once on a tap, on staging

**Result: passed.** On the till's consent screen, one tap on the small box of a "Please confirm" line ticks it, and it stays ticked. A second tap on the box unticks it. A tap on the words of a line ticks that line once. Space on the focused box ticks or unticks it once per press.

- **Where:** the staging till app, https://oto-pos-web-staging.onrender.com, at Oto Play Park, Central Floresta.
- **Version:** commit 748ed62f, live on oto-pos-web-staging and oto-pos-staging before the run began (read at 12:52 UTC). The page's script carries the change. Details are in `receipt.json` → `deploys` and `bundle`.
- **When:** 9 November 2026, 19:53–20:03 Bangkok time. No page errors were recorded.
- **How:** a headless Chromium at 1440 × 900 with touch turned on, so every tap is a real touch tap. The till read it as a touch screen. It was signed in as the staging reception account.
- **Till:** a test till made for this run, "ZZ TEST SCRUM-767 till" on Virtual box 1, receipt prefix Z767. It was archived at the end.
- **No paired display.** The test till had no customer display paired to it. The till therefore showed the family's form on its own right half (the till's "Show customer display" test view), and the ticks were made there, on the till.

## How "once" was checked

Every time a box's ticked state changed, the page logged it. After each tap or key press the log showed **exactly one change**. The fault this ticket fixes made a tap on the box tick and then untick straight away, which would show as two changes. The staff side's "Agreements" panel (top left in every picture) was read after each step too, and always agreed with the box.

## What was done, and what each picture shows

**Set-up (no picture):** a walk-in sale on a test phone number: 1 Hour Play for 1 child and no adult, ฿690. The sale was not paid. Pay opened the "Children playing alone" step. On the right half the child was named "ZZ TEST 767 Child" and given age 6. The form then showed "Drop-off supervision needed — ฿225 one-time", the consent line and the "Please confirm" list with three lines.

- `767-st-01-box-tap-ticks-and-stays.png`: one touch tap on the 24 × 24 px box of the first line, "I will remain within 15 minutes of the venue". The box is ticked, and the staff side reads "ticked". The picture was taken about 15 seconds after the tap, and the box was still ticked. One change was logged.
- `767-st-02-box-tap-again-unticks.png`: a second tap on the same box unticks it. The staff side reads "not ticked yet". One change was logged.
- `767-st-03-words-tap-ticks-once.png`: one touch tap on the words of the second line, "I understand early pickup does not qualify for refund". That line ticks, and the first line stays unticked. One change was logged.
- `767-st-04-space-on-focused-box-ticks-once.png`: the first line's box is focused and Space is pressed once. It ticks, with one change logged, and the second line stays ticked. Space was then pressed once more and the box unticked, again with one change (no picture).

**Also checked (no picture):** the consent line above the list ("I authorize Oto Play Park staff to supervise my child…"). One tap on its box ticks it and a second tap unticks it, with one change logged for each tap.

**Then the sale was cancelled.** Back left the step and Cancel emptied the order. Afterwards the till had no sales. The only thing the till sent for this cart was a price quote. No sale, no member and no photo were made.

The magenta block near the top of the right half covers the test phone number given at the start of the sale. It overlaps the form's subtitle. Nothing else is hidden.

## Clean-up

The same test till then served the SCRUM-766 proof. At the end of both, the till signed out and its session was refused afterwards. The till's printers were unassigned and the till was archived; a read-back shows it archived with no devices. The admin session signed out too. Till 1 (Pi), Till 2 (test), Reception Till 1 and FWBooth1 read back unchanged. No till notice was pressed, no setting was changed and no text message was sent.

Every tap, the logged changes and the staff side's reading after each step are in `receipt.json`.
