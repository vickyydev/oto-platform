# Box quickstart — the park, the Mac, and nothing else

The short card for setting a booth box up away from home. Every step is a command or a
click; the long explanations live in [PI_BOOTH.md](PI_BOOTH.md) and
[BOOTH_SETUP.md](BOOTH_SETUP.md). Bring: the Pi with its 27 W supply, the imaged card or
stick, micro-HDMI cable, the wireless keyboard, the printer with one network cable, the
red button, the MacBook, and the newest release file handed to you, already saved on the
Mac. Its name says which build it is — version, build date, commit:
`oto-box-0.1.0-20261029-b25b644.tgz` stands for it below; type the name of your file.

## A. New Wi-Fi, same Pi — no re-imaging, two minutes

The Wi-Fi typed into Imager is just a saved connection; add the park's beside it.

The wheel auto-opens over the desktop — you do not need the desktop. The Pi keeps text
consoles behind the picture, and the game cannot swallow the switch:

1. Plug the Pi into the TV, keyboard receiver in, power on. Let the wheel appear.
2. Press **Ctrl+Alt+F2**: a black console replaces the wheel. Log in (`oto`, your
   password) and run:

   ```
   sudo nmcli device wifi connect "PARK-WIFI-NAME" password "PARK-WIFI-PASSWORD"
   hostname -I
   ```

   Note the first address `hostname -I` prints.
3. Press **Ctrl+Alt+F1** to get the wheel back (F7 on some setups).
4. From the Mac (same Wi-Fi): `ssh oto@<that address>`.

If you really want the desktop itself: in the F2 console, `sudo systemctl stop
oto-kiosk` shows it (network icon top right), and `sudo systemctl start oto-kiosk`
brings the wheel back. The box keeps selling nothing meanwhile — stopping the kiosk
only hides the picture, it does not stop the box.

**Before leaving, the zero-effort route:** while the Pi is still on the old Wi-Fi, add
the destination's Wi-Fi in advance over SSH — it joins by itself on arrival:

```
sudo nmcli connection add type wifi ifname wlan0 con-name park ssid "PARK-WIFI-NAME" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "PARK-WIFI-PASSWORD"
```

**No keyboard or screen at all?** Rename your phone's hotspot to EXACTLY the old
Wi-Fi's name with the same password: the Pi joins it by itself, believing it is home.
Put the Mac on the same hotspot, SSH in, add the real Wi-Fi with the nmcli line, switch
the hotspot off. (iPhone: the hotspot's name is the device name under Settings →
General → About → Name; switch on Maximize Compatibility. Android: name and password
are set directly on the hotspot screen.)

**Do not** cable the Pi to a router to get internet: its Ethernet socket is reserved
for the printer, with a fixed address and no internet route, so the cable gets nothing
and confuses the printer link.

**Make the new Wi-Fi stick.** A network joined once should come back by itself on
every boot. If it does not:

```
sudo nmcli connection up "WIFI-NAME"
sudo nmcli connection modify "WIFI-NAME" connection.autoconnect yes connection.autoconnect-priority 20
sudo reboot
```

If `connection up` complains about secrets, the saved profile has no password — give
it one and retry:

```
sudo nmcli connection modify "WIFI-NAME" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "THE-PASSWORD"
```

Worth knowing: after a few failed attempts (usually a wrong or missing password) the
Pi quietly stops auto-trying that network until someone activates it by hand or
reboots. One successful `connection up` clears the block. Old networks can stay
saved — priority decides who wins, so the box connects at the park and at home with
no hands either way.

## A2. Keep the box awake — run once on every new box

The park test found three power-saving defaults that make a booth look broken: the
button and mouse die after idle, and the box vanishes from the network. Until the
installer sets these itself, run this block once over SSH on every new box, in this
order (the last step drops SSH for a few seconds; it comes back):

```
for f in /sys/bus/usb/devices/*/power/control; do echo on | sudo tee "$f"; done
grep -q usbcore.autosuspend /boot/firmware/cmdline.txt || sudo sed -i '1 s/$/ usbcore.autosuspend=-1/' /boot/firmware/cmdline.txt
sudo raspi-config nonint do_blanking 1
printf '[connection]\nwifi.powersave = 2\n' | sudo tee /etc/NetworkManager/conf.d/wifi-powersave.conf
sudo systemctl restart NetworkManager
sudo reboot
```

After the reboot, two checks: `iw dev wlan0 get power_save` says off, and the box
still answers SSH after twenty untouched minutes. One thing no command reaches: the
TV's own eco or auto-off timer, switched off once in the TV's own settings menu with
its remote.

## B. The printer — nothing to set, ever

With `--printer-direct`, the printer is not on any Wi-Fi or router: it hangs on its own
cable straight into the Pi, and the Pi itself hands it the address
**192.168.192.168 — the same at home, at the park, everywhere**. Cable in, printer on,
and in the Console it is always `192.168.192.168:9100`. To check from the Pi:
`ping -c 3 192.168.192.168`.

## C. A brand-new box, from nothing

Skip to C4 if the card is already imaged; skip this whole part if it is the same Pi
already claimed — then only part A applies.

1. **Image** (Mac, ~10 min): Raspberry Pi Imager → Raspberry Pi 5 →
   Raspberry Pi OS (other) → **Raspberry Pi OS (Legacy, 64-bit)** ("Bookworm … desktop")
   → the card or USB stick → Next → Edit Settings:
   hostname `booth` · user `oto` + password · the Wi-Fi you will have there ·
   locale `Asia/Bangkok`, keyboard `us` · Services: SSH, public-key only, paste the line
   from `cat ~/.ssh/id_ed25519.pub` (make one first with `ssh-keygen -t ed25519` if
   missing). Write.
2. **Boot**: card in (or stick in a blue USB port, card slot empty), HDMI, keyboard
   receiver, power last. Wait for the desktop; first boot restarts once.
3. **Wi-Fi wrong or changed?** Part A.
4. **Copy the release** (Mac, same Wi-Fi; `<ip>` from part A step 3):

   ```
   cd ~/Downloads
   shasum -a 256 oto-box-0.1.0-20261029-b25b644.tgz     # must match the checksum sent with it
   scp oto-box-0.1.0-20261029-b25b644.tgz oto@<ip>:~/
   ```

5. **Install** (in the SSH window; ~5 min):

   ```
   ssh oto@<ip>
   cd ~
   sha256sum oto-box-0.1.0-20261029-b25b644.tgz
   rm -rf oto-box
   tar -xzf oto-box-0.1.0-20261029-b25b644.tgz
   sudo bash oto-box/pi/install.sh --api https://oto-api-staging.onrender.com --printer-direct
   ```

   Afterwards `oto-box status` names the build installed (`oto-box 0.1.0 build 2026-10-29
   b25b644 (…)`), and Console → Devices shows the same id as the box's agent version.
   Every update after this one is part G: one command from the laptop, no trip to the
   box — once the box is on the private network (part F).

6. **Claim**: Mac browser → `https://oto-console-staging.onrender.com` → Devices →
   **Add a box** (name, slot e.g. `booth-1`, role **Booth**) → copy the code (one-time,
   short-lived). On the Pi's screen: **Set up this box** → code → Claim.
   Then in SSH: `sudo reboot`. The TV opens the booth by itself.
7. **Printer**: paper in, network cable from printer straight into the Pi's Ethernet
   socket. Self-test page: printer off → hold FEED → on, keep holding. Page shows
   192.168.192.168. `ping -c 3 192.168.192.168` from SSH answers.

## D. Console setup (Mac browser, once per booth)

In this order — details per screen in [BOOTH_SETUP.md](BOOTH_SETUP.md):

1. Devices → the box → **Add a device**: Receipt printer · a label · LAN ·
   `192.168.192.168:9100` → Add.
2. Devices → **New station**: this box · a name · Kind **Booth** · Code prefix two
   capitals/digits nobody uses (e.g. `P1`) · the printer from step 1 ·
   Who may use it: **Only the people I name**, nobody named → Create.
3. Booths → the booth → **Booth settings**: Layout "Classic wheel (v1)" → Save.
4. Booths → the booth → **Today's staff**: add yourself for today if the rota does not
   name you (your name prints on the slip; nobody signs in at the booth).
5. Voucher types first, then **Add prize** per prize until chances total exactly 100%.
6. **Review and publish** → Publish. The TV shows the wheel within a minute.

## E. Play

Red button into a black USB port (it sends Space; nothing to set). Nobody signs in:
press the button, the slip prints with today's staff in its Staff row. No slip within 3 seconds → the
code and QR show on the TV, and the slip follows once the printer answers. Redeem the
slip at a till per [COUNTER_VOUCHERS.md](COUNTER_VOUCHERS.md).

## F. Remote access — the private network (Tailscale)

A box on the private network is reached from the laptop by name, from anywhere —
`ssh oto@oto-till`, `ssh oto@oto-booth` — and a release is pushed to it with one
command (part G). The counter box is on it already (`oto-till`, 100.89.6.16); the
booth is not yet. The laptop itself has to be on the network too (the Tailscale app,
signed in to the same account).

**One reusable key for every box, made once** (the Tailscale admin console, in the
browser):

1. **Access controls** → the policy file. Add a tag for the boxes and an SSH rule that
   lets your own devices in with no periodic re-check (`action` is `accept`, not
   `check`):

   ```
   "tagOwners": { "tag:oto-box": ["autogroup:admin"] },
   "ssh": [
     { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:oto-box"], "users": ["oto", "root"] }
   ]
   ```

   Leave the rules already there in place. If the `acls` list at the top is no longer
   the allow-all default, add
   `{ "action": "accept", "src": ["autogroup:member"], "dst": ["tag:oto-box:22"] }` to
   it as well.
2. **Settings → Keys → Generate auth key**: a description (`oto boxes`), **Reusable**
   on, **Expiration** the longest offered (90 days — that is the key's own life, after
   which a new one is made the same way; a box already joined is not affected),
   **Ephemeral** off, **Pre-approved** on if it is shown, **Tags**: `tag:oto-box`.
   Generate, copy — it is shown once.
3. On the laptop, put it in the repo-root `.env` (a file git never commits):

   ```
   TAILSCALE_AUTHKEY=tskey-auth-…
   ```

   Nowhere else: not in the repository, not in a ticket, not in a message. The
   installer and `push-release.sh` never print it.

A box joined with a tagged key has no key expiry of its own: it stays on the network
until it is removed in the admin console (**Machines** → the box → Remove).

**Join an existing box, once.** Run the installer again with the key. The quickest way
is part G's command with the key added, over the box's local address while the laptop
is on the same Wi-Fi (the key the box was imaged with, part C step 1, is the one that
opens it):

```
PUSH_RELEASE_KEY=~/.ssh/id_ed25519 scripts/agent/push-release.sh <ip> ~/Downloads/oto-box-0.1.0-20261029-b25b644.tgz -- --api https://oto-api-staging.onrender.com --printer-direct --tailscale-hostname oto-booth --tailscale-authkey "$(sed -n 's/^TAILSCALE_AUTHKEY=//p' .env)"
```

The installer puts Tailscale in from its own package repository, joins with Tailscale
SSH on, and its summary ends `Tailscale: joined as oto-booth (100.x.y.z)`. Or by hand
at the box (the Ctrl+Alt+F2 console, or an SSH window), two commands:

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname oto-booth --auth-key tskey-auth-…
```

The counter box (`oto-till`) was joined by hand under your own login, so its key
expires one day unless told otherwise: in the admin console, **Machines** →
`oto-till` → **Edit ACL tags** → `tag:oto-box`. A tagged machine's key expiry is off,
and the SSH rule above then covers it. Nothing to run on the box.

**Check**: on the box, `tailscale status` and `tailscale ip -4`; from the laptop,
`ssh oto@oto-booth hostname`.

## G. Update the box — one command from the laptop, from anywhere

The release file and its checksum come as a pair, `oto-box-….tgz` and
`oto-box-….tgz.sha256`: CI's **Pi release** artifact on the run of the commit holds
both, and `pnpm --filter @oto/box-agent pack:pi` on the laptop writes both into
`packages/box-agent/dist/`. Keep them side by side under their own names: the push
refuses to run without the checksum, and refuses a file renamed away from it.

In Git Bash (Windows) or a Mac terminal, from the repository folder:

```
# the counter box before its customer display is in (no screen; printer on the Pi's own cable)
scripts/agent/push-release.sh oto-till ~/Downloads/oto-box-0.1.0-20261102-abc1234.tgz -- --no-kiosk --printer-direct

# the counter box with its customer display (part I; printer on the Pi's own cable)
scripts/agent/push-release.sh oto-till ~/Downloads/oto-box-0.1.0-20261102-abc1234.tgz -- --printer-direct --kiosk-url "https://oto-pos-staging.onrender.com/display?keyboard=screen" --kiosk-scale 1.25 --rotate off

# the booth box (television; printer on the Pi's own cable)
scripts/agent/push-release.sh oto-booth ~/Downloads/oto-box-0.1.0-20261102-abc1234.tgz -- --printer-direct
```

The flags after `--` are the installer's — the same ones each box was first installed
with; `--api` may be left out on an update, the box keeps the api it has. It prints
the build line before, copies the pair, checks the checksum on the box, unpacks, runs
the installer (its output scrolls by as it would on the box) and prints the build line
after. Any failure stops it with a non-zero exit, and the box keeps what it ran before
unless the installer had already reached "Starting" — then the new build is in, and
`oto-box status` says which. `--dry-run` (before the `--`) prints the commands and
runs none of them.

The SSH key: `~/.ssh/oto_till_ed25519` when that file exists, else
`PUSH_RELEASE_KEY=<path>` in front of the command (or in `.env`). A box on the private
network with part F's SSH rule needs no key at all.

**By hand instead** (a box not on the private network, or no laptop with the script):
part C steps 4 and 5 with the new file's name, from a machine on the box's Wi-Fi;
`--api` may be left out. The previous release stays in `/opt/oto-box/releases/` for a
rollback (PI_BOOTH.md §7, "Update").

## H. The counter scanner — into the box

The Zebra cradle (DS2278 on its CR2278 cradle) plugs into the **counter box**, not the
iPad: the box reads it itself and the till, the customer display and the gate on that
station hear every scan, online or offline. It needs a box release built after SCRUM-700
landed (part G): the agent in it reads the scanner, and its installer writes the
scanner's udev rule.

1. **Cradle in**: its USB cable into a black USB port on the Pi.
2. **Pick the mode.** Either works; the second reads cleaner.
   - **USB keyboard (HID)** — the cradle as it ships. Nothing to scan. It must still
     end every code with Enter (the factory setting).
   - **USB serial (CDC)** — scan the **USB CDC Host** bar code in the Zebra guide
     (DS2278 Product Reference Guide, chapter 8, "USB Device Type") once; the scanner
     beeps and restarts. **USB Keyboard (HID)** in the same list switches it back.
     On a counter box with no television this is the one to use: in HID mode the box's
     own text console hears the keystrokes too (they land at a login prompt nobody
     sees; harmless, but noise).
3. **Console** → Devices → the counter box → **Add a device**: What it is **Scanner** ·
   a label (`Counter scanner`) · **How the box reads it**: the mode from step 2 (it
   sets how the box reaches it: USB for HID, Serial for CDC) · leave the USB ids and
   the path empty (they mean the Zebra cradle: `05e0:1200` in HID, `05e0:1701` in
   CDC) → Add it.
4. Devices → the till's station → **Scanner**: the device from step 3 → Save.
5. **Check**, within a minute: under the scanner row, **Reading /dev/input/event…**
   (HID) or **Reading /dev/ttyACM0** (CDC). Scan a band or a voucher: the row says
   "last scan just now" and the till shows it.

If the row says instead:

- **Not plugged into this box** — the cable is not in the box, or the row's mode is
  not the scanner's (a cradle in CDC is `05e0:1701`, in HID `05e0:1200`). On the box,
  `lsusb | grep 05e0` shows which it is; change the row's mode, or scan the other bar
  code.
- **Plugged in … but not open** — the box's user may not read the scanner's node. On
  the box, `ls -l` on the node the row names (`/dev/input/event…` in HID,
  `/dev/ttyACM…` in CDC) should show the group `oto-box`. If it shows `input` or
  `dialout`, the scanner rule is missing or another rule took the node back: install
  the current box release (part G), whose installer rewrites the rule, then unplug the
  cradle and plug it back in once. `sudo udevadm test /sys/class/input/event… 2>&1 |
  grep -i group` shows which rule set the group. Do not add the box's user to the
  `input` group: that group reads every keyboard on the box, not just the cradle.
- **partial scans dropped** — HID mode with no Enter at the end of a code: scan "Add
  Enter Key" in the Zebra guide (Miscellaneous Scanner Parameters), or use CDC.
- A television on the box **types the code** — the cradle was plugged in before the
  rule existed: unplug it and plug it back in once.

On the box: `journalctl -u oto-box | grep -i scanner` shows when it opened the scanner,
lost it and found it again; each scan logs its fingerprint, never the code.

**The fallback — the iPad wedge.** If the box cannot read the cradle, plug the cradle
into the iPad running the till (USB-C) instead, set the iPad's keyboard to **English
(US)**, and scan with no text field selected: the till reads it as a keyboard, as it
always has. The scanner row then says "Not plugged into this box", which is expected
while the cradle is on the iPad.

## I. The counter's customer display

The Edatec 15.6-inch touch monitor stands at the counter, landscape, facing the family.
The counter box drives it and the iPad stays the till: the box opens the POS's display
page in Chromium, full screen, on that monitor. The addresses below are staging's.

**Cables**, power last:

1. **Picture**: micro-HDMI from the Pi to the monitor's HDMI.
2. **Touch**: the monitor's USB-C touch port to a USB port on the Pi, with a **data**
   cable. A charge-only cable gives a picture that does not answer touch.
3. **Power**: the monitor's own 12 V adapter. Never power it from the Pi.

**Install** on the box, the file as in part C steps 4 and 5 (or part G's command, which
runs the same thing from the laptop):

```
sudo bash oto-box/pi/install.sh --api https://oto-api-staging.onrender.com --printer-direct --kiosk-url "https://oto-pos-staging.onrender.com/display?keyboard=screen" --kiosk-scale 1.25 --rotate off
```

Keep the quotes around the address. `--no-kiosk` is gone from this box's options from
here on, and the box needs the desktop image (part C step 1; on Lite there is nothing to
draw the page on). The installer's summary has a `Screen:` line: the address, the scale,
and whether screen blanking is off. Then `sudo reboot` once. The monitor's own
sleep or eco timer, if it has one, is switched off once in its own menu.

**Pair it.** The screen shows *Set up this display* and a six-digit code. Console → Devices
→ **Pair a display**: the counter's station, a display name, the code. A station takes one
display, so if it has one already, revoke that under **Paired screens** first. The screen
follows that till from then on.

**What is kept.** A reboot, the 04:30 reboot, a power cut and a release update all come
back paired with nobody touching anything: the pairing lives in the browser's profile,
`/home/oto/.config/oto-kiosk`, and nothing clears it. The address, the scale and the turn
stay in `/etc/oto-box/config`. Chromium's cache is in RAM to spare the drive, so it starts
empty on every boot; that costs one page load and nothing else.

**The one step that loses the pairing** is a fresh profile, for a browser that has gone
wrong and will not recover by restarting:

```
sudo systemctl stop oto-kiosk && rm -rf /home/oto/.config/oto-kiosk && sudo systemctl start oto-kiosk
```

The screen then shows a new code. Revoke the old entry under **Paired screens** and pair it
again. `sudo systemctl restart oto-kiosk` on its own loses nothing: try that first.

**The nickname.** Touch the nickname field and a keyboard opens under it: English letters,
space, backspace, Done. The phone number has its keypad as it always had. `?keyboard=screen`
on the address is what asks for this keyboard; the plain `/display`, on an iPad or a
laptop, has none.

**Changing it later**: `sudo nano /etc/oto-box/config` (`OTO_KIOSK_URL`, `OTO_KIOSK_SCALE`,
`OTO_KIOSK_ROTATE`), then `sudo systemctl restart oto-kiosk`. The installer with
`--kiosk-url "" --kiosk-scale 1 --rotate cw` puts a box back on its own page.

**Still to prove on the real monitor (SCRUM-711):** the page fills the screen, touch lands
where it is pressed, a nickname can be typed, it comes back paired after `sudo reboot` and
after a release pushed with part G, and it does not blank through a long idle spell. A
bare screen: `journalctl -u oto-kiosk -n 20`.

**The scale.** 1.25 is the largest that keeps the whole keypad on the screen: every digit
shows on the "Are you a member?" step, and only the channel and the nickname need a swipe.
Only 1 fits the whole step. Do not go above 1.25 in landscape: at 1.6 the keypad stops at
4-5-6, so a family cannot type a number without knowing to swipe. Check it on the real
monitor. It is a line in the config file, no release needed.

## If the drive dies

Keep `OTO_BOX_MIRROR_DIR` on a **second physical drive**, mounted and writable by
`oto-box`. The service reads it alongside `OTO_BOX_HOME`. `oto-box status` says
when no directory is configured. A checked SQLite mirror is made every minute,
and after a new unsent record when the last mirror is over ten seconds old.
`oto-box store mirror-now` makes one on demand. The directory holds
`box.sqlite.mirror`, `.mirror.1` and `.mirror.2`; keep all three. A mirror is a
recent snapshot, so records newer than that snapshot are not protected by it.
If a record arrives within ten seconds of a mirror and no further record arrives,
it waits for the next minute's mirror. This is not a ten-second maximum loss window.
Health reports drive errors, low space and missing or old mirrors.

1. Stop the box (`sudo systemctl stop oto-box`). Keep the failed drive for
   recovery; do not format it. Install the current release on the replacement
   drive as in part C and connect the separate mirror drive.
2. In Console > Devices, open **the existing box** and issue a new claim code.
   Re-register that same box with `oto-box claim` (part C), then stop the service
   again. Do not create a different box: the mirrored records belong to the
   original box identity. Keep the new credential and service configuration.
3. With the service stopped, run as the service account, using its configured
   home: `sudo -u oto-box oto-box store restore /path/to/box.sqlite.mirror --home /var/lib/oto-box`.
   A damaged file is refused. Try `.mirror.1` or `.mirror.2` if necessary. The
   command checks the copy, preserves the current store and its WAL/SHM beside
   it as `box.sqlite.replaced-<time>` files, then prints the unsent record count.
   It does not change the credential or `/etc/oto-box/config`.
4. Start the service and inspect Health and Failures > Quarantine. Re-registering
   onto a blank store advances the journal epoch: restored records from the old
   epoch can need an administrator's review in Quarantine; the restore does not
   rewrite or automatically approve them. Confirm their outcome before reopening
   the counter. Keep the mirror and replaced files until that check is complete.

The local restore rehearsal checks file integrity and preserves unsent records.
A physical drive swap and the park's recovery time still need a Pi visit.

## Resetting the game

- Fresh game: `sudo systemctl restart oto-kiosk` (10 s). Fresh game and box:
  `sudo systemctl restart oto-box oto-kiosk`. No keyboard/SSH: pull the power, wait
  5 s, plug back — a cold start is safe by design.
- TV amnesia (forgets the chosen booth, rotation, everything the page remembered; on
  the counter's customer display it also loses the pairing, part I):
  `sudo systemctl stop oto-kiosk && rm -rf /home/oto/.config/oto-kiosk && sudo systemctl start oto-kiosk`
- Button dead but the game is up? Press the keyboard's space bar: keyboard spins but
  button does not → replug the button (other black USB port); neither spins → the
  browser lost focus, restart the kiosk. Note which case it was (SCRUM-467).

## If something misbehaves

`oto-box status` · `journalctl -u oto-box -n 50` · TV blank: `journalctl -u oto-kiosk
-n 20` · printer: `systemctl is-active dnsmasq`, `journalctl -u dnsmasq -n 20` (a
`DHCPACK … 192.168.192.168` line means the printer took its address) · full checklist:
PI_BOOTH.md §7. Photograph anything odd; findings come back as one list.
