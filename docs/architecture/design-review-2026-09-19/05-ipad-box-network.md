## 0. Principles for this slice
- One station contract, one implementation. Everything a till, display, kiosk or booth does goes through a versioned contract in `packages/contracts` (zod). The only implementation is the box agent (`apps/box-agent`, `buildAgent({devices, storage, cloudLink})`). The cloud hosts the same agent in-process as a **virtual box (vbox) per branch** under `/api/vbox/<branch>/v1/*`.
  - The vbox has no devices or simulated ones.
  - Its cloud link is a function call into the same sync-ingest service, so queue items are applied to Postgres before the till is acked.
  - Its SQLite cache is rebuildable from the change feed.
  - Remote admin, cloud fallback and Sprint 2 staging are all the vbox.
- A device with no station binding is in cloud mode and never probes the LAN. A device with a station binding is in box mode. Transport is decided by the binding, not by guessing the network.
- Durable data never lives only on an iPad. IndexedDB holds only the station binding, the shift token, a device id, an optional read replica, and a one-item command journal.
- Anything longer than about 2 s (EDC sale, print, 2C2P QR) is an async command: `202 {jobId}`, with progress over the channel. Never hold a single long HTTP request on iOS.

## 1. Origins and hosting
- Cloud: a single origin `https://app.otoplay.co` with path-mounted apps.
  - Paths: `/` launcher, `/pos/`, `/admin/`, later `/hr/` and others, plus `/api/v1/*` and `/api/ws`.
  - Serve static bundles and the API from the one Fastify Render service (`@fastify/static`, immutable cache headers). WebSockets and cookies then work with no rewrite tricks. I have not confirmed that Render static-site rewrites carry WebSockets.
  - `apps/api/src/app.ts` currently has no prefix; the dev Vite proxy strips `/api` (`apps/pos/vite.config.ts`). Register routes under `/api/v1` in production.
- The cookie stays host-only, httpOnly and Secure. Never set `Domain=.otoplay.co`: every `*.central.otoplay.co` box and the Replit-built marketing site would receive or share it.
- The marketing site is same-site with `app.otoplay.co`, so SameSite gives no CSRF protection against it. Add an onRequest hook that rejects mutating requests whose `Origin` is not the app origin, and reject non-JSON bodies.
- Box: hostname per **box**, not per station: `c1.central.otoplay.co`, `c2.…`, `gate.…`. Stations can be re-homed, so station-to-box is data.
  - Caddy terminates TLS, restricted to `h1 h2`. Disable HTTP/3 to avoid Alt-Svc/QUIC surprises on private IPs.
  - Caddy proxies to the agent on 127.0.0.1. It serves `/v1/*`, `/ws`, `/display`, `/kiosk`, `/booth`, and `/till` (break-glass shell).
- CSP on the cloud PWA: `connect-src 'self' https://*.central.otoplay.co wss://*.central.otoplay.co` plus the branch-2 zone. No third-party scripts. Self-host Inter; `apps/pos/index.html` loads Google Fonts today, which breaks the offline shell.
  - The client validates that a station's `boxHost` ends in an allow-listed suffix before ever sending a token to it.

## 2. Token transport (why not cookies)
- `oto_session` is host-only and opaque (`apps/api/src/plugins/session.ts`). It is never sent to the box, and the box could not verify it offline anyway.
- Add `POST /api/v1/auth/station-token` (cookie required). It returns an Ed25519-signed token with claims: sub, operatorId, branchId, `aud=branch:<id>`, `sid`=session id, iat, exp=session expiry, kid. Add a JWKS endpoint; keys are pushed to boxes with config.
- The PWA keeps the token in memory and IndexedDB so an offline reload still works. It sends `Authorization: Bearer` with `credentials:'omit'` to the box.
- XSS exposure is bounded by:
  - a strict CSP;
  - shift-length expiry;
  - the audience binding;
  - a revocation list pushed to boxes.
  - Leave an optional `cnf` claim in the token format for later DPoP-style key binding, but do not build it now.
- Box CORS:
  - echo only allow-listed origins (prod and staging app origins from cloud config, plus the box's own origin);
  - `Vary: Origin`;
  - allow headers `authorization, content-type, idempotency-key, x-oto-client, x-request-id`;
  - expose `x-request-id, x-oto-contract`;
  - `Access-Control-Max-Age: 7200`.
  - Browsers cap the preflight cache (WebKit to minutes, from memory), and the cache is keyed per URL. Make the station contract **RPC-style with static URLs** (`POST /v1/op/<name>`, ids in the body), so about 50 URLs stay cached instead of one preflight per entity URL.
- WebSocket:
  - Browsers cannot set headers on a WebSocket. Use `POST /v1/op/ws-ticket` to get a single-use 30 s ticket, then `wss://host/ws?ticket=`.
  - CORS does not apply to WebSockets, so the agent must check `Origin` on upgrade itself.
  - Validate the `Host` header as a DNS-rebinding defence.
- Lock is not sign-out.
  - `apps/pos/src/auth/OperatorContext.tsx` currently calls `authApi.signOut()` on the inactivity lock. Change it to a local lock that keeps the token and the lease.
  - Unlock calls `unlock` on the active transport.
  - Inactivity must be computed from wall-clock time on `visibilitychange`, because iOS freezes timers.

## 3. iOS / installed-PWA rules
- The till must run as a Home Screen web app, not in a Safari tab.
  - A Safari tab is subject to ITP's 7-day script-writable-storage cap, which wipes service worker, caches and IndexedDB. It also has separate storage from the installed app.
  - Detect `display-mode: standalone`. In a tab on a bound device, show install instructions and refuse till mode.
  - Call `navigator.storage.persist()`. Eviction is still possible, which is the reason for the no-durable-data rule.
- Service worker (`vite-plugin-pwa`, injectManifest):
  - Precache **all** chunks plus the barcode WASM. No lazy chunk ever comes from the network, which avoids ChunkLoadError after a deploy.
  - Navigation fallback page.
  - Never intercept `/api` or cross-origin box calls.
  - Update mode is `prompt`, applied only at the lock screen with no open sale. No Background Sync (unsupported on iOS).
- Manifest: `id:/pos/`, `start_url:/pos/`, `scope:/`.
  - With `scope:/`, launcher and sign-in navigation stay in-window. iOS opens out-of-scope URLs in an overlay browser, which would break a root `/login`.
  - Sign-in UI therefore ships as a shared package rendered inside each app, not as a separate page.
  - Each app's service worker is scoped to its own path.
- Backgrounding and lock:
  - iOS suspends JavaScript and drops sockets within seconds.
  - The protocol is a **snapshot plus monotonic `rev`**, never an event stream that must not be missed.
  - On `visibilitychange`, re-probe, fetch a new ticket, reconnect, and pull the snapshot.
  - App-level ping every 10 s; two missed pongs means the link is dead. After 3 WebSocket failures, fall back to 1 s polling.
- Device policy:
  - Supervised iPads via Apple Business Manager and a light MDM.
  - Auto-Lock set to Never, Guided Access or Single App mode, no iCloud account, auto-join the park SSID only, Wi-Fi Assist off.
  - Do not rely on the Wake Lock API in standalone mode; it was buggy before roughly iOS 18.4 (verify in the spike).
  - The risk being managed: during an outage an iPad may hop to a known mall Wi-Fi network that has internet and lose the box.
- Local network access:
  - The brief expects one iOS prompt. I have not confirmed whether Safari or installed web apps are subject to the Local Network permission. Settle it in the spike.
  - A denied permission looks identical to "box down", so the unreachable screen must mention Settings > Privacy > Local Network.
  - Chrome (LNA permission, about v142 and later) and macOS 15 prompt for admins' laptops on site.
  - For Chromium on the Pi, set `LocalNetworkAccessAllowedForUrls` by policy, although kiosks use localhost anyway.
- Camera scanning:
  - `BarcodeDetector` is not available in Safari.
  - The repo has `getUserMedia` capture (`apps/pos/src/components/mobile/history/MobileBraceletScanner.tsx`, `components/shared/CameraCapture.tsx`), and grep found no barcode decoder library in `apps/pos`. Add a zxing-wasm based decoder and precache it.
  - Standalone apps re-prompt for the camera more often than Safari does. Keep the box-attached Zebra as primary; the box routes `scan` events to the station's lease holder over the channel.
  - A Bluetooth HID scanner paired to an iPad suppresses the on-screen keyboard. Use in-app keypads for customer entry, or the scanner's keyboard-toggle.

## 4. DNS and certificates
- DNS:
  - Preferred: static host records for the box names on the router itself, with `central.otoplay.co` whitelisted from rebind protection. The router stays the only DHCP-advertised resolver.
  - The router is already the LAN's single point of failure, so this adds none. It removes the Pis from the path of all name resolution, including cloud access.
  - Specify a router class that supports this: Teltonika RUTX/RutOS, MikroTik or Peplink.
  - Fallback if the router cannot do it: the brief's dnsmasq on two boxes. Both must hold identical records with `local-ttl=300`, and the router must never be advertised as a third resolver. iOS treats resolvers as equivalent and does not fail over strictly in order.
- In either case:
  - Return NXDOMAIN for `mask.icloud.com` and `mask-h2.icloud.com`, Apple's documented signal to disable Private Relay on a network.
  - Forbid encrypted-DNS profiles and apps via MDM.
  - Use an uncommon subnet per branch (for example 10.87.x.0/24), so public A records pointing at private IPs never collide with an admin's home LAN.
  - Public A records are only a fallback. DNS-01 needs only TXT records.
- Certificates:
  - The cloud runs ACME DNS-01 as an `acme-client` job in the API's job runner. It issues **per-box** certificates with the box hostnames as SANs. It stores them encrypted and delivers certificate and key over the authenticated box channel. Caddy loads them from the data partition.
  - Boxes hold no DNS credentials. Booth and kiosk-only boxes get no certificate, since Chromium loads `http://localhost`, a secure context.
  - Renew at 50 percent of lifetime. The heartbeat reports `cert_not_after`; alert below 21 days.
  - Let's Encrypt ended OCSP in 2025, so handshakes make no OCSP fetch. Never enable must-staple.
  - Lifetimes are shrinking: Let's Encrypt has announced 45-day certificates by about 2028, and the CA/B Forum 47 days by 2029. "90 days, so outages never matter" will not stay true, and monitoring is mandatory.
- Spare:
  - Keep it powered as a registered warm standby: certificate current, cache synced, role `standby`.
  - The agent self-checks its expected IP from cached config and adds it as an alias if DHCP disagrees. Reservations are MAC-bound, and a board swap changes the MAC.
  - Fit the Pi 5 RTC battery. With no UPS, a wrong clock breaks token `exp` checks and occurred-at stamps.
  - `/v1/hello` returns the box time, and the PWA warns when skew exceeds 2 minutes.

## 5. Transport abstraction (`packages/api-client`)
```
Transport { kind:'box'|'vbox'; baseUrl; auth:'bearer'|'cookie';
  op(name, input, {commandId, leaseId, epoch}); subscribe(channel, onSnapshot);
  hello(): {boxId, agentVersion, contract:{major,minor}, minClientContract,
            capabilities[], stations[], cloudLink, lastSyncAt, queueDepth, time} }
api.station.* -> resolver-selected transport   (contract ops)
api.cloud.*   -> always app origin + cookie    (admin, HR, reports; 'needs internet' state)
```
- The box is not a reverse proxy for the cloud API. The client is dual-homed.
- Resolver states:
  - `unbound`, which uses the vbox;
  - `bound: probing`;
  - `box-ok`, with sub-flag `cloudLink down` driving an "offline – selling locally" chip in `StationHeader`;
  - `box-unreachable`.
- Probe timing:
  - Probe `GET /v1/hello` with a 1.5 s AbortController timeout.
  - Run it on start, on becoming visible, on any network error, and every 15 s while idle.
  - `navigator.onLine` is ignored; it stays true on a LAN with no internet.
- Commands:
  - A `commandId` (UUIDv7) is minted when the user acts and journaled in IndexedDB until acked. Retries are then safe on any transport.
  - Today `apps/pos/src/api/platform.ts` mints `idemKey()` inside the wrapper at call time.
- Reads: keep the `catalogStore`/`hydrateFromApi` replica pattern, hydrated from whichever transport is active. A box cache miss while online reads through box to cloud.
- Sale affinity: the transport is pinned for the life of a sale. Switches happen only between sales. Return to the box is automatic; leaving the box needs staff confirmation.

## 6. Station picking, lease and fencing
- The first pick needs the cloud. It returns the station list with `boxId` and `boxHost`, plus `knownBoxHosts[]` for the whole branch.
  - The binding `{stationId, boxId, boxHost, knownBoxHosts, branchId}` is stored in IndexedDB with a localStorage mirror.
  - This retires the "no browser storage" rule still stated in `apps/pos/src/station/StationContext.tsx` and its siblings.
- Every box caches all stations of its branch, so re-picking works offline through any reachable box. Device records are reported to the cloud so admins can see and revoke them.
- `lease.acquire {stationId, role: till|display|observer, deviceId, takeover?}` returns `{leaseId, epoch, ttl 30s}`, renewed over the channel.
  - If the station is held, return `409 STATION_IN_USE {holder, lastSeenSec}`. The till offers Observe, or Take over.
  - Take over requires a stale holder or the `pos:station:takeover` permission, and is audited.
  - Every mutating op carries `leaseId` and `epoch`. The box rejects stale epochs. These fencing tokens are what make the lock real rather than advisory.
  - The lease is per device, not per staff member. The inactivity lock keeps it; sign-out releases it. The actor comes from the token on each command.
- Cloud mode never binds a physical station. It uses a **virtual station** on the vbox with its own receipt series and no devices.

## 7. Customer display
- The display is a device surface served by the box at `https://c1.central…/display`, so it is same-origin.
  - It therefore works with an httpOnly device-session cookie and needs no CORS.
  - The bundle ships with the agent release, so there is no skew.
  - A tiny service worker only provides a "reconnecting" page, because a standalone app has no reload button.
- Pairing:
  - The display shows a 6-digit code or QR. Staff on the till run "Pair display".
  - The box issues a revocable device session bound to the station with role `display`, and syncs it to the cloud.
  - Kiosk, booth and the reception kiosk (SCRUM-116: "one mechanism, not two") use the same mechanism.
- Session document:
  - `StationSession {rev, stage, lines, totals (satang, computed by the box with packages/domain), memberSummary, consentDraft, payment{state, qr}, language, theme}`.
  - It is owned by the box and persisted to SQLite on every rev, so it survives a watchdog reboot mid-sale.
  - The till sends ops. The display sends intents: phone.submitted, identify.skip, consent.ack, child.patch, done. Keystrokes stay local to the display.
  - The box broadcasts full snapshots, not diffs. The display receives a redacted `displayView`; observers receive the staff view.
  - The box fetches the 2C2P QR image and serves it, so the display depends only on the box. When offline, it switches automatically to PAX QR.
- This replaces D8 (`session.pending_lookup_phone`, `/me/session/pending-lookup`, `Till.tsx` handleIdentify).
- Keep the split-screen harness as an in-process loopback implementation of the same session interface. It serves as dev mode and as degraded mode when the display or the box is dead.
- Prerequisite: a headless `useTillSession` reducer and `{state, dispatch}` panes across the 6 host surfaces.
- Option: a USB-touch monitor on the box's second HDMI port, running the same `/display` bundle over localhost. It removes Wi-Fi and iOS from the customer side.

## 8. Failure ladder (box dies mid-sale)
1. **Box alive, link flaky:** show a banner and retry. The sale is safe in the box session. Another iPad can take over when the lease expires.
2. **Box dead:**
   - The till keeps its local cart copy, because it is the editor.
   - Any EDC sale in flight has an unknown outcome. Staff check the terminal's screen or slip and record the result through the audited manual-confirm path the brief already defines for GHL.
3. **Re-home the station to a sibling box.**
   - This is a manager action that works offline. The sibling already holds branch config and cache, and adopts the station with a new epoch.
   - Ethernet printers keep working, since any box can drive port 9100. The dead box's USB devices (EDC, scanner) do not; the card terminal runs standalone with manual recording.
   - Receipt series must be keyed by **(station, box)** or by box, so an adopted station never collides with the dead box's unsynced numbers. Take this to the accountant.
   - The dead box's queue drains when it, or its NVMe in the spare board, returns. Idempotent by id.
4. **No box reachable, internet up:** cloud fallback on a vbox virtual station. It supports lookup, **child release**, member creation, and 2C2P QR or cash with a digital receipt. It cannot print or drive the EDC.
5. **Nothing reachable:** the paper runbook. Child release is never blocked at any rung.

## 9. Version skew
- Display, kiosk and booth bundles ship inside the agent release and cannot skew. Only the cloud-served till can.
- `/v1/hello` exposes `contract {major, minor}`, `minClientContract` and `capabilities[]`. The UI gates features on capabilities, never on version comparisons.
- Every request carries `x-oto-client: pos/<build>; contract=<n>`. Heartbeats report the agent version and the client versions seen, feeding a fleet skew dashboard.
- Policy:
  - Additive-only within a major version, with expand/contract migrations.
  - Deploy cloud first, then agents in waves (staging vbox, then booth, gate, counters, outside opening hours), then capability-gated PWA features.
  - Remove old paths only when the fleet shows zero old agents.
  - CI runs the current PWA contract client against the previous agent release.
- Hard incompatibility: a blocking screen offers a one-tap OTA when online. When offline, load the **box-served till shell** at `https://c1…/till`, which is always compatible with its own agent. It also covers service-worker-cache eviction during an outage.
- Agent OTA uses A/B slots with health-gated rollback, staged on the data partition.

## 10. Chromium kiosk surfaces (kiosk, booth TV)
- Use a cage/labwc Wayland kiosk and Chromium with `--kiosk`, pointed at `http://localhost:<port>/kiosk|booth`. This needs no certificate, DNS, CORS or LNA prompt.
- The agent's loopback listener trusts the surface with the role from box config. The LAN listener stays token-gated.
- Staff sign in by QR badge or PIN, verified against cached credential hashes with rate limiting. No biometrics: remove the face-scan placeholders in `LockScreen.tsx` and `mockApi`.
- Hardening:
  - Flags: `--noerrdialogs --disable-session-crashed-bubble --disable-pinch --overscroll-history-navigation=0`.
  - Profile on tmpfs or the data partition. Blanking off. Force 1080p.
  - In-app keypad, since there is no OS keyboard.
  - A page-to-agent heartbeat; the agent restarts Chromium on silence. Nightly reboot.
- The USB dome button is a keydown event with debounce. Spin is an idempotent command.
- Booth boxes sit outside the park LAN and need only outbound internet. Their connectivity is an open question; avoid mall captive-portal Wi-Fi.

## 11. Admin at home
- Use the cloud origin, the cookie, and no station binding. `api.station.*` goes to the vbox, so the screens are identical. Device capabilities are false, so print and EDC actions are hidden or turned into remote commands.
- Remote test print goes admin, cloud, box WebSocket, printer. It is async: `202 {jobId}`, with the result over `/api/ws` or polling.
- The cloud WebSocket hub runs in-process on the single Render instance. Move to LISTEN/NOTIFY on one dedicated connection if it is ever scaled out.