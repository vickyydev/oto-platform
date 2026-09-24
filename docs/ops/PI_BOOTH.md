# The Raspberry Pi booth box — set-up guide

One page for setting up a Lucky Wheel booth on a Raspberry Pi 5: the Pi runs the booth box (the draw, the voucher codes, the printer, the queue for the cloud) and shows the wheel on the television plugged into it. Codes are made on the Pi, so the booth keeps playing and printing when the mall's internet drops; everything catches up when it returns.

**Nothing in this kit has run on a Raspberry Pi yet.** The box program was run as a box on a bench laptop, against a local api, with a network printer stand-in; the install script and the system units were checked for syntax and in pieces. Your first install at the bench is their first real run: read what the installer prints, and keep the Pi on a keyboard and screen (or SSH) until the wheel is up.

## 1. On the desk

- Raspberry Pi 5 with the **official 27 W USB-C power supply**, a **good A2 microSD card** (32 GB or more) or a USB SSD, a micro-HDMI to HDMI cable.
- The television, **hung portrait**. It still sends a landscape picture, and the page turns the picture clockwise to stand it upright. If your television is hung the other way round the picture comes out upside down: set `OTO_KIOSK_ROTATE=ccw` (section 7), or install with `--rotate ccw`. A landscape layout is not built.
- The red button (it must send **Space**; never Enter — Enter is the badge scanner's key and is refused).
- For staff: a **small wireless keyboard with a touchpad** (one USB receiver) covers everything — the claim code (it has letters), PINs, phone and password, and the staff panel. A number pad alone enters a PIN but only reaches Reprint and Sign out if it has a **Tab** key.
- The receipt printer: 80 mm ESC/POS **on a network cable**, port 9100. Print its self-test page: note its **IP address** and whether it is **576 or 512 dots** per line. USB-only printers are not supported yet.
- The router at the booth: the printer and the Pi on the same network. Give the printer a **fixed address (DHCP reservation)** on the router.

## 2. Write the card

In Raspberry Pi Imager choose the device **Raspberry Pi 5**, then **Raspberry Pi OS (other)** → **Raspberry Pi OS (Legacy, 64-bit)** — the one Imager describes as "A port of Debian Bookworm with security updates and desktop environment".

- **Not the first entry in the list.** Imager's first choice, **Raspberry Pi OS (64-bit)**, is Debian 13 "Trixie". The installer is written for Debian 12 "Bookworm" and warns on anything else. (Those are the names in Imager's list in September 2026. Imager downloads its list, so the names can change; whatever the entry is called, its description must say Bookworm and desktop.)
- **Not Lite.** The television is a web browser on the Pi's desktop; the *Lite* images have no desktop, and the screen would stay on a text console. (*Raspberry Pi OS (Legacy, 64-bit) Full* works too; it only adds applications the booth does not use.)

In Imager's settings: a username and password, Wi-Fi if not cabled, **SSH with a public key** (not a password), timezone Asia/Bangkok. Write, insert, boot, and let the desktop come up once.

## 3. Install the box

Build the release on a development machine with `pnpm --filter @oto/box-agent pack:pi`; it writes `packages/box-agent/dist/oto-box-<version>-<commit>.tgz` — for example `oto-box-0.1.0-6cfbc5c.tgz`. Copy that file to the Pi's home folder (USB stick or `scp`), then on the Pi, **with the file's own name**:

```
cd ~
rm -rf oto-box
tar -xzf oto-box-0.1.0-6cfbc5c.tgz
sudo bash oto-box/pi/install.sh --api https://oto-api-staging.onrender.com
```

Name the file rather than writing `oto-box-*.tgz`: once an old and a new release sit in the same folder, the wildcard names both and `tar` fails. `rm -rf oto-box` clears the folder the last release unpacked into, so nothing of it is left mixed into the new one.

The installer puts in: Node 22 (checked against nodejs.org's checksums), a service user `oto-box`, the box (`oto-box.service`, restarted whenever it stops), a watchdog that restarts it if its page stops answering — or if systemd gave up on it after repeated crashes — the television (`oto-kiosk.service`: Chromium full screen on `http://127.0.0.1:8780/`, restarted if it closes), desktop auto-login, no screen blanking, network time, and a daily reboot at 04:30. Options: `--rotate ccw` (section 1), `--no-daily-reboot`, `--ssh-keys-only`; `sudo bash oto-box/pi/install.sh --help` lists them. It prints the next steps when it finishes.

## 4. Claim the box

1. Console → **Devices** → **Add a box**. Name it (e.g. "Bench box"), role **Booth**. Copy the claim code — it is valid for a short time and only once.
2. On the television: **Set up this box** → type the code → Claim. Or on the Pi: `sudo oto-box claim <CODE>` — the running service notices within a few seconds and restarts itself to use it.

The box writes its credential to `/var/lib/oto-box/credential.json` (owner-only, 0600). Never copy it to another Pi; a replacement Pi is claimed with a new code.

After the first install, **reboot once** (`sudo reboot`): the desktop logs in by itself and the television opens the booth, as it will on every boot.

## 5. Printer, booth, staff, wheel — in the Console

1. **Printer**: Devices → the box → **Add a device** → Receipt printer, network, the printer's `IP:9100`.
2. **Booth**: Devices → **New station** → box: this box, kind **Booth**, a two-character code prefix (e.g. `B2`), receipt → the printer. A box can run more than one booth; the television then asks which one it is, once, and remembers.
3. **Staff and PINs**: Booths → the booth → **Booth staff** — add the people who work the booth and set each one's PIN there (the steps are in [BOOTH_SETUP.md](BOOTH_SETUP.md), section 3). Before your own test, **add yourself and set your own PIN** — otherwise a phone-and-password sign-in at the booth answers "You are not on this booth's staff list", and there is no PIN to fall back on. The roles that may sign in at a booth are staff, reception, branch manager and both administrator roles. What each prize is worth and what its slip says are set up under **Voucher types**, and the session length under **Booth settings** — BOOTH_SETUP.md walks through all of it, in order, before the publish below.
4. **Wheel**: Booths → the booth → prizes, chances (must add up to 100 %), **Review and publish**. A prize switched off is not on the wheel. The box picks up a publish within about a minute. (The Booths page's "Screens / pair a screen" section is for the staging website, not for a Pi: the Pi's own television needs no pairing.)

## 6. At the booth

- The Pi boots straight into the wheel. The television is up within seconds of the box starting, with or without internet — even when the line is up but the cloud does not answer: the box plays the wheel it holds, gives up on any call to the cloud that has not begun to answer within 15 seconds, and keeps trying in the background.
- The staff panel opens: sign in with a **PIN** (checked on the box, works offline) or with **phone and password** (checked by the cloud — only if the person is on the booth's list and their role allows booth sign-in). What the panel can answer besides "Signed in":
  - *No internet — sign in with your PIN*: the cloud could not be reached, or did not answer within 5 seconds.
  - *You are not on this booth's staff list* / *Your role cannot sign in at a booth* / *Change your temporary password on the POS first*.
  - *This box is no longer allowed here*: the cloud refused the box itself — its credential was revoked or replaced in the Console, or the box was taken out of service. The box notices by itself within a minute: it lets go of the refused credential, and the television goes back to "Set up this box", ready for a new claim code.
  - *This booth is not on this box any more*: the booth was moved to another box or archived in the Console.
- A sign-in lasts the booth's **staff session length** — 12 hours unless one is set under Booths → the booth → Booth settings (BOOTH_SETUP.md, section 4) — and is not ended by inactivity. A new length reaches the box with the next publish; a sign-in already running keeps the length it started with. The top corner shows who is signed in (name and staff code). With nobody signed in the wheel **still plays** — the button reads *Staff: sign in for your name on the slip* — and those spins are recorded *unattributed*.
- **Staff panel from the keyboard**: type any digit. Signed out, that digit is the first of the PIN. Signed in, the panel opens on *Reprint last voucher*, *Change booth* (a box with several booths) and *Sign out*: **Tab** moves between them, **Enter** presses, **Escape** closes. With a touchpad or mouse: click the name in the top corner or the dot in the bottom corner.
- **While the phone or password box has the keyboard, the red button does not spin.** (During a *Too many attempts* wait the boxes are greyed out and a press does spin — nothing can type into them then; the keyboard goes back to the password box once the wait is over.) The television shows *Staff are signing in — the wheel is back in a moment*; sign in, or press Close (or Escape), and the next press spins. After a refused sign-in the keyboard goes back to the password box, so the wheel stays held until you sign in or close the panel. The reason: the red button and the keyboard's space bar send the same key and nothing can tell them apart, so spinning on it would give a prize away — and print a voucher — whenever somebody typed a space in a password. A press while the *password* box has the keyboard types a space into it; if a guest pressed the button while you were typing, clear the password and type it again. (The PIN pad does not hold the wheel: the button spins while a PIN is being typed.)
- **The staff panel closes itself** 45 seconds after the last key or click in it, and **2 minutes after it opened** at the latest, whatever is typed. A press of the red button does not count, so guests pressing it cannot keep the panel — and the held wheel — on the screen. Signing in starts both times again for the signed-in panel.
- Keep the keyboard with staff: whoever can open the panel while somebody is signed in can reprint the last voucher (it is recorded, with who was signed in).
- Press the red button. The voucher prints: the prize (or its voucher type's own title and instruction, once the booth has been published with them), code and QR, booth, **Staff: name (code)**, expiry, the terms. If the printer does not answer, the television shows the code and QR instead, and the slip waits on the box. It is tried again with the box's heartbeat, **once a minute**, so it comes out within about a minute of the printer being back (measured on the bench: 14 s and 26 s) — but not while the Console's offline switch is on for this box: the retry resumes when the box is back online. After 20 tries — about 20 minutes — it is given up; the code on the screen stays valid either way. A slip still owed when the power goes prints after the restart.
- **Reprint**: staff signed in → panel → *Reprint last voucher*. Same code, marked "Reprint", recorded against the voucher; never a second prize.

## 7. Checking and fixing

- `oto-box status` — registered, which booth, printer, how much waits for the cloud.
- `journalctl -u oto-box -f` (the box) · `journalctl -u oto-kiosk -f` (the television) · `journalctl -t oto-box-watchdog` (restarts).
- Console → Devices → the box: online, last heartbeat, printer, running wheel version.
- **The box's folder, `/var/lib/oto-box`, is private to its service user**: listing or editing anything in it needs `sudo` (for example `sudo ls -l /var/lib/oto-box`).
- **Bench printer override**: `sudo nano /var/lib/oto-box/config.json`, write `{ "printer": { "host": "192.168.1.60", "port": 9100, "widthDots": 576 } }`, save, then `sudo systemctl restart oto-box`. Delete the file (`sudo rm /var/lib/oto-box/config.json`) and restart to go back to the Console's printer.
- **Picture upside down** (a television hung the other way round): `sudo nano /etc/oto-box/config`, set `OTO_KIOSK_ROTATE=ccw` (add the line if it is not there; `cw` is the default), save, then `sudo systemctl restart oto-kiosk`. The setting lives in `/etc/oto-box/config` rather than the box's folder because the television runs as the desktop user, which cannot read that folder.
- **Update**: copy the new tarball to the Pi and run the section 3 commands again with the **new file's name**, without `--api` (the configured api is kept). The credential, the store and `/etc/oto-box/config` are kept; the previous release stays in `/opt/oto-box/releases/` (to roll back: `sudo ln -sfn <previous> /opt/oto-box/current && sudo systemctl restart oto-box`).

## 8. Advice for a booth that stays up

- The official 27 W supply — under-powered Pis corrupt cards. A good A2 card, or better a USB SSD. Keep a **spare card imaged** from a working booth (without its credential — claim the spare with a new code).
- Fit the Pi 5's **RTC battery** so the clock is right before the network is.
- Printer and Pi on the **same router**, the printer on a **DHCP reservation**; cable the Pi where you can.
- **SSH keys only** (`install.sh --ssh-keys-only` once your key is on the Pi). The credential file stays 0600.
- Leave the **daily reboot** at a quiet hour on (default 04:30).

## 9. Not automated yet — be aware

- Nothing here has run on a Raspberry Pi yet (see the top of this page), and there is no ready-made SD image: the install script runs on stock Raspberry Pi OS.
- The booth's set-up — voucher types and their slip wording, booth staff and PINs, the session length — is done in the Console, not by an engineer, and has to be done before the bench test: [BOOTH_SETUP.md](BOOTH_SETUP.md) is the guide, and its last section says when each change reaches the box — staff and PINs at its next pull, the session length with a publish, and a voucher type's slip words as the wheel version the booth is running has them: a type's first title or instruction is on paper only once the booth is published with it, and until then its terms still follow the pull.
- The slip starts printing when the button is pressed — the box draws the prize at the press — so on a fast printer the paper can be out before the wheel stops.
- The Console's wheel preview still draws a switched-off prize (dimmed) and says the television does; the television no longer does.
- The red button is read as a keyboard key by the page, not by the box; if Chromium loses focus, a click on the screen brings it back.
- Network printers only (no USB); portrait television only (turned either way, section 7).
- Thai on the television comes from Google Fonts when the box can reach it, and from a copy of the same face inside the booth page when it cannot.
- One booth per box reports in the heartbeat: on a box with two booths, the Console shows the one the television chose.
- Codes printed while offline read "not synced yet" at a counter until the box reconnects.
