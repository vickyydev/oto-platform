#!/usr/bin/env bash
# The counter's customer display standing on its end (SCRUM-928) and its
# camera (SCRUM-896): helpers for install.sh --display-rotate, --display-output
# and --display-camera. Sourced by install.sh; no action on source. Not yet run
# on a real Pi: each helper is proved against copies of the files it reads and
# writes (packages/box-agent/test/s928-display-install.test.ts), and what must
# still be tried on the Pi is listed in BOX_QUICKSTART.md part I.
#
# THE TURN. Raspberry Pi OS's desktop (labwc, Wayland) starts kanshi at every
# log-in from its autostart file, and kanshi applies the FIRST profile in
# ~/.config/kanshi/config whose outputs are all connected: the file the Screen
# Configuration tool writes, and where the park's screen was turned by hand.
# The box's profile goes at the top of that file between two marked lines, so
# it is the one kanshi applies; whatever the file held stays below it, byte for
# byte, and applies again once the box's block is taken out.
#
# THE TOUCH. A touch screen follows the output's turn only when the compositor
# maps it to that output: labwc's <touch mapToOutput="..."/> in
# ~/.config/labwc/rc.xml. labwc looks its touch settings up from the LAST one
# written, device by name first, then the last one with no deviceName (the
# fallback for every touch device). The box's block goes just before the
# file's closing tag, so it is the last: one line for the touch screen it
# found by name (when there is exactly one) and one fallback line. A file the
# user did not have is made from the system's own rc.xml, so nothing the
# desktop had is lost, and is deleted again on "off" if nobody changed it.
#
# THE CAMERA. Chromium's managed policy VideoCaptureAllowedUrls lets the
# origins it names use the camera without asking; it is written for the origin
# of the screen's address only, never a pattern for every site, in Chromium's
# own policy folder (/etc/chromium/policies/managed) and in
# /etc/chromium-browser/policies/managed where that package's folder exists.

DISPLAY_KANSHI_BEGIN='# >>> oto-box display (SCRUM-928): written by the OTO box installer; --display-rotate off removes this block'
DISPLAY_KANSHI_END='# <<< oto-box display (SCRUM-928)'
# XML comments may not hold two hyphens in a row: no option names in these.
DISPLAY_XML_BEGIN='<!-- >>> oto-box display (SCRUM-928): written by the OTO box installer; its display-rotate off removes this block -->'
DISPLAY_XML_END='<!-- <<< oto-box display (SCRUM-928) -->'
DISPLAY_XML_MADE='<!-- oto-box display (SCRUM-928): this file was made by the OTO box installer from the system rc.xml -->'
DISPLAY_XML_MINIMAL='<?xml version="1.0"?>
<labwc_config>
</labwc_config>
'
DISPLAY_CAMERA_FILE='oto-box-display-camera.json'

# One value from the box's config file, the last line that sets it; nothing
# when the file or the line is not there.
display_config_get() {
  [ -r "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

# The connected outputs, by the names the desktop gives them (HDMI-A-1,
# HDMI-A-2, DSI-1): the kernel's connectors, <drm>/card<N>-<name>, whose
# status reads "connected". Readable without a desktop session.
display_connected_outputs() {
  local drm="$1" dir name status
  for dir in "$drm"/card*-*; do
    [ -r "$dir/status" ] || continue
    status="$(cat "$dir/status" 2>/dev/null || true)"
    [ "$status" = connected ] || continue
    name="${dir##*/}"
    name="${name#card*-}"
    case "$name" in Writeback-*) continue ;; esac
    printf '%s\n' "$name"
  done
}

# The touch screens plugged in, by the names libinput gives them: the input
# devices whose properties say DIRECT (a screen, not a touch pad), from the
# kernel's list (/proc/bus/input/devices).
display_touch_devices() {
  local file="$1" line name="" prop=""
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      'N: Name="'*) name="${line#N: Name=\"}"; name="${name%\"}" ;;
      'B: PROP='*) prop="${line#B: PROP=}"; prop="${prop##* }" ;;
      '')
        if [ -n "$name" ] && [[ "$prop" =~ ^[0-9A-Fa-f]{1,8}$ ]] && (( 16#$prop & 2 )); then
          printf '%s\n' "$name"
        fi
        name=""; prop=""
        ;;
    esac
  done <"$file"
  if [ -n "$name" ] && [[ "$prop" =~ ^[0-9A-Fa-f]{1,8}$ ]] && (( 16#$prop & 2 )); then
    printf '%s\n' "$name"
  fi
}

display_xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

# FILE without the lines from BEGIN to END (both kept out), on stdout.
display_without_block() {
  awk -v b="$2" -v e="$3" '
    !skip && $0 == b { skip = 1; next }
    skip { if ($0 == e) skip = 0; next }
    { print }
  ' "$1"
}

# Write CONTENT to FILE: an existing file keeps its owner and mode (it is
# written in place); a new one gets 0644 and OWNER (user:group) when given.
display_write() {
  local file="$1" content="$2" owner="${3:-}"
  if [ -f "$file" ]; then
    printf '%s' "$content" >"$file"
  else
    display_dirs "$owner" "${file%/*}"
    printf '%s' "$content" >"$file"
    chmod 0644 "$file"
    [ -z "$owner" ] || chown "$owner" "$file" 2>/dev/null || true
  fi
}

# Make each folder that is missing (0755, OWNER when given); one that is there
# is left exactly as it is.
display_dirs() {
  local owner="$1" dir
  shift
  for dir in "$@"; do
    [ -d "$dir" ] && continue
    mkdir -p -m 0755 "$dir"
    [ -z "$owner" ] || chown "$owner" "$dir" 2>/dev/null || true
  done
}

# The box's kanshi profile at the top of FILE: OUTPUT turned TRANSFORM.
display_kanshi_set() {
  local file="$1" output="$2" transform="$3" owner="${4:-}" rest=""
  if [ -f "$file" ]; then rest="$(display_without_block "$file" "$DISPLAY_KANSHI_BEGIN" "$DISPLAY_KANSHI_END"; printf x)"; rest="${rest%x}"; fi
  display_write "$file" "$DISPLAY_KANSHI_BEGIN
profile oto-box-display {
	output $output enable transform $transform
}
$DISPLAY_KANSHI_END
$rest" "$owner"
}

# Take the box's block out of FILE; a file that held nothing else goes. Says
# (exit 0) whether there was a block to take out.
display_kanshi_clear() {
  local file="$1" rest
  [ -f "$file" ] && grep -qxF "$DISPLAY_KANSHI_BEGIN" "$file" || return 1
  rest="$(display_without_block "$file" "$DISPLAY_KANSHI_BEGIN" "$DISPLAY_KANSHI_END"; printf x)"
  rest="${rest%x}"
  if [ -z "$(printf '%s' "$rest" | tr -d '[:space:]')" ]; then rm -f "$file"; else printf '%s' "$rest" >"$file"; fi
}

# The box's touch lines just before the closing tag of the labwc rc.xml FILE:
# every touch screen to OUTPUT, and TOUCH (a device name) by name when given.
# A FILE that is not there is made from SYSTEM (the system's rc.xml) or, with
# none, from an empty configuration. Fails (exit 1, nothing written) when the
# file has no closing tag it knows.
display_labwc_set() {
  local file="$1" output="$2" touch="$3" system="$4" owner="${5:-}" content close before after block
  if [ -f "$file" ]; then
    content="$(display_without_block "$file" "$DISPLAY_XML_BEGIN" "$DISPLAY_XML_END"; printf x)"; content="${content%x}"
  elif [ -r "$system" ]; then
    content="$(cat "$system"; printf x)"; content="${content%x}"
    content="$content$DISPLAY_XML_MADE
"
  else
    content="$DISPLAY_XML_MINIMAL$DISPLAY_XML_MADE
"
  fi
  case "$content" in
    *'</labwc_config>'*) close='</labwc_config>' ;;
    *'</openbox_config>'*) close='</openbox_config>' ;;
    *) return 1 ;;
  esac
  block="$DISPLAY_XML_BEGIN
"
  [ -z "$touch" ] || block="$block<touch deviceName=\"$(display_xml_escape "$touch")\" mapToOutput=\"$output\" mouseEmulation=\"no\" />
"
  block="$block<touch mapToOutput=\"$output\" mouseEmulation=\"no\" />
$DISPLAY_XML_END
"
  before="${content%"$close"*}"
  after="${content##*"$close"}"
  case "$before" in ''|*$'\n') ;; *) before="$before"$'\n' ;; esac
  display_write "$file" "$before$block$close$after" "$owner"
}

# Take the box's touch lines out of FILE; a file the installer made, which
# nobody has changed since, goes. Says whether there were lines to take out.
display_labwc_clear() {
  local file="$1" system="$2" rest base
  [ -f "$file" ] && grep -qxF "$DISPLAY_XML_BEGIN" "$file" || return 1
  rest="$(display_without_block "$file" "$DISPLAY_XML_BEGIN" "$DISPLAY_XML_END"; printf x)"
  rest="${rest%x}"
  base="$DISPLAY_XML_MINIMAL"
  if [ -r "$system" ]; then base="$(cat "$system"; printf x)"; base="${base%x}"; fi
  if [ "$rest" = "$base$DISPLAY_XML_MADE
" ]; then
    rm -f "$file"
  else
    printf '%s' "$rest" >"$file"
  fi
}

# The origin of an http(s) address: scheme://host[:port], lower case, with no
# user part and no default port. Nothing (exit 1) for anything else.
display_origin() {
  local url="$1" scheme rest authority host port=""
  case "$url" in http://*|https://*) ;; *) return 1 ;; esac
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%[/?#]*}"
  authority="${authority##*@}"
  [ -n "$authority" ] || return 1
  host="$authority"
  case "$authority" in
    \[*\]:*|[!\[]*:*) host="${authority%:*}"; port="${authority##*:}" ;;
  esac
  host="$(printf '%s' "$host" | tr 'A-Z' 'a-z')"
  [[ "$host" =~ ^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$ ]] || return 1
  [ -z "$port" ] || [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
  if [ "$scheme:$port" = "https:443" ] || [ "$scheme:$port" = "http:80" ]; then port=""; fi
  printf '%s://%s%s' "$scheme" "$host" "${port:+:$port}"
}

# The policy folders the camera file goes in: Chromium's own always, the
# others named in ROOTS when that package's folder is on this machine.
display_policy_dirs() {
  local first=1 root
  for root in "$@"; do
    if [ "$first" -eq 1 ] || [ -d "$root" ]; then printf '%s\n' "$root/policies/managed"; fi
    first=0
  done
}

# Let ORIGIN use the camera without a tap: the policy file in each folder.
display_camera_set() {
  local origin="$1" dir
  shift
  while IFS= read -r dir; do
    display_dirs "" "$dir"
    printf '{\n  "VideoCaptureAllowedUrls": ["%s/"]\n}\n' "$origin" >"$dir/$DISPLAY_CAMERA_FILE"
    chmod 0644 "$dir/$DISPLAY_CAMERA_FILE"
  done < <(display_policy_dirs "$@")
}

# Take the box's camera file out of every folder; nothing else there changes.
# Says whether there was one.
display_camera_clear() {
  local root found=1
  for root in "$@"; do
    if [ -f "$root/policies/managed/$DISPLAY_CAMERA_FILE" ]; then
      rm -f "$root/policies/managed/$DISPLAY_CAMERA_FILE"
      found=0
    fi
  done
  return "$found"
}

# Settle what this run does about the display before anything is changed,
# from the run's options and what an earlier run kept in CONFIG, and refuse
# what cannot work. Sets DISPLAY_ROTATE_NOW (90, 180, 270 or off),
# DISPLAY_OUTPUT_NOW, DISPLAY_CAMERA_NOW (allow or off), DISPLAY_ORIGIN_NOW and
# DISPLAY_OUTPUTS_SEEN. Reads install.sh's WITH_KIOSK, ROTATE, KIOSK_URL,
# KIOSK_URL_GIVEN, DISPLAY_ROTATE, DISPLAY_OUTPUT and DISPLAY_CAMERA; stops with
# install.sh's die.
display_preflight() {
  local config="$1" drm="$2" url page_rotate stored_output
  local -a seen=()
  DISPLAY_ROTATE_NOW=off; DISPLAY_OUTPUT_NOW=""; DISPLAY_CAMERA_NOW=off; DISPLAY_ORIGIN_NOW=""; DISPLAY_OUTPUTS_SEEN=""
  if [ "$WITH_KIOSK" -eq 0 ]; then
    [ "${DISPLAY_ROTATE:-off}" = off ] || die "--display-rotate turns the customer display's screen, and --no-kiosk says there is no screen: pass one of them"
    [ "${DISPLAY_CAMERA:-off}" = off ] || die "--display-camera lets the customer display use the camera, and --no-kiosk says there is no screen: pass one of them"
    return 0
  fi
  DISPLAY_ROTATE_NOW="${DISPLAY_ROTATE:-$(display_config_get "$config" OTO_DISPLAY_ROTATE)}"
  DISPLAY_ROTATE_NOW="${DISPLAY_ROTATE_NOW:-off}"
  DISPLAY_CAMERA_NOW="${DISPLAY_CAMERA:-$(display_config_get "$config" OTO_DISPLAY_CAMERA)}"
  DISPLAY_CAMERA_NOW="${DISPLAY_CAMERA_NOW:-off}"
  if [ "$KIOSK_URL_GIVEN" -eq 1 ]; then url="$KIOSK_URL"; else url="$(display_config_get "$config" OTO_KIOSK_URL)"; fi
  page_rotate="${ROTATE:-$(display_config_get "$config" OTO_KIOSK_ROTATE)}"
  page_rotate="${page_rotate:-cw}"
  if [ "$DISPLAY_ROTATE_NOW" != off ]; then
    [ -n "$url" ] || die "--display-rotate turns a screen that opens a display address (--kiosk-url), and this one opens the box's own booth page, which turns itself with --rotate: give --kiosk-url, or --display-rotate off"
    [ "$page_rotate" = off ] || die "--display-rotate turns the screen itself, so the page must not turn as well (the page's turn is $page_rotate): add --rotate off"
    mapfile -t seen < <(display_connected_outputs "$drm")
    DISPLAY_OUTPUTS_SEEN="${seen[*]:-}"
    stored_output="$(display_config_get "$config" OTO_DISPLAY_OUTPUT)"
    if [ -n "$DISPLAY_OUTPUT" ]; then
      DISPLAY_OUTPUT_NOW="$DISPLAY_OUTPUT"
    elif [ "${#seen[@]}" -eq 1 ]; then
      DISPLAY_OUTPUT_NOW="${seen[0]}"
    elif [ -n "$stored_output" ] && { [ "${#seen[@]}" -eq 0 ] || [[ " ${seen[*]} " == *" $stored_output "* ]]; }; then
      DISPLAY_OUTPUT_NOW="$stored_output"
    elif [ "${#seen[@]}" -eq 0 ]; then
      die "--display-rotate: no screen is connected that this Pi can see (is the monitor on, and its HDMI cable in?). Switch it on and run the installer again, or name its output with --display-output, e.g. --display-output HDMI-A-1"
    else
      die "--display-rotate: more than one screen is connected (${seen[*]}): name the customer display's with --display-output, e.g. --display-output ${seen[0]}"
    fi
  fi
  if [ "$DISPLAY_CAMERA_NOW" = allow ]; then
    [ -n "$url" ] || die "--display-camera allow lets the display's address use the camera, and this screen opens the box's own booth page: give --kiosk-url, or --display-camera off"
    DISPLAY_ORIGIN_NOW="$(display_origin "$url")" || die "--display-camera allow: the screen's address ($url) has no origin the camera can be allowed for"
  fi
}

# Write, or take out, the turn and the touch for the desktop user whose home
# is HOME (files owned by OWNER, user:group), as display_preflight settled
# them. SYSTEM_RC, AUTOSTARTS (space-separated) and UDEV are the system files
# it reads to say what the desktop will do with them. Sets DISPLAY_NOTE.
display_turn_apply() {
  local home="$1" owner="$2" inputs="$3" system_rc="$4" autostarts="$5" udev="$6"
  local kanshi="$home/.config/kanshi/config" rc="$home/.config/labwc/rc.xml"
  local touch="" note="" kept="" file
  local -a touches=()
  if [ "$DISPLAY_ROTATE_NOW" = off ]; then
    local undone=""
    display_kanshi_clear "$kanshi" && undone="the box's turn taken out of $kanshi"
    display_labwc_clear "$rc" "$system_rc" && undone="${undone:+$undone; }the box's touch lines taken out of $rc"
    if [ -n "$undone" ]; then
      note="off: $undone. From the next boot (sudo reboot) the desktop shows the screen as it is made"
      if [ -f "$kanshi" ]; then note="$note, or as the profile still in $kanshi turns it"; fi
      DISPLAY_NOTE="$note"
    else
      DISPLAY_NOTE=""
    fi
    return 0
  fi
  mapfile -t touches < <(display_touch_devices "$inputs")
  [ "${#touches[@]}" -ne 1 ] || touch="${touches[0]}"
  if [ -f "$kanshi" ] && [ -n "$(display_without_block "$kanshi" "$DISPLAY_KANSHI_BEGIN" "$DISPLAY_KANSHI_END" | grep -v '^[[:space:]]*#' | tr -d '[:space:]')" ]; then
    kept="the profile(s) already in that file are kept below the box's and apply again with --display-rotate off"
  fi
  display_dirs "$owner" "$home/.config" "$home/.config/kanshi" "$home/.config/labwc"
  display_kanshi_set "$kanshi" "$DISPLAY_OUTPUT_NOW" "$DISPLAY_ROTATE_NOW" "$owner"
  note="$DISPLAY_ROTATE_NOW on $DISPLAY_OUTPUT_NOW, from the next boot (sudo reboot): the box's profile at the top of $kanshi${kept:+ ($kept)}"
  if display_labwc_set "$rc" "$DISPLAY_OUTPUT_NOW" "$touch" "$system_rc" "$owner"; then
    if [ -n "$touch" ]; then
      note="$note; touch mapped to $DISPLAY_OUTPUT_NOW in $rc (\"$touch\", and every other touch screen)"
    elif [ "${#touches[@]}" -eq 0 ]; then
      note="$note; touch mapped to $DISPLAY_OUTPUT_NOW in $rc for every touch screen (none is plugged in now: plug the monitor's touch cable in)"
    else
      note="$note; touch mapped to $DISPLAY_OUTPUT_NOW in $rc for every touch screen (${#touches[@]} are plugged in)"
    fi
  else
    warn "$rc has no closing </labwc_config> or </openbox_config> tag, so the touch was NOT mapped: a press may land away from where it is pressed"
    note="$note; touch NOT mapped ($rc has no closing tag the installer knows)"
  fi
  local starts=0
  for file in $autostarts; do grep -qs kanshi "$file" && starts=1; done
  if [ "$starts" -eq 0 ]; then
    warn "nothing in the desktop's autostart ($autostarts) starts kanshi, so the turn is written but this desktop may not apply it: Raspberry Pi OS with labwc starts it"
    note="$note. WARNING: this desktop's autostart does not start kanshi"
  fi
  local matrix=""
  matrix="$(grep -ls LIBINPUT_CALIBRATION_MATRIX "$udev"/*.rules 2>/dev/null | tr '\n' ' ' || true)"
  if [ -n "$matrix" ]; then
    warn "a touch calibration made by hand is in ${matrix% }: with the box's mapping the touch may now turn twice. If a press lands in the wrong place, take that rule out (and reboot)"
    note="$note. WARNING: a hand-made touch calibration is in ${matrix% }"
  fi
  DISPLAY_NOTE="$note"
}

# Write, or take out, the camera policy for the screen's origin, as
# display_preflight settled it. ROOTS are Chromium's configuration folders.
# Sets CAMERA_NOTE.
display_camera_apply() {
  if [ "$DISPLAY_CAMERA_NOW" = allow ]; then
    display_camera_set "$DISPLAY_ORIGIN_NOW" "$@"
    CAMERA_NOTE="allowed without a tap for $DISPLAY_ORIGIN_NOW only (Chromium policy $(display_policy_dirs "$@" | sed "s|\$|/$DISPLAY_CAMERA_FILE|" | tr '\n' ' ' | sed 's/ $//')), from the next start of the screen"
  elif display_camera_clear "$@"; then
    CAMERA_NOTE="off: the box's camera policy taken out; the display's page asks before it uses the camera, from the next start of the screen"
  else
    CAMERA_NOTE=""
  fi
}
