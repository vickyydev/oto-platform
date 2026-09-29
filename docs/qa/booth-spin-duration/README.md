# Lucky Wheel spin duration - 29 September 2026

SCRUM-452 WORKS on staging release `5fb8525` and is Deployed. The Console
defaults to ten seconds and accepts whole seconds from 2 to 20. The setting
uses `spinDurationSeconds` throughout draft, publication and the box cache.
Saving changes the draft; publication delivers the setting between spins.
Each spin captures its duration once. Default ten remains absent from the
published document, preserving older version and checksum bytes.

All **nine staging checks passed**, with no cleanup failures. The affected
existing files passed **84 tests** (DB 22, shared 13, wheel 5, API 44), and all
touched packages passed typecheck and lint. Forward migration 0028 adds the
stored setting. No new test suite or dependency.
[Main CI 36521266122](https://github.com/vickyydev/oto-platform/actions/runs/36521266122)
is green. API, POS, Console, Launcher and Booth are live on `5fb8525`; the
OTO App remains on `c416065`.

## Reviewed evidence

| Evidence | Jira attachment |
|---|---|
| [Native Console default ten](SCRUM-452-staging-default-10.png) | 10862 |
| [Saved twelve-second draft](SCRUM-452-staging-saved-12-draft.png) | 10863 |
| [Native publication summary](SCRUM-452-staging-publish-summary-12.png) | 10864 |
| [Twelve-second reveal and printed result](SCRUM-452-staging-reveal-12.png) | 10865 |
| [Offline restored reveal and printed result](SCRUM-452-staging-offline-reveal-12.png) | 10866 |
| [Default ten-second reveal and printed result](SCRUM-452-staging-reveal-default-10.png) | 10867 |

The first three screenshots show the actual staging Console. The wheel
screenshots use the native staging build downloaded and served by an isolated
local box with a simulated printer. They verify that build's animation and
reveal-to-print behavior; they do not prove a physical Pi installation.

[Sanitised results](staging-results.json) contain the passing facts:

- Fresh Console draft and published default are ten seconds.
- Saving twelve seconds leaves the running default version unchanged.
- Publication delivers twelve seconds with identical prizes and a verified
  canonical bundle checksum.
- Seven native staging asset files were downloaded.
- Online twelve-second animation measured 12,015 ms; print arrived 12,949 ms
  after animation start with the result visible.
- A new offline box instance restored twelve seconds from retained in-memory
  SQLite and its public configuration file. Animation measured 12,006 ms;
  print arrived after 12,978 ms with the result visible.
- Offline restart and spin made zero cloud requests.
- Returning to ten seconds saved a clean native form and published the
  implicit default; prize bytes stayed identical.
- Default animation measured 10,002 ms; print arrived after 10,972 ms with the
  result visible. All three spin responses were queued, then printed at reveal.

The first seven checks and five screenshots were retained from the earlier
passing scope. A fresh disposable scope completed only the default-ten save,
publication and spin. Helper corrections covered asynchronous staff-panel
opening, the simulated printer address, form hydration and reselecting the
temporary booth after reload. Page writes were bounded to that booth.
Existing booths retained their published versions: Booth 2 (proof) 1,
Booth 3 (fixes) 1 and FWBooth1 5. The dedicated proof inventory was archived;
audit history remains. Its reference design has three active prizes and one
disabled prize; the physical booth's seven-prize configuration was not edited.

## Pi update

The exact green main CI packed `oto-box-0.1.0-5fb8525.tgz`. After all five
staging services were live, the release was downloaded, its SHA-256 checked,
and the archive and `.tgz.sha256` copied to the Desktop. The Desktop copy was
checked again. The older release pair was moved into `old-oto-box-releases`.

SHA-256: `f82baa9a6053df514ebfd75a27529aba25b44b33d6ca012aba61b704c61a49f2`

Use [PI_BOOTH.md's Update step](../../ops/PI_BOOTH.md#7-checking-and-fixing).
Cloud deployment does not replace the Pi's locally served page. Install this
release before publishing a non-default duration; older Pi assets do not apply
the new field. This session did not install the release on the physical Pi.
