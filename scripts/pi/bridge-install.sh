#!/usr/bin/env bash
# SCRUM-713: opt-in bridge installer helpers. Not yet run on a real Pi.
# Sourced only by install.sh --bridge-host; no action on source.

bridge_host_valid() {
  local name="$1" label
  [ "${#name}" -le 253 ] && [[ "$name" == *.* ]] || return 1
  [[ "$name" != *[!A-Za-z0-9.-]* && "$name" != *..* && "$name" != *. ]] || return 1
  [[ ! "$name" =~ ^[0-9.]+$ ]] || return 1
  local -a labels
  IFS=. read -r -a labels <<<"$name"
  for label in "${labels[@]}"; do
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || return 1
  done
}

bridge_read_env() {
  # Data, never a shell script. The restricted alphabet also has identical
  # meaning to systemd EnvironmentFile; no interpolation, quoting or escapes.
  local file="$1" line key value seen=','
  unset OTO_DNS_PROVIDER OTO_DNS_MODULE OTO_DNS_API_TOKEN OTO_ACME_EMAIL
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || return 1
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in
      OTO_DNS_PROVIDER|OTO_DNS_MODULE|OTO_DNS_API_TOKEN|OTO_ACME_EMAIL) ;;
      *) return 1 ;;
    esac
    [[ "$seen" != *",$key,"* && -n "$value" ]] || return 1
    seen="$seen$key,"
    [[ "$value" != *[!A-Za-z0-9._~+/:=@-]* ]] || return 1
    export "$key=$value"
  done <"$file"
  [[ "${OTO_DNS_PROVIDER:-}" =~ ^[a-z][a-z0-9_]*$ ]] || return 1
  [[ "${OTO_DNS_MODULE:-}" =~ ^github\.com/caddy-dns/[a-zA-Z0-9_-]+(@v[0-9][A-Za-z0-9.+-]*)?$ ]] || return 1
  [[ "${OTO_ACME_EMAIL:-}" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$ ]] || return 1
  [ -n "${OTO_DNS_API_TOKEN:-}" ]
}

bridge_append_origins() {
  # The existing line is data too. Preserve every existing origin, add the two
  # staging POS origins once, and leave every other line byte-identical.
  local file="$1" line value='' count=0 origin
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == OTO_BOX_BRIDGE_ORIGINS=* ]]; then
      count=$((count + 1)); value="${line#*=}"
    fi
  done <"$file"
  [ "$count" -le 1 ] || return 1
  [[ "$value" != *[!A-Za-z0-9._:/,-]* ]] || return 1
  for origin in https://oto-pos-staging.onrender.com https://oto-pos-web-staging.onrender.com; do
    case ",$value," in *",$origin,"*) ;; *) value="${value:+$value,}$origin" ;; esac
  done
  if [ "$count" -eq 1 ]; then
    sed -i "s|^OTO_BOX_BRIDGE_ORIGINS=.*|OTO_BOX_BRIDGE_ORIGINS=$value|" "$file"
  else
    printf '\nOTO_BOX_BRIDGE_ORIGINS=%s\n' "$value" >>"$file"
  fi
}

bridge_preflight() {
  bridge_host_valid "$BRIDGE_HOST" || die '--bridge-host needs a DNS hostname, without a scheme, path, wildcard or IP address'
  [ ! -L /etc/caddy ] && [ ! -L /etc/caddy/env ] && [ -f /etc/caddy/env ] \
    || die 'prepare /etc/caddy/env first; see BOX_BRIDGE_BENCH.md'
  [ "$(stat -c '%u:%a' /etc/caddy/env)" = '0:600' ] \
    || die '/etc/caddy/env must belong to root and have mode 0600'
  [ "$(stat -c '%u' /etc/caddy)" = '0' ] && [ -z "$(find /etc/caddy -maxdepth 0 -perm /022 -print)" ] \
    || die '/etc/caddy must belong to root and not be writable by other users'
  bridge_read_env /etc/caddy/env || die '/etc/caddy/env is incomplete or invalid; no credential was printed'
  if [ -e /etc/caddy/Caddyfile ]; then
    [ ! -L /etc/caddy/Caddyfile ] && grep -qx '# Managed by oto-box --bridge-host (SCRUM-713).' /etc/caddy/Caddyfile \
      || die 'an unrelated Caddyfile already exists; leave it intact and resolve that before this install'
  fi
  if systemctl is-active --quiet caddy.service || systemctl is-enabled --quiet caddy.service 2>/dev/null; then
    die 'an existing caddy.service owns this machine; no service was replaced'
  fi
  case "$USERLAND" in arm64|amd64) ;; *) die 'the bridge build requires arm64 or amd64' ;; esac
  [ -f "$SOURCE/pi/Caddyfile" ] || die 'this release has no bridge Caddyfile'
  if [ -f /etc/oto-box/config ]; then
    cp /etc/oto-box/config "$WORK/bridge-config-check"
    bridge_append_origins "$WORK/bridge-config-check" || die 'the existing bridge origin list is ambiguous; it was not replaced'
  fi
}

bridge_install() {
  say 'Installing the optional HTTPS station bridge (bench proof still required)'
  # Same custom-build endpoint used by Caddy's own add-package command.
  # No token is sent to the download service or put on a command line.
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --max-time 240 --get 'https://caddyserver.com/api/download' \
    --data-urlencode 'os=linux' --data-urlencode "arch=$USERLAND" \
    --data-urlencode "p=$OTO_DNS_MODULE" -o "$WORK/oto-caddy"
  chmod 0755 "$WORK/oto-caddy"
  "$WORK/oto-caddy" list-modules >"$WORK/caddy-modules"
  grep -qx "dns.providers.$OTO_DNS_PROVIDER" "$WORK/caddy-modules" \
    || die 'the downloaded Caddy has no requested DNS provider'
  export OTO_BRIDGE_HOST="$BRIDGE_HOST"
  # Validation can mention provider configuration on failure. Keep its output
  # private and delete it with WORK; never echo it or Caddy's adapted JSON.
  (umask 077; "$WORK/oto-caddy" validate --config "$SOURCE/pi/Caddyfile" --adapter caddyfile >"$WORK/caddy-validation" 2>&1) \
    || die 'Caddy rejected the provider configuration; check the provider instructions privately'
  if ! id oto-caddy >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/oto-box-caddy --shell /usr/sbin/nologin oto-caddy
  fi
  install -d -m 0755 /usr/local/lib/oto-box
  [ ! -f /usr/local/lib/oto-box/caddy ] || cp -p /usr/local/lib/oto-box/caddy /usr/local/lib/oto-box/caddy.previous
  [ ! -f /etc/caddy/Caddyfile ] || cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.previous
  install -m 0755 "$WORK/oto-caddy" /usr/local/lib/oto-box/caddy
  install -m 0644 "$SOURCE/pi/Caddyfile" /etc/caddy/Caddyfile
  cat >/etc/systemd/system/oto-box-bridge.service <<EOF
# Managed by oto-box --bridge-host (SCRUM-713).
[Unit]
Description=OTO HTTPS station bridge
After=network-online.target oto-box.service
Wants=network-online.target
[Service]
Type=simple
User=oto-caddy
Group=oto-caddy
EnvironmentFile=/etc/caddy/env
Environment=OTO_BRIDGE_HOST=$BRIDGE_HOST
Environment=XDG_DATA_HOME=/var/lib/oto-box-caddy
Environment=XDG_CONFIG_HOME=/var/lib/oto-box-caddy
ExecStart=/usr/local/lib/oto-box/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
StateDirectory=oto-box-caddy
StateDirectoryMode=0700
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF
  bridge_append_origins /etc/oto-box/config || die 'the existing bridge origin list is ambiguous; it was not replaced'
  unset OTO_DNS_API_TOKEN
  # Started with the agent below; --kiosk-url is deliberately not changed.
}
