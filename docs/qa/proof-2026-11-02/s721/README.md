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

All six jobs passed in [CI 41472577991](https://github.com/vickyydev/oto-platform/actions/runs/41472577991)
for source `5671ac24dbf0bcef687362956e3ccc64a8923d67`. API and both POS services
were independently read back live on that source. The OTO App job applied its
existing path exclusions; this unit does not claim a fresh OTO App test run.

## Live failure, restoration and browser proof

At 16:09:38.790 UTC, one synthetic POST to an absent ZZ TEST route answered
502 UPSTREAM_UNAVAILABLE and produced exactly one structured log line with
ECONNREFUSED and reusedSocket=false. Query, body, Cookie, Authorization,
x-oto-action-id and Idempotency-Key test markers were absent from the service
logs. The request was never replayed. The forwarder's own health, direct API
and old POS path remained healthy during the fault.

Only API_UPSTREAM on oto-pos-web-staging was temporarily changed through a
single-key write. All four environment names and every original value were
restored and verified; no API or old-site setting changed. Same-source restore
`dep-dbkbbjmc6qcc73e39fh0` finished at 16:12:34.471562 UTC, and the routed new
POS path was healthy at 16:12:42.635 UTC. The deployment proof window is closed.
`live-failure-verified.json` is the passing receipt; `live-commits.json` names
all three live service commits.

The earlier attempt is retained in `live-failure.json`. Render's live status
preceded its traffic handover: the first synthetic POST reached the previous
healthy instance and the API logged 404 on the absent route. Restoration had
the same delay before its first 200. The repeated proof waited for three
read-only checks showing the active fault, then sent a new single POST, and
waited for observed healthy routing after restoration. No product test was
weakened and no write was retried.

The real browser then verified the installed shell offline with no cached API
response, a genuine API network failure, online recovery, one synthetic scan
heard once over EventSource (84 ms), refusal of a foreign Origin with no CORS,
and preserved login. Normal sign-out returned 200 and /me returned 401. The
shell screenshot was recaptured after its entrance animation settled; input
fields are masked. No financial record was created or altered in these checks.

The labelled `s721-staging-proof.png` was opened and inspected after deployment,
and copied to `docs/qa/jira-comments/attachments/SCRUM-721/` for attachment.
The required jira.mjs walk completed and independent read-back confirmed
Deployed at 16:17:57 UTC. The inspected image is attachment 12235;
`jira-closeout.json` records that result. Done remains the owner's acceptance.
The revised order is 721, then staging-link switch-over 725, then the first
stage of 713 at Testing. No physical Pi/iPad or production change is allowed.
