/**
 * The park's birthday catalogue as printed, with the fields migration 0041
 * added (SCRUM-803): the Central Floresta Birthday package (Birthday
 * Package_Floresta.pdf), the two After School packages (the owner's text of
 * 9 November 2026), the 19 lines of the Entertainment menu
 * (Entertainment menu_eng.pdf) and the three set menus, each item with the
 * till catalogue's code (Central's printed menu numbers, CF-24 for Margherita).
 *
 * IDEMPOTENT BY NAME, AND IT UPDATES IN PLACE. Staging already holds these
 * rows, entered on 9 November through the app's own routes before the fields
 * existed; this writes the printed data onto those same rows:
 *   - a set menu, an entertainment line or a package is found by its name in
 *     the park group, a package's line item by its label within the package;
 *     only the fields that differ are written, and a row that is missing is
 *     made;
 *   - the two Floresta templates of the first entry, "(weekday)" and
 *     "(weekend)", become ONE package: the weekday row is renamed and given
 *     both days' prices, the weekend row is archived the way the app archives
 *     a package (is_active false, as Event Settings' archive button does) and
 *     left otherwise as it was. The merged package's "Extra child" and
 *     "Additional adult" add-on lines are removed: their prices are now the
 *     package's own extra child and extra adult prices, by day;
 *   - an add-on line starts at quantity 0 (billable), so a party the package
 *     is applied to has bought none until staff set a quantity in the BEO;
 *   - the Floresta package's branch is the park group's one branch named
 *     "Central Floresta" or ending with it ("Oto Play Park, Central Floresta");
 *   - nothing else is deleted, and no other row is touched. A second run
 *     changes nothing.
 *
 * Money is satang, as the three template tables store it (16,900 THB is
 * 1690000). A dish the catalogue has no product for keeps no product code and
 * is listed at the end as a question; so is anything else the sources leave
 * open. Nothing is invented to fill a gap.
 *
 * Usage, as the app's own role on the database the app runs on (DATABASE_URL,
 * and DB_SCHEMA when it is not "otoapp"):
 *   node script/seed-birthday-packages.mjs --dry-run      prints the plan, writes nothing
 *   node script/seed-birthday-packages.mjs                writes it
 *   ... --tenant <uuid>   the park group, when the database holds several
 *
 * Every write is made in one transaction; a dry run makes the same writes and
 * rolls them back, so its plan is exactly what a run would do. Plain
 * JavaScript needing only pg, like script/migrate.mjs, so it runs in the
 * runtime image (oto-app-staging) as a one-off job.
 *
 * Exits 0 when done, 1 when it refused (the park group is not clear), 2 when
 * it could not start.
 */
import pg from "pg";

const SCHEMA = process.env.DB_SCHEMA || "otoapp";
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const tenantArg = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null;

function fail(message, code = 2) {
  console.error(`seed-birthday-packages: ${message}`);
  process.exit(code);
}
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set.");
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) fail(`DB_SCHEMA "${SCHEMA}" is not a schema name.`);
if (tenantArg !== null && !/^[0-9a-f-]{36}$/i.test(tenantArg)) fail("--tenant needs the park group's uuid.");
for (const arg of args) {
  if (!["--dry-run", "--tenant", tenantArg].includes(arg)) fail(`unknown argument ${arg}`);
}

// ─── The data, as printed ─────────────────────────────────────────────────────

const baht = (thb) => thb * 100;
const SLIPS_AT = "11:00:00";
const CENTRAL_FLORESTA = "Central Floresta";

const FLORESTA_SET_MENU_NAME = "Birthday set menu, Central Floresta";
const FLORESTA_SET_MENU =
  "Pizza (margherita, hawaiian or pepperoni), hot dish (chicken schnitzel or fish fingers), french fries, " +
  "waffles or pancakes, fried rice (veggie, chicken or shrimp), veggie sticks, fruit skewers, " +
  `pitchers of drinks (juice or mors). Set menu template: "${FLORESTA_SET_MENU_NAME}".`;

const included = (category, label, qty = 1, unitLabel = null, description = null) => ({
  category, label, description, qty_default: qty, qty_editable: false, unit_label: unitLabel,
  included: true, default_unit_price: 0, billable_by_default: false,
  fnb_credit: null, prints_voucher: false, price_is_from: false,
});
// An add-on is the customer's choice: applying the package copies it onto the
// party at quantity 0, billable, so nothing is charged until staff set how many
// were bought (the app's own seed, script/minimal/main.ts, starts its optional
// add-ons at 0 the same way). otoapp_v.event_packages lists an add-on only once
// it is billable with a quantity above 0.
const addon = (category, label, priceThb, unitLabel = null, description = null, extra = {}) => ({
  category, label, description, qty_default: 0, qty_editable: true, unit_label: unitLabel,
  included: false, default_unit_price: baht(priceThb), billable_by_default: true,
  fnb_credit: null, prints_voucher: false, price_is_from: false,
  ...extra,
});

const FLORESTA = {
  name: "Birthday package, Central Floresta",
  renamedFrom: "Birthday package, Central Floresta (weekday)",
  archives: "Birthday package, Central Floresta (weekend)",
  removesLines: ["Extra child", "Additional adult"],
  row: {
    description:
      "Central Floresta. Weekday 16,900 THB, weekend 20,900 THB, up to 10 children; " +
      "extra child 1,300 THB on weekdays, 1,500 THB on weekends (includes full package). " +
      "Additional adults beyond the 4 included: 350 THB on weekdays, 500 THB on weekends; " +
      "full amount used for food & drinks, guests may sit at any available table and order food individually. " +
      "Reserved table for adults (up to 10 adults) 5,000 THB; full amount used for food & drinks, " +
      "a prime table is reserved for the group in advance. " +
      "Photo zones & add-ons: Classic balloon decoration 4,000; PRO photo zone with decorations 8,900; " +
      "upgrade or customize the activity program from 1,000. " +
      "Want to add more fun? Choose from the entertainment menu.",
    base_price: baht(16900),
    pricing_mode: "fixed",
    tags: [CENTRAL_FLORESTA, "Up to 10 children", "4 adults included", "3 hours"],
    sort_order: 1,
    kids_included: 10,
    adults_included: 4,
    socks_included: -1,
    hours: 3,
    price_weekday: baht(16900),
    price_weekend: baht(20900),
    extra_child_weekday: baht(1300),
    extra_child_weekend: baht(1500),
    extra_adult_weekday: baht(350),
    extra_adult_weekend: baht(500),
    slips_time: SLIPS_AT,
  },
  setMenu: FLORESTA_SET_MENU_NAME,
  branch: CENTRAL_FLORESTA,
  lines: [
    included("setup", "Kids' table reserved for 3 hours"),
    included("food", "Special birthday set menu", 1, null, FLORESTA_SET_MENU),
    included("entertainment", "Interactive birthday animation program, 30 minutes", 1, null,
      'Entertainment template: "Birthday entertainment program" (included in the package).'),
    included("cake", "Ice-cream cake with candles and birthday song"),
    included("play", "Entry for 4 accompanying adults", 4, "adults"),
    included("other", "Socks for all children", 10, "pairs", "Socks for all children (up to 10 children in the package)."),
    addon("setup", "Reserved table for adults, up to 10 adults", 5000, null,
      "Full amount used for food & drinks. A prime table is reserved for the parents in advance.",
      { fnb_credit: baht(5000), prints_voucher: true }),
    addon("setup", "Classic balloon decoration", 4000),
    addon("setup", "PRO photo zone with decorations", 8900),
    addon("entertainment", "Upgrade or customize your activity program", 1000, null,
      "From 1,000 THB (custom amount). Choose from the entertainment menu.", { price_is_from: true }),
    addon("entertainment", "Bracelet Making", 100, "child", "100 THB per child."),
  ],
};

const afterSchool = (kids) => {
  const price = kids === 10 ? 10900 : 18900;
  return {
    name: `After School Birthday Package, Central (${kids} kids)`,
    row: {
      description:
        `Central. ${price.toLocaleString("en")} THB for ${kids} kids: table reservation, entrance for ${kids} children and ${kids} adults, ` +
        "Birthday Food Set for Kids, Ice Cream Cake, unlimited complimentary drinking water. " +
        "Fish & Chips can be replaced with 2 portions of Chicken Schnitzel. " +
        "Private Zone not included: if available on the day it may be used; guaranteed for an additional 3,000 THB, " +
        "the full amount goes towards food and beverages. " +
        `${kids} parents can enter and stay; they buy food and drinks separately. ` +
        "Socks not included: non-slip socks are required for children; socks are sold at 60 THB a pair. " +
        "Extra fun from the Entertainment Menu; free face painting for all park guests every day; Bracelet Making 100 THB per child.",
      base_price: baht(price),
      pricing_mode: "fixed",
      tags: ["Central", "After school", `${kids} kids`, `${kids} adults included`],
      sort_order: kids === 10 ? 3 : 4,
      kids_included: kids,
      adults_included: kids,
      // Socks are not included; the owner's text prints no hours.
      socks_included: null,
      hours: null,
      price_weekday: null,
      price_weekend: null,
      extra_child_weekday: null,
      extra_child_weekend: null,
      extra_adult_weekday: null,
      extra_adult_weekend: null,
      slips_time: SLIPS_AT,
    },
    setMenu: `After School food set (${kids} kids)`,
    // "Central" is printed; which park that is is a question, so no branch is set.
    branch: null,
    lines: [
      included("setup", "Table reservation"),
      included("play", `Entrance for ${kids} children`, kids, "children"),
      included("play", `Entrance for ${kids} adults`, kids, "adults"),
      included("food", "Birthday Food Set for Kids", 1, null,
        `${kids === 10
          ? "French Fries x3, Margherita Pizza x3, Vegetable Sticks x2, Belgian Waffles x2, Chicken Schnitzel x1, Fish & Chips x1, Fruit Skewers x2. Fish & Chips can be replaced with 2 portions of Chicken Schnitzel."
          : "French Fries x5, Margherita Pizza x3, Hawaiian Pizza x1, Pepperoni Pizza x1, Vegetable Sticks x3, Belgian Waffles x4, Chicken Schnitzel x2, Fish & Chips x1, Fruit Skewers x3, Fried Rice x2."
        } Set menu template: "After School food set (${kids} kids)".`),
      included("cake", "Ice Cream Cake"),
      included("other", "Unlimited complimentary drinking water"),
      // The plan (section 4, approved in 6.1): a table reservation or private
      // zone grants its F&B credit and prints the credit voucher.
      addon("setup", "Private Zone (guaranteed)", 3000, null,
        "Not included: if available on the day it may be used. Guaranteed for an additional 3,000 THB; the full amount goes towards food and beverages.",
        { fnb_credit: baht(3000), prints_voucher: true }),
      addon("other", "Socks (per pair)", 60, "pair", "Socks not included; non-slip socks are required for children."),
      addon("entertainment", "Bracelet Making", 100, "child", "100 THB per child."),
    ],
    removesLines: [],
  };
};

const PACKAGES = [FLORESTA, afterSchool(10), afterSchool(20)];

/** One Entertainment menu line: category, name, THB, minutes, age, max kids, extra child THB, unit, "from", the menu's blurb. */
const ent = (category, name, priceThb, minutes, ageRange, maxKids, extraChildThb, unit, priceIsFrom, blurb, isIncluded = false) => ({
  name,
  row: {
    category, description: blurb, duration_minutes: minutes, default_price: baht(priceThb),
    included: isIncluded, billable_by_default: !isIncluded,
    age_range: ageRange, max_kids: maxKids, extra_child_price: extraChildThb === null ? null : baht(extraChildThb),
    unit, price_is_from: priceIsFrom,
  },
});

const ENTERTAINMENT = [
  // Games ("Including into the package", 3000 / 30 min)
  ent("Games", "Birthday entertainment program", 3000, 30, null, null, null, "session", false,
    "Games with bright props, fun contests, team activities and dancing, each child receives a balloon as a gift! Choose your favorite character!", true),
  ent("Games", "Zombie game", 4000, 30, "6+", 10, 400, "session", false,
    "Immersive game, where kids become real detectives and need to save the world by finding the antidote that is guarded by a zombie."),
  ent("Games", "Squid games", 4000, 30, "6+", 10, 400, "session", false,
    "The hottest, most thrilling celebration of the year! Play iconic games like Red Light, Green Light and Dalgona Challenge, wear player uniforms, win prizes, and enjoy a themed photo shoot. Fun, safe, and unforgettable!"),
  ent("Games", "Jurassic park", 4000, 30, "4+", 10, 400, "session", false,
    "An emergency landing leaves the young explorers stranded on an uninhabited island. While looking for water and shelter they discover that dinosaurs also live there and some even try to prevent kids from finding what they're looking for."),
  // Shows
  ent("Shows", "Tesla show", 8000, 40, "4+", 20, null, "session", false,
    "The Power of Lightning! An electrifying science show where kids discover the secrets of electricity, see dancing lightning, catch real sparks, and control Tesla coils with sound! Fun, magic, and science, all in one lightning adventure!"),
  ent("Shows", "Bubble show", 5500, 30, "1+", 20, null, "session", false,
    "A Magical Journey into the World of Bubbles! Dive into a sparkling world where air, water, and light come alive! The Fire Bubble, a dazzling mix of flame and magic; the Human Bubble, step inside a giant bubble; bubbles of all sizes filling the space with wonder! Perfect for birthdays and family celebrations, where science meets art and pure magic!"),
  ent("Shows", "Crio show", 6500, 30, "4+", 10, 650, "session", false,
    'Magic and ice! The coolest science show ever! Experience real experiments with liquid nitrogen, giant snow explosions, fog vortexes, and "space" ice cream made before your eyes! Safe, fun, and unforgettable!'),
  ent("Shows", "Minecraft: Creeper hunt", 5000, 30, "5-13", 20, null, "session", false,
    "Join an epic Minecraft adventure! Explore mazes, gather resources, craft TNT, and defeat the sneaky Creeper to unlock the treasure chest! Quest & Animation."),
  // Workshops (no duration printed)
  ent("Workshops", "Slime Master Class", 4000, null, "4+", 10, 400, "session", false,
    "Kids get to experiment with colour mixes, glitter, textures, and play with them in the end."),
  ent("Workshops", "Cooking Class (pizza/cookies)", 7000, null, "5+", 10, 700, "session", false,
    "Become a little chef, under professional supervision. Later, enjoy what you made with your friends."),
  ent("Workshops", "Ocean in a glass", 4000, null, "5+", 10, 400, "session", false,
    "Gel candles with colored sand. A relaxing and creative experience."),
  ent("Workshops", "ECO bracelet-making", 600, null, "5+", 10, null, "piece", false,
    "Feel the energy of natural materials! Wood, metal, ceramics, and stone: connect with nature and create your own unique bracelet that carries your personal energy."),
  ent("Workshops", "Cookie decorating", 5000, null, "5+", 10, 500, "session", false,
    "Feel like a real chef and decorate your own cookie with delicious icing. We will show you how to do it and guide through the process."),
  ent("Workshops", "Mini aquarium / Jurassic", 4000, null, "5+", 10, 400, "session", false,
    "Arrange the figures and sand in a glass and fill with special gel to preserve the beautiful landscape that you create."),
  ent("Workshops", "Make & Take Workshop", 100, null, null, null, null, "piece", true,
    "Create your own handmade souvenir and take home a special memory from the party. Ask our team about today's Make & Take options."),
  // Other (no age printed)
  ent("Other", "Face painting", 2000, 60, null, null, null, "hour", false,
    "Choose your favourite character to draw by our staff or use the dedicated palette to paint on your friends."),
  ent("Other", "Glitter tattoo", 1000, null, null, 10, 100, "session", false,
    "Tattoo made out of glitter. Choose designs, colours and placement!"),
  ent("Other", "Pinata", 2000, null, null, null, null, "session", true,
    "The best activity for kids of any age! Pinata is full of candies and fun."),
  ent("Other", "Neon party", 5500, 30, null, null, null, "session", false,
    "Our new program has it all: electrifying dances, neon body art, and even mountains of glowing neon paper! Come and experience it!"),
].map((e, i) => ({ ...e, row: { ...e.row, sort_order: i + 1 } }));

// Set-menu items keep the ids the first entry gave them, so a run never churns
// a parent's saved choices. A code is the till's (Central's printed number);
// a dish the printed menu does not carry has none.
const always = (id, label, extra = {}) => ({ id, type: "always_included", label, ...extra });
const choice = (id, label, options, extra = {}) => ({ id, type: "choice_group", label, options, allowMultiple: false, ...extra });
const FISH_OR_SCHNITZEL = "Can be replaced with 2 portions of Chicken Schnitzel";

const SET_MENUS = [
  {
    name: FLORESTA_SET_MENU_NAME,
    // The Floresta package prints the dishes but no portions.
    items: [
      choice("item_cf_bday_pizza", "Pizza", ["Margherita", "Hawaiian", "Pepperoni"],
        { optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27", Pepperoni: "CF-31" } }),
      choice("item_cf_bday_hot_dish", "Hot dish", ["Chicken schnitzel", "Fish fingers"],
        { optionProductCodes: { "Chicken schnitzel": "CF-37" } }),
      always("item_cf_bday_fries", "French fries", { productCode: "CF-11" }),
      choice("item_cf_bday_waffles_pancakes", "Waffles or pancakes", ["Waffles", "Pancakes"],
        { optionProductCodes: { Waffles: "CF-4", Pancakes: "CF-5" } }),
      // One till product, "Fried rice", whose own Protein choice is the option.
      choice("item_cf_bday_fried_rice", "Fried rice", ["Veggie", "Chicken", "Shrimp"], { productCode: "CF-43" }),
      always("item_cf_bday_veggie_sticks", "Veggie sticks", { productCode: "CF-53" }),
      always("item_cf_bday_fruit_skewers", "Fruit skewers"),
      choice("item_cf_bday_drinks", "Drinks pitcher", ["Juice", "Mors"]),
    ],
  },
  {
    name: "After School food set (10 kids)",
    items: [
      always("item_as10_fries", "French Fries", { productCode: "CF-11", qty: 3 }),
      always("item_as10_margherita", "Margherita Pizza", { productCode: "CF-24", qty: 3 }),
      always("item_as10_veg_sticks", "Vegetable Sticks", { productCode: "CF-53", qty: 2 }),
      always("item_as10_waffles", "Belgian Waffles", { qty: 2 }),
      always("item_as10_schnitzel", "Chicken Schnitzel", { productCode: "CF-37", qty: 1 }),
      always("item_as10_fish_chips", "Fish & Chips", { productCode: "CF-36", qty: 1, note: FISH_OR_SCHNITZEL }),
      always("item_as10_fruit_skewers", "Fruit Skewers", { qty: 2 }),
    ],
  },
  {
    name: "After School food set (20 kids)",
    items: [
      always("item_as20_fries", "French Fries", { productCode: "CF-11", qty: 5 }),
      always("item_as20_margherita", "Margherita Pizza", { productCode: "CF-24", qty: 3 }),
      always("item_as20_hawaiian", "Hawaiian Pizza", { productCode: "CF-27", qty: 1 }),
      always("item_as20_pepperoni", "Pepperoni Pizza", { productCode: "CF-31", qty: 1 }),
      always("item_as20_veg_sticks", "Vegetable Sticks", { productCode: "CF-53", qty: 3 }),
      always("item_as20_waffles", "Belgian Waffles", { qty: 4 }),
      always("item_as20_schnitzel", "Chicken Schnitzel", { productCode: "CF-37", qty: 2 }),
      always("item_as20_fish_chips", "Fish & Chips", { productCode: "CF-36", qty: 1 }),
      always("item_as20_fruit_skewers", "Fruit Skewers", { qty: 3 }),
      always("item_as20_fried_rice", "Fried Rice", { productCode: "CF-43", qty: 2 }),
    ],
  },
];

const QUESTIONS = [
  'Floresta set menu: "Fish fingers" (hot dish), "Fruit skewers" and the drinks pitcher ("Juice" or "Mors") have no till product; which products are they?',
  'Floresta set menu: "Waffles or pancakes" is coded CF-4 Waffles and CF-5 Pancakes (breakfast, 255 THB); the kids\' menu also has CF-49 Waffle and CF-50 Pancake (180 THB). Which is the party\'s?',
  'Floresta set menu: the package prints no portions for any dish; how many of each for 10 children?',
  'After School food sets: "Belgian Waffles" and "Fruit Skewers" are not on the printed menu; which products are they?',
  'After School 20 kids: the owner\'s text gives "Fish & Chips can be replaced with 2 portions of Chicken Schnitzel" under 10 kids only; does it hold for 20 kids?',
  'After School packages: "Central" is printed; are they sold at Central Floresta only (the package\'s branch is left unset), and for how many hours?',
  "Floresta's additional adult (350 / 500) is printed as \"full amount used for food & drinks\": is that a credit the till should grant like the reserved table's?",
  "Entertainment menu: \"For groups larger than 10, an additional fee applies per extra child\" (Other page) names no amount; what is the extra-child price of Face painting, Pinata and Neon party (none is set)?",
];

// ─── Writing it ───────────────────────────────────────────────────────────────

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: "oto-app-seed-birthday-packages" });
const q = async (text, params = []) => (await client.query(text, params)).rows;
const plan = [];
const counts = { created: 0, updated: 0, renamed: 0, archived: 0, removed: 0, unchanged: 0 };
const say = (kind, what, detail = "") => {
  counts[kind] += 1;
  plan.push(`${kind.padEnd(9)} ${what}${detail ? `: ${detail}` : ""}`);
};

/** Key order and undefined do not make two values differ. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
const JSON_COLUMNS = new Set(["tags", "items"]);
const param = (column, value) => (JSON_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value);

async function insert(table, row) {
  const columns = Object.keys(row);
  const values = columns.map((c) => param(c, row[c]));
  const [made] = await q(
    `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    values,
  );
  return made;
}

/** Write the fields of `want` that differ from `have`; answers the names written. */
async function update(table, have, want, { touch = true } = {}) {
  const changed = Object.keys(want).filter((c) => !same(have[c], want[c]));
  if (changed.length === 0) return [];
  const sets = changed.map((c, i) => `${c} = $${i + 2}`);
  if (touch) sets.push("updated_at = now() at time zone 'UTC'");
  await q(`update ${table} set ${sets.join(", ")} where id = $1`, [have.id, ...changed.map((c) => param(c, want[c]))]);
  return changed;
}

async function resolveTenant() {
  if (tenantArg) {
    const found = await q("select id from tenants where id = $1", [tenantArg]);
    if (found.length === 0) fail(`no park group ${tenantArg} on this database.`, 1);
    return tenantArg;
  }
  const names = [FLORESTA.name, FLORESTA.renamedFrom, ...PACKAGES.slice(1).map((p) => p.name)];
  const holding = await q("select distinct tenant_id from birthday_package_templates where name = any($1)", [names]);
  if (holding.length === 1) return holding[0].tenant_id;
  if (holding.length > 1) fail(`the packages are in ${holding.length} park groups; name one with --tenant.`, 1);
  const all = await q("select id from tenants");
  if (all.length === 1) return all[0].id;
  fail(`this database has ${all.length} park groups and none holds these packages yet; name one with --tenant.`, 1);
}

async function findByName(table, tenant, name) {
  const rows = await q(`select * from ${table} where tenant_id = $1 and name = $2 order by created_at, id`, [tenant, name]);
  if (rows.length > 1) plan.push(`note      ${rows.length} rows in ${table} are named "${name}"; the oldest (${rows[0].id}) is used`);
  return rows[0] ?? null;
}

async function seedSetMenus(tenant) {
  const ids = {};
  for (const menu of SET_MENUS) {
    const have = await findByName("beo_set_menu_templates", tenant, menu.name);
    if (!have) {
      const made = await insert("beo_set_menu_templates", { tenant_id: tenant, name: menu.name, items: menu.items });
      ids[menu.name] = made.id;
      say("created", `set menu "${menu.name}"`, `${menu.items.length} items`);
      continue;
    }
    ids[menu.name] = have.id;
    const changed = await update("beo_set_menu_templates", have, { items: menu.items });
    if (changed.length) say("updated", `set menu "${menu.name}"`, "items (labels, product codes, portions, notes)");
    else say("unchanged", `set menu "${menu.name}"`);
    if (!have.is_active) plan.push(`note      set menu "${menu.name}" is archived; left archived`);
  }
  return ids;
}

async function seedEntertainment(tenant) {
  for (const line of ENTERTAINMENT) {
    const have = await findByName("entertainment_package_templates", tenant, line.name);
    if (!have) {
      await insert("entertainment_package_templates", { tenant_id: tenant, name: line.name, ...line.row });
      say("created", `entertainment "${line.name}"`);
      continue;
    }
    const changed = await update("entertainment_package_templates", have, line.row);
    if (changed.length) say("updated", `entertainment "${line.name}"`, changed.join(", "));
    else say("unchanged", `entertainment "${line.name}"`);
    if (!have.is_active) plan.push(`note      entertainment "${line.name}" is archived; left archived`);
  }
}

/**
 * The park the package is sold at: the one branch of the park group whose
 * name, trimmed, is the printed park or ends with it as its last words
 * (staging names it "Oto Play Park, Central Floresta ", with the trailing
 * space), ignoring case. None or several: the package's branch is left as it
 * is, and the plan says so.
 */
async function findBranch(tenant, name) {
  if (!name) return null;
  const rows = await q(
    `select id, name from branches
      where tenant_id = $1
        and (lower(btrim(name)) = lower($2) or right(lower(btrim(name)), char_length($2) + 1) = ' ' || lower($2))
      order by created_at, id`,
    [tenant, name],
  );
  if (rows.length === 1) {
    plan.push(`branch    "${rows[0].name}" (${rows[0].id}) is the "${name}" park`);
    return rows[0].id;
  }
  const found = rows.length === 0 ? "no branch" : `${rows.length} branches (${rows.map((r) => `"${r.name}"`).join(", ")})`;
  plan.push(`note      ${found} named "${name}" in this park group; the package's branch is left as it is`);
  return undefined;
}

async function seedPackages(tenant, setMenuIds) {
  for (const pkg of PACKAGES) {
    let have = await findByName("birthday_package_templates", tenant, pkg.name);
    const want = { ...pkg.row, set_menu_template_id: setMenuIds[pkg.setMenu] ?? null };
    const branchId = await findBranch(tenant, pkg.branch);
    if (branchId !== undefined) want.branch_id = branchId;

    if (!have && pkg.renamedFrom) {
      const former = await findByName("birthday_package_templates", tenant, pkg.renamedFrom);
      if (former) {
        await q("update birthday_package_templates set name = $2, updated_at = now() at time zone 'UTC' where id = $1", [former.id, pkg.name]);
        say("renamed", `package "${pkg.renamedFrom}"`, `now "${pkg.name}" (${former.id})`);
        have = { ...former, name: pkg.name };
      }
    }
    if (!have) {
      have = await insert("birthday_package_templates", { tenant_id: tenant, name: pkg.name, ...want });
      say("created", `package "${pkg.name}"`);
    } else {
      const changed = await update("birthday_package_templates", have, want);
      if (changed.length) say("updated", `package "${pkg.name}"`, changed.join(", "));
      else say("unchanged", `package "${pkg.name}"`);
      if (!have.is_active) plan.push(`note      package "${pkg.name}" is archived; left archived`);
    }

    if (pkg.archives) {
      const other = await findByName("birthday_package_templates", tenant, pkg.archives);
      if (other && other.is_active) {
        await q("update birthday_package_templates set is_active = false, updated_at = now() at time zone 'UTC' where id = $1", [other.id]);
        say("archived", `package "${pkg.archives}"`, `merged into "${pkg.name}" (${other.id})`);
      } else if (other) {
        say("unchanged", `package "${pkg.archives}"`, "archived");
      }
    }

    const lines = await q(
      "select * from package_line_item_templates where package_template_id = $1 order by sort_order, created_at, id",
      [have.id],
    );
    for (const [i, line] of pkg.lines.entries()) {
      const row = { ...line, sort_order: i };
      const found = lines.find((l) => l.label === line.label);
      if (!found) {
        await insert("package_line_item_templates", { package_template_id: have.id, ...row });
        say("created", `line "${pkg.name}" / "${line.label}"`);
        continue;
      }
      const changed = await update("package_line_item_templates", found, row, { touch: false });
      if (changed.length) say("updated", `line "${pkg.name}" / "${line.label}"`, changed.join(", "));
      else say("unchanged", `line "${pkg.name}" / "${line.label}"`);
    }
    for (const label of pkg.removesLines) {
      for (const gone of lines.filter((l) => l.label === label)) {
        await q("delete from package_line_item_templates where id = $1", [gone.id]);
        say("removed", `line "${pkg.name}" / "${label}"`, "now the package's own extra prices by day");
      }
    }
    const unknown = lines.filter((l) => !pkg.lines.some((x) => x.label === l.label) && !pkg.removesLines.includes(l.label));
    for (const l of unknown) plan.push(`note      line "${pkg.name}" / "${l.label}" is not in the printed package; left as it is`);
  }
}

await client.connect();
let exitCode = 0;
try {
  await client.query(`set search_path to ${SCHEMA}`);
  const present = await q("select to_regclass('birthday_package_templates') is not null as t, exists (select 1 from information_schema.columns where table_schema = $1 and table_name = 'birthday_package_templates' and column_name = 'kids_included') as c", [SCHEMA]);
  if (!present[0].t) fail(`schema "${SCHEMA}" has no birthday_package_templates; is the OTO App migrated here?`);
  if (!present[0].c) fail("birthday_package_templates has no kids_included: apply migration 0041 (npm run db:migrate) first.");

  await client.query("begin");
  const tenant = await resolveTenant();
  plan.push(`park group ${tenant}${DRY_RUN ? " (dry run: every write below is rolled back)" : ""}`);
  const setMenuIds = await seedSetMenus(tenant);
  await seedEntertainment(tenant);
  await seedPackages(tenant, setMenuIds);
  await client.query(DRY_RUN ? "rollback" : "commit");

  for (const line of plan) console.log(line);
  console.log("questions for the owner (nothing was invented for these):");
  for (const question of QUESTIONS) console.log(`  - ${question}`);
  console.log(`seed-birthday-packages: ${JSON.stringify({ dryRun: DRY_RUN, tenant, ...counts })}`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  console.error(`seed-birthday-packages: failed, nothing written: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 2;
} finally {
  await client.end();
}
process.exit(exitCode);
