# The counter bridge: first-stage implementation and remaining bench work

SCRUM-713 first stage. The `--bridge-host` installer has **not been run on a
real Pi**. A Windows loopback proof does not prove iPad private-network access,
DNS, a real certificate, physical printers or power recovery. Keep the ticket
at Testing until the owner schedules those checks. No park device is switched
by this work.

## What this release adds

Console > Devices > the counter box > Bridge address records a bare HTTPS
origin. A station pick carries it to the till, which remembers it with that
station. Leaving the station, changing account/park or changing the address
clears the in-memory box session. Re-pick after changing the address. Virtual
boxes and older responses with no field retain the same-origin route.

Online sales still use the platform. A network failure, forced-offline answer,
or exactly `502 UPSTREAM_UNAVAILABLE` with a configured bridge can select the
box. The sale, line and action IDs survive an unknown successful answer, so
reconnect meets the existing ledger entry. Pending electronic payments still
hold the lane change. No write retry or new offline tender is introduced.

The release contains `display/` beside the agent and booth page. On this box,
`http://127.0.0.1:8780/display?keyboard=screen` serves those assets directly;
an empty HTTP asset cache needs no internet. Pair it while online to a station
on this box. Its existing paired credential is stored by this local origin;
the box bundle holds its hash. Clearing site data removes that credential and
requires online pairing again. No token or cookie is copied from a staff page.

The page checks its build ID against the agent before starting. A different
version shows Reload; index and version are never cached. Hashed assets may
be cached. The display uses the existing redacted snapshots, intents, stream,
15-second grace and pause. Its HTTP listener stays loopback-only with Host and
Origin guards. Caddy publishes only `/box/v1/station/*`, never this page or the
kiosk control routes. `--kiosk-url` stays exactly as configured until explicitly
changed; installing a bridge does not change it.

## Prepare the owner's chosen DNS provider

1. The owner chooses the DNS zone and a unique box hostname. Reserve the box's
   LAN address. Give that hostname an A record for that address in the router's
   local DNS, including when WAN is disconnected; check IPv6/AAAA does not send
   the iPad elsewhere. Do not forward public ports to the box.
2. The zone must permit DNS-01 TXT updates for `_acme-challenge.<box-name>` and
   its CAA records must permit the chosen ACME issuer. Use a least-privilege
   provider token for that zone. DNS-01 requires outbound DNS-provider and ACME
   access for initial issuance and renewal, though no inbound internet port.
3. Prepare `/etc/caddy` owned by root and not writable by other users. Prepare
   `/etc/caddy/env`, root:root, mode 0600. Enter values privately with an editor;
   never put the token in command history, a ticket, this repo or screenshots.
   It is a data file: one unquoted `NAME=value` per line, no shell commands,
   variable expansions, spaces or escapes. Required names:

   - `OTO_DNS_PROVIDER`: the Caddy provider ID, such as `cloudflare`.
   - `OTO_DNS_MODULE`: its `github.com/caddy-dns/...` module, preferably pinned
     with its reviewed `@v...` version.
   - `OTO_DNS_API_TOKEN`: the provider's zone token.
   - `OTO_ACME_EMAIL`: the certificate-notice address.

   The supplied Caddyfile supports a provider with one API-token argument.
   Check the chosen module's documentation before the bench; multi-field
   providers need an explicit reviewed configuration change. The installer
   downloads a custom build from Caddy's official endpoint, checks the module
   and validates configuration without printing it. See [Caddy custom builds](https://caddyserver.com/docs/build)
   and [DNS TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls).
4. With the owner's bench approval, install the reviewed release:
   `sudo bash install.sh oto-box-<build>.tgz --bridge-host <box-name>`.
   Without this option, no Caddy action or bridge-origin edit occurs. An
   unrelated existing Caddyfile/service is refused. The optional service is
   `oto-box-bridge`; the binary is `/usr/local/lib/oto-box/caddy`. Certificate
   state is private under `/var/lib/oto-box-caddy`.
5. The installer preserves existing `OTO_BOX_BRIDGE_ORIGINS` entries and adds
   both staging POS origins once. It preserves other box settings, including
   the kiosk URL and mirror. After inspecting the first certificate and its
   hostname/expiry, set this counter box's Console bridge address to the HTTPS
   origin. Pick that station again. Do not set a loopback address on an iPad.
6. Separately, with permission to change that display, set
   `--kiosk-url http://127.0.0.1:8780/display?keyboard=screen --rotate off --kiosk-scale 1.25`.
   Pair online, wait for the pairing bundle to reach the box, and record the
   release shown by `oto-box status`. Keep Chromium site data across reboots.

## Real iPad and Pi acceptance, still open

- On the installed POS app on a real iPad, grant the browser's local-network
  permission normally. Never disable browser security or bypass a certificate
  warning. Prove Origin refusal and the Private Network Access preflight with
  the permitted origin; record OS/browser versions and the permission prompt.
- Pick the ready ZZ TEST counter online and lock it. Pull WAN while keeping
  the router/LAN alive. Unlock with the issued shift token **and password**;
  wrong password and missing/expired/revoked token must refuse.
- Ring cash, a terminal card with a final answer, and PAX QR awaiting settlement
  only when separately approved for the bench. Confirm physical receipt and
  bands, numbering, and drawer. Refuse 2C2P QR, vouchers, refunds and voids in
  the existing words. Never replay an electronic payment with an unknown result.
- Confirm the display follows both directions, pause/grace, and a cold restart
  of the Pi and browser during WAN loss, with the asset cache empty but its
  pairing credential retained. Check the wrong-version Reload notice.
- Restore WAN. Read the same sale and payment IDs on the platform exactly once,
  zero quarantine, and retained audit receipts. Check online journeys on both
  staging POS addresses and native sign-out. Check certificate renewal while
  WAN is up and operation through an outage shorter than certificate validity.

## Staging and production settings

`STAFF_TOKEN_PRIVATE_KEY` is an Ed25519 private key kept only in API settings.
Its public half is published in `core.signing_key` and box bundles. Station
picks and the existing staff-token endpoint then issue bound shift tokens;
existing expiry, session/account revocation and cached deny-list rules apply.
`STAFF_OFFLINE_SIGN_IN` stays absent/false: tokenless offline sign-in stays off.
`BOX_BRIDGE_ALLOW_LOOPBACK=true` is only a temporary local/staging proof flag,
refused in production validation. Remove it after proof and redeploy the same
green commit. A missing flag defaults to false; existing old stations still work.

Production go-live list (not authorized by this stage): create a separate
Ed25519 key, store it through a read-guarded single-key write, privately retain
the recovery material, redeploy the same approved source, confirm the public
fingerprint in the database and each intended box's bundle, and test revocation.
Do not copy staging's private key, enable tokenless sign-in, or set the loopback
flag. Add only the approved production POS origin to the box allow-list at the
owner's switch, then complete the real iPad/Pi checklist above.

## Way back

Before a bench change, privately back up the box config, kiosk address and
certificate state; retain the previous release. To stop publishing the new
bridge: `sudo systemctl disable --now oto-box-bridge`. Restore the saved
`OTO_BOX_BRIDGE_ORIGINS` and kiosk URL, restart `oto-box` and `oto-kiosk`, and
clear the box's Console bridge address; re-pick its station. Online operation
then uses the platform; offline access from that iPad is no longer claimed.
For a bridge binary/config update, the preceding Caddy binary and Caddyfile
are kept as `.previous`; restore both together and restart only this bridge
service. Keep certificate state and credentials private. Do not rotate or
remove the API signing key as a UI rollback: issued shifts depend on it, and
key rotation requires its own expiry/revocation plan.
