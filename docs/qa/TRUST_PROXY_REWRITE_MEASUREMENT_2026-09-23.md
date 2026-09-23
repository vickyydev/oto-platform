# The caller's address behind the POS site's `/api/*` rewrite

Measured on staging 23 Sep 2026, 16:59–17:14 Bangkok, against the deploy that
carries `TRUST_PROXY_ADDRS` (3317360, 16:52). No source was changed, nothing was
deployed, and nothing was written to the staging database. Evidence files are
named at the end; every address quoted below is either the measuring machine's
own public address (`184.82.240.136`) or a published Render or Cloudflare one.

**The starting point.** With `TRUST_PROXY_ADDRS` = Render's internal network
(`10.0.0.0/8`) + Cloudflare's published ranges, a call straight to the api host
keys the throttles on the caller's own address and ignores a forged
`X-Forwarded-For`. A call through the POS site's `/api/*` rewrite — which is
**every** till, because `apps/pos/src/api/client.ts` fetches `/api` relative —
keys on Render's outbound egress instead, so every till shares one bucket for
the rate limits, the sign-in failure count and the booth credential throttle.

---

## 1. What the api actually receives through the rewrite

### 1a. Neither the api's log nor Render's carries anything left of the egress

`apps/api/src/plugins/telemetry.ts` builds the one line the api writes per
request, and its `record` has no `ip`, no `ips` and no headers — method, route,
path, status, ms, reqId, accountId, branchId, stationId, traceId, actionId,
errorCode, and nothing else. Read back from the staging api through Render's
logs API, for a probe sent through the rewrite at 17:06 Bangkok:

```
{"level":40,"time":1790158005500,"pid":102,"hostname":"srv-danh2ljtqb8s73bt9en0-c4bcdc84d-2vhpq",
 "reqId":"chain367b-rewrite-mudxurfv","method":"GET","route":"(unrouted)",
 "path":"/chainprobe-367b-rewrite-mudxurfv","statusCode":404,"ms":0,"msg":"request completed"}
```

So route (a) as stated does not reach the chain. What it *did* turn up is
better than nothing: Render emits a second log stream for the api service,
`type: request`, and **that one carries `clientIP`**. Four probes at 17:07
Bangkok, two straight to the api host and two through the rewrite, the second of
each pair carrying a forged `X-Forwarded-For: 198.51.100.68/.69`:

```
10:07:34Z  clientIP="184.82.240.136"  requestID="71af37d4-bee5-4e31"  userAgent="oto-qa-367b-direct-plain"
10:07:36Z  clientIP="184.82.240.136"  requestID="c916a1d8-cc95-4fa2"  userAgent="oto-qa-367b-direct-forged"
10:07:37Z  clientIP="74.220.48.5"     requestID="c7058d03-f81b-4dea"  userAgent="oto-qa-367b-rewrite-plain"
10:07:39Z  clientIP="74.220.48.5"     requestID="20b7f36e-c363-4cb8"  userAgent="oto-qa-367b-rewrite-forged"
```

**Render's own platform resolves the caller exactly as `req.ip` does** — the
measuring machine on the direct path, the egress on the rewrite path, the
forgery ignored on both. The platform underneath us cannot see the till either.
Whatever the rewrite forwards, it is not something Render itself treats as the
caller.

### 1b. The rewrite is otherwise a transparent header proxy — measured three ways

**Origin.** `app.ts`'s `onRequest` hook refuses a write whose `Origin` is
neither in `ALLOWED_ORIGINS` nor equal to `Host`. That makes the answer to a
`POST /auth/sign-out` (public, and with no cookie it does nothing) a read-out of
what the api saw. 17:04 Bangkok:

| request | direct to api | through the rewrite |
|---|---|---|
| no `Origin` | 200 `{"ok":true}` | 200 `{"ok":true}` |
| `Origin: https://chain-probe-367b.example` | **403 ORIGIN_NOT_ALLOWED** | **403 ORIGIN_NOT_ALLOWED** |
| `Origin: https://oto-api-staging.onrender.com` | 200 | **200** |
| `Origin: https://oto-pos-staging.onrender.com` | 200 | 200 |

Two things fall out. The unknown origin is refused identically on both paths, so
`Origin` crosses the rewrite **verbatim**. And `https://oto-api-staging.onrender.com`
is *not* in `ALLOWED_ORIGINS` on staging (the value is the five app origins:
pos, launcher, console, app, booth) — it passes only through the same-origin
fallback `origin.endsWith('://' + host)`, so through the rewrite the api saw
**`Host: oto-api-staging.onrender.com`**. The rewrite rewrites Host to the
destination and leaves everything else alone.

**A custom header.** `genReqId` echoes a caller-supplied `x-request-id` matching
`^[A-Za-z0-9._-]{8,64}$` back in the response. Sent through the rewrite:
`chain367b-rewrite-mudxqr9n` came back unchanged. Arbitrary request headers are
forwarded.

**Byte for byte.** A padding header `x-probe-pad` of increasing size, on both
paths:

| bytes | direct `x-probe-pad` | rewrite `x-probe-pad` |
|---|---|---|
| 1000 / 4000 / 8000 / 12000 | 200 | 200 |
| 16000 / 24000 / 32000 | **431** `{"error":"Request Header Fields Too Large"…}` | **431** (identical body) |

The 16 KB header limit fires at the same size on both paths, so the rewrite
hands the api the same header block the caller sent, uncompressed and untrimmed.

**Two Render hops, one response.** Response headers on the rewrite path carry
`rndr-id: 1189b5c3-7aea-47c0, d3d0f08f-e685-4151` — two Render proxy ids
comma-joined, against one on the direct path and one on a plain site asset.
`x-render-origin-server: Render` and the api's `x-request-id` are both present.

### 1c. …and `X-Forwarded-For` is the one header that does **not** arrive

Both hosts' Cloudflare edges refuse an over-long `X-Forwarded-For` with a 403
page. Bisected at 17:05 Bangkok:

| path | last accepted | first refused | refusing edge (page `<title>`) |
|---|---|---|---|
| direct | 34 entries / 508 bytes | 35 / 523 | `DNS points to prohibited IP \| oto-api-staging.onrender.com \| Cloudflare` |
| rewrite | 34 entries / 508 bytes | 35 / 523 | `DNS points to prohibited IP \| oto-pos-staging.onrender.com \| Cloudflare` |

The page titles are the finding. Through the rewrite the refusal is issued by
the **POS host's own edge**, before the rewrite happens — so this probe never
reached the api. But the *accepted* case is what settles it. At 34 entries
through the rewrite the api answered **200**. For that to happen:

- the POS edge accepted 34 entries and, as Cloudflare does and as the direct
  forged probe independently shows (my forged entry survived to the api's left
  with my real address appended to its right), **appended the caller's address**
  → 35 entries / ~524 bytes leaving that edge;
- the api host is Cloudflare-fronted (`server: cloudflare`, `cf-ray` on every
  answer) and the rewritten request reaches it over the public internet — the
  api's own request log records the public egress `74.220.48.5` as its client,
  which an internal short-circuit would not produce;
- 35 entries / 523 bytes arriving at that edge is **exactly what it refuses**,
  measured on the direct path minutes earlier.

It answered 200. Therefore **what the POS edge produced did not reach the api.**
The caller's `X-Forwarded-For`, and the entry Cloudflare appended to it naming
the till, are dropped at the rewrite.

### 1d. What could not be measured, and the one line that would settle it

Two possibilities survive and are **indistinguishable from outside**:

- **(i)** the rewrite sends no `X-Forwarded-For` at all, and the chain the api
  sees is `74.220.48.x, <cf-edge>`;
- **(ii)** the rewrite mints a fresh one-entry header naming the till, and the
  chain is `<till>, 74.220.48.x, <cf-edge>`.

Why nothing outside can tell them apart: `proxy-addr` walks the chain from the
right and returns the **first entry no trusted proxy wrote**. The egress is not
trusted, so the walk stops there, and `req.ip`, the rate-limit headers and the
`auth_throttle` rows all report the egress in either case. Nothing to its left
is printed by the api's log, by Render's request log, or by any response header;
the api reads no other forwarding header (grep across `apps/api/src` and
`packages/`: `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`, `Forwarded`,
`X-Forwarded-Host`, `X-Forwarded-Proto` appear in prose comments only, never in
code), and `CF-Connecting-IP`/`True-Client-IP` would in any case be overwritten
by the api's own Cloudflare with the egress. Inflating the header to trip the
edge's length limit is impossible because the rewrite, not the caller, writes it.

**The diagnostic, not added.** One debug line in
`apps/api/src/plugins/telemetry.ts`'s `onResponse` — `req.ips` (Fastify's full
resolved array, which exists whenever `trustProxy` is set) plus the raw
`req.headers['x-forwarded-for']` — logged at `debug` on staging only, with
`LOG_LEVEL=debug` set on the api service for the length of one measurement.
Send one request through the rewrite and one direct; the two lines print the
literal chains. It would show whether case (i) or (ii) holds, and it is the only
thing that will. It would need the log line to be removed or left behind a level
nothing sets in production, because the chain is caller-controlled text going
into a log stream.

### 1e. Which forwarding headers matter at all

Only `X-Forwarded-For`. `req.ip` is the single input to every throttle
(`plugins/rate-limit.ts` `keyGenerator: (req) => req.ip`; `services/auth.ts`
`ip:<addr>`; `plugins/credential.ts` → `box-auth:<ip>`, `box-claim-miss:<ip>`,
`booth-pair:<ip>`), and `req.ip` comes only from `X-Forwarded-For` through
`proxy-addr`. Adding a different header to the trust decision means adding code
that reads it, which is shape (B) below.

---

## 2. Is the egress address the POS site's own, or shared?

**Render's own API says shared, and narrows the range.** `GET
/v1/services/{id}/outbound-ips` for each service in the workspace:

| service | type | outbound |
|---|---|---|
| oto-pos-staging | static_site | `{"ips":["74.220.48.0/24","74.220.56.0/24"],"type":"shared"}` |
| oto-booth-staging | static_site | *identical* |
| oto-console-staging | static_site | *identical* |
| oto-launcher-staging | static_site | *identical* |
| oto-api-staging | web_service (singapore) | `{"ips":["74.220.52.0/24","74.220.60.0/24"],"type":"shared"}` |
| oto-app-staging | web_service (singapore) | *identical to the api* |

Two /24s — 512 addresses — not the /20 the reverse lookup suggested, and the
field is literally `"type": "shared"`. Every static site in the workspace
returns the same pair.

**Render's documentation says shared across tenants.** From *Static Outbound IP
Addresses*: outbound IP ranges are "shared across _all_ services in the same
region", and "static sites don't use outbound IP addresses, because they can't
initiate outbound traffic" — which is why these are the region's shared proxy
fleet rather than anything belonging to the POS site. Dedicated addresses are a
separate paid workspace feature. *Redirects and Rewrites* says nothing at all
about which headers a rewrite forwards or about the client IP.

**Measured, over ten minutes.** 33 requests through the POS rewrite, three a
minute, 17:02:49 → 17:12:39 Bangkok, reading the `rl:GET:/public/member-tier:*`
rows afterwards. One address for the whole run: **74.220.48.242**. The earlier
run at 16:49–16:52 was **74.220.48.5**. Those two rows are the only `74.220.*`
rows the table holds, and rows are never swept (rows from 21 Sep are still
there) — so across all of today's rewrite traffic on that route, two distinct
egress addresses, and the one in use changed between 16:52 and 17:02. Stable
within a run, not stable between them.

**Three sites, one pool, one bucket.** At 17:13, three requests each through the
POS, Console and launcher rewrites, twenty seconds apart, watching
`x-ratelimit-remaining`:

```
pos       200/119 200/118 200/117     <- a fresh window
console   200/119 200/118 200/117     <- another fresh window
launcher  200/116 200/115 200/114     <- counts 4,5,6 — it joined the POS's window
rows after: 74.220.48.5 = 6 @17:13:40   74.220.48.242 = 3 @17:13:33
```

The launcher's requests continued the counter the POS had opened seconds before,
on `74.220.48.5`, while the Console landed on `74.220.48.242`. **Two different
apps shared one egress address and one rate-limit bucket, and the same app used
two different addresses within a minute.** The address is not the site's, it is
whichever proxy in the region's shared fleet takes the request.

**The live consequence, worth stating plainly.** `AUTH_MAX_FAILURES=5`,
`AUTH_COOLDOWN_SECONDS=300` on staging, and `services/auth.ts` throttles a
sign-in on `phone:<phone>` **and** `ip:<addr>`, refusing if either is locked. The
POS, the Console and the launcher all sign in through their own `/api/*`
rewrites onto this shared handful of addresses. So five mistyped passwords
anywhere in the estate lock **every** till, the Console and the launcher out of
signing in for five minutes. The rate limit (120/min) and the booth pairing
throttle (10 wrong codes per address per ten minutes, and the television pairs
through the booth site's `/booth/*` rewrite) collapse the same way. Boxes are
the exception: a Pi calls `/box/v1/*` on the api host directly, so
`box-auth:<ip>` and `box-claim-miss:<ip>` still key on the box's own address.

---

## 3. Does the till's own address survive the hop?

**In the only form a trust list could use, no — measured (§1c).** What the POS
edge wrote, including the entry naming the till, is dropped at the rewrite. The
residual unknown (§1d) is whether the rewrite substitutes a fresh one-entry
header naming the till. That unknown decides whether a trust list would be
*ineffective* or *dangerous*, and it does not rescue the approach either way:

- **case (i), no header:** trusting `74.220.48.0/24` changes nothing. With the
  whole chain trusted, `proxy-addr` returns its last element, which is the
  egress. Same bucket, same collapse, plus a new hole for nothing.
- **case (ii), a fresh entry naming the till:** trusting the two /24s would
  recover the till's address — and would simultaneously let **any** of the
  thousands of services other tenants run in that region call the api from
  `74.220.48.x` with a forged `X-Forwarded-For` and be believed, which is
  precisely the hole SCRUM-353 closed. A forged sign-in source is a free reset
  of the per-address failure count on every attempt.

So no trust list is the answer, and the shapes reduce to (C) and (D). For those,
two facts from the code:

- **The cookie.** `plugins/session.ts` sets it `httpOnly`, `sameSite: 'lax'`,
  `secure`, `path: '/'`, host-only — no `domain`. `onrender.com` is on the public
  suffix list, so two `*.onrender.com` hosts are cross-**site**, not merely
  cross-origin (ARCHITECTURE §16 records this as the reason the rewrite exists).
- **The hand-off is not a counter-example.** `POST /auth/handoff/exchange` looks
  cross-origin but is not: the launcher mints a token aimed at one app, the
  browser carries it in the URL fragment, and the target app exchanges it from
  **its own** origin through **its own** `/api/*` rewrite, receiving a host-only
  cookie for that origin. Nothing today sets a cookie on a cross-site response.
- **What a credential could key on.** Signed-in traffic carries a session, and
  the session carries `accountId`, `branchId` and `stationId` (`req.auth`,
  already read by `plugins/telemetry.ts`). Boxes carry a bearer secret, the
  television a paired device header. Sign-in, `/public/*` and booth pairing
  carry nothing — by definition, since they are where a credential comes from.

---

## 4. The four shapes

### (A) Trust the site's exact documented outbound addresses only

Add `74.220.48.0/24,74.220.56.0/24` to `TRUST_PROXY_ADDRS`.

- **Fixes:** in case (ii) only, the till's address is recovered and each till
  gets its own bucket. In case (i), nothing.
- **Leaves shared:** nothing further — but see below.
- **Forgery surface:** 512 addresses shared, by Render's own documentation and
  its own API field (`"type":"shared"`), with every other tenant's services in
  the region. Any of them can forge a caller past every throttle. This is the
  hole SCRUM-353 closed, reopened wider.
- **Change size:** one value — `render.yaml` + the dashboard env var + the
  comment block in `apps/api/src/env.ts` and `app.ts`. No code.
- **Cookie risk:** none.
- **Verdict: refuse.** Not acceptable, and in case (i) it does not even work.

### (B) A header the proxy sets that a caller cannot forge

- **Does one exist?** Not on this path. The api's own log and Render's request
  log both stop at the egress; Render's documentation names no such header for
  static-site rewrites; `CF-Connecting-IP` and `True-Client-IP` are rewritten by
  the api's own Cloudflare to the egress. Nothing measured on the outside gives
  a candidate.
- **If one existed:** the api would have to read it explicitly, which means
  trusting whoever can set it — the same shared egress fleet — so it inherits
  (A)'s forgery surface exactly.
- **Change size:** `app.ts`, `env.ts`, `plugins/rate-limit.ts`,
  `apps/api/test/trust-proxy.test.ts`.
- **Verdict: not available.** Would only be reconsidered if Render documents a
  signed or tenant-scoped forwarding header for rewrites.

### (C) The tills call the api host directly

Drop the `/api/*` rewrites; each frontend calls `https://…api….onrender.com`
with `credentials: 'include'`; the session cookie becomes `SameSite=None`;
CORS with the origin allow-list.

- **Fixes:** everything. Each till's own address reaches the api, keyed
  correctly and unforgeably, because the api is then the first hop behind
  Cloudflare exactly as the direct measurements show.
- **Leaves shared:** only what genuinely is shared — one mall's NAT.
- **Forgery surface:** none beyond today's direct path, which is already proven
  to ignore a forged header.
- **Change size:** large and spread. `render.yaml` (five site blocks), each
  frontend's api client and `vite.config.ts` (pos, console, launcher, booth,
  oto-app), `plugins/session.ts` (cookie attributes), `app.ts` (register CORS,
  and the origin check's role changes), plus the POS's service worker and
  offline behaviour, which assumes same-origin.
- **Cookie risk: this is the decision ARCHITECTURE §16 rejected, on record and
  for three reasons that have not changed.** `SameSite=None` is the attribute
  that exists to let a cookie travel cross-site, so the free CSRF protection
  goes and the whole defence moves onto our own origin check; the cookie becomes
  a third-party cookie because `onrender.com` is a public suffix, at a moment
  when browsers are restricting exactly that — a till losing its session to a
  browser update; and every sale-path write pays a preflight round trip over a
  mall connection.

### (D) Key the throttles on a credential where one exists, keep the address for the rest

`rl:` route buckets and any signed-in throttle key on `station:<id>` or
`account:<id>` when the request carries a session, falling back to the address;
the box and booth credential throttles already key on a credential they can
identify and would key on it rather than on `req.ip`; sign-in, `/public/*` and
booth pairing keep the address.

- **Fixes:** the bulk of the traffic. Every signed-in till gets its own bucket
  regardless of how it reaches the api; the shared egress stops being the unit
  of account for the routes that carry a session.
- **Leaves shared:** the sign-in failure count (`ip:<addr>`), the booking site's
  `/public/*` limits, and booth pairing — all of which are *pre*-credential by
  definition. The five-failures-locks-the-estate problem survives unless the
  sign-in throttle's address half is dropped or widened, which is its own
  decision: `phone:<phone>` is the primary bucket there and is unaffected.
- **Forgery surface:** none added. A credential is already verified before the
  throttle would read it; an unauthenticated caller falls back to the address
  and is no worse off than today.
- **Change size:** contained and in one layer. `plugins/rate-limit.ts`
  (`keyGenerator`), `services/auth.ts` (the `ip:` half), `plugins/credential.ts`
  and `services/device-credential.ts`/`services/box.ts` (the three credential
  throttles), plus tests. No frontend, no blueprint, no cookie.
- **Cookie risk:** none. The same-origin rewrite and ARCHITECTURE §16 stand
  untouched.

### Recommendation

**Take (D) now, and do not take (A).** It is the only shape that improves the
thing that is actually broken without reopening SCRUM-353's hole or reversing
the same-origin cookie decision, and it is confined to the api's own plugin
layer. It should land with the sign-in throttle's address half reconsidered
explicitly — as it stands, five mistyped passwords lock every till, the Console
and the launcher for five minutes, and that is a worse outage than the throttle
prevents. `phone:<phone>` is the bucket that carries the security value there.

**Second choice: (C)** — and it is the only complete answer, so it is the one to
take if the estate ever moves to a real parent domain, where `SameSite=Lax`
survives across subdomains and §16's three objections mostly dissolve. On
`*.onrender.com` it costs the session cookie's own protection, so not now.

**(D) does not depend on the unmeasured fact.** (A) does: it is useless in case
(i) and dangerous in case (ii). If (A) is to be argued for at all, the debug
line in §1d has to be run first — and the shared-tenancy objection stands after
it either way.

---

## Evidence index

All in the session scratchpad.

| file | what it holds |
|---|---|
| `367b-svc.json` | POS site and api service records from the Render API |
| `367b-outbound.json` | `outbound-ips` for all six services — the `"type":"shared"` answers |
| `367b-headers.json` | the Origin table and the `x-request-id` echo |
| `367b-size.json` | the padding/`X-Forwarded-For` size sweep |
| `367b-bisect.json` | the 34/35-entry thresholds and the two Cloudflare 403 page titles |
| `367b-hops.json` | response headers, direct vs rewrite vs site asset (the doubled `rndr-id`) |
| `367b-logs.json` | the api's pino line for a probe through the rewrite |
| `367b-reqlog.json` | Render's four `type: request` lines with `clientIP` |
| `367b-egress.json`, `367b-egress.log` | the ten-minute run, 17:02:49 → 17:12:39 |
| `367b-census.json` | every `74.220.*` row in `auth_throttle` |
| `367b-siblings.json` | POS / Console / launcher sharing the egress pool |

Prior art re-read, not re-measured: `367-measure.json`, `367-confirm.json`
(the 16:49 and 16:52 runs this follows).
