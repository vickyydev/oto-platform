# The Raspberry Pi booth box — set-up guide

One page for setting up a Lucky Wheel booth on a Raspberry Pi 5: the Pi runs the booth box (the draw, the voucher codes, the printer, the queue for the cloud) and shows the wheel on the television plugged into it. Codes are made on the Pi, so the booth keeps playing and printing when the mall's internet drops; everything catches up when it returns.

**Nothing in this kit has run on a Raspberry Pi yet.** The box program was run as a box on a bench laptop, against a local api, with a network printer stand-in; the install script and the system units were checked for syntax and in pieces. Your first install at the bench is their first real run: read what the installer prints, and keep the Pi on a keyboard and screen (or SSH) until the wheel is up.

## 1. On the desk

- Raspberry Pi 5 with the **official 27 W USB-C power supply**, a **good A2 microSD card** (32 GB or more) or a USB SSD, a micro-HDMI to HDMI cable.
- The Pi 5's **RTC battery** (the small battery that plugs into the Pi's BAT connector), so the Pi keeps the time through a power cut.
- The television, **hung portrait**. It still sends a landscape picture, and the page turns the picture clockwise to stand it upright. If your television is hung the other way round the picture comes out upside down: set `OTO_KIOSK_ROTATE=ccw` (section 7), or install with `--rotate ccw`. A landscape layout is not built.
- The red button (it must send **Space**; never Enter — Enter is the badge scanner's key and is refused).
- For staff: a **small wireless keyboard with a touchpad** (one USB receiver) covers everything — the claim code (it has letters), PINs, phone and password, and the staff panel. A number pad alone enters a PIN but only reaches Reprint and Sign out if it has a **Tab** key.
- The receipt printer: 80 mm ESC/POS **on a network cable**, port 9100. Print its self-test page: note its **IP address** and whether it is **576 or 512 dots** per line — a 512-dot printer needs one more step in the Console (section 7, "A 512-dot printer") — and send us its **model** (section 9 says why). USB-only printers are not supported yet.
- The router at the booth: the printer and the Pi on the same network. Give the printer a **fixed address (DHCP reservation)** on the router. The router must also let the Pi reach an internet **time server (NTP, UDP port 123)**: with the RTC battery, that is what keeps the Pi's clock right. Without them, a Pi that comes back from a power cut with its clock wrong still shows online and uses the platform's time once it has heard the platform (section 7, "The clock"); until then — normally the first minute after it starts, longer if the mall's internet is still down — its slips carry the Pi's own time. On the Pi, `timedatectl` says "System clock synchronized: yes" once time sync has set the clock.
- **Your printer is an Epson TM-T82IV (label TM-T82IV-412, the box marked ETH — the Ethernet model; confirm the RJ45 socket on its back when you unpack it).** What that means for the booth: 80 mm paper, ESC/POS, 203 dpi, so **576 dots** across — the box's default, nothing to set; it answers the box's status questions, so paper-out and cover-open reach the television. Connect it to the booth router with a network cable and give it a reservation there. To learn its address: switch it off, hold the FEED button, switch it on and keep holding until it prints its self-test — the network settings are on that page (Epson's factory address is 192.168.192.168 with DHCP on; the page shows what it has now). Port 9100 is open by default. In the Console the printer's Model can read "Epson TM-T82IV" and the Protocol ESC/POS; both are notes, the box prints the same either way.

## 2. Write the card

In Raspberry Pi Imager choose the device **Raspberry Pi 5**, then **Raspberry Pi OS (other)** → **Raspberry Pi OS (Legacy, 64-bit)** — the one Imager describes as "A port of Debian Bookworm with security updates and desktop environment".

- **Not the first entry in the list.** Imager's first choice, **Raspberry Pi OS (64-bit)**, is Debian 13 "Trixie". The installer is written for Debian 12 "Bookworm" and warns on anything else. (Those are the names in Imager's list in September 2026. Imager downloads its list, so the names can change; whatever the entry is called, its description must say Bookworm and desktop.)
- **Not Lite.** The television is a web browser on the Pi's desktop; the *Lite* images have no desktop, and the screen would stay on a text console. (*Raspberry Pi OS (Legacy, 64-bit) Full* works too; it only adds applications the booth does not use.)

In Imager's settings: a username and password, Wi-Fi if not cabled, **SSH with a public key** (not a password), timezone Asia/Bangkok. Write, insert, boot, and let the desktop come up once.

## 3. Install the box

The release is one file, `oto-box-0.1.0-<commit>.tgz`, which **we send you together with its SHA-256 checksum** (64 letters and digits); you do not build it yourself. Copy the file to the Pi's home folder (USB stick or `scp`). Below, `oto-box-0.1.0-abc1234.tgz` stands for it: type **the name of the file you received** instead. First check it:

```
cd ~
sha256sum oto-box-0.1.0-abc1234.tgz
```

The checksum it prints must be exactly the one we sent. If it is not, the file was damaged on the way or is not the one we sent: do not install it, and ask us for it again. If it is:

```
rm -rf oto-box
tar -xzf oto-box-0.1.0-abc1234.tgz
sudo bash oto-box/pi/install.sh --api https://oto-api-staging.onrender.com
```

Name the file rather than writing `oto-box-*.tgz`: once an old and a new release sit in the same folder, the wildcard names both and `tar` fails. `rm -rf oto-box` clears the folder the last release unpacked into, so nothing of it is left mixed into the new one.

The installer puts in: Node 22 (checked against nodejs.org's checksums), a service user `oto-box`, the box (`oto-box.service`, restarted whenever it stops), a watchdog that restarts it if its page stops answering — or if systemd gave up on it after repeated crashes — the television (`oto-kiosk.service`: Chromium full screen on `http://127.0.0.1:8780/`, restarted if it closes), desktop auto-login, no screen blanking, network time, a journal kept across reboots (`journalctl --list-boots` shows the earlier boots), and a daily reboot at 04:30. It refuses a 32-bit system — a card written with the wrong image (section 2) — before it installs anything. Options: `--rotate ccw` (section 1), `--no-daily-reboot`, `--ssh-keys-only` (section 8); `sudo bash oto-box/pi/install.sh --help` lists them. It prints the next steps when it finishes, and whether SSH password log-in is still on.

## 4. Claim the box

1. Console → **Devices** → **Add a box**: a **Name** (e.g. "Bench box"), a **Slot** — where the box stands, e.g. `booth-1` — and the role **Booth**. **Add the box** stays greyed out until the name and the slot are both filled in. Copy the claim code — it is valid for a short time and only once.
2. On the television: **Set up this box** → type the code → Claim. Or on the Pi: `sudo oto-box claim`, and type the code at its prompt — it is asked for rather than typed on the command line, so it is not left in the shell's history. The running service notices within a few seconds and restarts itself to use it.

The box writes its credential to `/var/lib/oto-box/credential.json` (owner-only, 0600). Never copy it to another Pi; a replacement Pi is claimed with a new code.

After the first install, **reboot once** (`sudo reboot`): the desktop logs in by itself and the television opens the booth, as it will on every boot.

## 5. Printer, booth, staff, wheel — in the Console

1. **Printer**: Devices → the box → **Add a device**: What it is **Receipt printer**, a **Label** (e.g. "Booth printer"), How the box reaches it **LAN**, Address the printer's `IP:9100`. Model and Protocol can stay empty. **Add it**.
2. **Booth**: Devices → **New station**:
   - **Box**: this box.
   - **Name** (e.g. "Booth 2"), Kind **Booth**, and a **Code prefix** of exactly two capital letters or digits that no other station at the park uses, e.g. `B2`. Every voucher code the booth prints starts with it, and the Console does not save a booth without one.
   - **Receipt printer**: the printer from step 1.
   - **How money reaches it**: leave it as it is; a booth takes no money.
   - **Who may use it**: **Only the people I name**, with nobody named. This list is who sees the booth in the POS's station picker, not who works at the booth (that is step 4); left on "All staff at this branch", the booth shows up in the station picker of everybody at the park.
   - **Create the station**. Until this is done, the television says "No booth on this box yet".

   A box can run more than one booth; the television then asks which one it is, once, and remembers. Adding a second booth to a box whose television already shows a wheel brings that question up too: the wheel is off the screen until somebody picks.
3. **Booth settings**: Booths → the booth → **Booth settings**: a **Layout** (e.g. "Classic wheel (v1)") and the staff session length → **Save settings**. A new booth has no layout, and a publish is refused until it has one ("This booth has no wheel design").
4. **Staff and PINs**: Booths → the booth → **Booth staff** — add the people who work the booth and set each one's PIN there (the steps are in [BOOTH_SETUP.md](BOOTH_SETUP.md), section 3). Before your own test, **add yourself and set your own PIN** — otherwise a phone-and-password sign-in at the booth answers "You are not on this booth's staff list", and there is no PIN to fall back on. The roles that may sign in at a booth are staff, reception, branch manager and both administrator roles. What each prize is worth and what its slip says are set up under **Voucher types** — BOOTH_SETUP.md walks through all of it, in order, before the publish below.
5. **Wheel**: Booths → the booth → **Add prize** for each prize (a new booth has none): its name, its **Chance**, and its **Voucher** — the voucher type it prints. The chances of the prizes on the wheel must add up to exactly 100 %. A prize switched off is not on the wheel. Then **Review and publish** → **Publish version 1**. The box picks up a publish within about a minute. (The Booths page's **Screens** section pairs the staging website as a booth's television. The Pi's own television needs no pairing: for a booth on its own box the section says "This booth runs on its own box; its television needs no pairing.")

**Until the booth's first publish the television has no wheel to show.** While the box is online it says "This booth is being set up — please ask our staff", with a note for staff under it, "No wheel published for this booth yet", that says to publish it in Console → Booths. With no internet it says "Booth not set up, connect to internet". The wheel appears by itself within about two minutes of the publish.

## 6. At the booth

- The Pi boots straight into the wheel. The television is up within seconds of the box starting, with or without internet — even when the line is up but the cloud does not answer: the box plays the wheel it holds, gives up on any call to the cloud that has not begun to answer within 15 seconds, and keeps trying in the background.
- The staff panel opens: sign in with a **PIN** (checked on the box, works offline) or with **phone and password** (checked by the cloud — only if the person is on the booth's list and their role allows booth sign-in). What the panel can answer besides "Signed in":
  - *No internet — sign in with your PIN*: the cloud could not be reached, or did not answer within 5 seconds.
  - *You are not on this booth's staff list* / *Your role cannot sign in at a booth* / *Change your temporary password on the POS first*.
  - *This box is no longer allowed here*: the cloud refused the box's own credential. Nothing in the Console does that to a box that is already claimed, so tell us if you see it. The box notices by itself within a minute: it lets go of the refused credential, and the television goes back to "Set up this box". A new claim code comes only with a new box in the Console (Devices → Add a box); type it on the television, then move the booth to the new box (section 7, "A damaged store", steps 4 and 5).
  - *This booth is not on this box any more*: the booth was moved to another box or archived in the Console.
- A sign-in lasts the booth's **staff session length** — 12 hours unless one is set under Booths → the booth → Booth settings (BOOTH_SETUP.md, section 4) — and is not ended by inactivity. A new length reaches the box with the next publish; a sign-in already running keeps the length it started with. The top corner shows who is signed in (name and staff code). With nobody signed in the wheel **still plays** — the button reads *Staff: sign in for your name on the slip* — and those spins are recorded *unattributed*.
- **Staff panel from the keyboard**: type any digit. Signed out, that digit is the first of the PIN. Signed in, the panel opens on *Reprint last voucher*, *Change booth* (a box with several booths) and *Sign out*: **Tab** moves between them, **Enter** presses, **Escape** closes. With a touchpad or mouse: click the name in the top corner or the dot in the bottom corner.
- **While the phone or password box has the keyboard, the red button does not spin.** (During a *Too many attempts* wait the boxes are greyed out and a press does spin — nothing can type into them then; the keyboard goes back to the password box once the wait is over.) The television shows *Staff are signing in — the wheel is back in a moment*; sign in, or press Close (or Escape), and the next press spins. After a refused sign-in the keyboard goes back to the password box, so the wheel stays held until you sign in or close the panel. The reason: the red button and the keyboard's space bar send the same key and nothing can tell them apart, so spinning on it would give a prize away — and print a voucher — whenever somebody typed a space in a password. A press while the *password* box has the keyboard types a space into it; if a guest pressed the button while you were typing, clear the password and type it again. (The PIN pad does not hold the wheel: the button spins while a PIN is being typed.)
- **The staff panel closes itself** 45 seconds after the last key or click in it, and **2 minutes after it opened** at the latest, whatever is typed. A press of the red button does not count, so guests pressing it cannot keep the panel — and the held wheel — on the screen. Signing in starts both times again for the signed-in panel.
- Keep the keyboard with staff: whoever can open the panel while somebody is signed in can reprint the last voucher (it is recorded, with who was signed in).
- Press the red button. The voucher prints: the prize (or its voucher type's own title and instruction, once the booth has been published with them), code and QR, booth, **Staff: name (code)**, expiry, the terms. If the slip has not printed within 3 seconds — the printer is off, out of paper or slow to answer — the television shows the code and QR instead. That holds for a printer that answers the box's status questions; one that does not is taken to have printed, even out of paper (section 9). A slow printer still prints the slip a moment later; one that is off or cannot be reached leaves it waiting on the box. It is tried again with the box's heartbeat, **once a minute**, so it comes out within about a minute of the printer being back (measured on the bench: 14 s and 26 s) — but not while the Console's offline switch is on for this box: the retry resumes when the box is back online. After 20 tries — about 20 minutes — it is given up; the code on the screen stays valid either way. A slip cut off part-way is not printed again by itself: a signed-in member of staff can print it again with *Reprint last voucher* while it is still the booth's last. A slip still owed when the power goes prints after the restart. So a late slip can come out long after the family has gone, into a tray nobody is watching: it is the same voucher as the code the television showed, not a second one, and whichever of the two is shown first at the counter uses it up.
- **Reprint**: staff signed in → panel → *Reprint last voucher*. Same code, marked "Reprint", recorded against the voucher; never a second prize.
- **The dot in the bottom corner** is green while the box is online and orange while it is not. While it is orange, the number beside it is how many records wait for the cloud — about three for each spin (the spin, its voucher and whether it printed) — not how many vouchers. They are sent by themselves within a minute of the internet coming back.

## 7. Checking and fixing

- `oto-box status` — registered, which api (the configured one until the box is claimed), which booth, printer, how much waits for the cloud.
- `journalctl -u oto-box -f` (the box) · `journalctl -u oto-kiosk -f` (the television) · `journalctl -t oto-box-watchdog` (restarts). The journal is kept across reboots: `journalctl -u oto-box -b -1` is the boot before this one, and `journalctl --list-boots` lists them.
- Console → Devices → the box: online, last heartbeat, printer, running wheel version.
- **The clock.** On every heartbeat the box measures its clock against the platform's, and it stamps and prints the platform's time. The Pi's own clock is left as it is: `date`, `timedatectl` and the journal still show the Pi's time. A Pi that comes back from a power cut with its clock wrong — no RTC battery, a network that blocks time sync — is shown online within about a minute of the platform first hearing from it, whether its clock is ahead or behind, and its slips, spins and trading day use the platform's time from that first answer on. Console → Devices → the box → **Clock** says how far the Pi's own clock is out: "Clock in step with the platform", or for example "Clock 12 h behind the platform (measured 3 min ago)", in amber past ten minutes; spins pressed while it is that far out are marked as taken with a doubtful clock. After a reboot, until the box has heard the platform, it has only the Pi's own clock: its slips carry that time, and what it records is dated by when the platform receives it — which is why the RTC battery and NTP (section 1) still matter.
- Console → Booths → the booth → **What this booth is running**: **Spins today** counts the park's trading day, which starts at 05:00, not at midnight. A spin at 01:00 on 26 September counts under 25 September, while its slip is dated 26 September.
- **The box's folder, `/var/lib/oto-box`, is private to its service user**: listing or editing anything in it needs `sudo` (for example `sudo ls -l /var/lib/oto-box`).
- **Bench printer override**: `sudo nano /var/lib/oto-box/config.json`, write `{ "printer": { "host": "192.168.1.60", "port": 9100, "widthDots": 576 } }`, save, then `sudo systemctl restart oto-box`. Delete the file (`sudo rm /var/lib/oto-box/config.json`) and restart to go back to the Console's printer. The override changes the address and the width of the receipt printer the Console gave the booth (section 5); it does not stand in for it. A booth with no receipt printer in the Console still has none, and the box log says "config.json names a printer, but this booth has no receipt printer in the Console to point at it — add one to this box first".
- **A 512-dot printer** (its self-test page says so) is set in the Console → Devices → the box → the printer → **Edit** → **Paper width**, which the box takes on its next poll; without it the right-hand 8 mm of every slip is lost.
- **Picture upside down** (a television hung the other way round): `sudo nano /etc/oto-box/config`, set `OTO_KIOSK_ROTATE=ccw` (add the line if it is not there; `cw` is the default), save, then `sudo systemctl restart oto-kiosk`. The setting lives in `/etc/oto-box/config` rather than the box's folder because the television runs as the desktop user, which cannot read that folder.
- **Update**: we send you the new release with its checksum. Check it as in section 3, then run the section 3 commands again with the **new file's name**, without `--api` (the configured api is kept). The credential, the store and `/etc/oto-box/config` are kept; the previous release stays in `/opt/oto-box/releases/` (to roll back: `sudo ln -sfn <previous> /opt/oto-box/current && sudo systemctl restart oto-box`).
- **A damaged store.** Rare — a card that lost data it had reported saved, after a power cut or because the card is failing — and restarting does not cure it. The television shows Chromium's own "This site can't be reached" page (turned sideways) instead of the wheel; the Console shows the box offline; `oto-box status` says `outbox (the store could not be read)`; and `journalctl -u oto-box` repeats "The box could not start: …". To bring the booth back:
  1. Console → Devices → **Add a box**: a new name and a new slot (the damaged box keeps its own), role Booth. Copy the claim code.
  2. On the Pi: `sudo oto-box claim --force`, and type the new code at the prompt. It sets the damaged store and the old credential aside in `/var/lib/oto-box` (their names end in `.replaced-` and the date and time) and registers the Pi as the new box. The service picks the new credential up by itself within about a minute.
  3. `sudo systemctl restart oto-kiosk`: the television opens the booth page again, and once the box runs as the new box it says "No booth on this box yet".
  4. Console → Devices → the new box → **Add a device**: the receipt printer again, at the same address (section 5, step 1).
  5. Console → Devices → the booth's station → **Box**: the new box; **Receipt printer**: the printer from step 4 → **Save the station**. The booth keeps its wheel, its staff and their PINs, and the television shows the wheel within about two minutes. The damaged box stays in the list, offline.

  **What is lost**: whatever the box had not yet sent to the cloud — in particular any voucher printed while it was offline — stays in the set-aside file. Those slips answer "Code not found — the booth may not have synced yet" at the counter until an engineer recovers them from that file, so **do not delete the `.replaced-` files**, and tell us. Staff sign in again.

## 8. Advice for a booth that stays up

- The official 27 W supply — under-powered Pis corrupt cards. A good A2 card, or better a USB SSD. Keep a **spare card imaged** from a working booth (without its credential — claim the spare with a new code: a new box in the Console, with the booth moved to it, as in section 7, "A damaged store", steps 1, 4 and 5).
- Fit the Pi 5's **RTC battery** (section 1) so the clock is right before the network is.
- Printer and Pi on the **same router**, the printer on a **DHCP reservation**; cable the Pi where you can.
- **SSH keys only**: the installer leaves password log-in on and says so at the end of its run. Once your public key is in `~/.ssh/authorized_keys` on the Pi, run it again with `--ssh-keys-only`; it refuses to switch password log-in off while no key is there. The credential file stays 0600.
- Leave the **daily reboot** at a quiet hour on (default 04:30).

## 9. Not automated yet — be aware

- Nothing here has run on a Raspberry Pi yet (see the top of this page), and there is no ready-made SD image: the install script runs on stock Raspberry Pi OS.
- The booth's set-up — voucher types and their slip wording, booth staff and PINs, the session length — is done in the Console, not by an engineer, and has to be done before the bench test: [BOOTH_SETUP.md](BOOTH_SETUP.md) is the guide, and its last section says when each change reaches the box — staff and PINs at its next pull, the session length with a publish, and a voucher type's slip words as the wheel version the booth is running has them: a type's first title or instruction is on paper only once the booth is published with it, and until then its terms still follow the pull.
- The slip starts printing when the button is pressed — the box draws the prize at the press — so on a fast printer the paper can be out before the wheel stops.
- The red button is read as a keyboard key by the page, not by the box; if Chromium loses focus, a click on the screen brings it back.
- Network printers only (no USB); portrait television only (turned either way, section 7).
- **Some network printers do not answer the box's status questions.** Such a printer still prints, but the box cannot see that it is out of paper: the television then tells the family to take a voucher that did not come out, and shows no code. A signed-in member of staff can print the last voucher again once there is paper (*Reprint last voucher*). The printer's model tells us which kind yours is.
- Thai on the television is drawn with a copy of the face built into the booth page, so the page never waits for the internet to show it; once the page is up it also asks Google Fonts for the same face, and uses that when it answers.
- The Thai on the television — under the wheel, on the result card, in the notices — has not been checked by a Thai speaker yet. On the slip, the title, the instruction and the terms are your own words from the voucher types.
- One booth per box reports in the heartbeat: on a box with two booths, the Console shows the one the television chose.
- The Pi has not been started with the television switched off (the 04:30 reboot with the television off for the night, for example). If the picture is wrong once the television is on, reboot the Pi with the television on (`sudo reboot`).
- **Codes printed while the booth is offline** read "Code not found — the booth may not have synced yet" at a counter until the box is back online and has sent them — usually within a minute of the internet coming back. At the counter, **press Redeem once**, and again only once the booth's dot is green: every try on such a code counts as a wrong code, and five wrong codes inside a minute lock voucher redemption at that till for 10 minutes — for every family, not only this one — and put "Somebody may be guessing codes" in the Console's Health. Another till still works. [COUNTER_VOUCHERS.md](COUNTER_VOUCHERS.md) is the counter's side.
