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
#   --ssh-keys-only       turn SSH password log-in off (only if a key is installed)
#   --no-kiosk            the box without the television (a headless test)
#   --rotate cw|ccw       which way the page turns a television hung portrait:
#                         cw (the default) or ccw if the picture is upside down
#
# Written for Raspberry Pi OS 64-bit (Debian 12, Bookworm) WITH the desktop:
# the television is Chromium on that desktop, so Lite (no desktop) will not do.
# NOT YET RUN ON A RASPBERRY PI: checked for syntax and in pieces on a bench
# laptop, so the first install at the bench is its first real run — read what
# it prints. Run it again with a newer release to update: the credential, the
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
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *.tgz|*.tar.gz) TARBALL="$1"; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
[ "$(uname -m)" = "aarch64" ] || warn "this is $(uname -m), not a 64-bit Pi (aarch64); continuing"
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
  [ "$(uname -m)" = "x86_64" ] && ARCH=x64
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
PREVIOUS="$(readlink -f /opt/oto-box/current 2>/dev/null || true)"
ln -sfn "$TARGET" /opt/oto-box/current.new
mv -T /opt/oto-box/current.new /opt/oto-box/current
[ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TARGET" ] && echo "previous release kept at $PREVIOUS"

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
if [ "$SSH_KEYS_ONLY" -eq 1 ]; then
  KEYS="$(getent passwd "${KIOSK_USER:-root}" | cut -d: -f6)/.ssh/authorized_keys"
  if [ -s "$KEYS" ]; then
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/etc/ssh/sshd_config.d/oto-box.conf
    systemctl reload ssh || systemctl reload sshd || true
    say "SSH: keys only"
  else
    warn "no key in $KEYS: SSH password log-in left ON so you are not locked out"
  fi
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

cat <<EOF

Installed: oto-box $RELEASE, talking to $(grep '^OTO_BOX_API=' /etc/oto-box/config | cut -d= -f2-)

Next:
  1. In the Console: Devices -> Add a box. Copy the claim code (valid for a short time).
  2. Type it on the television ("Set up this box"), or here:
       sudo oto-box claim <CODE>
  3. In the Console: add the receipt printer to this box at its network address,
     create a booth station on this box, put staff on the booth, publish the wheel.
  4. Check:   oto-box status     journalctl -u oto-box -f     (the box row in Console -> Devices)
  5. First install: reboot once (sudo reboot). The desktop logs in by itself and
     the television opens the booth; every boot after that does the same.

The credential is /var/lib/oto-box/credential.json (owner-only). Never copy it to another machine.
EOF
