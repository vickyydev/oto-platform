#!/bin/sh
# Push a box release to a Raspberry Pi box and install it there (SCRUM-701).
#
#   scripts/agent/push-release.sh HOST FILE [--dry-run] [-- INSTALLER FLAGS]
#
#   HOST       the box's name or address on the private network (oto-till,
#              100.89.6.16), or a local-network address for a box that is not
#              on it yet
#   FILE       the release, oto-box-<version>-<date>-<commit>.tgz, with
#              FILE.sha256 beside it: CI's "Pi release" artifact and
#              `pnpm --filter @oto/box-agent pack:pi` both write the pair.
#              Refused without the checksum
#   --dry-run  print the commands and run none of them
#   --         everything after it goes to the installer on the box, e.g.
#                -- --api https://oto-api-staging.onrender.com --no-kiosk --printer-direct
#
# From the laptop it copies the file and its checksum to oto@HOST; on the box
# it checks the checksum, unpacks the release and runs its installer with the
# flags given. The build line before and after is printed, and any failure
# ends the run with a non-zero exit. The SSH key: PUSH_RELEASE_KEY (the
# environment, else the repo-root .env), else ~/.ssh/oto_till_ed25519 when
# that file exists, else ssh's own keys; a box reached over Tailscale SSH
# needs none. Plain sh, so Git Bash on Windows and a Mac shell run it alike.
set -eu

usage() { sed -n '2,/^$/p' "$0"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

HOST=""
FILE=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (installer flags go after --)" ;;
    *)
      if [ -z "$HOST" ]; then HOST="$1"
      elif [ -z "$FILE" ]; then FILE="$1"
      else die "unexpected argument: $1 (installer flags go after --)"
      fi
      shift ;;
  esac
done
[ -n "$HOST" ] && [ -n "$FILE" ] || { usage >&2; exit 2; }
# What is left in $@ are the installer's flags.

# --- The release and its checksum ------------------------------------------
# Git Bash accepts a Windows path for the file test; scp would read "C:" as
# a host name, so the path is turned into its POSIX form where cygpath exists.
if command -v cygpath >/dev/null 2>&1; then FILE="$(cygpath -u "$FILE")"; fi
[ -f "$FILE" ] || die "no such file: $FILE"
SUM="$FILE.sha256"
[ -f "$SUM" ] || die "no checksum beside the release: $SUM is missing. CI's artifact and pack:pi write it; without it the box cannot check what it was handed"
NAME="$(basename "$FILE")"
case "$NAME" in
  *.tgz|*.tar.gz) ;;
  *) die "not a release tarball: $NAME" ;;
esac
case "$NAME" in
  *[!A-Za-z0-9._+-]*) die "a release file name has only letters, digits, . _ + and -: $NAME" ;;
esac
# `sha256sum -c` on the box reads "<hash>  <name>" (or "<hash> *<name>"), and
# the name must be the file's: a renamed download is refused here, not there.
LINE="$(head -n 1 "$SUM" | tr -d '\r')"
HASH="${LINE%% *}"
NAMED="${LINE#* }"
NAMED="${NAMED# }"
NAMED="${NAMED#\*}"
printf '%s' "$HASH" | grep -Eq '^[0-9a-f]{64}$' || die "$SUM does not start with a SHA-256: it reads \"$LINE\""
[ "$NAMED" = "$NAME" ] || die "$SUM names \"$NAMED\", not $NAME: sha256sum -c on the box would refuse it. Rename the file back, or ask for the pair again"
# The same check here, when the laptop has a tool for it: a damaged file is
# refused before it is copied anywhere.
LOCAL=""
if command -v sha256sum >/dev/null 2>&1; then LOCAL="$(sha256sum "$FILE")"
elif command -v shasum >/dev/null 2>&1; then LOCAL="$(shasum -a 256 "$FILE")"
fi
if [ -n "$LOCAL" ]; then
  [ "${LOCAL%% *}" = "$HASH" ] || die "$NAME does not match $SUM on this machine: the file is damaged or is not the one the checksum was made for"
fi

# --- The key and the box ----------------------------------------------------
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KEY="${PUSH_RELEASE_KEY:-}"
if [ -z "$KEY" ] && [ -f "$ROOT/.env" ]; then
  KEY="$(sed -n 's/^PUSH_RELEASE_KEY=//p' "$ROOT/.env" | head -n 1)"
fi
if [ -z "$KEY" ] && [ -f "${HOME:-}/.ssh/oto_till_ed25519" ]; then KEY="$HOME/.ssh/oto_till_ed25519"; fi
if [ -n "$KEY" ]; then
  if command -v cygpath >/dev/null 2>&1; then KEY="$(cygpath -u "$KEY")"; fi
  [ -f "$KEY" ] || die "no such key: $KEY (PUSH_RELEASE_KEY)"
fi
TARGET="oto@$HOST"
# BatchMode: no prompt for a password or a passphrase, so a key the box does
# not know fails at once with ssh's own message. accept-new: a box reached for
# the first time is trusted on first use; a box whose host key CHANGED is
# refused, as it should be.
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
KEY_OPT=""
[ -z "$KEY" ] || KEY_OPT="-i $KEY"

# --- What runs on the box ---------------------------------------------------
# Each installer flag single-quoted for the box's shell, so a URL or a key
# arrives as one word whatever it holds.
FLAGS=""
for arg in "$@"; do
  q="$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")"
  FLAGS="$FLAGS '$q'"
done
BEFORE="command -v oto-box >/dev/null 2>&1 && oto-box status | head -1 || echo '(no box installed yet)'"
REMOTE="set -e
cd ~
sha256sum -c '$NAME.sha256'
rm -rf oto-box
tar -xzf '$NAME'
sudo bash oto-box/pi/install.sh$FLAGS
oto-box status | head -1"
AFTER="oto-box status | head -1"

echo "Release: $NAME (sha256 $HASH)"
echo "Box:     $TARGET${KEY:+ (key $KEY)}"

if [ "$DRY" -eq 1 ]; then
  echo
  echo "Dry run — these are the commands; none of them ran:"
  echo
  echo "ssh $SSH_OPTS $KEY_OPT $TARGET \"$BEFORE\""
  echo "scp -q $SSH_OPTS $KEY_OPT $FILE $SUM $TARGET:"
  echo "ssh $SSH_OPTS $KEY_OPT $TARGET <the script below, as one argument>"
  printf '%s\n' "$REMOTE" | sed 's/^/    /'
  echo "ssh $SSH_OPTS $KEY_OPT $TARGET \"$AFTER\""
  exit 0
fi

# $SSH_OPTS and $KEY_OPT are split on purpose: a list of options, no spaces
# inside any of them (the key path is quoted by itself below).
remote() {
  if [ -n "$KEY" ]; then
    # shellcheck disable=SC2086
    ssh $SSH_OPTS -i "$KEY" "$TARGET" "$1"
  else
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "$TARGET" "$1"
  fi
}

printf 'Before:  '
remote "$BEFORE" || die "could not reach $TARGET (ssh's message is above). On the private network: is the laptop on it, and is the box? On a local address: same Wi-Fi, and the key the box was set up with (PUSH_RELEASE_KEY)"
echo "Copying $NAME and its checksum to $TARGET"
if [ -n "$KEY" ]; then
  # shellcheck disable=SC2086
  scp -q $SSH_OPTS -i "$KEY" "$FILE" "$SUM" "$TARGET:" || die "the copy to $TARGET failed (scp's message is above)"
else
  # shellcheck disable=SC2086
  scp -q $SSH_OPTS "$FILE" "$SUM" "$TARGET:" || die "the copy to $TARGET failed (scp's message is above)"
fi
echo "Installing on $TARGET (the installer's own output follows)"
remote "$REMOTE" || die "the install on $TARGET did not complete (its output is above). The box runs what it ran before unless the installer got as far as 'Starting'"
printf 'After:   '
remote "$AFTER" || die "the install finished but the box did not report its build; check with: ssh $TARGET oto-box status"
