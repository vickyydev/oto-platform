# SCRUM-734 branch configuration copy

Plan posted before product changes at 2026-11-03T16:36:30.133Z.

I will extend the existing branch copy so a new branch receives the source supervision policy, guardian confirmations, drop-off prices and stock definitions. Stock definitions include their product/size links, pack sizes and shelf minimums, with references changed to the target branch's own records. Stock counts and trading history are not copied. Existing target choices stay unchanged, repeat copying adds no duplicates, and rows that cannot be mapped are explained in the preview rather than linked back to the source branch.

I read the current schemas and the whole clone service. Payment methods and staff benefit templates already belong to the operator, so both branches already share them; the old comment saying they have no tables is wrong. Booth settings, prizes and published versions belong to a booth station. Stations are not copied, so there is no valid target station for those rows. I will leave those rows out and say so plainly; wheel layouts are already shared across the operator. This produces no booth configuration without its matching published version.

I will test the real preview/copy routes, exact copied values and fresh identities, source isolation, existing and archived target choices, blocked barcode items, stock links and zero copied balances, repeat requests, and the booth exclusion. The Console preview will name the additional copied items. Staging proof will use only two dedicated ZZ TEST branches, show the copied values on screen, then retire the exact fixture records and read them back. No migration, new setting, service or park device is planned.

Local implementation starts on its own branch while the first-sale print checks run. Source will stay off main until SCRUM-707 is Deployed and I have rebased over its clone changes. SCRUM-730 currently holds the release slot, with 728 next. I will claim no slot before its published handover releases it. The older proof-only tickets remain separate, with their report limits carried into the proof.
