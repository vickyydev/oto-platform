# Pi update at the park - 5 October 2026

The archive and checksum are on the Windows Desktop. Use a second Windows PowerShell window for the copy; the SSH terminal is already running on the Pi and cannot read the Windows Desktop.

## 1. Find the address from the existing SSH session

```bash
echo "$SSH_CONNECTION" | awk '{print $3}'
```

## 2. Copy from Windows

The confirmed Pi address for this visit is 192.168.0.240. In Command Prompt (a C:\Users\...> prompt), run:

```cmd
cd /d "%USERPROFILE%\OneDrive\Desktop"
scp oto-box-0.1.0-7eca661.tgz oto-box-0.1.0-7eca661.tgz.sha256 oto@192.168.0.240:~/
```

The following alternative is for PowerShell only; $env: variables do not work in Command Prompt.

```powershell
$piAddress = Read-Host "Enter the Pi address shown in SSH"
scp "$env:USERPROFILE\OneDrive\Desktop\oto-box-0.1.0-7eca661.tgz" "$env:USERPROFILE\OneDrive\Desktop\oto-box-0.1.0-7eca661.tgz.sha256" "oto@${piAddress}:~/"
```

## 3. Check and install inside the existing Pi SSH session

```bash
cd ~
sha256sum -c oto-box-0.1.0-7eca661.tgz.sha256
```

Continue only if it says OK. Expected SHA-256:

```text
970d5340b45f892174de2167ef5806c2858480e3a5239cf031f7a69e4cdf063e
```

```bash
update_dir="$(mktemp -d "$HOME/oto-update.XXXXXX")" &&
tar -xzf "$HOME/oto-box-0.1.0-7eca661.tgz" -C "$update_dir" &&
sudo bash "$update_dir/oto-box/pi/install.sh" &&
sudo reboot
```

The installer preserves registration, the voucher store and existing configuration. The temporary extraction directory prevents mixing old release files into the new installation. Existing printer networking stays configured; no new claim is needed. Reboot closes SSH. Reconnect normally, then check:

```bash
readlink -f /opt/oto-box/current
systemctl is-active oto-box oto-kiosk
sudo oto-box status
```

The release path should contain 7eca661 and both services should say active.

## 4. Apply the saved seven-prize draft

Console -> Booths -> FWBooth1 -> Review and publish. Review seven active prizes totalling 100%, then publish. At this checkpoint the current version was 11, so the next expected version is 12 unless somebody publishes another version first. Wait for The box -> running version to match the published version. The TV updates between spins. The existing 300 THB chance was split: 300 THB 5%, Kids Pizza 5%; all other odds are unchanged.

After this software update, settings need only Save and Publish, not another software install. The box polls queued commands every five seconds by default; Publish queues config_apply, which fetches the complete configuration and cache. The TV also checks local configuration every five seconds. There is no separate supported five-second fetch CLI command. Network latency can add time.

If the box needs a manual restart after publishing, wait for the current spin/print to finish, then run:

```bash
sudo systemctl restart oto-box
sleep 5
sudo oto-box status
```

The sleep only waits; it is not a fetch command. A restart loads published settings, never an unpublished draft. If the TV alone remains stale after the box has applied, restart its browser:

```bash
sudo systemctl restart oto-kiosk
```

## 5. Static QRs and switching back

The six supplied prize QRs are already saved under their matching Voucher types: 100 THB, 150 THB, 200 THB, Free Bracelet Workshop, Kids Pizza, and 1+1 Kids Ticket. Leave Code on the slip set to Generated codes. The separate QR for current POS (temporary) -> Existing QR content field overrides only the QR. It does not require Fixed code mode. The internal platform code still prints as a reference and each spin remains recorded. The 300 THB prize has no supplied static QR, so it keeps its generated QR.

To enable a static QR later: open its Voucher type, enter the exact original decoded QR content in Existing QR content, Save, then Review and publish each linked booth. Do not paste the QR image or its prize title into the field. Do not copy actual redeemable values into tickets or logs.

To return to dynamic QRs: clear Existing QR content for each affected Voucher type, keep Generated codes selected, Save, then Review and publish FWBooth1. Wait for the running version to match. New winning slips then contain their own platform-generated QR. Old slips and their reprints retain the original saved QR/design. Restoring a static QR later requires the original QR content again.

## 6. Paper and physical acceptance

Customise slip controls the layout, shared English/Thai wording, logo, Staff row and terms visibility. Voucher types controls each prize's title, redemption instruction and terms. Save, then publish the booth. The saved park draft uses Bilingual showcase with the Staff row off; existing terms visibility was preserved.

Print a NEW winning slip and scan it on the current POS; confirm that POS recognises the correct prize. Repeat for other winning prizes as practical. The six software-rendered QRs exactly matched the supplied originals at both 512 and 576 dots; physical print/scan is still an on-site acceptance check. Current-POS redemption and reuse rules are controlled by that POS and do not sync redemption status into the new platform ledger.
