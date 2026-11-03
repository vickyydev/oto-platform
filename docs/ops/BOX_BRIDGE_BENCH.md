# The counter bridge: first-stage implementation and remaining bench work

SCRUM-713 first stage. The `--bridge-host` installer has **not been run on a
real Pi**. A Windows loopback proof does not prove iPad private-network access,
DNS, a real certificate, physical printers or power recovery. Keep the ticket
at Testing until the owner schedules those checks. No park device is switched
by this work.

SCRUM-727 requires a complete staff-cache pull before fresh password sign-in
if the saved cache predates latest-shift ID and revocation state. Until then,
the box refuses that path with `OFFLINE_REVOCATION_UNKNOWN`; a missing token
must never hide an ended shift. The existing Clear cache command requests
a complete refresh if a damaged copy still carries a current bundle version.

The software stage passed staging proof on source `f3b793dcc35d296a03582d617a9a94a3b555da60`
with [the receipts and inspected images](../qa/proof-2026-11-02/s713/README.md).
The staff signing key is configured; the temporary loopback flag is removed.
The test box/station are archived. The physical checks below remain open.

## What this release adds

Console > Devices > the counter box > Bridge address records a bare HTTPS
origin below `BOX_BRIDGE_ZONE`; with no configured zone no address is accepted.
IP literals are always refused. Reads recheck saved addresses under the current
zone, and the till independently checks `VITE_BOX_BRIDGE_ZONE` from its own build.
Both zones must name the same approved DNS parent. A station pick carries the
validated address to the till, which remembers it with that
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
   - The pinned Caddy artifact must include that DNS provider. `OTO_DNS_MODULE`
     is an optional legacy hint; the installer verifies the actual binary.
   - `OTO_DNS_API_TOKEN`: the provider's zone token.
   - `OTO_ACME_EMAIL`: the certificate-notice address.

   The supplied Caddyfile supports a provider with one API-token argument.
   Check the chosen module's documentation before the bench; multi-field
   providers need an explicit reviewed configuration change. The installer
   takes a reviewed custom binary URL for the chosen architecture. Record its
   exact Caddy version and SHA-256 before installation; the installer refuses
   missing pins, verifies the digest before executing the download, then checks
   its version, module and configuration. Do not use the checksum of a standard
   Caddy binary for a custom DNS build. The DNS token is never exported to apt,
   curl or other installer children; only Caddy's validation subprocess receives
   it, and the service later reads the private EnvironmentFile. See [Caddy custom builds](https://caddyserver.com/docs/build)
   and [DNS TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls).
4. With the owner's bench approval, install the reviewed release:
   `sudo bash install.sh oto-box-<build>.tgz --bridge-host <box-name>
   --bridge-origins <https-till-origin-list> --bridge-caddy-url <reviewed-binary-url>
   --bridge-caddy-version <vX.Y.Z> --bridge-caddy-sha256 <reviewed-sha256>`.
   Supply these on one command line. Use a reviewed immutable custom artifact
   built with the chosen DNS module; [xcaddy's versioned build instructions](https://caddyserver.com/docs/build)
   describe how to prepare it. No artifact or DNS provider is selected for a real
   park by this software change.
   Without this option, no Caddy action or bridge-origin edit occurs. An
   unrelated existing Caddyfile/service is refused. The optional service is
   `oto-box-bridge`; the binary is `/usr/local/lib/oto-box/caddy`. Certificate
   state is private under `/var/lib/oto-box-caddy`.
5. The installer preserves existing `OTO_BOX_BRIDGE_ORIGINS` entries and adds
   only the explicitly supplied `--bridge-origins` entries once. It preserves other box settings, including
   the kiosk URL and mirror. After inspecting the first certificate and its
   hostname/expiry, set this counter box's Console bridge address to the HTTPS
   origin. Pick that station again. Do not set a loopback address on an iPad.
6. Separately, with permission to change that display, set
   `--kiosk-url http://127.0.0.1:8780/display?keyboard=screen --rotate off --kiosk-scale 1.25`.
   Pair online, wait for the pairing bundle to reach the box, and record the
   release shown by `oto-box status`. Keep Chromium site data across reboots.

After setting or changing the bridge, pick the station again and use the normal
lock/unlock once to authorise its local display. Online unlock keeps the platform
as authority and sends the same shift token and entered password to the local
box in one bounded background call, without retries or redirects. It never saves the password, delays online
access or changes the trading lane. An unavailable box leaves online access
working; a late response cannot restore a credential after lock or station change.

## Real iPad and Pi acceptance, still open

- On the installed POS app on a real iPad, grant the browser's local-network
  permission normally. Never disable browser security or bypass a certificate
  warning. Prove Origin refusal and the Private Network Access preflight with
  the permitted origin; record OS/browser versions and the permission prompt.
- Pick the ready ZZ TEST counter online and lock it. Pull WAN while keeping
  the router/LAN alive. Unlock with the issued shift token **and password**;
  wrong passwords and revoked, forged or foreign tokens must refuse. With
  `STAFF_OFFLINE_SIGN_IN=true`, a missing token or an otherwise valid expired
  token may use OD-6: recognised here within 30 days, deny-list at most 72 hours
  old (a successful unchanged confirmation counts), no uncleared manager end or revoked account. Check the offline banner and fresh
  session marker. With the setting false, missing/expired tokens refuse.
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
`STAFF_OFFLINE_SIGN_IN` is the single OD-6 setting: true by default, explicit
false disables fresh sign-in. The API delivers it as `staffOfflineSignIn` in
the versioned box configuration; both the physical and virtual mounts read it.
The owner's OD-6 confirmation remains open. A fresh sign-in requires staff seen
on this box within 30 days and a deny-list applied or confirmed current within 72 hours; its session
and facts carry `offlineFresh` and the till shows its offline-unlock banner.
A manager end later than the latest online issue refuses fresh sign-in even without a token; a later online issue restores it. Normal sign-out and station changes revoke only their own live tokens. A valid token is judged by its own ID and signed issue time, and a pulled manager end closes an older fresh box session. Only a verified token whose
sole failure is expiry may enter that path; it stays bound to its station,
box, branch and person.

Use a dedicated DNS zone controlled by the park, never a public or shared hosting
suffix such as `com` or `onrender.com`. Single-label zones are refused except
explicit non-production localhost proof. A rejected stored address stays hidden
from tills; the Console explains why, and rename/disable remain available.

Restoring an older box copy can temporarily restore an ended shift until the
next successful pull. Fresh sign-in is bounded by the 72-hour confirmation age;
a token is bounded by its own expiry. Restore the network and pull current staff
and deny-list data before returning a restored counter to use.

`BOX_BRIDGE_ZONE` and the till's build-time `VITE_BOX_BRIDGE_ZONE` default empty:
no external address is saved or returned, and no password leaves the page for
an external box. A local proof may use a DNS child such as `zz-test.localhost`,
zone `localhost`, and explicit `BOX_BRIDGE_ALLOW_LOOPBACK=true` plus build-time
`VITE_BOX_BRIDGE_ALLOW_LOOPBACK=true`. Even that exception refuses IP literals.
The API ignores its loopback exception in production. Remove temporary API
flags after proof and redeploy the same green source. No real address is part
of the proof. The signing key stays configured.

Production go-live list (not authorized by this stage): create a separate
Ed25519 key, store it through a read-guarded single-key write, privately retain
the recovery material, redeploy the same approved source, confirm the public
fingerprint in the database and each intended box's bundle, and test revocation.
Production refuses startup without `STAFF_TOKEN_PRIVATE_KEY`. Do not copy
staging's private key or set a loopback flag. Apply the owner's OD-6 ruling
through `STAFF_OFFLINE_SIGN_IN` before go-live. Add only the approved production POS origin to the box allow-list at the
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
