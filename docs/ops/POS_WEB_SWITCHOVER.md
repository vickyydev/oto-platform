# POS web service: staging proof and owner switch-over

## Staging links: SCRUM-725

The owner approved the staging link switch on 2 November 2026. The new destination
is `https://oto-pos-web-staging.onrender.com`. The live switch and browser acceptance passed on 2 November, 17:35 UTC,
on source `0f4061d6e9076638258a79daa453026a39d2e2dd`, CI 41485215834.
Park Pi/iPad addresses, production and the old static site's settings are unchanged.
No new service or redirect is part of this operation.

The read-only inventory found no old POS hostname in 425 tables and 2,299
text/JSON/string columns, including settings, message templates, assistant
knowledge, print templates and booking links. There is no database edit to make.
The safe inventory and service-setting fingerprints are in
`docs/qa/proof-2026-11-02/s725/`.

### Completed staging switch

The API restarted on the same green source at 17:21:34 UTC; a fresh native
launcher sign-on reached the new POS at 17:22:54. Launcher and Console rebuilt
at 17:24:08 and 17:26:14. A hand-off minted before the routing change can retain
the old destination until its one-minute expiry; continuous zero outage was
not measured. Reopening from the launcher obtains a fresh hand-off.

API, launcher and Console retain 56, 7 and 3 environment names. Only the named
three keys changed. Every other value across ten services, all five non-POS
hand-off entries, and both allowed origins stayed byte-identical. The old
site settings match their original fingerprint; it has no redirect and native
sign-in/sign-out still pass. No stored old-hostname match needed a database edit.

All 302 served frontend files across eight sites are free of the old address.
The native browser matrix covered launcher and other-app sign-ons/links,
Console POS links, POS booking/stock/admin/Today/launcher links and sign-out.
The ZZ TEST cash journey took 3.431 seconds, 39 calls and one finalise request.
Visible display updates took 304/233 ms; single scan delivery took 82 ms.
Grace, pause, recovery, revocation, installed offline shell and Origin checks
passed. The exact test station/box are archived, all paired screens and leases
cleared, sessions signed out, and receipt Z725-000001 retained for audit.

[The final report](../qa/proof-2026-11-02/s725/README.md) records exact live
commits, deploy IDs, attempts, cleanup and inspected proof. The forward order
below is the executed procedure; the way back remains available.

### Forward order

1. Land the records, defaults and guarded replacement with green exact-source CI.
   Check the latest STATUS for another lane's active proof before restarting API.
2. Read every API environment value privately and count its names. Read
   HANDOFF_APP_ORIGINS separately and stop if it is empty or unreadable. Require
   exactly one `pos=` entry naming the old origin. Keep ALLOWED_ORIGINS unchanged,
   with both addresses present.
3. Use `replacePosHandoffOrigin` in `scripts/agent/render.mjs` with the old origin
   as the expected value and the new origin as the replacement. It writes only
   `/services/{id}/env-vars/HANDOFF_APP_ORIGINS`, never the bulk endpoint, and reads
   the result back. Check every non-POS entry byte for byte, every other API value,
   and the unchanged name count (56 in the initial inventory).
4. Redeploy the API's same green commit. Wait for observed routing as well as
   Render's live state: SCRUM-721 measured a short handover after that state.
   The launcher follows the API's returned `launchUrl` even on its older build.
   A hand-off minted immediately before or during the handover can still name
   the old origin and fail until its normal one-minute expiry; return to the
   launcher and open the app again. Existing sessions and old native sign-in
   remain available. Record the actual cutover window.
5. Read and set VITE_POS_URL separately on launcher and Console, with one key per
   write and every other setting preserved. Rebuild both on their same green
   source; saving a Vite variable alone does not change a built page.
6. Read each affected live commit. Inspect the served bundles for the old address,
   then click the launcher/Console/POS links and all suite sign-ons in a real
   browser. Prove deep entry, sign-out, display pairing, scan and a ZZ TEST cash
   sale. No real payment, SMS, booth action or channel-mode change is involved.
   Finish and inspect the image before the ticket's Deployed walk.

### Way back and paper check

Use the currently live green source; a rollback changes addresses, not money
records or source history. Read the settings again and check the actual counts
against the completed switch receipt. Call `replacePosHandoffOrigin` with the new
origin as the expected value and the old origin as its replacement. Preserve
every other entry and API value, redeploy that same API commit, and wait for
observed routing. Set launcher and Console VITE_POS_URL back to the old origin
through separate single-key writes, rebuild both, and repeat the sign-on checks.
The same brief hand-off window applies in reverse. ALLOWED_ORIGINS keeps both
addresses throughout; the old site has no redirect to undo. No database rollback
or sale replay is needed. Existing old bookmarks and home-screen icons stay valid.

The live paper check passed at 17:26:58 UTC (`settings-after.json`): both service IDs and origins exist; the old
site still answers; each expected key is readable; exactly one `pos=` entry
exists; the other five hand-off entries and other settings match their saved
fingerprints; both origins remain allowed; and the reversal changes only the
same three keys. All three reversed values reproduce the original fingerprints. The rollback was
checked on paper and was not executed.

Old-address references are deliberately retained in the old service definition,
ALLOWED_ORIGINS, regression fixtures, this rollback/history, dated handovers and
QA evidence, the September POS gap audit, and the September owner-action CORS
example (an allow-list, not a POS destination). Current script defaults and
operating examples use the new origin. Updating a Pi command example does not
authorize running it on a park device.

The SCRUM-718 creation and acceptance account below is historical. Its original
address-change restriction is superseded only for the staging links above.

**Final staging measurements passed:** source `796a3724505ee9cd46f93584c975971ad50a3e4d`,
CI 41452442131. The final [acceptance report](../qa/proof-2026-11-02/final/README.md)
contains the current live commits and proof. The earlier 540 ms miss is retained;
the 50 ms item-quote schedule and three fresh display runs resolved it. Device
switch-over remains the owner's separate step.

SCRUM-718, 2 November 2026. **The owner approved one staging Starter web service
beside the existing POS static site. No staff, iPad or Pi address is switched by
this unit. Production, another service and a larger plan need a separate decision.**

## What runs

`apps/pos/server/` is a Node HTTP forwarder and static file server. Build with
`pnpm --filter @oto/pos build`; run with `pnpm --filter @oto/pos start`.
`API_UPSTREAM` is an HTTP(S) origin, without credentials or a path. The approved
deployment uses the API's private hostname and port 10000, in the API's Singapore
workspace. `PORT` defaults to 10000. `/healthz` checks this server only; `/api/health`
checks the API path. Neither response should be used as a substitute for sign-in,
a sale, a scan and paired-display proof.

The same built POS files are served. Relative `/api` paths lose just that prefix.
Request bodies, Origin, Cookie, Authorization, Idempotency-Key and x-oto-action-id
are forwarded unchanged; connection-specific HTTP headers are removed and Host
names the upstream. Set-Cookie headers stay separate. The socket peer is appended
to X-Forwarded-For; the API's existing address allow-list decides which hops to
trust. Never trust Render's shared public egress range `74.220.48.0/20`.

The server never retries a write. It may retry one bodyless GET only after a reset
of a reused upstream socket, before a response. An unavailable API produces a 502
API error envelope. The existing till treats that as an API refusal, as it does
today; losing the internet still produces NetworkError and triggers the box lane.
There is no new session, CORS rule, credential or alternate money path.

Connection setup and its socket queue are bounded at 30 seconds. Once connected,
the API controls completion: the proxy adds no response deadline that could cut
off an in-flight sale. A regression held a write response past 30 simulated
seconds and verified the successful answer arrived exactly once.

Streams are piped with backpressure and no compression or response lifetime timer.
A disconnected client cancels its upstream request, including before headers.
Safe reads keep their upstream socket for reuse. SCRUM-721 gives writes a fresh
connection (measured added p50/p95 1.228/0.845 ms on the private network) and logs
upstream failures without bodies, headers or query strings. SIGTERM drains
ordinary work and closes remaining streams after 25 seconds for normal reconnect.

Static compression is generated at build time (Brotli and gzip), keeping request
CPU small. Hashed assets have a one-year immutable cache; index.html, SPA fallback
and sw.js use no-store. This follows the owner's explicit cache requirement: the
old static site's measured headers used max-age=0 and a 300-second edge cache on
all three. The live HSTS and nosniff headers are retained. Missing assets return
404 and traversal/hidden-file requests are refused. The existing worker still
caches only the shell and never API responses. A held worker update still waits
until the till's existing safe update point.

## Staging creation and verification

1. Land the server dark, rebase first, wait for an idle main CI queue, push and
   watch the full commit SHA. Keep SCRUM-718 Testing until measured acceptance.
2. Read `oto-api-staging` directly and use its owner ID and region. Create exactly
   one always-on Starter web service, one instance, named `oto-pos-web-staging`.
   In the same operation add its ID to environment `evm-danh1brtqb8s73bt5pk0`
   through `POST /v1/environments/{id}/resources`. Read the actual assigned URL.
3. Set `autoDeployTrigger=checksPass` and verify it. Set a build filter including
   `apps/pos/**`, `packages/shared/**`, `packages/api-types/**`, `packages/config/**`,
   `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.npmrc`. Documentation
   and unrelated app changes must not consume a build. No linked blueprint exists;
   the commented service block in render.yaml documents API/dashboard settings.
4. New-service settings: NODE_VERSION=22, NODE_ENV=production, API_UPSTREAM on the
   verified private address, and VITE_LAUNCHER_URL matching the existing POS build.
   Copy other existing POS VITE settings privately if present. Verify the private
   path from the running service; a public fallback is not private-network proof.
5. Before changing the API, check STATUS for other lanes' proofs. Name exact keys
   on SCRUM-718, read their values privately and count all environment names.
   **Only ALLOWED_ORIGINS is currently needed**: append the new origin using
   `appendEnvList` in scripts/agent/render.mjs. Never use the bulk env-vars PUT.
   Read back that every prior name/value remains, with only the intended list
   addition. Redeploy the same API commit and verify its live SHA. If build minutes
   have run out, stop and report it; only the owner raises the limit.
6. HANDOFF_APP_ORIGINS and the launcher stay on the old POS address. The new address
   uses the existing POS phone/password form for isolated proof. The handoff parser
   currently allows one origin per app: **do not append a second `pos=` entry**,
   which would fail the API boot. No new handoff mechanism is required for testing.
7. TRUST_PROXY_ADDRS already includes the private network and Cloudflare's ranges.
   Verify the real caller and forged-header throttle using observed evidence before
   claiming it works. An additional trust entry needs verified ownership, a ticket
   note, the guarded one-key helper and another same-commit deploy; a public shared
   range is never acceptable.
8. Keep the old POS site unchanged and working. Use only the dedicated new ZZ TEST
   virtual box/station. Run the before/after matrix below, inspect and attach the
   images, read Jira state back, and stop before switching any device.

## Measurement and acceptance

From the same Bangkok machine, interleave direct API, old POS and new POS reads
within a few minutes. At least 30 samples per path/mode/tool: first connections
and warm calls, curl and a real browser. Report raw samples and p50/p95, including
stream opening. “First” means a fresh connection/context, not stopping an always-on
service to manufacture a cold boot. Record first-page transfer/load and installed
offline shell separately from API latency.

Time the same native sign-in, add-item and synthetic cash-sale journey on both
addresses, recording request count, finalise count and total elapsed time. Re-run
the SCRUM-710 harness and state the exact client/API commits; SCRUM-720 owns the
polling changes. Exercise scan delivery, login/logout, forged forwarded addresses,
disconnect/recovery and concurrent streams. Report Starter CPU and memory against
its 0.5 CPU / 512 MB capacity, with the measurement window and workload.

Acceptance is below 50 ms added per call compared with direct API, and below
500 ms in each display direction. A miss stays Testing with the measured values.
No speed result excuses a change to money, authentication or offline safety.
Local latency and local tests are labelled local, never staging proof. The final
local 100-sample check added 0.56/1.13 ms p50/p95; its installed shell and
network-failure recovery controls passed.

Before-change receipt (09:47–09:56 UTC): 30 per group. Warm curl direct/old p50
57.7/452.7 ms, p95 72.9/539.5 ms; warm browser 61.4/473.9 ms, p95 170.2/675.3 ms.
Direct streams opened 30/30 with curl p50/p95 165.4/327.7 ms and browser 79/175.7 ms;
old-path streams opened 0/30 with either tool within 3 seconds. The ZZ TEST native
cash journey took 9,547 ms, 42 API calls and exactly one finalise, total 9,000 satang.
Its session signed out and its station lease was released. Raw evidence and the
after-change results are published under `docs/qa/proof-2026-11-02/` at close-out.

## Owner's later switch-over checklist

This is a future operation, **not authorization to execute it during SCRUM-718**.

| Setting or device | Forward step | Way back |
| --- | --- | --- |
| ALLOWED_ORIGINS on API | Keep both old and new origins during the transition. | Leave both allowed while reverting devices; do not remove a still-used origin. |
| HANDOFF_APP_ORIGINS on API | Change the single `pos=` destination from old to new in a separately approved, reviewed operation; other app mappings remain byte-identical. Do not use appendEnvList for a replacement. | Restore only the old `pos=` mapping using the then-approved guarded replacement procedure. Never bulk replace environment variables. |
| Launcher VITE_POS_URL | Coordinate its rebuild with the handoff destination; both must name the same origin. | Restore old value and rebuild the launcher. The old static site stays available. |
| Console VITE_POS_URL | Save the new origin and rebuild the Console so its own POS links follow it. | Restore old value and rebuild the Console. |
| POS VITE_LAUNCHER_URL / other VITE values | Preserve the launcher URL and existing build-time settings; rebuild if a value changes. | Use the preserved old site's build/settings. |
| TRUST_PROXY_ADDRS | Retain the verified private and edge hops only; record the measured caller chain. | Retain the existing valid list. Never add shared public egress to make a test pass. |
| iPads' installed-app address | At an idle, settled till, install/open the new address and sign in normally. Its worker/cache/cookie belong to that origin. | Open the old installed app/address and sign in normally; preserve old installation until accepted. |
| Customer displays | Pair each display afresh on the new origin; credentials live per origin and are never copied. Confirm station identity and both direction timings. | Use the old origin and its still-valid pairing, or pair afresh there. Revoke abandoned pairings deliberately. |
| Pi OTO_BOX_BRIDGE_ORIGINS | Owner/box lane adds the approved new origin while retaining old during transition. This lane does not edit the Pi. | Keep or restore the old allowed origin; verify the old till can reach the box. |
| SCRUM-711 `--kiosk-url` | Owner changes the kiosk URL at the agreed bench step, with a new pairing and reboot proof. | Restore the old kiosk URL and pairing, then verify the display. |

Before switching: finish or void every open order using existing controls, resolve
unknown payment outcomes, release the till lease and sign out. Do not copy cookies,
display secrets or a cart between origins. Keep the old service and settings until
the owner accepts the switch. A rollback is an address/sign-in operation, never a
database rollback or a replay of a sale. Production has its own separate approval.

The verified service and results are recorded below. The owner checklist above
is the next operation; this unit does not execute it.

## Created staging service and final proof

| Item | Verified value |
| --- | --- |
| New test address | https://oto-pos-web-staging.onrender.com |
| Service ID | srv-dbk7qu8n74is73bm894g |
| POS live source | 796a3724505ee9cd46f93584c975971ad50a3e4d |
| API live source | 796a3724505ee9cd46f93584c975971ad50a3e4d |
| Source CI | 41452442131, all six jobs successful |
| Workspace / region / plan | API owner, Singapore, Starter, one instance |
| Project environment | evm-danh1brtqb8s73bt5pk0 |
| Deploy / edge cache | checksPass; no-cache |
| Build filter | Step 3 paths read back exactly; three relevant source builds, no documentation rebuild |
| Private network | Private DNS and health 200 from service job job-dbk7sch42hec73et4n8g |
| Existing API settings | Only ALLOWED_ORIGINS extended; 56 names preserved; SCRUM-717 later added BOX_AGENT_TEST_SLOT, bringing the count to 57 |

Only item-counter quote scheduling changed after the first proof, from 200 to
50 ms. The current platform price is still required before displaying money;
pending, stale reply, lock/commit and offline rules remain. The ticket-till
debounce stays 200 ms. No protected display/bridge source changed.

Final warm browser direct/old/new p50: 61.8/480.4/64.3 ms;
p95: 64.8/795.8/82.8 ms. Added p50/p95:
2.5/18.0 ms. Every first/warm curl/browser percentile
comparison passed the 50 ms target; raw individual outliers remain visible.
Native cash journey: old 9023 ms/39 calls; new
3351 ms/39 calls; identical mutation counts and one finalise
each. Three visible till-to-display runs: 325, 338, 301 ms; customer-to-till:
298, 268, 257 ms. Each is below 500 ms without an added warm-up wait.

Caller-address, cookie/Origin, installed-shell/network-failure, scan and static
controls pass. The 32-stream/559-read workload measured peak CPU
0.0105/0.5 cores and memory
141.6/512.0 MiB at 30-second resolution.
No larger plan is supported by this measured workload. All test streams closed,
pairings/leases were removed and sessions signed out. Seven exact synthetic cash
audit receipts remain. There is no physical Pi/offline-unlock or saturation claim.

See [the final report](../qa/proof-2026-11-02/final/README.md) for timestamps,
per-service commits, all p50/p95 values, limits and inspected evidence. The old
static site, launcher destination and park-device addresses remain unchanged.
Stop here: the owner chooses when to execute the forward/rollback checklist.
Returning a test browser to the old address does not require deleting or
suspending the new service.
