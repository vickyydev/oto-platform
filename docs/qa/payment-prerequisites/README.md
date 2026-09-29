# Sprint 2 payment prerequisites - 29 September 2026

SCRUM-391, SCRUM-388 and SCRUM-382 WORK on staging at `b02f7e0` and are
Deployed. All **21 behavioural checks passed** through the public staging API.
The resumed instruction authorised the dedicated simulated proof.

The source commits are `e333994` (reserve unresolved tender amounts), `c0aefae`
(refuse unavailable configured methods) and `b02f7e0` (saved QR routing and
metadata). Seven existing API files passed **196 tests**; API typecheck, lint
and independent review passed. No new suite, migration or dependency.
[Main CI 36486990526](https://github.com/vickyydev/oto-platform/actions/runs/36486990526)
is green. API, POS, Console, Launcher and Booth deployed together on this release;
the OTO App remains on `c416065`.

## Staging evidence

| Ticket | Evidence | Jira attachment |
|---|---|---|
| SCRUM-391 | [Console station routing](staging-391-station-routing.png) | 10856 |
| SCRUM-391 | [Console gateway invoice](staging-391-gateway-routing.png) | 10855 |
| SCRUM-391 | [Paid sale in POS History](staging-391-pos-history.png) | 10857 |
| SCRUM-391 | [Routing, settlement and inquiry API card](staging-391-api-routing-proof.png) | 10858 |
| SCRUM-388 | [Pending money reservation API card](staging-388-reserved-balance.png) | 10859 |
| SCRUM-382 | [Unavailable methods and later settlement API card](staging-382-unavailable-tenders.png) | 10860 |

[Sanitised results](staging-results.json) contain all 21 passing facts and no
cleanup failures. The API cards are screenshots of real staging assertions,
clearly labelled as API evidence. Native screens show configuration, the
pending gateway invoice and the resulting paid sale separately.

The proof verified routing and metadata, signed settlement, missing-callback
inquiry recovery and station QR refusal; disabled/archived cash, card, QR and
manual-card refusal without attempts; replacement precedence and settlement
after disable; same-action replay, reserved balance refusal for new requests,
the unreserved split and closing without a second charge.

Dedicated methods were disabled and the proof station/terminal archived.
Test sales and payment history remain in the staging audit. The final History
capture used the native picker for virtual T1 and reused all passing checks
without repeating financial tests. The physical booth and global methods were
not changed. Real 2C2P sandbox evidence remains separate.

The earlier [read-only inspection](staging-read-only-inspection.json) and
[gateway screenshot](staging-391-gateway-read-only.png), attachment 10854, are
configuration evidence only. They preceded the behavioural proof.

SCRUM-206 Slice F remains In Progress: the shared foundation is tested on
`feat/payment-stage`, but its four screens, complete offline transport and
independent-display acceptance remain to be finished.
