# Sprint 2 payment prerequisites - 29 September 2026

SCRUM-391, SCRUM-388 and SCRUM-382 are implemented and live on staging at
`b02f7e0`. Their Jira status remains **Testing**: staging payment behaviour has
not yet been exercised for this release.

The three source commits are `e333994` (reserve unresolved tender amounts),
`c0aefae` (refuse unavailable configured methods) and `b02f7e0` (saved QR
routing and durable QR metadata). No new test suite, migration or dependency.

Local verification passed in seven existing API test files: cash 21, methods
23, terminal 24, gateway 42, sync 23, sales 58 and redaction 5, **196 total**.
API typecheck, lint of the changed files and independent review passed.
[Main CI 36486990526](https://github.com/vickyydev/oto-platform/actions/runs/36486990526)
and [branch CI 36485272336](https://github.com/vickyydev/oto-platform/actions/runs/36485272336)
are green. One deployment put API, POS, Console, Launcher and Booth on this
release; the OTO App remains on `c416065`.

## Read-only staging evidence

- [Console gateway screenshot](staging-391-gateway-read-only.png): the native
  Console section shows the simulated sandbox gateway and no pending QR
  attempts. It does not show a successful payment.
  Attached to [SCRUM-391](https://oto-suite-dev.atlassian.net/browse/SCRUM-391)
  as `staging-391-gateway-read-only.png`, attachment 10854; the ticket is Testing.
- [Inspection report](staging-read-only-inspection.json): the virtual box has
  simulated devices and the gateway simulator is available. No configuration,
  test sale, payment attempt or simulator event was created.

The report explicitly records `paymentBehaviourProven: false`. Real 2C2P
sandbox credentials and verification are separate from this simulator proof.

## Pending behavioural proof

Automatic approval review blocked the disposable proof before execution
because it creates and archives shared staging configuration and financial
records. Explicit approval has been requested for the scoped simulated proof:

- Create a dedicated station and terminal on the in-process box, with its own
  payment methods and no drawer routing.
- Verify saved gateway routing, durable QR metadata, signed callback settlement,
  inquiry recovery without a callback, and station-level QR refusal.
- Verify disabled/archived cash, card, QR and manual-card refusals without new
  attempts; a live method replacement; settlement after a method is disabled.
- Verify pending terminal reservation, same-action replay, refusal of distinct
  terminal/cash/manual attempts over the available balance, an unreserved split,
  staff confirmation and closing without a second charge.
- Capture native Console/POS screenshots and clearly labelled API test-run
  cards, then disable the proof methods and archive the station/terminal.
  Test sales and payment history remain as staging audit records.

The physical booth configuration and global tender methods stay unchanged.
Do not mark these tickets Deployed until the behavioural proof passes and its
named staging screenshots are attached to Jira. SCRUM-206 Slice F remains
unbuilt; offline and separate-display acceptance require its existing seams.
