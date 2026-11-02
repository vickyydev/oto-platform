#!/usr/bin/env bash
# The booth television: Chromium, full screen, on the booth box's own page —
# or on another address, when OTO_KIOSK_URL says so (the counter's customer
# display, SCRUM-711).
# Run by oto-kiosk.service as the desktop user; systemd starts it again
# whenever Chromium exits or dies.
set -u

PORT="$(sed -n 's/^OTO_BOX_PORT=//p' /etc/oto-box/config 2>/dev/null)"
PORT="${PORT:-8780}"
BASE="http://127.0.0.1:${PORT}/"
# Which way the page turns the picture on a television that is hung portrait
# but sends a landscape signal: cw (the default), or ccw for a television hung
# the other way round, whose picture would otherwise be upside down. Set
# OTO_KIOSK_ROTATE in /etc/oto-box/config — this script runs as the desktop
# user, which can read that file and not the box's own (0700) folder — then
# sudo systemctl restart oto-kiosk.
ROTATE="$(sed -n 's/^OTO_KIOSK_ROTATE=//p' /etc/oto-box/config 2>/dev/null | tr -d '[:space:]')"
case "$ROTATE" in
  cw|ccw|off) ;;
  *) ROTATE=cw ;;
esac
# The page reads the turn from the address (#cw, #ccw, #off) and remembers it.
URL="${BASE}#${ROTATE}"
# Set OTO_KIOSK_URL and the screen opens that address instead: the display page
# is the platform's, not the box's. "off" is a screen with nothing to turn, so
# nothing goes on that address. Same file, same restart.
KIOSK_URL="$(sed -n 's/^OTO_KIOSK_URL=//p' /etc/oto-box/config 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
if [ -n "$KIOSK_URL" ]; then
  URL="$KIOSK_URL"
  [ "$ROTATE" = off ] || URL="${KIOSK_URL}#${ROTATE}"
fi
# How large the page is drawn, for a screen whose pixels are small: 1 asks for
# nothing, the booth's way. Chromium's flag, so the page simply sees a smaller
# window (1920 x 1080 at 1.6 is 1200 x 675).
SCALE="$(sed -n 's/^OTO_KIOSK_SCALE=//p' /etc/oto-box/config 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
SCALE_FLAG=()
case "$SCALE" in
  ''|1|1.0) ;;
  *[!0-9.]*) echo "OTO_KIOSK_SCALE is not a number ($SCALE); drawing at 1" >&2 ;;
  *) SCALE_FLAG=("--force-device-scale-factor=${SCALE}") ;;
esac
# Kept for good, and never cleared here: whatever the page remembers lives in
# it, and on the counter that is the display's pairing, which has to come back
# by itself after a reboot or a release update.
PROFILE="${HOME}/.config/oto-kiosk"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# Wait for the desktop session: a Wayland socket (labwc or wayfire) or X11.
# Chromium is then told which of the two to use, outright. Left to guess
# ("--ozone-platform-hint=auto"), it has no logged-in session to read the
# answer from — this script runs as a system service, not inside the desktop's
# own environment — so it picks X11 and dies with "Missing X server or
# $DISPLAY", and systemd starts it again every five seconds while the screen
# shows the bare desktop. That is what the first Pi at the bench did (28
# September 2026). The session's message bus is named for the same reason:
# without it Chromium logs "Failed to connect to the bus" on every start.
OZONE=""
for _ in $(seq 1 120); do
  SOCKET="$(ls "${RUNTIME}"/wayland-? 2>/dev/null | head -n 1 || true)"
  if [ -n "$SOCKET" ]; then
    export WAYLAND_DISPLAY="$(basename "$SOCKET")"
    OZONE=wayland
    break
  fi
  if [ -S /tmp/.X11-unix/X0 ]; then
    export DISPLAY=:0
    OZONE=x11
    break
  fi
  sleep 1
done
export XDG_RUNTIME_DIR="$RUNTIME"
if [ -S "${RUNTIME}/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${RUNTIME}/bus"
fi

# Wait (a minute at most) for the box to answer, so the first screen is the
# booth and not "this site can't be reached". Any answer will do, a 503 too:
# a box that is still starting, or that needs service, serves the page that
# says so. It opens anyway after that: the page keeps asking on its own.
#
# A page that is not the box's: its health says nothing about that, so the wait
# is on the page itself, which at boot means the Wi-Fi. A minute or so at most;
# it opens anyway after that.
if [ -z "$KIOSK_URL" ]; then
  for _ in $(seq 1 60); do
    curl -sS --max-time 2 -o /dev/null "${BASE}kiosk/health" && break
    sleep 1
  done
else
  for _ in $(seq 1 30); do
    curl -sS --max-time 2 -o /dev/null "$KIOSK_URL" && break
    sleep 1
  done
fi

# The screen never blanks. (raspi-config's setting covers Wayland; this is X11.)
if [ -n "${DISPLAY:-}" ] && command -v xset >/dev/null; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi

# A Chromium killed by a power cut asks to restore its tabs on the next start.
# A booth has nothing to restore.
mkdir -p "${PROFILE}/Default"
if [ -f "${PROFILE}/Default/Preferences" ]; then
  sed -i -e 's/"exited_cleanly":false/"exited_cleanly":true/' \
    -e 's/"exit_type":"[^"]*"/"exit_type":"Normal"/' "${PROFILE}/Default/Preferences" || true
fi

BROWSER="$(command -v chromium-browser || command -v chromium)"
[ -n "$BROWSER" ] || { echo "no Chromium installed" >&2; exit 1; }

# Chromium's cache goes in RAM, on every box: it rewrites this all day, it is
# worth nothing after a reboot, and the drive lasts longer without it.
exec "$BROWSER" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-features=Translate,TranslateUI,MediaRouter \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --ozone-platform="${OZONE:-x11}" \
  "${SCALE_FLAG[@]}" \
  --disk-cache-dir=/dev/shm/oto-kiosk-cache \
  --disk-cache-size=67108864 \
  --user-data-dir="${PROFILE}" \
  "$URL"
