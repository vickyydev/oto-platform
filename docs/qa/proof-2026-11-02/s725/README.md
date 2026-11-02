# SCRUM-725 staging link switch

Source checkpoint: live configuration and browser acceptance are pending.

The owner approved moving staging links to the new POS web address, with the old
static site unchanged and available. The plan was posted before code or settings.
Only API HANDOFF_APP_ORIGINS and launcher/Console VITE_POS_URL will change.

- `settings-before.json`: private reads, safe names/counts/fingerprints only. API
  has 56 names and six hand-off entries; both POS origins are already allowed.
- `database-inventory.json`: read-only scan of 425 tables and 2,299 text/JSON/string
  columns, zero errors and zero old-hostname matches. No database edit is needed.
- `review.json`: two HIGH mutations detected; exact original source restored.
- `local-bundles.json`: launcher and Console built files contain the new address
  and no old address. This is local evidence; served bundles still need checking.

Local gates ran unpiped under `set -eo pipefail`: API hand-off plus review 37
passed; launcher 88 passed; Console 585 passed with three existing TODOs. Whole
API, launcher and Console typechecks have zero diagnostics. Touched-file lint,
Node and installer syntax checks, both frontend builds and diff checks pass.
The Console build retains its existing large-chunk advisory.

See `docs/ops/POS_WEB_SWITCHOVER.md` for the forward order, short-lived hand-off
window, deliberately retained historical/rollback references and exact way back.
No production, park device, new service or old-site setting was changed.
