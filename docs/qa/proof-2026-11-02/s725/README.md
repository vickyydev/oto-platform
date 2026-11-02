# SCRUM-725 staging link switch

Staging acceptance passed on 2 November 2026; all times below are UTC.
Source: `0f4061d6e9076638258a79daa453026a39d2e2dd`.
CI: https://github.com/vickyydev/oto-platform/actions/runs/41485215834 (all six required jobs passed).
The OTO App job was path-skipped; this is not a fresh full OTO App test claim.

The owner approved moving staging links to the new POS web address, with the old
static site unchanged and available. The plan was posted before code or settings.
Only API HANDOFF_APP_ORIGINS and launcher/Console VITE_POS_URL changed.

- `settings-before.json`: private reads, safe names/counts/fingerprints only. API
  has 56 names and six hand-off entries; both POS origins are already allowed.
- `database-inventory.json`: read-only scan of 425 tables and 2,299 text/JSON/string
  columns, zero errors and zero old-hostname matches. No database edit is needed.
- `review.json`: two HIGH mutations detected; exact original source restored.
- `local-bundles.json`: launcher and Console built files contain the new address
  and no old address. The subsequent served-bundle scan also passed.

Local gates ran unpiped under `set -eo pipefail`: API hand-off plus review 37
passed; launcher 88 passed; Console 585 passed with three existing TODOs. Whole
API, launcher and Console typechecks have zero diagnostics. Touched-file lint,
Node and installer syntax checks, both frontend builds and diff checks pass.
The Console build retains its existing large-chunk advisory.

See `docs/ops/POS_WEB_SWITCHOVER.md` for the forward order, short-lived hand-off
window, deliberately retained historical/rollback references and exact way back.
No production, park device, new service or old-site setting was changed.

## Live switch and browser acceptance

`switch-api.json`, `switch-launcher.json` and `switch-console.json` record the
single-key changes and same-source deployments. API was live at 17:21:34;
fresh native launcher hand-off reached the new POS at 17:22:54; launcher and
Console rebuilt at 17:24:08 and 17:26:14. Pre-switch hand-offs can fail during
routing handover until their normal one-minute expiry. Continuous zero outage
was not measured. Returning to the launcher obtains a fresh hand-off.

`settings-after.json` confirms unchanged API/launcher/Console name counts
56/7/3, every other value across ten services identical, five non-POS hand-off
entries byte-identical, and both allowed origins unchanged. Old-site settings
are identical and the address returns 200 without a redirect. Paper reversal
of exactly the three changed values reproduces the original fingerprints;
rollback was not executed. `live-commits.json` names every live source/deploy.

`served-bundles-before.json` found old-address matches only in launcher and
Console JavaScript. `served-bundles-after.json` reads the same 302 served
HTML/JS/CSS/service-worker files across eight sites, including lazy chunks,
and finds zero old-address matches.

Real Edge browser receipts:

- `browser-suite.json`: launcher sign-in and POS/Admin/Inbox/OTO App/Radar
  sign-ons; Console All apps, Inbox return link, OTO App's own Console link,
  Radar native sign-out. Lucky Wheel opens its existing direct demo without
  a sign-on or booth write; it has no own return link.
- `browser-console.json`: both Performance buttons, Occupancy, End of day,
  and POS Admin with/without the separate POS host cookie.
- `browser-lock.json`: POS launcher, booking, admin/back-to-sign-in, stock
  native sign-in, direct Today entry, and native sign-out to /me 401.
- `browser-old.json`: old-address native sign-in, no redirect, native sign-out.
- `cash-journey.json`: 3,431 ms; 39 calls; exactly one finalise POST; synthetic
  THB 90 cash sale 01a19d53-9d66-7197-9c40-019de90e6351, Z725-000001.
- `display/s725-display-staging-proof.json`: visible 304/233 ms outward/return,
  stream 288/77 ms, 10-second grace, 20-second pause, automatic recovery,
  revocation and replacement-code expiry. Polling source
  `2513e1fb385190c38f494d81006cfc1e44302f79`; API/POS source is the release above.
- `scan-and-offline-shell.json`: single 82 ms scan, nine cached shell entries,
  no API cache, genuine offline NetworkError and online recovery, foreign
  Origin 403 without CORS, sign-out 401.

`cleanup.json` independently confirms the exact ZZ TEST station/box archived,
no active display or lease and signed-out sessions at 17:35:33. The synthetic
receipt is retained as an audit record. No real provider payment, SMS, booth
action, channel-mode change, park-device change or production action occurred.

## Attempts and limits

The first routing assertion checked /me before hand-off exchange completed.
The final harness waits for the actual exchange and authenticated /me result.
Early suite attempts looked for a conditional OTO App management notice on
the wrong/conditionally hidden page, then encountered a harness method/string
assertion error. The final full pass clicks the actual unconditional Console
link on the vouchers page. Lock attempts corrected a native input selector and
waited for sign-out completion before checking /me. These receipts are retained
with their failures; no product behavior was changed to satisfy the harness.

The final `s725-staging-proof.png` was opened and inspected before attachment.
It includes native cash/display images and all live service commits. The
staging virtual box tests do not claim real iPad, private HTTPS certificate or
Pi acceptance; those remain SCRUM-713 bench work.
