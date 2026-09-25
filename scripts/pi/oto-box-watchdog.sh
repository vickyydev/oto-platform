#!/usr/bin/env bash
# Restart the booth box when it stops answering its own health route.
#
# Two misses in a row, ten seconds apart, before a restart: one slow answer
# while the box writes a spin to the card is not a hang. A box somebody
# stopped on purpose is left alone; one systemd gave up on — too many
# crashes in a minute — is started again, or it would stay dark until the
# nightly reboot.
#
# What is an answer: a 200 (the box runs), or a 503 whose body names the
# store — the box is up and needs service, its television says so, and a
# restart cannot mend a card (the box tries its store again every minute by
# itself). A miss: no answer, or a 503 that does not name the store, which is
# a box still starting — ten seconds later, a start that lasts.
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
NL=$'\n'
seen='no answer'
for attempt in 1 2; do
  # The body, then the status on a line of its own. Nothing when nothing
  # answered: curl fails (its reason goes to this unit's journal), and the
  # reply is dropped.
  reply="$(curl -sS --max-time 10 -w '\n%{http_code}' "http://127.0.0.1:${PORT}/kiosk/health")" || reply=''
  status="${reply##*"$NL"}"
  body="${reply%"$NL"*}"
  case "$status" in
    200) exit 0 ;;
    503)
      if printf '%s' "$body" | grep -Eq '"store"[[:space:]]*:[[:space:]]*"[a-z_]+"'; then exit 0; fi
      if printf '%s' "$body" | grep -q '"starting":true'; then seen='still starting'; else seen='HTTP 503'; fi
      ;;
    '') seen='no answer' ;;
    *) seen="HTTP ${status}" ;;
  esac
  [ "$attempt" -eq 1 ] && sleep 10
done
logger -t oto-box-watchdog "the booth box did not answer on 127.0.0.1:${PORT} twice (last: ${seen}); restarting it"
systemctl restart oto-box.service
