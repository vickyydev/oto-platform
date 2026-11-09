# SCRUM-792 on staging: the park's real menus in the till catalogue

Taken on 9 November 2026 between 13:14 and 13:20 Bangkok time, after the seed
had already been applied. Everything here is a read. No till, sale, product,
setting or message was created or changed. The only writes were the admin's
own sign-in and sign-out, and `receipt.json` lists every non-read request the
browser made.

## What the till's catalogue holds (API readback)

The till reads its menu from `GET /branches/{branch}/menu`. That same read was
made for both parks, signed in as the platform admin.

| | Central Floresta | Robinson Chalong |
|---|---|---|
| Real tabs present (of 27) | 27 | 27 |
| Real items from the menus and price list | 152 (124 menu, 28 shop) | 149 (121 menu, 28 shop) |
| Booking add-ons kept (AO-SOCKS, AO-GRIPSOCKS, AO-LOCKER, AO-CUP, AO-GLOW) | 5 | none |
| Other live items with no code | 5 | 1 |
| Live items in total | 162 | 150 |
| Chinese Tea | 140, under Tea pot, with the "Tea Choice" of five teas | 140, under Tea pot, the same choice |
| Free Drinks Menu tab | there, empty | there, empty |

Items per tab, Central / Chalong: Breakfast 9/8, Sides 18/18, Sharing 4/4,
Soup 1/1, Salads 6/6, Pasta 4/4, Pizza 9/9, Mains 8/7, Asian Food 7/7,
Kids 8/7, Desserts 1/1, Coffee 7/7, Iced Coffee 6/6, Chocolate 2/2, Soda 2/2,
Smoothies 3/3, Juice 2/2, Tea pot 6/6, Soft drinks 7/7, Kids juice 4/4,
Wine 7/7, Beer 1/1, Specials 2/2, Free Drinks Menu 0/0, Balloons 5/5,
Merchandise 19/19, Workshop 4/4.

All 28 demo menu and shop items (Margherita Pizza, Mojito, Chicken Nuggets,
Chang Beer and the rest) are archived at Central. Chalong never had them.

## Where it differs from what was expected

1. **Central has five more live items that are not on any menu.** None of them
   has a code, so the demo clean-up, which works by code, left them in place:
   - Ice Cream Cone, 60, in the old "F&B" tab
   - Bracelet Workshop, 150, an add-on also sold on the booking site
   - Mystery box, 0, shop
   - Native payment free item 0d008153, 0, shop
   - ZZ TEST Stock 496 Mug, 10, shop
2. **Chalong has one more live item: ZZ TEST Spend Cup 1007**, 40, in the old
   "Snacks" tab.
3. **The 12 old demo tabs are still there**, because tabs are shared by every
   park: F&B, Food, Mains, Light Bites, Drinks, Coffee, Bar, Snacks, Apparel,
   Accessories, Toys, Ticket add-ons. The Console therefore lists 39 categories,
   and "Coffee" and "Mains" each appear twice. Almost all are empty. The ones
   that are not empty hold the items in points 1 and 2 and the kept add-ons.
4. **Menu names carry no printed number.** Central's line 24 is the item
   "Margherita" with the code CF-24 (Chalong: RC-23). The Console list shows
   names and prices, not codes.
5. **The Categories page shows 0 items for Balloons, Merchandise and
   Workshop.** That page counts menu items only. The 28 shop items are on the
   Merch page (`s792-st-04b`).

## The pictures (Console, headless Chromium, 1440 x 900)

| File | What it shows |
|---|---|
| `s792-st-01a-categories-top.png` | Categories, Central Floresta: the top of the list, where the old demo tabs come first |
| `s792-st-01b-categories-real-tabs.png` | Categories: the real tabs from Breakfast down |
| `s792-st-01c-categories-real-tabs-end.png` | Categories: the end of the list, with Specials, Free Drinks Menu, Balloons, Merchandise and Workshop |
| `s792-st-01d-categories-full.png` | Categories: the whole page, all 39 |
| `s792-st-02a-menu-central-top.png` | Menu, Park chip set to Central Floresta, "125 items" |
| `s792-st-02d-menu-central-full.png` | Menu, Central Floresta: the whole page, every tab with prices |
| `s792-st-02b-menu-central-pizza.png` | Menu, Central: the Pizza tab, Margherita 400 down to Veggie delight 390 |
| `s792-st-02c-menu-central-pizza-section.png` | The Pizza tab on its own |
| `s792-st-03a-menu-central-tea-pot.png` | Menu, Central: the Tea pot tab, five teas at 115 and Chinese Tea at 140 with its choice group |
| `s792-st-03b-menu-central-tea-pot-section.png` | The Tea pot tab on its own |
| `s792-st-03c-menu-central-specials.png` | Menu, Central: Specials, Sea Salt & Maple Latte 170 and OTO Buffalo Wings 240 |
| `s792-st-04a-merch-central-top.png` | Merch, Central: the top of the shop list, "31 items" |
| `s792-st-04b-merch-central-full.png` | Merch, Central: the whole page with balloons, the 19 merchandise items and the 4 workshop items |
| `s792-st-05a-menu-chalong-top.png` | Menu, Park chip set to Robinson Chalong, "122 items" (Breakfast 8 here, 9 at Central) |
| `s792-st-05d-menu-chalong-full.png` | Menu, Robinson Chalong: the whole page |
| `s792-st-05b-menu-chalong-pizza.png` | Menu, Chalong: the Pizza tab. The items and prices are the same as Central's. |
| `s792-st-05c-menu-chalong-tea-pot.png` | Menu, Chalong: Tea pot, with Chinese Tea at 140 |

In the full-page pictures the account panel in the sidebar is covered by a
pink box, so that no account detail shows. In the tab pictures the Park chip is
scrolled out of view. `receipt.json` records which park the chip was set to at
every capture.

## The till itself

This was not captured on purpose. The till opens no selling screen, F&B
included, until a station is taken, and taking one is a write. The till was
therefore not opened.

## Files

- `receipt.json`: timestamps, the full readback per park (every tab, kind
  counts, the samples, Chinese Tea's choice group, the state of each demo code),
  every picture with its time and park, every non-read request the browser
  made, and the comparison against what was expected.

## After the pictures (13:30 to 13:50 Bangkok, same day)

Done through the Console's own routes, on the owner's word, after these
pictures were taken: the six uncoded sample rows the code-based retirement
could not reach were withdrawn (Ice Cream Cone, Bracelet Workshop, Mystery
box, Native payment free item, ZZ TEST Stock 496 Mug at Central; ZZ TEST
Spend Cup 1007 at Chalong); seven empty sample tabs were withdrawn (F&B,
Mains, Bar, Snacks, Apparel, Accessories, Toys), four stay because archived
sample items still sit in them (Coffee, Light Bites, and their parents Food
and Drinks); Regular Socks (AO-SOCKS) went from 50 to 60 at Central as the
price list prints; the same row cannot be created at Chalong because item
codes are unique across the operator. The Free Drinks Menu was then switched
on at both parks (13 items at 0 THB, active) by the seed job with
`--include-free-drinks`. Read back afterwards: Central 170 live items on 32
tabs, Chalong 162; Chinese Tea 140 at both.
