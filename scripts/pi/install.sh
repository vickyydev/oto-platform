#!/usr/bin/env bash
# Install (or update) the OTO booth box on a Raspberry Pi 5 (SCRUM-223).
#
#   sudo bash install.sh oto-box-0.1.0-<date>-<commit>.tgz [options]
#   sudo bash oto-box/pi/install.sh [options]        (from an unpacked release)
#
# The release's name — its BUILD ID, e.g. 0.1.0-20261029-b25b644: the agent
# version, the build's date and the commit — is read from the release's VERSION
# file and becomes its folder, /opt/oto-box/releases/<build id>; `oto-box
# status` prints the same id, and the Console shows it as the box's agent
# version. A tarball from before the date was in the name
# (oto-box-0.1.0-<commit>.tgz) still installs, under <version>-<commit>.
#
# Options:
#   --api URL             the api the box talks to (default: staging)
#   --kiosk-user NAME     the desktop user the television runs as (default: the
#                         user who ran sudo)
#   --timezone ZONE       the park's timezone (default: Asia/Bangkok)
#   --daily-reboot HH:MM  reboot every day at this local time (default 04:30)
#   --no-daily-reboot     do not
#   --ssh-keys-only       turn SSH password log-in off (only if a key is installed;
#                         without this it stays on, and the installer says so)
#   --no-kiosk            the box without the television (a headless test)
#   --rotate cw|ccw|off   which way the page turns a television hung portrait:
#                         cw (the default) or ccw if the picture is upside down;
#                         off for a screen that stands the way it is made (the
#                         counter's customer display)
#   --kiosk-url URL       what the screen opens instead of the box's own page, e.g.
#                         "https://oto-pos-web-staging.onrender.com/display?keyboard=screen"
#                         for the counter's customer display (BOX_QUICKSTART.md
#                         part I). Default: the box's own page. An update keeps
#                         the address the box has; --kiosk-url "" goes back to
#                         the box's own page
#   --kiosk-scale N       how large the screen draws the page: Chromium's device
#                         scale factor, 1 by default (the booth); the counter's
#                         customer display uses 1.25
#   --mirror-uuid UUID    the second drive the box copies its store to, by its
#                         filesystem UUID (sudo blkid), ext4. Mounted at
#                         /mnt/oto-mirror; nofail, so a missing drive never stops
#                         the box from booting or selling. Without this nothing
#                         about the mirror changes. On a RECOVERY install leave it
#                         off until the store is back: BOX_QUICKSTART.md, "If the
#                         drive dies"
#   --printer-direct      the receipt printer plugs by network cable straight into
#                         the Pi's Ethernet socket, no router between them: gives
#                         eth0 a fixed address for it (192.168.192.10), runs a
#                         small DHCP server on that cable which always hands the
#                         printer 192.168.192.168, and leaves Wi-Fi and every
#                         other connection alone
#   --tailscale-authkey KEY
#                         join the private network (Tailscale) with this auth
#                         key, Tailscale SSH on: installs Tailscale from its own
#                         apt repository if it is missing. The key is never
#                         printed or saved. Without it nothing about the
#                         network changes; the summary still says whether the
#                         box is on it
#   --tailscale-hostname NAME
#                         the box's name on that network (default: the Pi's
#                         hostname)
#
# Written for Raspberry Pi OS 64-bit (Debian 12, Bookworm) WITH the desktop:
# the television is Chromium on that desktop, so Lite (no desktop) will not do.
# RUN ONCE ON A RASPBERRY PI 5 so far (the bench, 28 September 2026): the
# printer link came up. The printer's address service below is newer than that
# run, and the rest was checked for syntax and in pieces on a bench laptop, so
# read what it prints. Run it again with a newer release to update — or push
# one from the laptop with scripts/agent/push-release.sh, which does exactly
# that over the private network: the credential, the store and
# /etc/oto-box/config are kept, and the previous release stays on disk for a
# rollback (see PI_BOOTH.md).
#
# It installs from a RELEASE TARBALL, not a git checkout: the Pi then never
# needs the source, a build toolchain, pnpm or GitHub credentials, and what
# runs is exactly the file that was built and tested. The one native module
# (@node-rs/argon2, for booth PINs) is fetched by npm as a prebuilt arm64
# binary; SQLite is part of Node 22 itself.

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.17.1}"
API_URL="https://oto-api-staging.onrender.com"
KIOSK_USER="${SUDO_USER:-}"
TIMEZONE="Asia/Bangkok"
DAILY_REBOOT="04:30"
SSH_KEYS_ONLY=0
WITH_KIOSK=1
API_GIVEN=0
ROTATE=""
KIOSK_URL=""
KIOSK_URL_GIVEN=0
KIOSK_SCALE=""
BLANKING_NOTE=""
PRINTER_DIRECT=0
PRINTER_IFACE="eth0"
PRINTER_LINK_ADDR="192.168.192.10/24"
PRINTER_LINK_NETMASK="255.255.255.0"   # the /24 of PRINTER_LINK_ADDR, written the way dnsmasq wants it
PRINTER_DHCP_ADDR="192.168.192.168"    # the one address the Pi hands the printer on that cable
PRINTER_DHCP_CONF="/etc/dnsmasq.d/oto-printer-link.conf"
TARBALL=""
TS_AUTHKEY=""
TS_HOSTNAME="$(hostname)"
TS_KEYRING="/usr/share/keyrings/tailscale-archive-keyring.gpg"
TS_LIST="/etc/apt/sources.list.d/tailscale.list"
MIRROR_UUID=""
MIRROR_MOUNT="/mnt/oto-mirror"
MIRROR_DIR="$MIRROR_MOUNT/box"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --api) API_URL="${2:?--api needs a URL}"; API_GIVEN=1; shift 2 ;;
    --kiosk-user) KIOSK_USER="${2:?--kiosk-user needs a name}"; shift 2 ;;
    --timezone) TIMEZONE="${2:?--timezone needs a zone}"; shift 2 ;;
    --daily-reboot) DAILY_REBOOT="${2:?--daily-reboot needs HH:MM}"; shift 2 ;;
    --no-daily-reboot) DAILY_REBOOT=""; shift ;;
    --ssh-keys-only) SSH_KEYS_ONLY=1; shift ;;
    --no-kiosk) WITH_KIOSK=0; shift ;;
    --rotate) ROTATE="${2:?--rotate needs cw, ccw or off}"; shift 2 ;;
    --kiosk-url) KIOSK_URL="${2?--kiosk-url needs a URL}"; KIOSK_URL_GIVEN=1; shift 2 ;;
    --kiosk-scale) KIOSK_SCALE="${2:?--kiosk-scale needs a number}"; shift 2 ;;
    --printer-direct) PRINTER_DIRECT=1; shift ;;
    --tailscale-authkey) TS_AUTHKEY="${2:?--tailscale-authkey needs a key}"; shift 2 ;;
    --tailscale-hostname) TS_HOSTNAME="${2:?--tailscale-hostname needs a name}"; shift 2 ;;
    --mirror-uuid) MIRROR_UUID="${2:?--mirror-uuid needs the UUID of the drive, from sudo blkid}"; shift 2 ;;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
    *.tgz|*.tar.gz) TARBALL="$1"; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
# The userland, not the kernel: Raspberry Pi OS 32-bit boots a 64-bit kernel on
# a Pi 5, so `uname -m` says aarch64 on a system whose libraries are armhf —
# where the arm64 Node below cannot run, and the failure would have read
# "Node did not install". dpkg knows which one this is.
USERLAND="$(dpkg --print-architecture 2>/dev/null || true)"
case "$USERLAND" in
  arm64) ;;
  amd64) warn "this is a 64-bit PC (amd64), not a Raspberry Pi; continuing" ;;
  armhf|armel|i386) die "this is a 32-bit system ($USERLAND): write the card again with Raspberry Pi OS (64-bit), PI_BOOTH.md section 2" ;;
  *)
    [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = "64" ] || die "this is a 32-bit system: write the card again with Raspberry Pi OS (64-bit), PI_BOOTH.md section 2"
    warn "could not tell the architecture from dpkg (${USERLAND:-none}); continuing"
    ;;
esac
[ "$(uname -m)" = "aarch64" ] || warn "this is $(uname -m), not a Raspberry Pi (aarch64); continuing"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  [ "${VERSION_CODENAME:-}" = "bookworm" ] || warn "written for Debian 12 (bookworm); this is ${PRETTY_NAME:-unknown}"
fi
if [ "$DAILY_REBOOT" != "" ] && ! printf '%s' "$DAILY_REBOOT" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$'; then
  die "--daily-reboot wants HH:MM, got $DAILY_REBOOT"
fi
case "$ROTATE" in
  ""|cw|ccw|off) ;;
  *) die "--rotate wants cw, ccw or off, got $ROTATE" ;;
esac
if [ -n "$KIOSK_URL" ]; then
  [ "$WITH_KIOSK" -eq 1 ] || die "--kiosk-url names what the screen opens, and --no-kiosk says there is no screen: pass one of them"
  # /etc/oto-box/config is read by bash (the oto-box command) and by systemd, so
  # the address holds only what means nothing to either: no spaces, & or quotes.
  printf '%s' "$KIOSK_URL" | grep -Eq '^https?://[A-Za-z0-9._:/?#=%+,@-]+$' \
    || die "--kiosk-url wants an http(s) address with no spaces, & or quotes in it, got $KIOSK_URL"
fi
if [ -n "$KIOSK_SCALE" ]; then
  { printf '%s' "$KIOSK_SCALE" | grep -Eq '^[0-9]+(\.[0-9]+)?$' && printf '%s' "$KIOSK_SCALE" | grep -q '[1-9]'; } \
    || die "--kiosk-scale wants a number such as 1.25, got $KIOSK_SCALE"
fi
if [ -n "$MIRROR_UUID" ]; then
  # It goes into /etc/fstab: only what a filesystem UUID is made of.
  printf '%s' "$MIRROR_UUID" | grep -Eq '^[A-Fa-f0-9-]{8,36}$' \
    || die "--mirror-uuid wants a filesystem UUID (sudo blkid), got $MIRROR_UUID"
fi
if [ -n "$TS_AUTHKEY" ]; then
  # The key itself is never part of a message: only its shape is checked.
  case "$TS_AUTHKEY" in
    tskey-*) ;;
    *) warn "the --tailscale-authkey value does not look like a Tailscale auth key (they begin tskey-); trying it all the same" ;;
  esac
  printf '%s' "$TS_HOSTNAME" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' \
    || die "--tailscale-hostname wants letters, digits and hyphens, got $TS_HOSTNAME"
fi

# --- The release -----------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "no such file: $TARBALL"
  tar -xzf "$TARBALL" -C "$WORK"
  SOURCE="$WORK/oto-box"
elif [ -f "$HERE/../oto-box.mjs" ]; then
  SOURCE="$(cd "$HERE/.." && pwd)"
else
  die "give the release tarball: sudo bash install.sh oto-box-<version>-<date>-<commit>.tgz"
fi
[ -f "$SOURCE/oto-box.mjs" ] || die "$SOURCE is not an oto-box release (no oto-box.mjs)"
[ -f "$SOURCE/booth/index.html" ] || warn "this release has no booth page; the television will say so"
# The release's name, from the first line of VERSION. Two shapes are read:
#   oto-box 0.1.0-20261029-b25b644 built 2026-10-29T05:38:23Z   → 0.1.0-20261029-b25b644
#   oto-box 0.1.0 b25b644 built 2026-10-29T05:38:23Z            → 0.1.0-b25b644  (older tarballs)
RELEASE="$(awk 'NR == 1 { if ($3 == "built") print $2; else print $2"-"$3 }' "$SOURCE/VERSION" 2>/dev/null | tr -c 'A-Za-z0-9.+-' '_' | sed 's/_*$//')"
[ -n "$RELEASE" ] || RELEASE="release-$(date +%Y%m%d%H%M%S)"

# --- Packages, time and the screen ------------------------------------------
say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils >/dev/null
if [ "$WITH_KIOSK" -eq 1 ] && ! command -v chromium-browser >/dev/null && ! command -v chromium >/dev/null; then
  apt-get install -y -qq chromium-browser >/dev/null 2>&1 || apt-get install -y -qq chromium >/dev/null
fi

say "Clock: NTP on, timezone $TIMEZONE"
timedatectl set-ntp true || warn "could not switch NTP on"
timedatectl set-timezone "$TIMEZONE" || warn "could not set the timezone"

# --- The private network (SCRUM-701) --------------------------------------------
# A box at the park changed build only when somebody carried the file to it
# over the local network and ran the installer there; the booth kept an old
# build for two days that way. Given an auth key, the box joins the private
# network (Tailscale) here, with Tailscale SSH on, and from then on a release
# is pushed to it by name from the laptop, from anywhere:
# scripts/agent/push-release.sh. Tailscale comes from its own apt repository:
# the signing key and the sources line that tailscale.com/install.sh would
# put in place are written here instead, so what runs is in this file and
# not a remote script piped to sh. The auth key goes to `tailscale up` and
# nowhere else — never printed, never logged, never kept in a file. Join with
# a reusable, pre-authorised, TAGGED key (BOX_QUICKSTART.md, "Remote access"):
# a tagged node's own key never expires, so the box never drops off the
# network for want of somebody logging in again. A box already on the network
# under this name is left as it is. Without a key nothing changes; the
# summary still says whether the box is on the network, and at which address.
ts_name() {
  # The box's own line of `tailscale status`: "100.x.y.z  name  user@  linux  -".
  # Nothing while Tailscale is logged out, stopped or not installed.
  tailscale status --self=true --peers=false 2>/dev/null | awk '$1 ~ /^100\./ { print $2; exit }'
}
ts_ip() { tailscale ip -4 2>/dev/null | head -n 1; }
TS_NOTE="not configured"
if [ -n "$TS_AUTHKEY" ]; then
  say "Private network: Tailscale as $TS_HOSTNAME"
  TS_READY=1
  if ! command -v tailscale >/dev/null; then
    # Raspberry Pi OS 64-bit says it is Debian; the 32-bit one, refused
    # above, would say raspbian. Both read from /etc/os-release above.
    TS_OS="debian"
    [ "${ID:-}" = "raspbian" ] && TS_OS="raspbian"
    TS_CODENAME="${VERSION_CODENAME:-bookworm}"
    if curl -fsSL "https://pkgs.tailscale.com/stable/$TS_OS/$TS_CODENAME.noarmor.gpg" -o "$TS_KEYRING"; then
      chmod 0644 "$TS_KEYRING"
      printf 'deb [signed-by=%s] https://pkgs.tailscale.com/stable/%s %s main\n' "$TS_KEYRING" "$TS_OS" "$TS_CODENAME" >"$TS_LIST"
      chmod 0644 "$TS_LIST"
      apt-get update -qq || true
      if ! apt-get install -y -qq tailscale >/dev/null; then
        warn "Tailscale did not install (apt's message is above)"
        TS_READY=0
      fi
    else
      warn "could not fetch Tailscale's package signing key from pkgs.tailscale.com: is the Pi on the internet?"
      TS_READY=0
    fi
  fi
  if [ "$TS_READY" -eq 1 ]; then
    systemctl enable --now tailscaled >/dev/null 2>&1 || true
    if [ "$(ts_name)" = "$TS_HOSTNAME" ]; then
      echo "already on the network as $TS_HOSTNAME ($(ts_ip)); nothing to join"
    else
      # --reset: whatever was set by hand on an earlier join goes back to its
      # default, so the box ends with exactly this — SSH on, this name — and
      # `up` cannot refuse over a flag it was not told about. --timeout: a
      # box with no internet is a warning below, not an installer that hangs.
      if tailscale up --reset --ssh --hostname "$TS_HOSTNAME" --auth-key "$TS_AUTHKEY" --timeout 90s; then
        echo "joined as $(ts_name) ($(ts_ip)); Tailscale SSH on"
      else
        warn "tailscale up did not complete (its message is above), so the box is NOT on the private network. In the Tailscale admin check that the key is reusable, not expired and tagged, then run the installer again with --tailscale-authkey"
        TS_NOTE="NOT joined — tailscale up did not complete (the warning above). Run the installer again with --tailscale-authkey"
      fi
    fi
  else
    TS_NOTE="NOT joined — Tailscale did not install (the warning above). Run the installer again with --tailscale-authkey once the Pi has its internet"
  fi
fi

# --- The box stays awake (SCRUM-467) -------------------------------------------
# At the park the red button, and then the mouse beside it, stopped answering
# after the box had sat idle, and the box's SSH turned flaky in the same spells.
# The red button is a USB keyboard: the kernel's USB autosuspend lets an idle
# input device (or a wireless receiver) power down, and its next press can be
# lost; Wi-Fi power saving parks the radio between packets. Both are pinned
# off here, on every run, so a booth box ships fully awake from its first
# boot. (The screen never blanking is set with the television, below.) A udev
# rule rather than the kernel command line: it holds for a device plugged in
# later too, and leaves the boot files alone. Nothing here needs a reboot.
say "Box stays awake: USB autosuspend off, Wi-Fi power saving off"
USB_AWAKE_RULE="/etc/udev/rules.d/50-oto-box-usb-awake.rules"
cat >"$USB_AWAKE_RULE" <<'EOF'
# Written by the OTO box installer (SCRUM-467): every USB device stays powered,
# so the red button and the keyboard never sleep. Rewritten on every install run.
ACTION=="add", SUBSYSTEM=="usb", TEST=="power/control", ATTR{power/control}="on"
EOF
chmod 0644 "$USB_AWAKE_RULE"
udevadm control --reload-rules 2>/dev/null || warn "udev did not reload its rules; they take effect at the next boot"
# Now, for what is already plugged in, and for the kernel's default.
for control in /sys/bus/usb/devices/*/power/control; do
  [ -w "$control" ] && { echo on >"$control" 2>/dev/null || true; }
done
if [ -w /sys/module/usbcore/parameters/autosuspend ]; then
  echo -1 >/sys/module/usbcore/parameters/autosuspend 2>/dev/null || true
fi
if command -v nmcli >/dev/null; then
  install -d -m 0755 /etc/NetworkManager/conf.d
  cat >/etc/NetworkManager/conf.d/oto-box-wifi-powersave.conf <<'EOF'
# Written by the OTO box installer (SCRUM-467): Wi-Fi power saving off
# (2 = disable) for every Wi-Fi connection. Rewritten on every install run.
[connection]
wifi.powersave = 2
EOF
  chmod 0644 /etc/NetworkManager/conf.d/oto-box-wifi-powersave.conf
  # Reload the configuration, never restart NetworkManager: this run may be
  # over SSH on that same Wi-Fi. The connection up now gets it from `iw`.
  nmcli general reload conf >/dev/null 2>&1 || warn "NetworkManager did not reload its configuration; Wi-Fi power saving goes off at the next boot"
else
  warn "nmcli is not on this system (no NetworkManager): Wi-Fi power saving was left as it is"
fi
if command -v iw >/dev/null; then
  for wifi in /sys/class/net/*/wireless; do
    [ -e "$wifi" ] || continue
    iface="$(basename "$(dirname "$wifi")")"
    iw dev "$iface" set power_save off 2>/dev/null || warn "could not switch power saving off on $iface now; it goes off at the next boot"
  done
fi

# --- The printer cable ------------------------------------------------------
# The booth's standard (PI_BOOTH.md section 1): the receipt printer plugs by
# network cable straight into the Pi's Ethernet socket, with no router between
# them, and the Pi's internet comes over Wi-Fi or a SIM dongle. The printer
# keeps its factory settings, and Epson's are "ask a DHCP server for an
# address", with nothing to fall back on: on a cable with nobody answering the
# printer has no address at all — the first Pi run at the bench found its
# self-test page saying "IP Address: None" — and 192.168.192.168 is only what
# Epson fills in once somebody sets the printer to a fixed address by hand.
# So the Pi answers. eth0 gets a fixed address of its own on that network
# (never-default keeps the internet route off the cable; the link-local
# address beside it is harmless and stays), and dnsmasq, with its DNS off and
# its DHCP kept to the printer cable, hands the one device on the cable
# 192.168.192.168 — always that one, so the Console address never changes.
# Nothing on the printer is set. One NetworkManager profile, "printer-link",
# and one dnsmasq file, /etc/dnsmasq.d/oto-printer-link.conf: added the first
# time, re-applied on every run after, never a second one. Nothing else on the
# Pi — Wi-Fi, a dongle, any other profile, the Pi's own name look-ups — is
# touched. The link has had one real run on a Pi 5 (it came up); the DHCP
# part has not yet.
PRINTER_NOTE="on the router path (no --printer-direct): the printer and the Pi on the same network, the printer on a DHCP reservation. For a printer cabled straight into the Pi, run the installer again with --printer-direct"
DHCP_OK=0
if [ "$PRINTER_DIRECT" -eq 1 ]; then
  say "Printer cable: printer-link on $PRINTER_IFACE ($PRINTER_LINK_ADDR)"
  if ! command -v nmcli >/dev/null; then
    warn "nmcli is not on this system (no NetworkManager), so the printer cable was NOT set up; Wi-Fi and every other connection were left as they are. Raspberry Pi OS Bookworm has nmcli — is this another system?"
    PRINTER_NOTE="NOT set up — nmcli is missing on this system. Use the router path (PI_BOOTH.md section 1), or run the installer again with --printer-direct on Raspberry Pi OS"
  else
    [ -e "/sys/class/net/$PRINTER_IFACE" ] || warn "no $PRINTER_IFACE on this machine: the printer link is saved for it all the same"
    NM_PROPS=(
      connection.autoconnect yes connection.autoconnect-priority 10
      ipv4.method manual ipv4.addresses "$PRINTER_LINK_ADDR" ipv4.never-default yes ipv4.link-local enabled
      ipv6.method disabled
    )
    if nmcli connection show printer-link >/dev/null 2>&1; then
      LINK="already there, its settings applied again"
      nmcli connection modify printer-link connection.interface-name "$PRINTER_IFACE" "${NM_PROPS[@]}" || LINK=""
    else
      LINK="added"
      nmcli connection add type ethernet ifname "$PRINTER_IFACE" con-name printer-link "${NM_PROPS[@]}" || LINK=""
    fi
    if [ -z "$LINK" ]; then
      warn "nmcli refused the printer-link connection, so the printer cable was NOT set up; nothing else was changed"
      PRINTER_NOTE="NOT set up — nmcli refused the printer-link connection (its message is above). Nothing else was changed"
    else
      ACTIVE="$(nmcli -g GENERAL.CONNECTION device show "$PRINTER_IFACE" 2>/dev/null || true)"
      GATEWAY="$(nmcli -g IP4.GATEWAY device show "$PRINTER_IFACE" 2>/dev/null || true)"
      [ "$GATEWAY" = "--" ] && GATEWAY=""
      if [ "$ACTIVE" = "printer-link" ]; then
        echo "printer-link $LINK; it is up on $PRINTER_IFACE"
        PRINTER_NOTE="printer-link on $PRINTER_IFACE ($PRINTER_LINK_ADDR), up"
      elif [ -n "$GATEWAY" ]; then
        # Switching eth0 over now would cut off an installer running over SSH on it.
        warn "$PRINTER_IFACE carries this Pi's internet right now (gateway $GATEWAY: the cable goes to a router, not the printer), so printer-link was saved but not switched on — switching would have cut this session off. It takes $PRINTER_IFACE by itself at the next boot; before then give the Pi its internet over Wi-Fi: sudo nmcli device wifi connect \"<network name>\" password \"<password>\""
        PRINTER_NOTE="printer-link on $PRINTER_IFACE saved, NOT switched on: $PRINTER_IFACE still carries the internet (the warning above). Put the Pi on Wi-Fi, move the cable to the printer, reboot"
      elif nmcli -w 20 connection up printer-link >/dev/null; then
        echo "printer-link $LINK; it is up on $PRINTER_IFACE"
        PRINTER_NOTE="printer-link on $PRINTER_IFACE ($PRINTER_LINK_ADDR), up"
      else
        echo "printer-link $LINK; not up yet (no cable, or the printer is off) — it comes up by itself once the printer is plugged in and switched on"
        PRINTER_NOTE="printer-link on $PRINTER_IFACE ($PRINTER_LINK_ADDR), saved — it comes up by itself when the printer is plugged in and switched on"
      fi
      # The printer's address: dnsmasq on the printer cable (the comment above).
      # Whether the link could be switched on just now makes no difference:
      # the server waits on the cable for the printer. Checked as a package,
      # not a command — NetworkManager's own dnsmasq-base puts a dnsmasq
      # command on the Pi with no service behind it.
      DHCP_NOTE=""
      if ! dpkg -s dnsmasq 2>/dev/null | grep -q '^Status: install ok installed'; then
        apt-get install -y -qq dnsmasq >/dev/null || DHCP_NOTE="the Pi's address service for the printer (dnsmasq) did NOT install (apt's message is above), so the printer will get no address from the Pi: run the installer again with --printer-direct once the Pi has its internet, or set the printer to a fixed address instead ($PRINTER_DHCP_ADDR, mask $PRINTER_LINK_NETMASK)"
      fi
      if [ -n "$DHCP_NOTE" ]; then
        warn "$DHCP_NOTE"
      else
        install -d -m 0755 /etc/dnsmasq.d
        cat >"$PRINTER_DHCP_CONF" <<EOF
# Written by the OTO box installer (--printer-direct) for the printer cable on
# $PRINTER_IFACE: DNS off, DHCP on that cable only, one address for the one
# device on it. Rewritten on every install run. To go back to the router path
# delete it and switch dnsmasq off (PI_BOOTH.md section 7).
port=0
interface=$PRINTER_IFACE
bind-dynamic
dhcp-authoritative
dhcp-range=$PRINTER_DHCP_ADDR,$PRINTER_DHCP_ADDR,$PRINTER_LINK_NETMASK,12h
dhcp-option=option:router
dhcp-option=option:dns-server
EOF
        chmod 0644 "$PRINTER_DHCP_CONF"
        # Where resolvconf manages /etc/resolv.conf, the package's start hook
        # would add this dnsmasq — whose DNS is off — as the Pi's first name
        # server. DNSMASQ_EXCEPT=lo in its defaults file is the package's own
        # way of saying "not a name server for this machine". Raspberry Pi OS
        # Bookworm has no resolvconf, so there this changes nothing.
        if command -v resolvconf >/dev/null && ! grep -q '^DNSMASQ_EXCEPT=' /etc/default/dnsmasq 2>/dev/null; then
          printf 'DNSMASQ_EXCEPT="lo"\n' >>/etc/default/dnsmasq
        fi
        if systemctl enable --now dnsmasq >/dev/null && systemctl restart dnsmasq; then
          DHCP_OK=1
          echo "dnsmasq hands the printer $PRINTER_DHCP_ADDR on $PRINTER_IFACE ($PRINTER_DHCP_CONF)"
          DHCP_NOTE="the printer gets $PRINTER_DHCP_ADDR from the Pi (dnsmasq on $PRINTER_IFACE)"
        else
          warn "dnsmasq, the Pi's address service for the printer, did not start — its status is below. The printer gets no address from the Pi until it runs"
          systemctl status dnsmasq --no-pager 2>&1 | tail -n 12 >&2 || true
          DHCP_NOTE="the Pi's address service for the printer (dnsmasq) is NOT running (its status is above), so the printer gets no address from the Pi until it is: sudo systemctl restart dnsmasq, then journalctl -u dnsmasq -n 20"
        fi
      fi
      PRINTER_NOTE="$PRINTER_NOTE; $DHCP_NOTE"
    fi
  fi
fi

# --- Node 22 ----------------------------------------------------------------
# From nodejs.org, checked against its published SHA-256 list. Debian's own
# package is Node 18, which has no node:sqlite; 22.13 is the first 22 where it
# needs no flag.
node_ok() {
  command -v node >/dev/null || return 1
  local v; v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  local major minor; major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}
if node_ok; then
  say "Node $(node -v) is already here"
else
  say "Node $NODE_VERSION"
  ARCH=arm64
  if [ "$USERLAND" = "amd64" ] || [ "$(uname -m)" = "x86_64" ]; then ARCH=x64; fi
  FILE="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${FILE}" -o "$WORK/$FILE"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
  (cd "$WORK" && grep " ${FILE}\$" SHASUMS256.txt | sha256sum -c -) || die "the Node download did not match its checksum"
  rm -rf "/opt/node-v${NODE_VERSION}"
  mkdir -p "/opt/node-v${NODE_VERSION}"
  tar -xJf "$WORK/$FILE" -C "/opt/node-v${NODE_VERSION}" --strip-components=1
  for bin in node npm npx; do ln -sf "/opt/node-v${NODE_VERSION}/bin/$bin" "/usr/local/bin/$bin"; done
  node_ok || die "Node $NODE_VERSION did not install"
fi
NODE_BIN="$(command -v node)"

# --- The service user and its home ------------------------------------------
say "Service user oto-box"
if ! id oto-box >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/oto-box --shell /usr/sbin/nologin oto-box
fi
install -d -m 0700 -o oto-box -g oto-box /var/lib/oto-box
# The credential, if there is one, is the box: owner-only, whatever happened to it.
[ -f /var/lib/oto-box/credential.json ] && chmod 0600 /var/lib/oto-box/credential.json && chown oto-box:oto-box /var/lib/oto-box/credential.json

# --- The mirror drive (SCRUM-712, SCRUM-719) --------------------------------------
# A checked copy of the store goes to a second physical drive, so a dead boot
# drive does not take the unsent sales with it. nofail and the short device
# timeout are what keep a missing drive from holding up the boot: the counter must
# sell without it, and Health says it is gone. The mount point is root's and is
# made immutable while nothing is mounted on it, so an agent can never write there
# on the boot drive; the agent refuses a directory on the store's own device as
# well. The directory on the drive is made only if the drive really is mounted.
# chown -R, because a replaced boot drive can give the oto-box user another id.
MIRROR_NOTE="not configured: this box does not copy its store to a second drive. To add one, run the installer again with --mirror-uuid UUID (sudo blkid shows it)"
if [ -n "$MIRROR_UUID" ]; then
  say "Mirror drive: UUID $MIRROR_UUID at $MIRROR_MOUNT"
  # Only when it is not there yet: an immutable mount point refuses a chmod, and
  # this script stops at the first refusal.
  [ -d "$MIRROR_MOUNT" ] || install -d -m 0755 -o root -g root "$MIRROR_MOUNT"
  if ! mountpoint -q "$MIRROR_MOUNT"; then
    chattr +i "$MIRROR_MOUNT" 2>/dev/null || warn "could not make $MIRROR_MOUNT immutable; the agent still refuses to copy onto the store's own drive"
  fi
  FSTAB_LINE="UUID=$MIRROR_UUID $MIRROR_MOUNT ext4 defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2"
  if grep -Eq "^[^#]*[[:space:]]${MIRROR_MOUNT}[[:space:]]" /etc/fstab; then
    sed -i -E "s|^[^#]*[[:space:]]${MIRROR_MOUNT}[[:space:]].*$|$FSTAB_LINE|" /etc/fstab
  else
    printf '%s\n' "$FSTAB_LINE" >>/etc/fstab
  fi
  systemctl daemon-reload
  if mountpoint -q "$MIRROR_MOUNT" || mount "$MIRROR_MOUNT"; then
    if mountpoint -q "$MIRROR_MOUNT"; then
      install -d -m 0700 -o oto-box -g oto-box "$MIRROR_DIR"
      chown -R oto-box:oto-box "$MIRROR_DIR"
      MIRROR_NOTE="$MIRROR_DIR on the drive $MIRROR_UUID, mounted"
    fi
  fi
  if ! mountpoint -q "$MIRROR_MOUNT"; then
    warn "the mirror drive is not mounted, so no copy can be made yet. Plug it in and run the installer again with --mirror-uuid; the box sells without it meanwhile, and Health says so"
    MIRROR_NOTE="configured for the drive $MIRROR_UUID, which is NOT mounted (the warning above): no copy is being made"
  fi
fi

# --- The counter scanner (SCRUM-700) ---------------------------------------------
# The Zebra cradle plugs into the box, and the box reads it itself: as the USB
# keyboard it ships as (05e0:1200, an input event node) or, after one
# configuration bar code, as a USB serial port (05e0:1701, /dev/ttyACM*). One
# udev rule, for any Symbol/Zebra device (vendor 05e0): its node belongs to
# the box's own user and to nobody else, the television's display server is
# told to ignore the keyboard (libinput), so a scan never types into the
# screen, and ModemManager is told not to probe the serial port as a modem.
# The group and mode are FINAL assignments (:=): Raspberry Pi OS's own
# 99-com.rules runs after this file and sets every input node to the "input"
# group with a plain "=", which would otherwise win and leave the node closed
# to the box's user. That user is deliberately not in "input", which would let
# it read every keyboard on the box, not just the cradle.
# After the user above, because the rule names its group. The serial driver is
# loaded at boot from here on, so the service's device allow-list (oto-box.service)
# finds it when the box starts. A cradle already plugged in picks the rule up
# below; if the screen still reacts to a scan, unplug the cradle and plug it
# back in once. Rewritten on every install run.
say "Counter scanner: udev rule for the Zebra cradle"
SCANNER_RULE="/etc/udev/rules.d/61-oto-box-scanner.rules"
cat >"$SCANNER_RULE" <<'EOF'
# Written by the OTO box installer (SCRUM-700): the box reads the counter
# scanner itself. Rewritten on every install run.
# HID mode (the cradle as it ships): the box's user reads the keyboard's event
# node; the display server leaves it alone. GROUP and MODE are final (:=) so a
# later rule (Raspberry Pi OS's 99-com.rules: every input node to "input")
# cannot take the node back.
ACTION!="remove", SUBSYSTEM=="input", KERNEL=="event*", ATTRS{idVendor}=="05e0", GROUP:="oto-box", MODE:="0640", ENV{LIBINPUT_IGNORE_DEVICE}="1"
# CDC mode (after scanning "USB CDC Host"): the box's user reads the serial port;
# ModemManager does not probe it. Final for the same reason.
ACTION!="remove", SUBSYSTEM=="tty", KERNEL=="ttyACM*", ATTRS{idVendor}=="05e0", GROUP:="oto-box", MODE:="0660", ENV{ID_MM_DEVICE_IGNORE}="1"
ACTION!="remove", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="05e0", ENV{ID_MM_DEVICE_IGNORE}="1"
EOF
chmod 0644 "$SCANNER_RULE"
printf '# Written by the OTO box installer (SCRUM-700): the USB serial driver a scanner in CDC mode needs.\ncdc_acm\n' >/etc/modules-load.d/oto-box-scanner.conf
chmod 0644 /etc/modules-load.d/oto-box-scanner.conf
modprobe cdc_acm 2>/dev/null || true
SCANNER_NOTE="the udev rule is in place (vendor 05e0). Plug the cradle into the box, add it in the Console (Devices -> this box -> Add a device -> Scanner), give it to the station's Scanner job"
if udevadm control --reload-rules 2>/dev/null; then
  udevadm trigger --action=change --subsystem-match=input --subsystem-match=tty --property-match=ID_VENDOR_ID=05e0 2>/dev/null || true
else
  warn "udev did not reload its rules; the scanner rule takes effect at the next boot"
  SCANNER_NOTE="the udev rule is written but udev did not reload it: reboot once before plugging the cradle in"
fi
if grep -qsx 05e0 /sys/bus/usb/devices/*/idVendor; then
  SCANNER_NOTE="a Zebra device is plugged in (vendor 05e0); $SCANNER_NOTE. If the screen still reacts to a scan, unplug the cradle and plug it back in once"
fi

# --- The release, beside the previous one ------------------------------------
say "Release $RELEASE"
install -d -m 0755 /opt/oto-box/releases
TARGET="/opt/oto-box/releases/$RELEASE"
rm -rf "$TARGET.new"
cp -a "$SOURCE" "$TARGET.new"
chown -R root:root "$TARGET.new"
(
  cd "$TARGET.new"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
  else
    npm install --omit=dev --no-audit --no-fund --loglevel=error
  fi
  # The one native module: prove it loads on THIS machine before switching.
  "$NODE_BIN" -e "import('@node-rs/argon2').then(()=>console.log('argon2: ok')).catch((e)=>{console.error('argon2 failed:',e.message);process.exit(1)})"
)
rm -rf "$TARGET"
mv "$TARGET.new" "$TARGET"
# -e, not -f: on a first install there is no `current` yet, and -f would still
# print the path it would have had.
PREVIOUS="$(readlink -e /opt/oto-box/current 2>/dev/null || true)"
ln -sfn "$TARGET" /opt/oto-box/current.new
mv -T /opt/oto-box/current.new /opt/oto-box/current
if [ -z "$PREVIOUS" ]; then
  echo "first install: nothing to roll back to yet"
elif [ "$PREVIOUS" != "$TARGET" ]; then
  echo "previous release kept at $PREVIOUS"
fi

# --- Configuration ------------------------------------------------------------
say "/etc/oto-box/config"
install -d -m 0755 /etc/oto-box
if [ ! -f /etc/oto-box/config ]; then
  cat >/etc/oto-box/config <<EOF
# The OTO booth box. Read by oto-box.service and by the oto-box command.
# Change OTO_BOX_API to move the box to another environment, then
#   sudo systemctl restart oto-box
OTO_BOX_API=$API_URL
OTO_BOX_HOME=/var/lib/oto-box
OTO_BOX_PORT=8780
OTO_BOX_PAGE=/opt/oto-box/current/booth
# The television: which way the page turns the picture of a television hung
# portrait — cw, or ccw when the picture is upside down; off for a screen that
# stands the way it is made. Then
#   sudo systemctl restart oto-kiosk
OTO_KIOSK_ROTATE=${ROTATE:-cw}
# What the screen opens: empty for the box's own page, or an address (the
# counter's customer display). How large it draws the page: Chromium's device
# scale factor. Each followed by the same restart.
OTO_KIOSK_URL=$KIOSK_URL
OTO_KIOSK_SCALE=${KIOSK_SCALE:-1}
${MIRROR_UUID:+OTO_BOX_MIRROR_DIR=$MIRROR_DIR}
EOF
else
  if [ "$API_GIVEN" -eq 1 ]; then
    sed -i "s|^OTO_BOX_API=.*|OTO_BOX_API=$API_URL|" /etc/oto-box/config
  fi
  # Only what this run names: an update keeps the screen the box has.
  config_set() {
    if grep -q "^$1=" /etc/oto-box/config; then
      sed -i "s|^$1=.*|$1=$2|" /etc/oto-box/config
    else
      printf '%s=%s\n' "$1" "$2" >>/etc/oto-box/config
    fi
  }
  [ -z "$ROTATE" ] || config_set OTO_KIOSK_ROTATE "$ROTATE"
  [ "$KIOSK_URL_GIVEN" -eq 0 ] || config_set OTO_KIOSK_URL "$KIOSK_URL"
  [ -z "$KIOSK_SCALE" ] || config_set OTO_KIOSK_SCALE "$KIOSK_SCALE"
  [ -z "$MIRROR_UUID" ] || config_set OTO_BOX_MIRROR_DIR "$MIRROR_DIR"
fi
chmod 0644 /etc/oto-box/config
# What the screen opens from here on, whichever run set it.
KIOSK_URL_NOW="$(sed -n 's/^OTO_KIOSK_URL=//p' /etc/oto-box/config | tail -n 1)"

# The command, run as the service user so the files it writes are the box's.
install -d -m 0755 /usr/local/lib/oto-box
cat >/usr/local/bin/oto-box <<EOF
#!/usr/bin/env bash
# oto-box: the booth box's command, as the oto-box user, with /etc/oto-box/config.
set -a; . /etc/oto-box/config; set +a
# The box's files belong to the oto-box user: anybody else goes through sudo.
if [ "\$(id -u)" -ne 0 ] && [ "\$(id -un)" != oto-box ]; then exec sudo "\$0" "\$@"; fi
if [ "\$(id -u)" -eq 0 ]; then
  exec runuser -u oto-box -- env OTO_BOX_API="\$OTO_BOX_API" OTO_BOX_HOME="\$OTO_BOX_HOME" OTO_BOX_PORT="\$OTO_BOX_PORT" OTO_BOX_PAGE="\$OTO_BOX_PAGE" OTO_BOX_MIRROR_DIR="\$OTO_BOX_MIRROR_DIR" \\
    "$NODE_BIN" --disable-warning=ExperimentalWarning /opt/oto-box/current/oto-box.mjs "\$@"
fi
exec "$NODE_BIN" --disable-warning=ExperimentalWarning /opt/oto-box/current/oto-box.mjs "\$@"
EOF
chmod 0755 /usr/local/bin/oto-box

# --- The box service and its watchdog -----------------------------------------
say "oto-box.service"
sed "s|@NODE@|$NODE_BIN|g" "$SOURCE/pi/oto-box.service" >/etc/systemd/system/oto-box.service
install -m 0755 "$SOURCE/pi/oto-box-watchdog.sh" /usr/local/lib/oto-box/watchdog.sh
install -m 0644 "$SOURCE/pi/oto-box-watchdog.service" /etc/systemd/system/oto-box-watchdog.service
install -m 0644 "$SOURCE/pi/oto-box-watchdog.timer" /etc/systemd/system/oto-box-watchdog.timer

# --- The journal --------------------------------------------------------------
# Kept on the card rather than in memory: the box reboots at 04:30 every day,
# and a volatile journal took the previous day's log with it — the log an
# engineer asks for the morning after a fault. `journalctl --list-boots` shows
# more than one boot once this has taken.
say "Journal kept across reboots"
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$SOURCE/pi/oto-box-journald.conf" /etc/systemd/journald.conf.d/oto-box.conf
install -d -m 2755 -g systemd-journal /var/log/journal 2>/dev/null || install -d -m 0755 /var/log/journal
systemctl restart systemd-journald || warn "journald did not restart; the journal is kept from the next boot"
journalctl --flush 2>/dev/null || true

# --- Less wear on the drive (SCRUM-712, SCRUM-719) --------------------------------
# Raspberry Pi OS keeps a swap file on the boot drive, and a box under memory
# pressure then writes to it constantly: on a flash stick, that is what wears it
# out. Off, on every run, wherever the service is there. The box runs well inside
# its memory, and a page dropped and read again costs less than a dead drive.
if command -v dphys-swapfile >/dev/null; then
  say "Swap off"
  dphys-swapfile swapoff || warn "could not switch the swap file off now; it stays off from the next boot"
  dphys-swapfile uninstall || warn "could not remove the swap file"
  systemctl disable --now dphys-swapfile >/dev/null 2>&1 || warn "could not disable dphys-swapfile"
fi

if [ -n "$DAILY_REBOOT" ]; then
  say "Daily reboot at $DAILY_REBOOT"
  sed "s|@TIME@|$DAILY_REBOOT|g" "$SOURCE/pi/oto-box-reboot.timer" >/etc/systemd/system/oto-box-reboot.timer
  install -m 0644 "$SOURCE/pi/oto-box-reboot.service" /etc/systemd/system/oto-box-reboot.service
else
  systemctl disable --now oto-box-reboot.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/oto-box-reboot.timer /etc/systemd/system/oto-box-reboot.service
fi

# --- The television -------------------------------------------------------------
if [ "$WITH_KIOSK" -eq 1 ]; then
  [ -n "$KIOSK_USER" ] || die "which user is logged in to the desktop? pass --kiosk-user NAME"
  id "$KIOSK_USER" >/dev/null 2>&1 || die "no such user: $KIOSK_USER"
  KIOSK_UID="$(id -u "$KIOSK_USER")"
  say "oto-kiosk.service for $KIOSK_USER"
  install -m 0755 "$SOURCE/pi/oto-kiosk.sh" /usr/local/lib/oto-box/kiosk.sh
  sed -e "s|@USER@|$KIOSK_USER|g" -e "s|@UID@|$KIOSK_UID|g" "$SOURCE/pi/oto-kiosk.service" \
    >/etc/systemd/system/oto-kiosk.service
  if command -v raspi-config >/dev/null; then
    # Desktop, logged in automatically; and the screen never blanks.
    raspi-config nonint do_boot_behaviour B4 || warn "could not set desktop autologin"
    # The Wayland desktop's setting; X11 is the kiosk script's (xset).
    if raspi-config nonint do_blanking 1; then
      BLANKING_NOTE="off (raspi-config, the Wayland desktop's setting, from the next boot; the kiosk script covers X11)"
    else
      warn "could not switch screen blanking off"
      BLANKING_NOTE="NOT switched off: raspi-config refused (the warning above). Run: sudo raspi-config nonint do_blanking 1"
    fi
  else
    warn "raspi-config not found: set desktop autologin and switch screen blanking off by hand"
    BLANKING_NOTE="NOT switched off: raspi-config is not on this system; switch it off by hand"
  fi
fi

# --- SSH ------------------------------------------------------------------------
# Password log-in stays ON unless asked: switching it off with no key on the Pi
# locks everybody out of a box in a mall. Whatever is decided is said again at
# the end, so nobody is left believing the box is keys-only when it is not.
SSH_HOME="$(getent passwd "${KIOSK_USER:-root}" | cut -d: -f6)"
KEYS="${SSH_HOME:-/root}/.ssh/authorized_keys"
if [ "$SSH_KEYS_ONLY" -eq 1 ]; then
  if [ -s "$KEYS" ]; then
    install -d -m 0755 /etc/ssh/sshd_config.d
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/etc/ssh/sshd_config.d/oto-box.conf
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    say "SSH: keys only"
    SSH_NOTE="keys only (password log-in off; a key is in $KEYS)"
  else
    warn "no key in $KEYS: SSH password log-in left ON so you are not locked out"
    SSH_NOTE="password log-in still ON — no key in $KEYS. Put your public key there, then run the installer again with --ssh-keys-only"
  fi
elif [ -f /etc/ssh/sshd_config.d/oto-box.conf ]; then
  SSH_NOTE="keys only (set by an earlier install)"
elif [ -s "$KEYS" ]; then
  SSH_NOTE="password log-in still ON. A key is in $KEYS, so it can go off: run the installer again with --ssh-keys-only"
else
  SSH_NOTE="password log-in still ON. To switch it off, put your public key in $KEYS and run the installer again with --ssh-keys-only"
fi

# --- Start ----------------------------------------------------------------------
say "Starting"
systemctl daemon-reload
# restart, not enable --now: on an update the box is already running the old
# release, and --now leaves a running service alone.
systemctl enable oto-box.service
systemctl restart oto-box.service
systemctl enable --now oto-box-watchdog.timer
[ -n "$DAILY_REBOOT" ] && systemctl enable --now oto-box-reboot.timer
if [ "$WITH_KIOSK" -eq 1 ]; then
  systemctl enable oto-kiosk.service
  systemctl restart oto-kiosk.service || true
fi
sleep 3
systemctl --no-pager --lines=0 status oto-box.service || true

if [ "$PRINTER_DIRECT" -eq 1 ] && [ "$DHCP_OK" -eq 1 ]; then
  PRINTER_STEP="  3. The printer: plug it into the Pi's Ethernet socket with an ordinary network
     cable and switch it on; nothing on the printer needs setting. It asks the Pi
     for an address and the Pi always gives it $PRINTER_DHCP_ADDR. Once it has
     asked, its self-test page shows that address: with the cable in, switch the
     printer off and on, wait 20 seconds, then print the page (switch it off, hold
     FEED, switch it on and keep holding until it prints). \"None\" on the page
     means it has not asked yet, or the cable is not in: check the cable, switch
     it off and on, print the page again. In the Console, add the receipt printer
     to this box at $PRINTER_DHCP_ADDR:9100. Then create a booth station on this
     box, put staff on the booth, publish the wheel."
elif [ "$PRINTER_DIRECT" -eq 1 ]; then
  PRINTER_STEP="  3. The printer: plug it into the Pi's Ethernet socket with an ordinary network
     cable and switch it on. The Pi's address service for it (dnsmasq) is NOT
     running — the Printer line below says why — so the printer has no address
     until that is put right: run the installer again with --printer-direct, or
     set the printer to a fixed address by hand ($PRINTER_DHCP_ADDR, mask
     $PRINTER_LINK_NETMASK). In the Console, add the receipt printer to this box
     at $PRINTER_DHCP_ADDR:9100. Then create a booth station on this box, put
     staff on the booth, publish the wheel."
else
  PRINTER_STEP="  3. In the Console: add the receipt printer to this box at its network address,
     create a booth station on this box, put staff on the booth, publish the wheel."
fi

# The private network, whatever this run did about it: a box joined on an
# earlier run is reported too, with its address, so the summary always says
# how the box is reached and how the next release gets to it.
TS_SELF=""
if command -v tailscale >/dev/null; then TS_SELF="$(ts_name)"; fi
if [ -n "$TS_SELF" ]; then
  TS_NOTE="joined as $TS_SELF ($(ts_ip)). The next release, from the laptop: scripts/agent/push-release.sh $TS_SELF <release>.tgz -- <this box's options, without the key>"
fi

# A screen on an address of its own: it does not show the box's set-up page or
# the booth, and it pairs with the platform instead. Without one, the lines are
# as they have always been.
CLAIM_WHERE='Type it on the television ("Set up this box"), or here:'
FIRST_BOOT_STEP="  5. First install: reboot once (sudo reboot). The desktop logs in by itself and
     the television opens the booth; every boot after that does the same."
SCREEN_LINE=""
if [ "$WITH_KIOSK" -eq 1 ] && [ -n "$KIOSK_URL_NOW" ]; then
  CLAIM_WHERE="The screen is showing another page, not the box's set-up, so here:"
  FIRST_BOOT_STEP="  5. First install: reboot once (sudo reboot). The desktop logs in by itself and
     the screen opens its page; every boot after that does the same. It shows a
     pairing code: Console -> Devices -> Pair a display, enter the code, choose
     the station. The pairing is kept across reboots and updates."
  SCREEN_LINE="Screen: opens $KIOSK_URL_NOW, scale $(sed -n 's/^OTO_KIOSK_SCALE=//p' /etc/oto-box/config | tail -n 1), turn $(sed -n 's/^OTO_KIOSK_ROTATE=//p' /etc/oto-box/config | tail -n 1). Screen blanking: $BLANKING_NOTE. The monitor's own sleep timer is set in its own menu.
"
fi

cat <<EOF

Installed: oto-box $RELEASE, talking to $(grep '^OTO_BOX_API=' /etc/oto-box/config | cut -d= -f2-)

Next:
  1. In the Console: Devices -> Add a box. Copy the claim code (valid for a short time).
  2. $CLAIM_WHERE
       sudo oto-box claim          (it asks for the code, so the code stays out of the shell history)
$PRINTER_STEP
  4. Check:   oto-box status     journalctl -u oto-box -f     (the box row in Console -> Devices)
$FIRST_BOOT_STEP

SSH: $SSH_NOTE
Tailscale: $TS_NOTE
Printer: $PRINTER_NOTE
Scanner: $SCANNER_NOTE
Mirror: $MIRROR_NOTE
${SCREEN_LINE}The credential is /var/lib/oto-box/credential.json (owner-only). Never copy it to another machine.
EOF
