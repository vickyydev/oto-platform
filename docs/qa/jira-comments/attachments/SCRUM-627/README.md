# SCRUM-627 POS Admin redirect and native operations acceptance

Jira is Deployed with one outcome comment 12544 and six inspected staging attachments. Source `cd2ed663d725e0fbcb05a3668249a2de5ba0b254` passed all six jobs in [CI 39931622118](https://github.com/vickyydev/oto-platform/actions/runs/39931622118) and is live on API, Admin and POS. Parent SCRUM-618 remains In Progress; final acceptance belongs to the owner.

The POS `/admin` entry is a one-release compatibility redirect with 27 fixed panel destinations and six native print-template choices. Sign-in, password/lock, actual app access and park readiness stay in force; deliberate retry and actor/park/address ownership prevent obsolete responses from navigating a new session. Admin now hosts the existing Inventory, Members, Tier verifications and Wallet lookup/reactivation panels through narrow capabilities. Actual stock/menu/tier metadata is read, with explicit unavailable states and the native first-sorted-tier fallback. Existing page guards and API authority remain; section gates affect navigation. Station Setup, till operations, offline member/check-in/stock/wallet behavior, catalogue hydration, public booking and mock device fallback stay in POS. All 75 former POS admin files plus 3 dead modules are absent, and only the POS package/importer edge is removed. Q11 updates the measured legacy caller counts platform 52 to 46 and wallet 2 to 3.

The original feature source `31801788b9015bbfd97d30cf748e93f497f470b5` retains its local gate image and manifest `70f7136e1d5fe0d88b30831ca7d117084ac31885221a2dc2231f711f4a02483c`. Its first hosted CI attempt failed during OTO App setup; the watcher returned exit 0 and is explicitly not treated as a pass. Q12 authorizes only the oto-app runner pin from ubuntu-latest to ubuntu-24.04. The portable repair receipt and exact diff bind the actual repair commit and the sole selected-input change. Application and dependency inputs stay unchanged. Final source `cd2ed663d725e0fbcb05a3668249a2de5ba0b254` uses manifest `7c0936842c5203d295a0369e39c93c0cc37b7ed8a88b052e429b158f05883d97` and has its own six successful CI jobs and three live deployments. The original 141 feature-owned paths and the single supplemental workflow path are counted separately. The first staging attempt stopped before any screenshot or issued handoff; its exact cause was not established. It made no business write and both origins signed out with 200/me 401, but its full readback did not complete. That incomplete attempt and wrapper exit 1 stay separate from the later complete proof.

| Staging image | Native check | Captured UTC |
|---|---|---|
| [SCRUM-627-01-pos-admin-opening-phone390.png](SCRUM-627-01-pos-admin-opening-phone390.png) | native POS Admin redirect held before issue at390px | 2026-10-23T09:56:52.835Z |
| [SCRUM-627-02-console-inventory-native.png](SCRUM-627-02-console-inventory-native.png) | native Inventory controls; no stock or location write | 2026-10-23T09:57:00.672Z |
| [SCRUM-627-03-new-member-controls.png](SCRUM-627-03-new-member-controls.png) | native new-member controls; empty draft opened and canceled only | 2026-10-23T09:57:08.457Z |
| [SCRUM-627-04-tier-verifications-native.png](SCRUM-627-04-tier-verifications-native.png) | native read-only tier verification audit; record values hidden | 2026-10-23T09:57:15.386Z |
| [SCRUM-627-05-wallet-lookup-empty.png](SCRUM-627-05-wallet-lookup-empty.png) | native empty Wallet lookup; no key, search or reactivation | 2026-10-23T09:57:21.451Z |
| [SCRUM-627-06-pos-station-setup-retained.png](SCRUM-627-06-pos-station-setup-retained.png) | native POS Station Setup retained; no station chosen or created | 2026-10-23T09:57:31.368Z |

The staging proof is read-only. It performs one existing-demo POS sign-in and the native same-person Admin handoff/exchange. It opens and cancels an empty Add member form; it does not save business data, create a member, query or reactivate a wallet, choose or create a station, send an SMS, change a channel, touch payment/check-in data or create a fixture. Stock/member/tier-trail fingerprints and the original demo park/preferences remain unchanged. Both origins finish with sign-out200 and me401. Identity, record values and input seeds are hidden, including native DIV stock badges and late mutations. Exact record photos learned from own-park stock are privacy-suppressed with transparent image responses in the main Inventory frame; original photo assets are not fetched or verified. All six real PNGs were independently inspected twice after all three exact-source deployments. Automated tests cover writes, refusals, retries, stale lifetimes, truthful failed readbacks and phone geometry; actual staging saves are not claimed.

The original feature frozen battery verifies 3685 source/config/static-asset inputs, 78 retired paths absent and 28 dependency inputs before and after each gate. The 141 owned paths comprise 63 present and 78 deleted. Installed POS has no admin-screens edge; Console keeps its own link. All eight original feature exact-image gates below finish successfully. API final totals: 4803 passed; 0 failed; 401 skipped; 5 todo. Feature post-rebase own compilers, touched lint, generated client and affected house/package checks also pass; the attached receipts retain exact counts and hashes.

| Gate | State | Final test summary |
|---|---|---|
| full-checks | complete | Complete; quality details in the gate receipt |
| full-other | complete | 2636 passed; 0 failed; 0 skipped; 3 todo |
| full-pos | complete | 1437 passed; 0 failed; 0 skipped; 0 todo |
| full-browser | complete | 194 passed; 0 failed; 0 skipped; 0 todo |
| full-api1 | complete | 1652 passed; 0 failed; 106 skipped; 0 todo |
| full-api2 | complete | 1651 passed; 0 failed; 174 skipped; 4 todo |
| full-api3 | complete | 1500 passed; 0 failed; 121 skipped; 1 todo |
| full-box | complete | 749 passed; 0 failed; 0 skipped; 0 todo |

Earlier outcomes remain separate from these complete gates: Earlier affected POS and browser fixture/compiler attempts, obsolete Booth wording assertion and private negative variants remain separate. No earlier partial or failed attempt is used as the frozen release result. The native Print templates wording/href correction and ref aliases are included in this exact source manifest.

Independent source review has no pending finding and confirms the preservation review of 158 operational bodies. Held-helper tests and locally mocked geometry are preparation only; no local PNG is represented as staging evidence.

The parent phase still needs its actual Till price/tender/tax round trip. This child acceptance does not close that requirement.

The optional staged whitespace check returned 2 for the retained blank line at the end of stockPresentation.ts. It is recorded as nonzero; the exact frozen bytes and mandatory gate outcomes are unchanged.

