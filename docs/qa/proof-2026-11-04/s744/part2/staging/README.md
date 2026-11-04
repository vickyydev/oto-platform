# SCRUM-744, second part: staging proof, 4 November 2026

Run from 21:50 to 21:57 Bangkok (14:50 to 14:57 UTC) against staging, in a
real Microsoft Edge driven by Playwright, one step at a time (`harness/`).
Live commit on every service the run touched:
`2549fefc0b4ea47cc72de0a068650d9f8f4a6ac4`. oto-pos-web-staging
(dep-dblk7jtbedkc73af31s0), oto-pos-staging (dep-dblk7k5bedkc73af323g),
oto-api-staging (dep-dblk7jtbedkc73af30t0) and oto-console-staging
(dep-dblk7k5bedkc73af327g) were live on it from 14:43 UTC and were still on
those deploys after the run (`live-readback.json`, read before and after).
Main CI 41845927108 passed on that SHA. Nothing was deployed or restarted by
hand and no setting was read or changed. Password and phone fields are
masked in every screen.

The plan is the one at the end of `../README.md`. This is the "after" of the
first part's finding,
`../../staging/s744-02-desktop-7-finding-park-list-after-unlock.png`
(Jira comment 13467).

## Fixture (ZZ TEST only)

- A ZZ TEST virtual box, `ZZ TEST SCRUM-744 mw28h2cu virtual box`, made at
  Oto Play Park, Central Floresta through the admin API. Nothing runs it.
- The till, `ZZ TEST SCRUM-744 mw28h2cu till`, made in the Console
  (Devices, New station) on that box: kind till, receipt prefix `Z744B`, cards
  taken on the terminal and recorded by hand, QR "Not taken here", open to all
  staff. The Console read it back as "Ready for selling"
  ([form](s744b-00-console-new-zz-test-till-form.png),
  [made](s744b-01-console-zz-test-till-made.png)).
- The staging reception test account signed in on it, once per width, each in
  a fresh browser context.

## What was run, and what was seen

| Step | Desktop 1440 x 900 | Phone 390 x 844 |
|---|---|---|
| Control: signed in and on the ZZ TEST till | [screen](s744b-02-desktop-1-control-signed-in-on-the-zz-test-till.png) | [screen](s744b-07-phone-1-control-signed-in-on-the-zz-test-till.png) |
| Left untouched: locked by the timeout (`POST /api/auth/lock` 200) | [screen](s744b-02-desktop-2-locked-by-timeout.png) | [screen](s744b-07-phone-2-locked-by-timeout.png) |
| Reloaded: still the lock screen | [screen](s744b-02-desktop-3-locked-after-reload.png) | [screen](s744b-07-phone-3-locked-after-reload.png) |
| Unlock: the till itself, on the real park | [screen](s744b-02-desktop-4-after-unlock.png) | [screen](s744b-07-phone-4-after-unlock.png) |
| 15 seconds later: unchanged | [screen](s744b-02-desktop-5-15-seconds-later.png) | [screen](s744b-07-phone-5-15-seconds-later.png) |
| The top bar after Unlock, close up | [screen](s744b-02-desktop-6-park-after-unlock-header.png) | |
| Tickets after Unlock (read only) | [screen](s744b-02-desktop-7-tickets-after-unlock.png) | |
| Control: the till's address opened directly | [screen](s744b-02-desktop-8-control-direct-address.png) | [screen](s744b-07-phone-6-control-direct-address.png) |
| Control: tickets on that open (read only) | [screen](s744b-02-desktop-9-control-tickets.png) | |

Each width locked by the real timeout about 121 seconds after the station
was picked (desktop 14:52:42 UTC, phone 14:55:47 UTC), after the "Auto-lock in
15s" warning.

### Behind the lock, after the reload (both widths)

`GET /api/me` 200, `GET /api/me/permissions` 200, `GET /api/branches` 423
`SESSION_LOCKED`, `GET /api/me/stations` 423 `SESSION_LOCKED`. No occupancy
request while locked.

### At Unlock (both widths)

`POST /api/auth/unlock` 200, then the whole session was read again before the
till opened: `GET /api/me`, `/api/me/permissions`, `/api/branches` (200, its
body naming "Oto Play Park, Central Floresta"), `/api/payment-methods`,
`/api/tiers`, `/api/branches/:id/ticket-packages`, `.../pricing-mode`,
`.../tax-config`, `.../holidays`, `/api/menu/discounts`, `.../menu` and
`.../stock/sellable`, all 200. Then `GET /api/me/stations` 200 and one
`PUT /api/me/session/station` 200, for the ZZ TEST till. The only writes from
the reload to 15 seconds after Unlock were the unlock and that station pick.
`/api/me/station/link` named the ZZ TEST till and the device still remembered
it. The in-park chip asked `GET /api/branches/<the park>/occupancy` every
5.1 seconds from Unlock on, for the session's park, answering a total of 1.

### Desktop header, control against after Unlock

| | Control (signed in) | After Unlock | 15 s later | Control (direct address) |
|---|---|---|---|---|
| Park chip | Oto Play Park, Central Floresta | same | same | same |
| Park switcher | none (one park) | none | none | none |
| "HKT Central" / "HKT Chalong" anywhere | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| In-park count | 1 | 1 | 1 | 1 |
| Low-stock strip | 13 out of stock · 1 low | same | same | same |
| Overdue notice | 5 overdue | same | same | same |
| Pricing mode | Weekday pricing | same | same | same |

The control has no park switcher because this account works one park; the
first part's finding showed a switcher only because the sample catalogue
carries two parks. After Unlock the header is the control's, not the sample's.

### Tickets, read only

Skip walk-in (Tourist), then the Tourist rate; no ticket was pressed and no
request other than reads was sent. After Unlock and on the control open the
grid was the same: 1 Hour Play ฿690, 2 Hours Play ฿890, Full Day Pass ฿1090,
Eat & Play Kids Pass ฿1300, per person, on Weekday pricing.

Note: on staging the park's ticket packages carry the same four names and
Tourist prices as the POS's built-in sample catalogue, so the ticket screen
alone cannot tell the two apart. What shows they are the park's own is the
request record above: after Unlock the till read the park's
`ticket-packages`, tiers, holidays, tax and pricing mode again and every one
answered 200. Before the change the unlock read none of this again (the
provider only cleared the lock; the local before-run in `../README.md` saw no
park-list request after Unlock), and the first part's staging run showed the
sample park after Unlock.

### Phone

The phone bar cuts the park chip and draws no low-stock strip or overdue
notice (see `../README.md`), so the phone is checked by what shows there and
by its requests: the in-park count after Unlock reads 1, the control's (the
sample park reads 0); `GET /api/branches` 423 at the locked reload, then 200
after Unlock naming "Oto Play Park, Central Floresta"; the occupancy poll for
the session's park every 5.1 seconds after Unlock. The till opened on Select
Customer Type, no picker, no "This session is locked", unchanged 15 seconds
later, the same as the control.

The first part's station checks also held at both widths: one station pick,
for the ZZ TEST till, no "Which station are you on?", no "No station here is
yours to work".

`receipt.json` keeps every call and check.

## Result

Both halves of SCRUM-744 are now proven on staging: a till locked by the
two-minute timeout and reloaded comes back, after Unlock, on its own station
(first part, comment 13467) and on its own park, with that park's count,
notices, tickets and prices (this part).

## Cleanup (read back)

Both till sessions signed out (`/api/me` 401 after each), the Console
session signed out (401 after), and the driver signed its admin API session
out as it stopped. The ZZ TEST till and then the ZZ TEST virtual box were
archived (200 each); neither is in the live lists, and no SCRUM-744 station
is live. No sale, payment, SMS, setting, real box or park device was touched.
