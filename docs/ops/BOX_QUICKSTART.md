# Box quickstart — the park, the Mac, and nothing else

The short card for setting a booth box up away from home. Every step is a command or a
click; the long explanations live in [PI_BOOTH.md](PI_BOOTH.md) and
[BOOTH_SETUP.md](BOOTH_SETUP.md). Bring: the Pi with its 27 W supply, the imaged card or
stick, micro-HDMI cable, the wireless keyboard, the printer with one network cable, the
red button, the MacBook, and the release file `oto-box-0.1.0-08ffe66.tgz` (or the newest
one handed to you) already saved on the Mac.

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

No screen handy? Make your phone's hotspot with the SAME name and password as the home
Wi-Fi the card was imaged with: the Pi joins it by itself, SSH in over the hotspot, add
the park Wi-Fi with the nmcli line above, then switch off the hotspot.

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
   shasum -a 256 oto-box-0.1.0-08ffe66.tgz     # starts de9c, ends 6fd3
   scp oto-box-0.1.0-08ffe66.tgz oto@<ip>:~/
   ```

5. **Install** (in the SSH window; ~5 min):

   ```
   ssh oto@<ip>
   cd ~
   sha256sum oto-box-0.1.0-08ffe66.tgz
   rm -rf oto-box
   tar -xzf oto-box-0.1.0-08ffe66.tgz
   sudo bash oto-box/pi/install.sh --api https://oto-api-staging.onrender.com --printer-direct
   ```

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
3. Booths → the booth → **Booth settings**: Layout "Classic wheel (v1)" + staff session
   length → Save.
4. Booths → the booth → **Booth staff**: add yourself, set your 5-digit PIN.
5. Voucher types first, then **Add prize** per prize until chances total exactly 100%.
6. **Review and publish** → Publish. The TV shows the wheel within a minute.

## E. Play

Red button into a black USB port (it sends Space; nothing to set). Type your PIN on the
keyboard to sign in, press the button, the slip prints. No slip within 3 seconds → the
code and QR show on the TV, and the slip follows once the printer answers. Redeem the
slip at a till per [COUNTER_VOUCHERS.md](COUNTER_VOUCHERS.md).

## If something misbehaves

`oto-box status` · `journalctl -u oto-box -n 50` · TV blank: `journalctl -u oto-kiosk
-n 20` · printer: `systemctl is-active dnsmasq`, `journalctl -u dnsmasq -n 20` (a
`DHCPACK … 192.168.192.168` line means the printer took its address) · full checklist:
PI_BOOTH.md §7. Photograph anything odd; findings come back as one list.
