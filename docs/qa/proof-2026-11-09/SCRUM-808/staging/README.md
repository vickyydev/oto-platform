# SCRUM-808 The BEO package total reads the package's price for the party's day: staging proof

Same run as `SCRUM-818/staging` (10 November 2026, 14:23-14:31 Bangkok,
oto-app-staging and oto-api-staging live at
`608e3c0ba23e385a6ffd0eac34421196a57ca6a6`, the staging administrator, name
masked). The event is the ZZ TEST "ZZ TEST 818 party" at Central Floresta on
Saturday 21 November 2026, 12 children and 6 adults, after the pasted AI Fill
was approved with the Floresta package (10 children and 4 adults included).

| Check | Result | Picture |
|---|---|---|
| Package price for the day | Pass: "Package price for Saturday (weekend) ฿20,900.00" | `808-st-01-package-module-total.png` |
| Extra children | Pass: "Extra children: 2 children × ฿1,500.00 ฿3,000.00" | same |
| Extra adults | Pass: "Extra adults: 2 adults × ฿500.00 ฿1,000.00" | same |
| Add-ons | Pass: none bought (every add-on at quantity 0), "Add-ons Subtotal: ฿0.00", no add-on line in the breakdown | same |
| Package Total | Pass: "Package Total: ฿24,900.00" | same |
| Included lines | Pass: the six included lines at ฿0 read "Included in the package price" | same |
| Events > Settings > Packages > the Floresta package | Pass: Included Items Total THB 0.00 with "Included in the package price"; no "unallocated" sentence anywhere on the page (read only, nothing saved) | `808-st-02-settings-package-breakdown.png` |
| Generate from BEO | Pass: `POST /api/events/:id/line-items/generate-from-beo` (mode replace) 201; lines "Package: Birthday package, Central Floresta (Saturday, weekend price)" 1 × 20,900, "Package: extra children" 2 × 1,500, "Package: extra adults" 2 × 500 (package lines 24,900, as the module); the included lines at 0; "Entertainment: Zombie game" 1 × 4,000 | read-back in `receipt.json`: `generateFromBeo` |

## Notes

- The billing module (with its Generate from BEO button) is not mounted
  anywhere in the editor today (`beo-billing-module.tsx` has no importer), so
  Generate from BEO was run through the module's own route and read back; no
  picture of it.
- The BEO's Party Details section still shows its older POS fields: "Total 0฿"
  and, after the deposit, "Outstanding -5,000฿" (see
  `SCRUM-813/staging/813-st-01-beo-party-details-5000.png`). It does not read
  the package total of ฿24,900.

Clean-up: see `SCRUM-818/staging/README.md` (all ZZ TEST events 404, the ZZ
TEST employee 404, signed out 401).
