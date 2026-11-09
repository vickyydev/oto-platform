# SCRUM-803 staging proof: birthday package data in the OTO App

Checked on 9 November 2026 against the OTO App on staging (https://oto-app-staging.onrender.com), running main `39c45636d`.
I signed in as the staging administrator through the launcher. The administrator's name is masked in every picture,
and a check before each picture confirmed that no name could still be read. The full readings are in `receipt.json`.

## What was checked

| # | Picture | What it shows | Result |
|---|---|---|---|
| 1 | `803-st-01-packages-list.png` | Event Settings > Packages | Pass. Three live packages are listed: the Floresta package, After School (10 kids) and After School (20 kids). The archived weekend Floresta package is greyed out and marked "Inactive". |
| 2 | `803-st-02-floresta-package-edit.png`, `803-st-02b-floresta-package-edit-full.png` | The Floresta package opened for editing (not saved) | Pass. The new fields are filled in: Kids Included 10, Adults Included 4, Socks "All children", Hours 3, Weekday 16,900 and Weekend 20,900, Extra Child 1,300 / 1,500, Extra Adult 350 / 500, Set Menu "Birthday set menu, Central Floresta", Kitchen Slips At 11:00, Branch "Oto Play Park, Central Floresta". 02b is the whole page, with the 6 included items and 5 add-ons. |
| 3 | `803-st-03-entertainment-list.png`, `803-st-03b-entertainment-zombie-game.png` | Event Settings > Entertainment | Pass. All 19 templates are listed. The "Zombie game" row reads THB 4000.00, 30 min, Games, Age 6+, Up to 10 kids, Extra child THB 400.00. |
| 4 | `803-st-04-set-menu-floresta.png`, `803-st-04b-set-menu-floresta-edit-dialog.png` | Event Settings > Set Menus, "Birthday set menu, Central Floresta" opened, then its edit dialog (closed without saving) | Pass. There are 8 items: 5 choice groups and 3 always-included items. The codes are Margherita CF-24, Hawaiian CF-27, Pepperoni CF-31, Chicken schnitzel CF-37, French fries CF-11, Waffles CF-4, Pancakes CF-5, Fried rice CF-43 and Veggie sticks CF-53. Fish fingers, Fruit skewers and the drinks pitcher have no code. |
| 5 | `803-st-05-beo-package-module-applied.png` | A throwaway event, "ZZ TEST 803 package snapshot" | Pass. It was a birthday at Central Floresta on 17 Nov 2026, with 8 children and 4 adults. I applied the Floresta package in its BEO's Birthday Package module. The module shows the package's limits and prices, and the slips at 11:00. |

## Read back through the API (no screen)

- **`GET /api/beo/birthday-packages`** answered 200 with 4 templates, 3 of them active.
  - **Floresta** (`391b269d…`) has:
    - 10 kids and 4 adults included, socks -1 (all children), 3 hours
    - weekday 1,690,000 and weekend 2,090,000 satang
    - extra child 130,000 / 150,000 and extra adult 35,000 / 50,000
    - set menu `0b1db99d…` ("Birthday set menu, Central Floresta"), slips 11:00:00, branch Central Floresta (`6427e84d…`)
    - 11 line items
  - **After School (10 kids)** has 10 kids and 10 adults, and **(20 kids)** has 20 and 20. Each has its own set menu and 9 line items.
  - **The weekend package** is inactive.
- **`GET /api/beo/entertainment-templates`** answered 200 with 19 templates, all active. 13 have an age range, 14 have a maximum number of kids and 10 have an extra-child price.
- **`GET /api/beo/set-menu-templates`** answered 200 with 9 templates. Three of them carry codes:
  - "Birthday set menu, Central Floresta" has 8 items in 5 choice groups. 6 of the items carry codes: 3 have their own code, and 3 choice groups have codes on their options.
  - "After School food set (10 kids)" has 7 items, 5 of them coded.
  - "After School food set (20 kids)" has 10 items, 8 of them coded.
- **The ZZ TEST event's snapshot** (`GET /api/beo/events/<id>/package-snapshot`) answered 200. It holds every value from the Floresta template, and 11 items: 6 included and 5 add-ons.
  - The kitchen plan was switched on with the Floresta set menu.
  - Then I deleted the event (`DELETE /api/admin/events/<id>` answered 204). Reading it again answered 404, the snapshot also answered 404, and no event named "ZZ TEST 803" is left at Central Floresta.

## Worth a look (not failures of this check)

- **The package total reads 0.** The Floresta package's 6 included items are priced at THB 0.00 each. Because of that:
  - the package editor says "THB 16900.00 unallocated" (picture 02b)
  - the BEO module shows "Package Total: ฿0.00" after the package is applied (picture 05)
  The package price appears only in the facts line and in the package chooser.
- **The After School packages have only some of the new fields.** They carry the kids and adults included, but no socks, hours, day prices, extras or branch.
- **The number boxes in the pictures show "16900,00".** The pictures were taken in a headless browser, which used a comma as the decimal sign. The values in the form are 16900.00.
- **The branch name has a trailing space.** On staging the Central Floresta branch is named "Oto Play Park, Central Floresta ".

## What was not changed

- Nothing was saved in the package editor or the set menu dialog.
- No real event, party, member or staff record was touched.
- The only record I wrote was the ZZ TEST event, and it has been deleted.
- Each sign-in ended with a sign-out.
