# POS web service: staging proof and owner switch-over

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
Ordinary completed requests keep their upstream socket for reuse. SIGTERM drains
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

## Created staging service

Verified on 2 November 2026. The service is live and staging timing/safety
acceptance passed. No park device has switched addresses.

| Item | Read-back |
| --- | --- |
| New test address | https://oto-pos-web-staging.onrender.com |
| Service ID | srv-dbk7qu8n74is73bm894g |
| Live source | c2fdd28fdc9e944d058af62dec1347e5f2b7a56f |
| Source CI | 41439428324, all six jobs passed |
| Workspace / region / plan | API owner, Singapore, Starter, one instance |
| Project environment | evm-danh1brtqb8s73bt5pk0 |
| Deployment / edge cache | checksPass; no-cache |
| Build filter | All paths in step 3 above were read back exactly |
| Private network | Private DNS and API health 200 from the new service job job-dbk7sch42hec73et4n8g |
| Existing API configuration | ALLOWED_ORIGINS only; 56 names before and after, all other values unchanged |

No address has been switched on a park device. The manual service settings match
the commented render.yaml block. The API same-commit deployment is
dep-dbk7sns9v7es73bvie50, live at 12:16:46 UTC on the source above.
Native sign-in confirmed the new origin is active.

## Measured acceptance and stop point

Bangkok, 30 per path/tool/mode, 360 calls, all 200. Warm browser direct/old/new
p50: 57.7/460.0/61.3 ms; p95: 62.4/518.1/65.4 ms. Matching-percentile added
latency is 3.6/3.0 ms; all four tool/mode comparisons are below 50 ms. Individual
internet outliers remain in the raw data; this is not an every-request maximum.
New streams opened 30/30 in both tools; old streams 0/30 within three seconds.
The native cash journey took 9.057 seconds old versus 3.327 seconds new, with
39 calls and one finalise on each path. Visible display directions measured
448 ms and 242 ms on source c2fdd28fdc9e944d058af62dec1347e5f2b7a56f,
including SCRUM-720's polling changes.

The real caller address reaches the API without changing TRUST_PROXY_ADDRS.
Forged values do not create new address buckets. Cookie/Origin controls, the
installed offline shell, native scans, static caching and traversal checks pass.
Under 32 streams plus 562 reads in 150 seconds, sampled peak memory was
114.4 MiB of 512 MiB and CPU 0.0062 of 0.5 cores. No larger plan is justified
by this measured workload. All 32 streams closed; test displays, leases and
sessions were cleaned up. The three synthetic cash receipts remain as audit facts.

Full methods, limits, raw receipts and inspected proof cards are in
[the result report](../qa/proof-2026-11-02/s718-results.md).
The proof is an isolated virtual setup, not a physical Pi/offline-unlock test.
The current park device addresses, launcher handoff destination and old static
site settings remain unchanged. Stop here; the owner chooses if and when to use
the forward/rollback checklist. The new service need not be deleted or suspended
to return a test browser to the old address.
