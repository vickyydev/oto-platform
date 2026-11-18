# The counter Pi (Till 1): what is waiting to be installed

One list of everything the counter box at Central Floresta needs at its next
visit, so a single visit covers all of it. Kept up to date at every landing
that touches the box (`packages/box-agent`, `scripts/pi`) or the customer
display.

**Nothing on this list is installed until the owner says go.** His word of
18 November 2026: more changes are coming and the Pi is offline, so wait for
his go and record everything that has to be installed. Nobody reaches the Pi,
over the private network or at the park, without that go.

_Last brought up to date: 18 November 2026. The Pi itself was not read that
day (it is offline); its state below is as last read on 12 November._

## The Pi today

- Raspberry Pi 5, the counter box of Till 1 (slot `till-1`), host `oto-till`.
- Runs box build `0.1.0-20261029-9b0926c4`, installed with the display
  start-up off (`--no-kiosk`) and the printers on the direct cable
  (`--printer-direct`).
- Starts from a 64 GB USB stick. On 12 November it failed to start from it
  (boot loader read timeout) and started again from a USB 2 socket. A full
  copy of the stick is kept on the owner's laptop; it is deleted only on his
  word (SCRUM-223, the branch box image and on-site readiness).
- The customer display is an Edatec 10-inch touch monitor standing
  **upright** on the counter: HDMI for the picture, its USB cable for touch.

## What one visit installs, in order

1. **A fresh box release packed from `main` on the day of the go.** The build
   on the Pi is from 29 October. Since then 62 commits touching the box have
   landed (count on 18 November), none of them on the Pi yet. Pack with
   `node packages/box-agent/scripts/build-runner.mjs --pack` and push with
   `sh scripts/agent/push-release.sh` (`--dry-run` first shows the commands).
   Read the Pi's current options before installing so none is lost.
2. **The display start-up, on, for an upright 10-inch screen.** Install
   without `--no-kiosk`, with `--kiosk-url` set to the till's display
   address, `--kiosk-scale` (to be tried on the real screen, about 1) and the
   turn for an upright screen (`--display-rotate`, with `--display-output`
   when the screen's name is needed; touch follows the turn). Camera for the
   drop-off photo: `--display-camera allow`. Keep `--printer-direct` and the
   api address the Pi has. The installer's header in `scripts/pi/install.sh`
   is the reference for every option; read it on the day, not this list.
3. **Pair the display to Till 1, once.** A 6-digit code from the Console's
   Devices page; the pairing stays in the display's browser profile.
4. **Power-cycle test.** Switch the Pi off and on: the display starts by
   itself, upright and at the right size, touch lands where the finger is,
   it waits for the Wi-Fi instead of showing an error, and it follows the
   station staff pick on the iPad.

## What the release carries that the Pi does not have yet

Grouped by what staff would notice; ticket keys are from the commits' own
footers.

| Area | Tickets |
| --- | --- |
| Customer display on the counter: started by the box, upright with touch following, waits for Wi-Fi, webcam without a tap, theme follows the till | SCRUM-711, SCRUM-928, SCRUM-895, SCRUM-896, SCRUM-929 |
| Drop-off and nanny forms on the customer display, the number confirmation, the family's photo, offline drop-off bands | SCRUM-857, SCRUM-861, SCRUM-862, SCRUM-863, SCRUM-893 |
| The counter keeps selling with the internet down; the till reaches its box on the counter network | SCRUM-713, SCRUM-719, SCRUM-727, SCRUM-728 |
| The scanner plugged into the box: read by the box, heard by the till, vouchers and barcodes resolved | SCRUM-700, SCRUM-736, SCRUM-737, SCRUM-738 |
| Private network join at install, one-command release push, installer reaches its summary when the network client is signed out | SCRUM-701, SCRUM-788 |
| A second drive that mirrors the box's store (`--mirror-uuid`) | SCRUM-708, SCRUM-710, SCRUM-712 |
| Pricing and check-in rules the box applies offline (free items, a child already paid for, tier proof documents) | SCRUM-740, SCRUM-762, SCRUM-764, SCRUM-768, SCRUM-772, SCRUM-773 |
| Cash drawer pulse recorded as a drawer kick, not a printout | SCRUM-952 |
| The family adds and removes saved children on the customer display (landed 19 November). Until the Pi has this release its box refuses a review with an empty place, and the till shows the review on its own customer half instead | SCRUM-1014 |

## What the visit can prove (tickets waiting at Testing for the real device)

- SCRUM-711: the counter box drives the customer display screen.
- SCRUM-928: the installer sets up a display that stands upright, with touch
  following the turn.
- SCRUM-929: the till's Display theme switch changes the separate display.
- SCRUM-895: a counter screen that starts before the Wi-Fi recovers by itself.
- SCRUM-896: the counter screen may use its webcam without a tap on Allow.
- SCRUM-713: the counter keeps selling with the internet down.
- SCRUM-700: the box reads the USB scanner itself.
- SCRUM-701: the box joins the private network at install; a release is
  pushed with one command.

Each needs a photo or a screen picture from the real device to close.

## Hardware, not software

- **Storage.** Move the Pi from the USB stick to an NVMe drive (a case with
  an NVMe base, or a USB NVMe enclosure meanwhile). The kept copy of the
  stick can be written onto the new drive so the box keeps its identity.
- **The printer cable.** The Pi's Ethernet socket is the printers' own cable.
  It is never plugged into the park's network.

## Known gaps to look at while there

- The on-screen keyboard is English only.
- SCRUM-893 and SCRUM-894 (the display form's keyboard on the allergies box
  and on a short screen) are on staging and have not been seen on the real
  10-inch screen.

## Changes still coming

The owner expects more changes before the visit. Each landing that touches
the box or the customer display adds its line to the table above, with its
ticket, on the day it lands.
