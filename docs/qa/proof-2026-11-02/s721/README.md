# SCRUM-721: forwarder failure trace and write connections

The runtime change is confined to `apps/pos/server/server.ts`. A fixed structured
failure line records method, upstream path without query, error code and whether
the socket was reused. It never records a request body, response body, header,
cookie, authorization or free-form error message. An interrupted response is
also traced; duplicate events for the same failed attempt and normal client
cancellation are suppressed. The connection setup deadline has an explicit
ETIMEDOUT code. There is still no connected-response deadline.

Writes use a fresh upstream connection; GET/HEAD/OPTIONS retain pooling. A write
is never replayed. The existing once-only retry remains limited to a bodyless GET
on a reused socket reset before a response. Exact payload/header and stream
behavior remains pinned by the existing tests.

## Private-network cost, before the source change

A one-off job on the existing staging POS web service sent 100 interleaved POSTs
per connection mode to an absent ZZ TEST API route over the private network.
All 200 calls returned 404, with zero business mutations. Live source was
14e1432492f603e3b774d512aa797e5a57061595; job job-dbkaihjbc2fs73eta6g0.

| Mode | p50 | p95 | Reused sockets |
| --- | ---: | ---: | ---: |
| Pooled | 0.757 ms | 1.946 ms | 100 / 100 |
| Fresh | 1.984 ms | 2.791 ms | 0 / 100 |
| Added | 1.228 ms | 0.845 ms | |

These are matching-percentile differences on Render's private network, not
end-user latency or an every-call maximum. Raw outliers remain in
`private-connection-cost.json`. The small measured cost favors fresh write
connections over another idle-socket timer/race.

## Local review and release

Seven new regression cases failed before the fix. Afterwards all 40 server/static
cases, 1,644 POS tests, seven built till journeys, whole POS typecheck, touched-file
lint and build passed. The tests cover four write methods, preserved read pooling,
one safe failure line, stale-GET recovery, response interruption and cancellation.

Exact-source CI, live forced-failure/restoration evidence and inspected image
attachment remain pending. 721 stays Testing after the source push until they
pass. The revised owner order is 721, then staging-link switch-over 725, then the
first stage of 713 at Testing. No physical Pi/iPad or production change is allowed.
