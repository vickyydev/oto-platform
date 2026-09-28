#!/usr/bin/env bash
# Install (or update) the OTO booth box on a Raspberry Pi 5 (SCRUM-223).
#
#   sudo bash install.sh oto-box-0.1.0-<commit>.tgz [options]
#   sudo bash oto-box/pi/install.sh [options]        (from an unpacked release)
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
#   --rotate cw|ccw       which way the page turns a television hung portrait:
#                         cw (the default) or ccw if the picture is upside down
#   --printer-direct      the receipt printer plugs by network cable straight into
#                         the Pi's Ethernet socket, no router between them: gives
#                         eth0 a fixed address for it (192.168.192.10), runs a
#                         small DHCP server on that cable which always hands the
#                         printer 192.168.192.168, and leaves Wi-Fi and every
#                         other connection alone
#
# Written for Raspberry Pi OS 64-bit (Debian 12, Bookworm) WITH the desktop:
# the television is Chromium on that desktop, so Lite (no desktop) will not do.
# RUN ONCE ON A RASPBERRY PI 5 so far (the bench, 28 September 2026): the
# printer link came up. The printer's address service below is newer than that
# run, and the rest was checked for syntax and in pieces on a bench laptop, so
# read what it prints. Run it again with a newer release to update: the credential, the
# store and /etc/oto-box/config are kept, and the previous release stays on
# disk for a rollback (see PI_BOOTH.md).
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
PRINTER_DIRECT=0
PRINTER_IFACE="eth0"
PRINTER_LINK_ADDR="192.168.192.10/24"
PRINTER_LINK_NETMASK="255.255.255.0"   # the /24 of PRINTER_LINK_ADDR, written the way dnsmasq wants it
PRINTER_DHCP_ADDR="192.168.192.168"    # the one address the Pi hands the printer on that cable
PRINTER_DHCP_CONF="/etc/dnsmasq.d/oto-printer-link.conf"
TARBALL=""

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
    --rotate) ROTATE="${2:?--rotate needs cw or ccw}"; shift 2 ;;
    --printer-direct) PRINTER_DIRECT=1; shift ;;
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
  ""|cw|ccw) ;;
  *) die "--rotate wants cw or ccw, got $ROTATE" ;;
esac

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
  die "give the release tarball: sudo bash install.sh oto-box-<version>.tgz"
fi
[ -f "$SOURCE/oto-box.mjs" ] || die "$SOURCE is not an oto-box release (no oto-box.mjs)"
[ -f "$SOURCE/booth/index.html" ] || warn "this release has no booth page; the television will say so"
RELEASE="$(awk '{print $2"-"$3}' "$SOURCE/VERSION" 2>/dev/null | tr -c 'A-Za-z0-9.+-' '_' | sed 's/_*$//')"
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
# portrait — cw, or ccw when the picture is upside down. Then
#   sudo systemctl restart oto-kiosk
OTO_KIOSK_ROTATE=${ROTATE:-cw}
EOF
else
  if [ "$API_GIVEN" -eq 1 ]; then
    sed -i "s|^OTO_BOX_API=.*|OTO_BOX_API=$API_URL|" /etc/oto-box/config
  fi
  if [ -n "$ROTATE" ]; then
    if grep -q '^OTO_KIOSK_ROTATE=' /etc/oto-box/config; then
      sed -i "s|^OTO_KIOSK_ROTATE=.*|OTO_KIOSK_ROTATE=$ROTATE|" /etc/oto-box/config
    else
      printf 'OTO_KIOSK_ROTATE=%s\n' "$ROTATE" >>/etc/oto-box/config
    fi
  fi
fi
chmod 0644 /etc/oto-box/config

# The command, run as the service user so the files it writes are the box's.
install -d -m 0755 /usr/local/lib/oto-box
cat >/usr/local/bin/oto-box <<EOF
#!/usr/bin/env bash
# oto-box: the booth box's command, as the oto-box user, with /etc/oto-box/config.
set -a; . /etc/oto-box/config; set +a
# The box's files belong to the oto-box user: anybody else goes through sudo.
if [ "\$(id -u)" -ne 0 ] && [ "\$(id -un)" != oto-box ]; then exec sudo "\$0" "\$@"; fi
if [ "\$(id -u)" -eq 0 ]; then
  exec runuser -u oto-box -- env OTO_BOX_API="\$OTO_BOX_API" OTO_BOX_HOME="\$OTO_BOX_HOME" OTO_BOX_PORT="\$OTO_BOX_PORT" OTO_BOX_PAGE="\$OTO_BOX_PAGE" \\
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
    raspi-config nonint do_blanking 1 || warn "could not switch screen blanking off"
  else
    warn "raspi-config not found: set desktop autologin and switch screen blanking off by hand"
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

cat <<EOF

Installed: oto-box $RELEASE, talking to $(grep '^OTO_BOX_API=' /etc/oto-box/config | cut -d= -f2-)

Next:
  1. In the Console: Devices -> Add a box. Copy the claim code (valid for a short time).
  2. Type it on the television ("Set up this box"), or here:
       sudo oto-box claim          (it asks for the code, so the code stays out of the shell history)
$PRINTER_STEP
  4. Check:   oto-box status     journalctl -u oto-box -f     (the box row in Console -> Devices)
  5. First install: reboot once (sudo reboot). The desktop logs in by itself and
     the television opens the booth; every boot after that does the same.

SSH: $SSH_NOTE
Printer: $PRINTER_NOTE
The credential is /var/lib/oto-box/credential.json (owner-only). Never copy it to another machine.
EOF
