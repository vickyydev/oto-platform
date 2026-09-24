#!/usr/bin/env bash
# Restart the booth box when it stops answering its own health route.
#
# Two misses in a row, ten seconds apart, before a restart: one slow answer
# while the box writes a spin to the card is not a hang. A box somebody
# stopped on purpose is left alone; one systemd gave up on — too many
# crashes in a minute — is started again, or it would stay dark until the
# nightly reboot.
set -u
if systemctl is-failed --quiet oto-box.service; then
  logger -t oto-box-watchdog "the booth box had stopped after repeated failures; starting it again"
  systemctl reset-failed oto-box.service
  systemctl start oto-box.service
  exit 0
fi
systemctl is-active --quiet oto-box.service || exit 0
PORT="$(sed -n 's/^OTO_BOX_PORT=//p' /etc/oto-box/config 2>/dev/null)"
PORT="${PORT:-8780}"
for attempt in 1 2; do
  if curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:${PORT}/kiosk/health"; then
    exit 0
  fi
  [ "$attempt" -eq 1 ] && sleep 10
done
logger -t oto-box-watchdog "the booth box did not answer on 127.0.0.1:${PORT} twice; restarting it"
systemctl restart oto-box.service
