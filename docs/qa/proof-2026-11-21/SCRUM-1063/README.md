# HR attendance tablet

The release source is `63e9f5b628f8bb09ec9690fc76d4e5379017f470`.
The production HR app returned 401 on all six face-identification requests
between 18:32 and 18:42 Bangkok on 21 November. The running server checked
the tablet credential before face identification. Its public status reported
face recognition switched off.

## Verification

- A disposable database and the built HR interface recorded one IN and one
  OUT for a synthetic employee. Both events used the registered device,
  carried the phone fallback method and retained a photo evidence path.
  The browser used a simulated camera. The database and temporary camera
  files were removed. [Local receipt](local/receipt.json)
- Staging deployment `dep-dc0oj0t9el5s73ep17p0` went live at 19:10 Bangkok.
  An HR administrator registered a test browser for Central Floresta and
  signed out of HR and the launcher. The signed-out browser reopened the
  clock, took a simulated photo and reached phone entry without a face
  request. The test stopped before entering a number. The temporary device
  was deleted and read back as 404. [Staging receipt](staging/receipt.json)
  and [administrator screenshots](staging/hr-tablet-registration.png)
- Production deployment `dep-dc0p2bs0916s73cdoth0` went live at 19:43
  Bangkok on 21 November. The authenticated HR app reported the exact
  release SHA on `app.otoplay.org`. The administrator approved a temporary
  Central Floresta tablet, opened the time clock and signed out of HR and
  the launcher. Both sessions returned 401. After a reload the approved
  browser took the required photo and reached phone entry with zero face
  requests. No employee number or real attendance entry was submitted.
  The temporary device was deleted and read back as 404.
  [Production screenshot guide](production/hr-tablet-registration.png),
  [photo screen](production/07-required-photo.png),
  [phone entry](production/08-enter-phone.png) and
  [production receipt](production/receipt.json)
- All four focused API review files passed, 94 tests total. The real kiosk
  device harness passed seven checks. The app built and its typecheck held
  at 411/411. The API typecheck passed. Explicit lint on the app's normally
  excluded files found the same four errors and 304 warnings on the three
  inherited files as on their parent. All new files had zero findings.

The park administrator completes the one-time approval in the browser on
each physical attendance tablet. An approval made in a test browser applies
only to that browser.
