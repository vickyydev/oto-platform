#!/usr/bin/env bash
# The booth television: Chromium, full screen, on the booth box's own page.
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
PROFILE="${HOME}/.config/oto-kiosk"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# Wait for the desktop session: a Wayland socket (labwc or wayfire) or X11.
for _ in $(seq 1 120); do
  SOCKET="$(ls "${RUNTIME}"/wayland-? 2>/dev/null | head -n 1 || true)"
  if [ -n "$SOCKET" ]; then
    export WAYLAND_DISPLAY="$(basename "$SOCKET")"
    break
  fi
  if [ -S /tmp/.X11-unix/X0 ]; then
    export DISPLAY=:0
    break
  fi
  sleep 1
done
export XDG_RUNTIME_DIR="$RUNTIME"

# Wait (a minute at most) for the box to answer, so the first screen is the
# booth and not "this site can't be reached". It opens anyway after that: the
# page keeps asking on its own.
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 -o /dev/null "${BASE}kiosk/health" && break
  sleep 1
done

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
  --ozone-platform-hint=auto \
  --user-data-dir="${PROFILE}" \
  "$URL"
