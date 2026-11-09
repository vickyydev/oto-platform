# SCRUM-771 on staging: customer display and iPad till presence

Run on 9 November 2026, 21:01 to 21:14 Bangkok time. Staging was on `b2704fed` (api, pos web, pos, console), checked before and after the run.

A ZZ TEST till ("ZZ TEST SCRUM-771 till", prefix Z771) was made on Virtual box 1 at Central Floresta, and the staging reception account signed in to it in one browser. A separate customer display ("ZZ TEST 771 display") was opened in another browser and paired to that till only. Nothing of the park's own was touched. No sale was made.

**Important: the park was closed.** Central Floresta's Monday hours end at 20:00, and the run was after 21:00. A display that goes quiet while the park is shut is shown as Offline but no alert is raised, by design. So this run could **not** prove the `display.offline` warning on Health, or its clearing. The park's hours were not changed. The Devices states were all proved. The alert needs a short re-run during opening hours (10:00 to 20:00).

## What the pictures show

| Picture | What it shows | Result |
|---|---|---|
| `771-st-01-devices-paired-display-online.png` | Devices > Paired screens: the ZZ TEST display reads **Online**, "Online · seen 0s ago" | passed |
| `771-st-02-devices-paired-display-offline.png` | 3.5 minutes after the display's browser was closed: **Offline**, "Offline · last seen 3m ago — quiet for longer than 3m". The park's display on Till 1 (Pi) underneath still reads Online, with its label masked | passed |
| `771-st-03-health-no-display-alert-park-closed.png` | Health while the display was Offline: no alert for it. The api's own health read says the park's hours are "closed", so no alert is the expected result | expected for a closed park; the alert itself was not proved |
| `771-st-04-devices-paired-display-online-again.png` | The display page opened again in a new browser with the same stored pairing: the same row reads **Online** again, with no re-pairing | passed |
| `771-st-05-devices-till-screen-online.png` | Devices > Stations, the ZZ TEST till: "**Till screen online** · seen 14s ago", "Scanner: no scan reported from this till screen yet." | passed |
| `771-st-06-devices-scanner-last-used.png` | After a made-up code was typed at a scanner's pace into the F&B Scan Wristband field: "**Scanner last used 1m ago**" | passed |
| `771-st-07-devices-till-screen-offline.png` | 3.5 minutes after the till's tab was closed: "**Till screen offline** · last seen 4m ago" | passed |
| `771-st-08-health-no-till-alert.png` | Health with the till screen Offline: no alert names the ZZ TEST till. A quiet till screen is shown on Devices only and never raised | passed |
| `771-st-09-devices-pi-till-display-not-judged.png` | Read only: the park's display paired to Till 1 (Pi), on the HKT till box (Pi 5), cropped to that row with its label masked. It reads Online because the platform heard it 2 seconds earlier. It is not judged Offline | passed (see the note below) |

## The scanner check, step by step

1. `Z771-TEST01` was **pasted** into the Scan Wristband field. The till looked it up ("No tab found"). The heartbeat after it still said no scan. This is correct: since `ccf9d8392`, a paste does not count as a scanner.
2. `Z771-TEST02` was **typed one key every ~15 ms**, which is a scanner's pace (the rule is 50 ms or less per key, at least 6 keys). The till said "No tab found for "Z771-TEST02"", so the code opened nothing. The next heartbeat (60 s later) recorded the scanner's last use at 14:05:43Z, about 0.6 s after the typing began.

The till heartbeat was sent as soon as the till was taken and then every 60 seconds (4 beats over 3 minutes). There were no page errors.

## What the api answered

`receipt.json` holds the presence fields from the reads the Console page itself made: `GET /api/branches/:id/credentials?includeRevoked=true` (the display's `presence`) and `GET /api/branches/:id/stations` (the till's `screen`). It shows:

- **The display:** `online` (age 0 to 5 s) → `offline` (age 221 s, threshold 180 s) → `online` again. `box` was null each time because Virtual box 1 is the platform's own box.
- **The till:** `online` → `scannerLastUsedAt` set → `offline` (age 264 s), with the scan time kept.
- **The Pi display:** `online` with `box` = HKT till box (Pi 5).

The receipt also has the timings, ids and the clean-up read-back. People's names are left out.

## Notes for the owner

- **The alert is still to prove.** To prove it, repeat steps 1 to 5 of the recipe between 10:00 and 20:00, when the park is open. That shows the warning on Health and then its clearing as `display.online`.
- **Till 1 (Pi) reads "Till screen offline · never reported" tonight.** The heartbeat went live at 20:54, after the park closed, so this is expected for now. Tomorrow, with the park open, check that this card turns Online. If the Pi's till app talks to its box rather than to the platform, the heartbeat may never reach the platform. The card would then read offline for a till that works. No alert is ever raised for a till screen, so this would only be misleading, not noisy.

## Clean-up, read back

- The ZZ TEST display was revoked (200; presence now null). The display page then showed a new pairing code, and that code was expired ("This code has expired").
- The till was signed out (200). `/me` on its session now answers **401**.
- The till's printers were unassigned (200, 0 devices). The till was then archived (200; it reads archived, `screen` null).
- There are no sales on the ZZ TEST till and no live credentials left on it.
- Health has no open alert naming the ZZ TEST display or till, and no `display.*` alert at all.
- The Console session was signed out (200, then `/me` 401). The admin api session was signed out (200, then `/me` 401).
- Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1 still have the same devices as before the run (7, 4, 4, 1). None of them was used.
