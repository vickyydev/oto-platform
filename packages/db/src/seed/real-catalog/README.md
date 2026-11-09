# The park's real till catalogue

Reference data for the two parks' tills, transcribed on 2026-11-09, and the
loader that puts it on a branch. It is separate from the demo seed
(`../menu.ts`), which stays as it is for local runs, CI and tests.

## Sources

| Document | What it gives |
|---|---|
| `Menu_eng_CENTRAL.pdf` (2 pages) | Oto Play Park, Central Floresta menu, lines 1-71 |
| `Menu_eng_ROBINSON_chalong.pdf` (2 pages) | Oto Play Park, Robinson Chalong menu, lines 1-68 (three fewer lines, so the numbers shift) |
| `OTO_PLAY_PARK_POS_Price_List.pdf` (3 pages) | 04 Balloons, 05 Merchandise, 06 Workshop (and tickets and extras, which are not loaded) |
| `photo-november-special-sea-salt-maple-latte-170.jpg`, `photo-november-special-oto-buffalo-wings-240.jpg` | The two November specials |
| `photo-free-drinks-menu.jpg` | The Free Drinks Menu card (no prices printed) |
| `photo-current-pos-chinese-tea-variants.jpg` | Chinese Tea on the current POS: its required single choice "Tea Choice", five options at THB0.00 (no base price visible) |
| `owner-answers-2026-11-09.md` | The owner's answers of 9 November 2026: Chinese Tea is 140 THB at both parks; the Free Drinks Menu "stays seeded hidden (active: false)" |

All prices are THB including VAT (and, on the menus, service charge), stored in
satang (`satangFromBaht`). Every document prints one price whatever the day, so
the weekend price is null on every row.

## Files

- `types.ts`: the shapes, the park prefixes (CF, RC) and branch codes.
- `categories.ts`: the 27 operator-wide categories with their taxable area and prep station.
- `menu-lines.ts`: the two menus merged into one list, with each line's printed number per park.
- `price-list.ts`: shop items, specials, the free drinks card, and Chinese Tea (`CURRENT_POS_LINES`).
- `catalog.ts`: `buildParkCatalog(park)`, the pure step from printed lines to product rows.
- `index.ts`: `seedRealCatalog(db, { operatorId, branchId, park, retireDemo?, retireStockLinked?, includeFreeDrinks?, apply? })`.
- `../../../scripts/real-catalog.ts`: the command line.

`menu-lines.ts` and `price-list.ts` were generated once from the transcription
(`menus.json`, `price-list.json`, not committed). From now on they are edited by
hand. `test/real-catalog-data.test.ts` holds them to the printed line counts.

## How the data becomes rows

- **Codes**: the park prefix plus the printed number, dots made hyphens (the
  API's `CodeSchema` allows no dot). Central's "24. Margherita" is `CF-24`,
  Chalong's "23. Margherita" is `RC-23`, Central's "15.1 With chicken" is
  `CF-15-1`. Codes are unique per operator, so the prefix keeps the two menus apart.
  Shop items use their section and printed position (`CF-BALLOON-01`,
  `CF-MERCH-06`, `CF-WORKSHOP-04`). Specials are `CF-SPECIAL-01` (latte) and
  `CF-SPECIAL-02` (wings). Chinese Tea has no printed number: `CF-CHINESE-TEA`,
  `RC-CHINESE-TEA`. Free drinks would be `CF-FREE-58-1` etc. (the card's numbers).
- **One product per printed line**, at that park's branch only. A section price
  applies to each of its lines. The shop items and the specials are loaded at each
  park the loader runs for, because the price list and the cards name no park.
- **Wine**: `ProductVariant` has no price, so each wine is two products,
  `-GLASS` and `-BOTTLE`. The red is printed as bottle only (`CF-70-BOTTLE`).
- **Slash lists** become a required single-choice inline group, every option +0.
  The group names are not printed: "Protein" for /Vegetarian, chicken, or shrimp/,
  and the placeholder "Choice" for the others.
- **"Add on fried egg / egg your way"** becomes an optional single group "Add on"
  with one +50 option.
- **Diet icons**: there is no field for them, so they go at the end of the
  description in brackets: `[vegetarian, dairy-free]`.
- **Sub-line names**: 15.1 and 15.2 read on their own at the till as
  "Caesar salad — With chicken" and "Caesar salad — With shrimp".
- **Categories**: one top-level tab per printed section. Food goes to the kitchen
  under `fnb`, drinks to the bar under `fnb`, wine and beer to the bar under `bar`,
  and the shop to no station under `merch`. Specials are kitchen, and the latte
  carries a bar prep override. Sort orders start at 10, after the demo tabs.
- **Chinese Tea**: 140 THB at both parks (the owner's answer), with the current
  POS's required single choice "Tea Choice": Rose black, Osmanthus oolong,
  Jasmine grape green, Peach oolong, Lychee black, each +0. No source names its
  tab; it is placed under Tea pot, the printed menu's tea section, so the till
  shows it and its prep ticket prints at the bar with the other teas. The owner
  can move it to another tab (a placement, not a price).
- It is keyed on `code`. A second run with the same data changes nothing.
- An existing live row of ours has its name, description, price, category, kind,
  prep override and sort order brought back to the data, so a corrected price
  reaches the till. Inline groups and options are added or corrected by name.
- A group or option on one of our products that the data no longer names is
  archived when this loader wrote it, so renaming one in the data (a group
  "Choice" to "Meat", an option "chicken" to "Chicken") replaces it instead of
  leaving the old one live beside the new. The loader knows what it wrote from
  its own audit rows (`modifier_group.create` and `.update`, request id
  `seed:real-catalog`). A group or option it never wrote, one added in the
  Console, is left alone and listed as "left alone".
- `active` is written on insert only. A row of ours that someone archived stays
  archived and is reported.
- A code that is live on another branch is a conflict. Nothing is written for it
  and the command exits 1.
- `retireDemo` archives this branch's demo products (codes from `../menu.ts`).
  It never touches ticket packages, stock items, another branch, operator-wide
  rows, or `DEMO_CODES_KEPT`: `AO-SOCKS`, which the price list names as Socks and
  the till, sale, booking checkout and redemption look up by code, and
  `AO-GRIPSOCKS`, `AO-LOCKER`, `AO-CUP` and `AO-GLOW`, which booking checkout maps
  booking-site add-ons to. It warns about discounts that give away an archived
  product (the demo `ICECREAM` gives away `FB-ICECREAM`).
- It also keeps every demo product linked to stock (a live
  `stock_item.product_id`, or the product's own `stock_item_id`), reported as
  "stock-linked (n stock items)". With the demo stock seed that is `FB-SLUSHIE`,
  `FB-WATER` and the eight `MR-*` items, 14 stock items between them, `MR-SOCKS`
  among them with the shop's grip socks in S, M and L and the seed's one barcode.
  `retireStockLinked` (`--retire-stock-linked`) archives them too, when the owner
  opts in; their stock items stay as they are and the loader warns about them.
- Every write is in one transaction with an audit row (`menu_category.*`,
  `menu_item.*`, `modifier_group.*`, request id `seed:real-catalog`, no account).

## Run it locally

```sh
# DATABASE_URL = the local database (never a remote one from a laptop)
pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park central                 # dry run, prints the plan
pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park central --apply
pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park chalong --apply
pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park central --retire-demo   # dry run of the retirement
```

Flags: `--park central|chalong` (required), `--apply`, `--retire-demo`,
`--retire-stock-linked` (with `--retire-demo` only), and `--include-free-drinks`.
The command prints counts and codes only, in under 100 lines.

## Run it on staging

Staging's pre-deploy runs only `db:migrate` and `db:platform-sync`, which never
write the menu. The catalogue reaches staging only through a one-off job on the
api image, which has tsx and this source.

1. Commit and push, then deploy the api at that SHA:
   `node scripts/agent/render.mjs deploy oto-api-staging <sha>`, then
   `node scripts/agent/render.mjs deploys oto-api-staging` until it is live.
   The job runs on the service's current build.
2. Dry run first and read the "untouched" and "demo products left live" lines.
   Staging has had hand edits and imports, so the plan is the first look at its catalogue:
   `node scripts/agent/render.mjs job "pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park central"`
3. Apply: the same command with `--apply`, then the same two steps for `--park chalong`.
4. Retirement: dry run with `--retire-demo`. Apply it only if the archive list
   holds demo codes alone and the warnings are acceptable.

The command must contain no `$` and no newlines. The helper waits up to 5
minutes and shows at most 100 log lines. If pnpm misbehaves, use
`cd packages/db && node_modules/.bin/tsx scripts/real-catalog.ts --park central`.

## Deliberately not seeded

| What | Why |
|---|---|
| Selection of cakes (CF-57, RC-54) | The menus print no price, only "Available at the counter". |
| Free Drinks Menu (13 drinks per park) | The owner's answer is that the card "stays seeded hidden (active: false)". On today's till that is not hidden: the F&B grid does not read `active` (`apps/pos/src/api/menu.ts` `mapMenu`; the till's `MenuItem` has no such field), so the 13 drinks would show at 0 THB in a "Free Drinks Menu" tab, and the sale would then refuse them (`services/sale.ts` loads active products only). They are in the data, 0 THB and inactive, and are written only with `--include-free-drinks`, after the owner answers question 2 below. |
| Price list 01 Tickets, 02 Expat Entry, 03 Extras | Ticket packages, adult rules, drop-off and nanny pricing live in `ticket_package` and the supervision config, not in the catalogue. This loader never writes them. Socks (60) is the existing `AO-SOCKS` row (50 in the demo seed), and this loader does not change it. |
| Translations | No document prints one. |

## Questions for the owner

1. **Chinese Tea's tab.** Which tab does Chinese Tea go in (Tea pot is one
   candidate)? Until it has one, the till finds it only through search and its
   prep ticket prints at the kitchen.
2. **Free Drinks Menu, "seeded hidden".** On today's till an inactive menu item
   still shows on the F&B grid, at 0 THB, and the sale then refuses it. Should the
   till's F&B grid be changed to hide inactive items (then the card is seeded,
   inactive, at both parks), or should the card stay out until there is a rule for
   who may order from it?
3. Weekday or weekend price pairs, which park the price list and the specials
   apply to, the group names ("Protein" and the placeholder "Choice"), and who may
   order from the Free Drinks Menu.

Until they are answered, the data says only what the documents and the owner's
answers say.
