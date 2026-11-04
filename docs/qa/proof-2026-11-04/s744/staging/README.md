# SCRUM-744 staging proof, 4 November 2026

Run from 20:00 to 20:13 Bangkok (13:00 to 13:13 UTC) against staging, in a
real Microsoft Edge (156) driven by Playwright, one step at a time
(`harness/`). Live commit on every service the run touched:
`a671f7bd0e8c2bcd872890212dd4e009be48b1b5`. oto-pos-web-staging
(dep-dblikvp7lnhs739pht60), oto-pos-staging (dep-dblikvp7lnhs739phti0),
oto-api-staging (dep-dblikvp7lnhs739phs60) and oto-console-staging
(dep-dblikvp7lnhs739phteg) were live on it from 12:56 UTC and stayed on those
deploys through the run (`live-readback.json`). Main CI 41828859420 passed all
six jobs on that SHA. Password and phone fields are masked in every screen.

## Fixture (ZZ TEST only)

- A ZZ TEST virtual box, `ZZ TEST SCRUM-744 mw24kguf virtual box`, made at
  Oto Play Park, Central Floresta through the admin API. Nothing runs it.
- The till, `ZZ TEST SCRUM-744 mw24kguf till`, made in the Console
  (Devices, New station) on that box: kind till, receipt prefix `Z744A`, cards
  taken on the terminal and recorded by hand, QR "Not taken here" (the Console
  has no hand-recorded QR choice; this one needs no device), open to all staff.
  The Console read it back as "Ready for selling"
  ([form](s744-00-console-new-zz-test-till-form.png),
  [made](s744-01-console-zz-test-till-made.png)).
- The staging reception test account signed in on it, once per width, each
  in a fresh browser context.

## What was run, and what was seen

| Step | Desktop 1440 x 900 | Phone 390 x 844 |
|---|---|---|
| On the ZZ TEST till after sign-in | [screen](s744-02-desktop-1-on-the-zz-test-till.png) | [screen](s744-07-phone-1-on-the-zz-test-till.png) |
| Left untouched: the warning at 105 s | [screen](s744-02-desktop-2-auto-lock-warning.png) | [screen](s744-07-phone-2-auto-lock-warning.png) |
| Locked by the timeout at 120 s (`POST /api/auth/lock` 200) | [screen](s744-02-desktop-3-locked-by-timeout.png) | [screen](s744-07-phone-3-locked-by-timeout.png) |
| Reloaded: still the lock screen | [screen](s744-02-desktop-4-locked-after-reload.png) | [screen](s744-07-phone-4-locked-after-reload.png) |
| Unlock: the till itself, no picker, no locked line | [screen](s744-02-desktop-5-after-unlock.png) | [screen](s744-07-phone-5-after-unlock.png) |
| 15 seconds later: unchanged | [screen](s744-02-desktop-6-15-seconds-later.png) | [screen](s744-07-phone-6-15-seconds-later.png) |
| Control: the till's address opened directly | [screen](s744-02-desktop-8-control-direct-address.png) | [screen](s744-07-phone-7-control-direct-address.png) |

Behind the lock after the reload the till asked `GET /api/me` (200),
`GET /api/me/permissions` (200), `GET /api/branches` (423 SESSION_LOCKED) and
`GET /api/me/stations` (423 SESSION_LOCKED). At Unlock it asked
`GET /api/me/stations` (200) and sent exactly one `PUT /api/me/session/station`
(200), for the ZZ TEST till; `/api/me/station/link` named it and the device
still remembered it, at both widths. After Unlock and 15 seconds later: no
"Which station are you on?", no "This session is locked" line, no "No station
here is yours to work". The till opened on Membership Check (desktop) and
Select Customer Type (phone). `receipt.json` keeps every call and check.

SCRUM-744's own change works on staging: these are the "after" of
`docs/qa/proof-2026-11-03/s732/staging/finding-repro-1..4`.

## Finding: the park list is not asked again after Unlock

The same reload also asks for the park list while locked (`GET /api/branches`,
423), and nothing asks again after Unlock. So the unlocked till keeps the
POS's built-in sample catalogue: the header reads "HKT Central" with a park
switcher listing "HKT Central" and "HKT Chalong"
([screen](s744-02-desktop-7-finding-park-list-after-unlock.png)), the in-park
count reads 0 instead of 1, and the low-stock strip and the "5 overdue" notice
are gone. Opening the address again (unlocked) brings back "Oto Play Park,
Central Floresta", 1 in park and both notices (the control screens). The
ticket list and prices come from the same load (`loadCatalogFromApi` in
`apps/pos/src/api/catalogBridge.ts`, called by `hydrate` in
`apps/pos/src/auth/OperatorContext.tsx`), so they stay the sample ones too;
that part is read from the code, not screened or sold on.

The local browser spec could not see this: the local seed's branch is also
named "HKT Central". SCRUM-744 stays at Testing until Unlock also reloads the
catalogue when the locked reload could not.

## Jira

SCRUM-744 got the eight screens attached and one plain comment (13467) showing them: the s732 before, the reload, Unlock and 15 seconds later at both widths, the park-list finding and the control. It was not moved: it stays at Testing because of the finding (`jira-publication.json`).

## Cleanup (read back)

Both till sessions and the Console session signed out (`/api/me` 401 after
each); the driver signed its admin API session out as it stopped. The ZZ TEST
till and then the ZZ TEST virtual box were archived (200 each); neither is in
the live lists, and no SCRUM-744 station is live. No sale, payment, SMS,
setting, real box or park device was touched.
