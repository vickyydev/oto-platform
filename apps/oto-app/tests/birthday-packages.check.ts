// seed: its own — two ZZ TEST park groups, made here. Not a Playwright file
// (the suite collects *.spec.ts and *.test.ts; this is neither): it boots the
// app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-803 — the birthday packages as the park prints them, over HTTP against
// the routes as registered:
//
//   1. the fields the printed packages need (migration 0041) round-trip through
//      the settings routes: a package's kids, adults and socks included, hours,
//      weekday and weekend prices, extra child and extra adult prices, set menu,
//      slip time and branch; a line item's F&B credit, voucher and "from"
//      price; an entertainment line's age range, max kids, extra-child price,
//      unit and "from" price; a set-menu item's product code, per-option codes,
//      quantity and note. A value out of range is a 400 and writes nothing; a
//      branch or set menu of another park group is refused;
//   2. applying a package copies its limits, day prices and slip time onto the
//      party's snapshot (so the party keeps them), starts the BEO's kitchen
//      plan on the package's set menu without overriding one already chosen,
//      and the slip time can be changed for that party alone; a parent's
//      choices give the kitchen plan the set menu's portions;
//   3. `otoapp_v.event_packages` (migration 0042) gives the platform one row
//      per party with a package, in the contract's shape, its satang the
//      stored satang; the till's settlement sale (`posSaleId` on the directory
//      party edit) lands in `beo_event_billing.pos_order_ref` and reads back
//      from the view;
//   4. Generate from BEO bills the package's satang as the whole baht a
//      billing line holds (SCRUM-806): a 5,000 THB add-on bills 5,000; an
//      add-on switched off or at quantity 0 bills nothing, and one at 2 bills
//      two, as the view reads the party's add-ons;
//   5. script/seed-birthday-packages.mjs on rows shaped as staging holds them
//      (the two Floresta templates, facts in descriptions): the dry run writes
//      nothing, the run updates those rows in place (the weekday template
//      renamed and given both days, the weekend one archived, no duplicate)
//      and does exactly what the dry run printed, and a second run changes
//      nothing.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/birthday-packages.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { generateDirectoryKey, hashDirectoryKey } from "../server/directory/clientAuth";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("birthday-packages.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

// ─── Two park groups, each with an operator, a mapped branch and an admin ────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
interface ParkGroup {
  tenant: string;
  operator: string;
  branch: string;
  coreBranch: string;
  admin: { id: string; email: string };
}
async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST bday ${label} ${run}`, `zz-bday-${label}-${run}`]);
  const operator = randomUUID();
  await q("insert into operators (id, tenant_id, name) values ($1, $2, $3)", [operator, tenant, `ZZ TEST bday ${label} ${run}`]);
  const branch = randomUUID();
  const coreBranch = randomUUID();
  await q(
    `insert into branches (id, tenant_id, operator_id, name, address, timezone, core_branch_id)
     values ($1, $2, $3, $4, 'ZZ TEST', 'Asia/Bangkok', $5)`,
    [branch, tenant, operator, `ZZ TEST bday ${label} park ${run}`, coreBranch],
  );
  const admin = { id: randomUUID(), email: `zz-bday-${label}-${run}@example.com` };
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, operator_id)
     values ($1, $2, $3, $4, 'operator_admin', true, false, $5)`,
    [admin.id, admin.email, hash(PASSWORD), `ZZ TEST Bday Admin ${label} ${run}`, operator],
  );
  await q(
    "insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')",
    [tenant, admin.id, branch],
  );
  return { tenant, operator, branch, coreBranch, admin };
}
const A = await parkGroup("a");
const B = await parkGroup("b");

async function birthday(group: ParkGroup, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  const row = {
    event_date: "2099-03-14",
    start_time: "14:00",
    end_time: "17:00",
    num_children: 12,
    num_adults: 5,
    prepayment_amount: 5000,
    ...over,
  };
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
                              num_children, num_adults, prepayment_amount, status)
     values ($1, $2, $3, 'birthday', $4, $5, $6, $7, $8, $9, $10, 'upcoming')`,
    [id, group.tenant, group.branch, `ZZ TEST bday party ${run}`, row.event_date, row.start_time, row.end_time,
      row.num_children, row.num_adults, row.prepayment_amount],
  );
  return id;
}

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
const HARNESS_ENV = {
  NODE_ENV: "test",
  APP_ENV: "dev",
  STORAGE_ENV_PREFIX: "zz-test",
  OBJECT_STORAGE: "local",
  OTOAPP_LEGACY_LOGIN: "true",
  LOG_LEVEL: "warn",
  TZ: "UTC",
  DEPLOY_ENV: "local",
  OTOAPP_JOBS: "platform",
  USE_AWS_REKOGNITION: "false",
};

async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 90_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}

let ORIGIN = "";
async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body };
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)}`;

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

/** Every SCRUM-803 field of a package, as the settings screen sends it. Satang. */
const FLORESTA_FIELDS = {
  kidsIncluded: 10,
  adultsIncluded: 4,
  socksIncluded: -1,
  hours: 3,
  priceWeekday: 1_690_000,
  priceWeekend: 2_090_000,
  extraChildWeekday: 130_000,
  extraChildWeekend: 150_000,
  extraAdultWeekday: 35_000,
  extraAdultWeekend: 50_000,
};

const SET_MENU_ITEMS = [
  {
    id: "item_zz_pizza",
    type: "choice_group",
    label: "Pizza",
    options: ["Margherita", "Hawaiian", "Pepperoni"],
    allowMultiple: false,
    optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27", Pepperoni: "CF-31" },
    qty: 2,
  },
  { id: "item_zz_fries", type: "always_included", label: "French Fries", productCode: "CF-11", qty: 3 },
  {
    id: "item_zz_fish",
    type: "always_included",
    label: "Fish & Chips",
    productCode: "CF-36",
    qty: 1,
    note: "Can be replaced with 2 portions of Chicken Schnitzel",
  },
  { id: "item_zz_skewers", type: "always_included", label: "Fruit Skewers", qty: 2 },
];

try {
  ORIGIN = await serve();
  const cookie = await signIn(A.admin.email);
  const cookieB = await signIn(B.admin.email);

  // ── 1. the fields round-trip ─────────────────────────────────────────────

  let setMenuId = "";
  await check("a set menu keeps each item's product code, per-option codes, quantity and note", async () => {
    const res = await call("POST", "/api/beo/set-menu-templates", {
      cookie,
      body: { name: `ZZ TEST set menu ${run}`, items: SET_MENU_ITEMS },
    });
    assert.equal(res.status, 201, show(res));
    setMenuId = res.body.id;
    const list = await call("GET", "/api/beo/set-menu-templates", { cookie });
    const saved = list.body.find((t: { id: string }) => t.id === setMenuId);
    assert.deepEqual(saved.items, SET_MENU_ITEMS);
    const bad = await call("PUT", `/api/beo/set-menu-templates/${setMenuId}`, {
      cookie,
      body: { items: [{ ...SET_MENU_ITEMS[1], qty: 0 }] },
    });
    assert.equal(bad.status, 400, show(bad));
    const blankCode = await call("PUT", `/api/beo/set-menu-templates/${setMenuId}`, {
      cookie,
      body: { items: [{ ...SET_MENU_ITEMS[1], productCode: "" }] },
    });
    assert.equal(blankCode.status, 400, show(blankCode));
    const after = await call("GET", "/api/beo/set-menu-templates", { cookie });
    assert.deepEqual(after.body.find((t: { id: string }) => t.id === setMenuId).items, SET_MENU_ITEMS, "a refused save changes nothing");
  });

  let packageId = "";
  await check("a package's kids, adults, socks, hours, day prices, extras, set menu, slip time and branch round-trip", async () => {
    const res = await call("POST", "/api/beo/birthday-packages", {
      cookie,
      body: {
        name: `ZZ TEST Floresta ${run}`,
        basePrice: 1_690_000,
        pricingMode: "fixed",
        ...FLORESTA_FIELDS,
        setMenuTemplateId: setMenuId,
        slipsTime: "11:30",
        branchId: A.branch,
      },
    });
    assert.equal(res.status, 201, show(res));
    packageId = res.body.id;
    const got = await call("GET", `/api/beo/birthday-packages/${packageId}`, { cookie });
    assert.equal(got.status, 200, show(got));
    for (const [key, value] of Object.entries(FLORESTA_FIELDS)) assert.equal(got.body[key], value, key);
    assert.equal(got.body.setMenuTemplateId, setMenuId);
    assert.equal(got.body.slipsTime, "11:30:00");
    assert.equal(got.body.branchId, A.branch);
    assert.equal(got.body.basePrice, 1_690_000, "the base price is untouched");

    const patched = await call("PATCH", `/api/beo/birthday-packages/${packageId}`, {
      cookie,
      body: { socksIncluded: null, priceWeekend: 2_100_000, slipsTime: "11:00" },
    });
    assert.equal(patched.status, 200, show(patched));
    assert.equal(patched.body.socksIncluded, null);
    assert.equal(patched.body.priceWeekend, 2_100_000);
    assert.equal(patched.body.slipsTime, "11:00:00");
    assert.equal(patched.body.kidsIncluded, 10, "a field the edit does not name stays");
    const restored = await call("PATCH", `/api/beo/birthday-packages/${packageId}`, {
      cookie,
      body: { socksIncluded: -1, priceWeekend: 2_090_000 },
    });
    assert.equal(restored.status, 200, show(restored));
  });

  await check("a package made with none of the new fields keeps working on its base price", async () => {
    const res = await call("POST", "/api/beo/birthday-packages", {
      cookie,
      body: { name: `ZZ TEST plain ${run}`, basePrice: 500_000 },
    });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.priceWeekday, null);
    assert.equal(res.body.kidsIncluded, null);
    assert.equal(res.body.slipsTime, "11:00:00", "the slip time defaults to 11:00");
    assert.equal(res.body.basePrice, 500_000);
  });

  await check("a value out of range is a 400 and writes nothing", async () => {
    const before = (await q<{ n: number }>("select count(*)::int as n from birthday_package_templates where tenant_id = $1", [A.tenant]))[0].n;
    for (const body of [
      { priceWeekday: -1 },
      { socksIncluded: -2 },
      { kidsIncluded: 2.5 },
      { hours: 0 },
      { slipsTime: "25:00" },
      { setMenuTemplateId: "not-a-uuid" },
    ]) {
      const res = await call("POST", "/api/beo/birthday-packages", { cookie, body: { name: `ZZ TEST bad ${run}`, ...body } });
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${show(res)}`);
    }
    const patched = await call("PATCH", `/api/beo/birthday-packages/${packageId}`, { cookie, body: { extraAdultWeekend: -50 } });
    assert.equal(patched.status, 400, show(patched));
    const after = (await q<{ n: number }>("select count(*)::int as n from birthday_package_templates where tenant_id = $1", [A.tenant]))[0].n;
    assert.equal(after, before);
    const row = (await q<{ extra_adult_weekend: number }>("select extra_adult_weekend from birthday_package_templates where id = $1", [packageId]))[0];
    assert.equal(row.extra_adult_weekend, 50_000);
  });

  await check("another park group's branch or set menu is refused", async () => {
    const theirMenu = await call("POST", "/api/beo/set-menu-templates", { cookie: cookieB, body: { name: `ZZ TEST B menu ${run}`, items: [] } });
    assert.equal(theirMenu.status, 201, show(theirMenu));
    const branch = await call("PATCH", `/api/beo/birthday-packages/${packageId}`, { cookie, body: { branchId: B.branch } });
    assert.equal(branch.status, 400, show(branch));
    const menu = await call("PATCH", `/api/beo/birthday-packages/${packageId}`, { cookie, body: { setMenuTemplateId: theirMenu.body.id } });
    assert.equal(menu.status, 400, show(menu));
    const created = await call("POST", "/api/beo/birthday-packages", {
      cookie,
      body: { name: `ZZ TEST foreign ${run}`, branchId: B.branch },
    });
    assert.equal(created.status, 400, show(created));
    const row = (await q<{ branch_id: string; set_menu_template_id: string }>(
      "select branch_id, set_menu_template_id from birthday_package_templates where id = $1",
      [packageId],
    ))[0];
    assert.deepEqual(row, { branch_id: A.branch, set_menu_template_id: setMenuId });
  });

  let tableItemId = "";
  await check("a line item's F&B credit, voucher and \"from\" price round-trip", async () => {
    const table = await call("POST", `/api/beo/birthday-packages/${packageId}/line-items`, {
      cookie,
      body: {
        category: "setup",
        label: "Reserved table for adults, up to 10 adults",
        included: false,
        defaultUnitPrice: 500_000,
        billableByDefault: true,
        fnbCredit: 500_000,
        printsVoucher: true,
      },
    });
    assert.equal(table.status, 201, show(table));
    tableItemId = table.body.id;
    const upgrade = await call("POST", `/api/beo/birthday-packages/${packageId}/line-items`, {
      cookie,
      body: { category: "entertainment", label: "Upgrade or customize your activity program", included: false, defaultUnitPrice: 100_000, priceIsFrom: true },
    });
    assert.equal(upgrade.status, 201, show(upgrade));
    const cake = await call("POST", `/api/beo/birthday-packages/${packageId}/line-items`, {
      cookie,
      body: { category: "cake", label: "Ice-cream cake with candles and birthday song", included: true, billableByDefault: false },
    });
    assert.equal(cake.status, 201, show(cake));
    const detail = await call("GET", `/api/beo/birthday-packages/${packageId}`, { cookie });
    const byLabel = Object.fromEntries(detail.body.lineItems.map((i: { label: string }) => [i.label, i]));
    assert.equal(byLabel["Reserved table for adults, up to 10 adults"].fnbCredit, 500_000);
    assert.equal(byLabel["Reserved table for adults, up to 10 adults"].printsVoucher, true);
    assert.equal(byLabel["Upgrade or customize your activity program"].priceIsFrom, true);
    assert.equal(byLabel["Upgrade or customize your activity program"].fnbCredit, null);
    assert.equal(byLabel["Ice-cream cake with candles and birthday song"].printsVoucher, false);
    const patched = await call("PATCH", `/api/beo/birthday-packages/${packageId}/line-items/${tableItemId}`, {
      cookie,
      body: { fnbCredit: 450_000 },
    });
    assert.equal(patched.status, 200, show(patched));
    assert.equal(patched.body.fnbCredit, 450_000);
    assert.equal(patched.body.printsVoucher, true);
    const bad = await call("PATCH", `/api/beo/birthday-packages/${packageId}/line-items/${tableItemId}`, { cookie, body: { fnbCredit: -1 } });
    assert.equal(bad.status, 400, show(bad));
    await call("PATCH", `/api/beo/birthday-packages/${packageId}/line-items/${tableItemId}`, { cookie, body: { fnbCredit: 500_000 } });
  });

  await check("an entertainment line's age range, max kids, extra-child price, unit and \"from\" price round-trip", async () => {
    const res = await call("POST", "/api/beo/entertainment-templates", {
      cookie,
      body: {
        name: `ZZ TEST Zombie game ${run}`,
        category: "Games",
        durationMinutes: 30,
        defaultPrice: 400_000,
        ageRange: "6+",
        maxKids: 10,
        extraChildPrice: 40_000,
        unit: "session",
      },
    });
    assert.equal(res.status, 201, show(res));
    const list = await call("GET", "/api/beo/entertainment-templates", { cookie });
    const saved = list.body.find((t: { id: string }) => t.id === res.body.id);
    assert.deepEqual(
      [saved.category, saved.ageRange, saved.maxKids, saved.extraChildPrice, saved.unit, saved.priceIsFrom],
      ["Games", "6+", 10, 40_000, "session", false],
    );
    const patched = await call("PATCH", `/api/beo/entertainment-templates/${res.body.id}`, {
      cookie,
      body: { unit: "piece", priceIsFrom: true, maxKids: null },
    });
    assert.equal(patched.status, 200, show(patched));
    assert.deepEqual([patched.body.unit, patched.body.priceIsFrom, patched.body.maxKids], ["piece", true, null]);
    for (const body of [{ unit: "day" }, { maxKids: 0 }, { extraChildPrice: -100 }]) {
      const bad = await call("PATCH", `/api/beo/entertainment-templates/${res.body.id}`, { cookie, body });
      assert.equal(bad.status, 400, `${JSON.stringify(body)}: ${show(bad)}`);
    }
  });

  await check("duplicating a package copies the new fields and the line items' credit and voucher", async () => {
    const dup = await call("POST", `/api/beo/birthday-packages/${packageId}/duplicate`, { cookie });
    assert.equal(dup.status, 201, show(dup));
    for (const [key, value] of Object.entries(FLORESTA_FIELDS)) assert.equal(dup.body[key], value, key);
    assert.equal(dup.body.setMenuTemplateId, setMenuId);
    assert.equal(dup.body.branchId, A.branch);
    const table = dup.body.lineItems.find((i: { label: string }) => i.label.startsWith("Reserved table"));
    assert.deepEqual([table.fnbCredit, table.printsVoucher], [500_000, true]);
  });

  // ── 2. applying a package to a party ─────────────────────────────────────

  const party = await birthday(A);
  await check("applying copies the limits, day prices and slip time, and starts the kitchen plan on the set menu", async () => {
    await call("PATCH", `/api/beo/birthday-packages/${packageId}`, { cookie, body: { slipsTime: "10:45" } });
    const res = await call("POST", `/api/beo/events/${party}/package-snapshot`, { cookie, body: { templateId: packageId } });
    assert.equal(res.status, 201, show(res));
    for (const [key, value] of Object.entries(FLORESTA_FIELDS)) assert.equal(res.body[key], value, key);
    assert.equal(res.body.slipsTime, "10:45:00");
    assert.equal(res.body.setMenuTemplateId, setMenuId, "the answer names the package's set menu for the BEO screen");
    const kitchen = (await q<{ set_menu_enabled: boolean; set_menu_template_id: string }>(
      "select set_menu_enabled, set_menu_template_id from beo_kitchen_plans where event_id = $1",
      [party],
    ))[0];
    assert.deepEqual(kitchen, { set_menu_enabled: true, set_menu_template_id: setMenuId });

    // The party keeps what it was sold at when the template changes later.
    await call("PATCH", `/api/beo/birthday-packages/${packageId}`, { cookie, body: { priceWeekday: 1_790_000, slipsTime: "11:00" } });
    const snapshot = await call("GET", `/api/beo/events/${party}/package-snapshot`, { cookie });
    assert.equal(snapshot.body.priceWeekday, 1_690_000);
    assert.equal(snapshot.body.slipsTime, "10:45:00");
    await call("PATCH", `/api/beo/birthday-packages/${packageId}`, { cookie, body: { priceWeekday: 1_690_000 } });
  });

  await check("a set menu already chosen in the kitchen plan stays when a package is applied", async () => {
    const other = await call("POST", "/api/beo/set-menu-templates", { cookie, body: { name: `ZZ TEST other menu ${run}`, items: [] } });
    const second = await birthday(A);
    await q("insert into beo_kitchen_plans (event_id, set_menu_enabled, set_menu_template_id) values ($1, true, $2)", [second, other.body.id]);
    const res = await call("POST", `/api/beo/events/${second}/package-snapshot`, { cookie, body: { templateId: packageId } });
    assert.equal(res.status, 201, show(res));
    const kitchen = (await q<{ set_menu_template_id: string }>("select set_menu_template_id from beo_kitchen_plans where event_id = $1", [second]))[0];
    assert.equal(kitchen.set_menu_template_id, other.body.id);
  });

  await check("the slip time is changed for one party alone, and refused when it is not a time", async () => {
    const res = await call("PATCH", `/api/beo/events/${party}/package-snapshot`, { cookie, body: { slipsTime: "10:30" } });
    assert.equal(res.status, 200, show(res));
    assert.equal(res.body.slipsTime, "10:30:00");
    const bad = await call("PATCH", `/api/beo/events/${party}/package-snapshot`, { cookie, body: { slipsTime: "noon" } });
    assert.equal(bad.status, 400, show(bad));
    const extra = await call("PATCH", `/api/beo/events/${party}/package-snapshot`, { cookie, body: { slipsTime: "10:30", basePrice: 1 } });
    assert.equal(extra.status, 400, "nothing else of the snapshot is changed here");
    const foreign = await call("PATCH", `/api/beo/events/${party}/package-snapshot`, { cookie: cookieB, body: { slipsTime: "09:00" } });
    assert.equal(foreign.status, 404, show(foreign));
    const template = (await q<{ slips_time: string }>("select slips_time::text from birthday_package_templates where id = $1", [packageId]))[0];
    assert.equal(template.slips_time, "11:00:00", "the template's own slip time is untouched");
  });

  await check("a parent's choices give the kitchen plan the set menu's portions", async () => {
    const link = await call("POST", "/api/beo/set-menu-selections", { cookie, body: { eventId: party, templateId: setMenuId } });
    assert.equal(link.status, 201, show(link));
    const submit = await call("POST", `/api/beo/set-menu-selections/public/${link.body.token}/submit`, {
      body: { selections: [{ groupId: "item_zz_pizza", chosenOptions: ["Hawaiian"] }] },
    });
    assert.equal(submit.status, 200, show(submit));
    const menus = (await q<{ menus: { kids: Array<{ itemName: string; quantity: number }> } }>(
      "select menus from beo_kitchen_plans where event_id = $1",
      [party],
    ))[0].menus;
    const qty = Object.fromEntries(menus.kids.map((i) => [i.itemName, i.quantity]));
    assert.deepEqual(qty, { Hawaiian: 2, "French Fries": 3, "Fish & Chips": 1, "Fruit Skewers": 2 });
  });

  // ── 3. the view the platform reads, and the settlement written back ──────

  const ent = async (body: Record<string, unknown>) => {
    const res = await call("POST", "/api/beo/entertainment-templates", { cookie, body });
    assert.equal(res.status, 201, show(res));
    return res.body.id as string;
  };
  const crio = await ent({
    name: `ZZ TEST Crio show ${run}`, category: "Shows", durationMinutes: 30, defaultPrice: 650_000,
    ageRange: "4+", maxKids: 10, extraChildPrice: 65_000, unit: "session",
  });
  const program = await ent({
    name: `ZZ TEST Birthday entertainment program ${run}`, category: "Games", durationMinutes: 30,
    defaultPrice: 300_000, included: true, billableByDefault: false, unit: "session",
  });

  await check("otoapp_v.event_packages gives the party's package, counts, add-ons, entertainment, set menu, bar, kitchen and settlement", async () => {
    for (const templateId of [crio, program]) {
      const sel = await call("POST", `/api/beo/events/${party}/entertainment-selections`, { cookie, body: { templateId } });
      assert.equal(sel.status, 201, show(sel));
    }
    // The upgrade is switched off in the BEO: it is not one of the party's add-ons.
    const snapshot = await call("GET", `/api/beo/events/${party}/package-snapshot`, { cookie });
    const upgrade = snapshot.body.items.find((i: { label: string }) => i.label.startsWith("Upgrade"));
    const off = await call("PATCH", `/api/beo/events/${party}/package-snapshot/items/${upgrade.id}`, { cookie, body: { billable: false } });
    assert.equal(off.status, 200, show(off));
    await q(
      `update beo_kitchen_plans set menus = menus || '{"kidsFoodTime": "15:00", "adultsFoodTime": "15:30"}'::jsonb,
              kitchen_ready_offset_minutes = 25
        where event_id = $1`,
      [party],
    );
    await q(
      `insert into beo_bar_plans (event_id, service_time, items) values ($1, '15:00', $2::jsonb)`,
      [party, JSON.stringify([{ id: "bar_1", itemName: "Juice pitcher", quantity: 2 }, { id: "bar_2", itemName: "  " }])],
    );

    const rows = await q("select * from otoapp_v.event_packages where event_id = $1", [party]);
    assert.equal(rows.length, 1);
    const row = rows[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a view row read field by field below
    assert.deepEqual(Object.keys(row), [
      "event_id", "core_branch_id", "party_date", "start_time", "end_time", "package", "counts",
      "add_ons", "entertainment", "set_menu", "bar_items", "kitchen", "settlement",
    ]);
    assert.equal(row.event_id, party);
    assert.equal(row.core_branch_id, A.coreBranch);
    assert.equal(row.start_time, "14:00:00");
    assert.equal(row.end_time, "17:00:00");
    const partyDate = (await q<{ d: string }>("select party_date::text as d from otoapp_v.event_packages where event_id = $1", [party]))[0].d;
    assert.equal(partyDate, "2099-03-14");
    assert.deepEqual(row.package, {
      template_id: packageId,
      name: `ZZ TEST Floresta ${run}`,
      hours: 3,
      kids_included: 10,
      adults_included: 4,
      socks_included: -1,
      price_weekday_satang: 1_690_000,
      price_weekend_satang: 2_090_000,
      extra_child_weekday_satang: 130_000,
      extra_child_weekend_satang: 150_000,
      extra_adult_weekday_satang: 35_000,
      extra_adult_weekend_satang: 50_000,
      included_lines: [{ label: "Ice-cream cake with candles and birthday song" }],
    });
    assert.deepEqual(row.counts, { kids_expected: 12, adults_expected: 5 });
    assert.deepEqual(row.add_ons, [{
      template_id: tableItemId,
      name: "Reserved table for adults, up to 10 adults",
      qty: 1,
      unit_price_satang: 500_000,
      fnb_credit_satang: 500_000,
      prints_voucher: true,
    }]);
    assert.deepEqual(row.entertainment, [
      {
        template_id: crio, name: `ZZ TEST Crio show ${run}`, category: "Shows", duration_minutes: 30, age_range: "4+",
        max_kids: 10, price_satang: 650_000, extra_children: 2, extra_child_price_satang: 65_000,
      },
      {
        template_id: program, name: `ZZ TEST Birthday entertainment program ${run}`, category: "Games", duration_minutes: 30,
        age_range: null, max_kids: null, price_satang: 0, extra_children: 0, extra_child_price_satang: null,
      },
    ]);
    assert.deepEqual(row.set_menu, [
      { product_code: "CF-27", name: "Pizza", qty: 2, choice_group: "Pizza", chosen_option: "Hawaiian", note: null },
      { product_code: "CF-11", name: "French Fries", qty: 3, choice_group: null, chosen_option: null, note: null },
      {
        product_code: "CF-36", name: "Fish & Chips", qty: 1, choice_group: null, chosen_option: null,
        note: "Can be replaced with 2 portions of Chicken Schnitzel",
      },
      { product_code: null, name: "Fruit Skewers", qty: 2, choice_group: null, chosen_option: null, note: null },
    ]);
    assert.deepEqual(row.bar_items, [{ product_code: null, name: "Juice pitcher", qty: 2 }]);
    assert.deepEqual(row.kitchen, { kids_food_time: "15:00", adults_food_time: "15:30", ready_offset_minutes: 25, slips_time: "10:30" });
    assert.deepEqual(row.settlement, { deposit_satang: 500_000, pos_sale_id: null });

    // Satang passed through: the view's money is the stored money, never multiplied.
    const stored = (await q<{ price_weekday: number; extra_child_weekday: number }>(
      "select price_weekday, extra_child_weekday from beo_package_snapshots where event_id = $1",
      [party],
    ))[0];
    assert.equal(row.package.price_weekday_satang, stored.price_weekday);
    assert.equal(row.package.extra_child_weekday_satang, stored.extra_child_weekday);
  });

  await check("an open choice is one line with no option; a package with one price charges it every day", async () => {
    const plain = await call("POST", "/api/beo/birthday-packages", {
      cookie,
      body: { name: `ZZ TEST one price ${run}`, basePrice: 1_090_000, kidsIncluded: 10, adultsIncluded: 10, setMenuTemplateId: setMenuId },
    });
    assert.equal(plain.status, 201, show(plain));
    const open = await birthday(A, { prepayment_amount: null });
    const applied = await call("POST", `/api/beo/events/${open}/package-snapshot`, { cookie, body: { templateId: plain.body.id } });
    assert.equal(applied.status, 201, show(applied));
    const row = (await q<Record<string, any>>("select * from otoapp_v.event_packages where event_id = $1", [open]))[0]; // eslint-disable-line @typescript-eslint/no-explicit-any -- read field by field
    assert.equal(row.package.price_weekday_satang, 1_090_000);
    assert.equal(row.package.price_weekend_satang, 1_090_000);
    assert.equal(row.package.socks_included, null);
    assert.deepEqual(row.set_menu[0], { product_code: null, name: "Pizza", qty: 2, choice_group: "Pizza", chosen_option: null, note: null });
    assert.deepEqual(row.add_ons, []);
    assert.deepEqual(row.entertainment, []);
    assert.deepEqual(row.bar_items, []);
    assert.deepEqual(row.kitchen, { kids_food_time: null, adults_food_time: null, ready_offset_minutes: 20, slips_time: "11:00" });
    assert.deepEqual(row.settlement, { deposit_satang: null, pos_sale_id: null });
  });

  await check("a party without a package, an event that is not a party, and an unmapped branch have no row", async () => {
    const bare = await birthday(A);
    const camp = randomUUID();
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, status)
       values ($1, $2, $3, 'workshop', 'ZZ TEST workshop', '2099-03-14', '10:00', 'upcoming')`,
      [camp, A.tenant, A.branch],
    );
    await q("insert into beo_package_snapshots (event_id, template_id, package_name, base_price) values ($1, $2, 'ZZ TEST', 1)", [camp, packageId]);
    const unmapped = randomUUID();
    await q(
      "insert into branches (id, tenant_id, operator_id, name, address, timezone) values ($1, $2, $3, $4, 'ZZ TEST', 'Asia/Bangkok')",
      [unmapped, A.tenant, A.operator, `ZZ TEST unmapped ${run}`],
    );
    const away = randomUUID();
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, status)
       values ($1, $2, $3, 'birthday', 'ZZ TEST away', '2099-03-14', '10:00', 'upcoming')`,
      [away, A.tenant, unmapped],
    );
    await q("insert into beo_package_snapshots (event_id, template_id, package_name, base_price) values ($1, $2, 'ZZ TEST', 1)", [away, packageId]);
    const found = await q("select event_id from otoapp_v.event_packages where event_id = any($1::varchar[])", [[bare, camp, away]]);
    assert.deepEqual(found, []);
  });

  const key = generateDirectoryKey();
  const keyB = generateDirectoryKey();
  await q("insert into directory_clients (tenant_id, name, key_hash, scopes, is_active) values ($1, $2, $3, $4, true)", [
    A.tenant, `ZZ TEST bday till ${run}`, hashDirectoryKey(key), ["events:write"],
  ]);
  await q("insert into directory_clients (tenant_id, name, key_hash, scopes, is_active) values ($1, $2, $3, $4, true)", [
    B.tenant, `ZZ TEST bday till B ${run}`, hashDirectoryKey(keyB), ["events:write"],
  ]);
  const edit = (eventId: string, fields: Record<string, unknown>, editedAt: string, bearer = key) =>
    call("POST", `/api/directory/events/${eventId}/edits`, {
      headers: { authorization: `Bearer ${bearer}` },
      body: { id: randomUUID(), editedAt, fields },
    });
  const saleOf = async (eventId: string) =>
    ((await q<{ settlement: { pos_sale_id: string | null } }>("select settlement from otoapp_v.event_packages where event_id = $1", [eventId]))[0])
      .settlement.pos_sale_id;
  const updatedAtOf = async (eventId: string) =>
    (await q<{ t: string }>("select updated_at::text as t from core_events where id = $1", [eventId]))[0].t;

  await check("the till's settlement sale is written back into the billing and read back from the view", async () => {
    const sale = `ZZ-${run}-000001`;
    const before = await updatedAtOf(party);
    // Made before the app's last change: the sale is a fact, not a competing edit.
    const res = await edit(party, { posSaleId: sale }, "2000-01-01T00:00:00Z");
    assert.equal(res.status, 200, show(res));
    assert.equal(res.body.replayed, false);
    assert.deepEqual(res.body.edit.fields, ["posSaleId"]);
    assert.equal(res.body.event.posSaleId, sale);
    const billing = (await q<{ pos_order_ref: string }>("select pos_order_ref from beo_event_billing where event_id = $1", [party]))[0];
    assert.equal(billing.pos_order_ref, sale);
    assert.equal(await saleOf(party), sale);
    assert.equal(await updatedAtOf(party), before, "the event and its edit order are untouched");

    const again = await edit(party, { posSaleId: sale }, new Date().toISOString());
    assert.equal(again.status, 200, show(again));
    assert.equal(again.body.replayed, true);
    assert.equal((await q("select 1 from beo_event_billing where event_id = $1", [party])).length, 1);
  });

  await check("named beside the party's own fields, the sale follows their order rule", async () => {
    const old = await edit(party, { posSaleId: `ZZ-${run}-000002`, decoration: "ZZ TEST balloons" }, "2000-01-01T00:00:00Z");
    assert.equal(old.status, 409, show(old));
    assert.equal(old.body.error, "edit_superseded");
    assert.equal(await saleOf(party), `ZZ-${run}-000001`, "nothing written");
    const now = await edit(party, { posSaleId: `ZZ-${run}-000002`, decoration: "ZZ TEST balloons" }, new Date(Date.now() + 1000).toISOString());
    assert.equal(now.status, 200, show(now));
    assert.equal(await saleOf(party), `ZZ-${run}-000002`);
    const cleared = await edit(party, { posSaleId: null }, new Date().toISOString());
    assert.equal(cleared.status, 200, show(cleared));
    assert.equal(await saleOf(party), null);
  });

  await check("a sale id is refused when blank, on another park group's key, and on a party with no billing yet it makes one", async () => {
    const blank = await edit(party, { posSaleId: "  " }, new Date().toISOString());
    assert.equal(blank.status, 400, show(blank));
    const foreign = await edit(party, { posSaleId: `ZZ-${run}-B` }, new Date().toISOString(), keyB);
    assert.equal(foreign.status, 404, show(foreign));
    assert.equal(await saleOf(party), null);
    const fresh = await birthday(A);
    await call("POST", `/api/beo/events/${fresh}/package-snapshot`, { cookie, body: { templateId: packageId } });
    const res = await edit(fresh, { posSaleId: `ZZ-${run}-000003` }, new Date().toISOString());
    assert.equal(res.status, 200, show(res));
    assert.equal(await saleOf(fresh), `ZZ-${run}-000003`);
  });

  // ── 4. Generate from BEO bills the package in baht (SCRUM-806) ───────────

  await check("Generate from BEO bills a 5,000 THB add-on as 5,000, not 500,000", async () => {
    const billed = await birthday(A);
    const applied = await call("POST", `/api/beo/events/${billed}/package-snapshot`, { cookie, body: { templateId: packageId } });
    assert.equal(applied.status, 201, show(applied));
    const sel = await call("POST", `/api/beo/events/${billed}/entertainment-selections`, { cookie, body: { templateId: crio } });
    assert.equal(sel.status, 201, show(sel));
    const res = await call("POST", `/api/events/${billed}/line-items/generate-from-beo`, { cookie, body: { mode: "replace" } });
    assert.equal(res.status, 201, show(res));
    const lines = await call("GET", `/api/events/${billed}/line-items`, { cookie });
    assert.equal(lines.status, 200, show(lines));
    const price = Object.fromEntries(
      lines.body.map((l: { name: string; unitPriceIncVat: number }) => [l.name, l.unitPriceIncVat]),
    );
    assert.equal(price["Add-on: Reserved table for adults, up to 10 adults"], 5_000);
    assert.equal(price["Add-on: Upgrade or customize your activity program"], 1_000);
    assert.equal(price["Package: Ice-cream cake with candles and birthday song"], 0);
    assert.equal(price[`Entertainment: ZZ TEST Crio show ${run}`], 6_500);
    // What the billing screen totals (qty x unit price of every line not included).
    const total = lines.body
      .filter((l: { isIncluded: boolean }) => !l.isIncluded)
      .reduce((sum: number, l: { qty: number; unitPriceIncVat: number }) => sum + l.qty * l.unitPriceIncVat, 0);
    assert.equal(total, 5_000 + 1_000 + 6_500);
  });

  await check("an add-on switched off or at quantity 0 adds nothing to the billing; a quantity bills that many", async () => {
    const billed = await birthday(A);
    const applied = await call("POST", `/api/beo/events/${billed}/package-snapshot`, { cookie, body: { templateId: packageId } });
    assert.equal(applied.status, 201, show(applied));
    const itemOf = (prefix: string) => applied.body.items.find((i: { label: string }) => i.label.startsWith(prefix)).id as string;
    const table = itemOf("Reserved table");
    const upgrade = itemOf("Upgrade");
    const setItem = async (itemId: string, body: Record<string, unknown>) => {
      const res = await call("PATCH", `/api/beo/events/${billed}/package-snapshot/items/${itemId}`, { cookie, body });
      assert.equal(res.status, 200, show(res));
    };
    await setItem(table, { qty: 0 });
    await setItem(upgrade, { billable: false });
    const generate = async () => {
      const res = await call("POST", `/api/events/${billed}/line-items/generate-from-beo`, { cookie, body: { mode: "replace" } });
      assert.equal(res.status, 201, show(res));
      const lines = await call("GET", `/api/events/${billed}/line-items`, { cookie });
      assert.equal(lines.status, 200, show(lines));
      return lines.body as Array<{ name: string; qty: number; unitPriceIncVat: number; isIncluded: boolean }>;
    };
    const billedTotal = (lines: Array<{ qty: number; unitPriceIncVat: number; isIncluded: boolean }>) =>
      lines.filter((l) => !l.isIncluded).reduce((sum, l) => sum + l.qty * l.unitPriceIncVat, 0);

    const none = await generate();
    assert.deepEqual(none.filter((l) => l.name.startsWith("Add-on:")), [], "nothing the party did not buy");
    assert.ok(none.some((l) => l.name === "Package: Ice-cream cake with candles and birthday song"), "the included lines stay");
    assert.equal(billedTotal(none), 0);

    await setItem(table, { qty: 2 });
    const two = await generate();
    assert.deepEqual(
      two.filter((l) => l.name.startsWith("Add-on:")).map((l) => [l.name, l.qty, l.unitPriceIncVat]),
      [["Add-on: Reserved table for adults, up to 10 adults", 2, 5_000]],
    );
    assert.equal(billedTotal(two), 10_000);
    // The billing and the view agree on what the party bought.
    const addOns = (await q<{ add_ons: Array<{ name: string; qty: number }> }>(
      "select add_ons from otoapp_v.event_packages where event_id = $1",
      [billed],
    ))[0].add_ons;
    assert.deepEqual(addOns.map((a) => [a.name, a.qty]), [["Reserved table for adults, up to 10 adults", 2]]);
  });

  // ── 5. the repo seed, on rows shaped as staging holds them ───────────────

  // A park group as staging was left on 9 November: the printed catalogue
  // entered through the app's routes before the fields existed — Floresta as
  // two templates, facts in descriptions, portions in set-menu labels.
  const C = await parkGroup("seed");
  await q("update branches set name = 'Central Floresta' where id = $1", [C.branch]);
  const cookieC = await signIn(C.admin.email);
  const asStaged = async (path: string, body: Record<string, unknown>) => {
    const res = await call("POST", path, { cookie: cookieC, body });
    assert.equal(res.status, 201, `${path}: ${show(res)}`);
    return res.body.id as string;
  };
  const stagedLine = (category: string, label: string, priceThb: number, isIncluded: boolean, qty = 1, unitLabel: string | null = null) => ({
    category, label, qtyDefault: qty, qtyEditable: !isIncluded, unitLabel, included: isIncluded,
    defaultUnitPrice: priceThb * 100, billableByDefault: !isIncluded,
  });
  const florestaLines = (extraChild: number, extraAdult: number) => [
    stagedLine("setup", "Kids' table reserved for 3 hours", 0, true),
    stagedLine("food", "Special birthday set menu", 0, true),
    stagedLine("entertainment", "Interactive birthday animation program, 30 minutes", 0, true),
    stagedLine("cake", "Ice-cream cake with candles and birthday song", 0, true),
    stagedLine("play", "Entry for 4 accompanying adults", 0, true, 4, "adults"),
    stagedLine("other", "Socks for all children", 0, true, 10, "pairs"),
    stagedLine("play", "Extra child", extraChild, false, 1, "child"),
    stagedLine("play", "Additional adult", extraAdult, false, 1, "adult"),
    stagedLine("setup", "Reserved table for adults, up to 10 adults", 5000, false),
    stagedLine("setup", "Classic balloon decoration", 4000, false),
    stagedLine("setup", "PRO photo zone with decorations", 8900, false),
    stagedLine("entertainment", "Upgrade or customize your activity program", 1000, false),
    stagedLine("entertainment", "Bracelet Making", 100, false, 1, "child"),
  ];
  const staged: Record<string, string> = {};
  for (const [name, price, extraChild, extraAdult] of [
    ["Birthday package, Central Floresta (weekday)", 16900, 1300, 350],
    ["Birthday package, Central Floresta (weekend)", 20900, 1500, 500],
  ] as const) {
    staged[name] = await asStaged("/api/beo/birthday-packages", { name, basePrice: price * 100, pricingMode: "fixed", tags: ["Central Floresta"] });
    for (const line of florestaLines(extraChild, extraAdult)) await asStaged(`/api/beo/birthday-packages/${staged[name]}/line-items`, line);
  }
  staged.as10 = await asStaged("/api/beo/birthday-packages", { name: "After School Birthday Package, Central (10 kids)", basePrice: 1_090_000 });
  for (const line of [
    stagedLine("setup", "Table reservation", 0, true),
    stagedLine("play", "Entrance for 10 children", 0, true, 10, "children"),
    stagedLine("setup", "Private Zone (guaranteed)", 3000, false),
  ]) await asStaged(`/api/beo/birthday-packages/${staged.as10}/line-items`, line);
  staged.zombie = await asStaged("/api/beo/entertainment-templates", {
    name: "Zombie game", category: "Games", durationMinutes: 30, defaultPrice: 400_000, billableByDefault: true,
    description: "Age 6+. Up to 10 kids. Extra child 400 THB. Immersive game, where kids become real detectives and need to save the world by finding the antidote that is guarded by a zombie.",
  });
  staged.menu10 = await asStaged("/api/beo/set-menu-templates", {
    name: "After School food set (10 kids)",
    items: [
      { id: "item_as10_fries", type: "always_included", label: "French Fries x3" },
      { id: "item_as10_fish_chips", type: "always_included", label: "Fish & Chips x1 (or 2 Chicken Schnitzel)" },
    ],
  });

  const SEED = join(APP_DIR, "script", "seed-birthday-packages.mjs");
  type SeedRun = { dryRun: boolean; created: number; updated: number; renamed: number; archived: number; removed: number; unchanged: number };
  const seed = (...flags: string[]) =>
    new Promise<{ out: string; result: SeedRun }>((resolve, reject) => {
      const child = spawn(process.execPath, [SEED, "--tenant", C.tenant, ...flags], {
        cwd: APP_DIR,
        env: { ...process.env, DATABASE_URL, DB_SCHEMA: "otoapp" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr!.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.on("exit", (code) => {
        const m = /seed-birthday-packages: (\{.*\})\s*$/.exec(out);
        if (code !== 0 || !m) return reject(new Error(`seed exited ${code}:\n${out}`));
        resolve({ out, result: JSON.parse(m[1]!) as SeedRun });
      });
    });
  /** Every row the seed may touch in this park group, as one value. */
  const fingerprint = async () =>
    (await q<{ f: string }>(
      `select md5(concat_ws('|',
         (select json_agg(t order by t.id)::text from birthday_package_templates t where t.tenant_id = $1),
         (select json_agg(l order by l.id)::text from package_line_item_templates l
            join birthday_package_templates p on p.id = l.package_template_id where p.tenant_id = $1),
         (select json_agg(e order by e.id)::text from entertainment_package_templates e where e.tenant_id = $1),
         (select json_agg(m order by m.id)::text from beo_set_menu_templates m where m.tenant_id = $1))) as f`,
      [C.tenant],
    ))[0].f;

  let dry: SeedRun | null = null;
  await check("the seed's dry run prints the plan and writes nothing", async () => {
    const before = await fingerprint();
    const run1 = await seed("--dry-run");
    dry = run1.result;
    assert.equal(dry.dryRun, true);
    assert.deepEqual([dry.renamed, dry.archived, dry.removed], [1, 1, 2], run1.out);
    assert.ok(dry.created > 0 && dry.updated > 0, run1.out);
    assert.match(run1.out, /renamed\s+package "Birthday package, Central Floresta \(weekday\)"/);
    assert.match(run1.out, /questions for the owner/);
    assert.equal(await fingerprint(), before);
  });

  await check("the seed writes the printed data onto the staged rows, updating rather than duplicating", async () => {
    const { result } = await seed();
    assert.deepEqual({ ...result, dryRun: true }, dry, "the run did exactly what the dry run said");
    const names = await q<{ name: string; n: number }>(
      "select name, count(*)::int as n from birthday_package_templates where tenant_id = $1 group by name order by name",
      [C.tenant],
    );
    assert.deepEqual(names, [
      { name: "After School Birthday Package, Central (10 kids)", n: 1 },
      { name: "After School Birthday Package, Central (20 kids)", n: 1 },
      { name: "Birthday package, Central Floresta", n: 1 },
      { name: "Birthday package, Central Floresta (weekend)", n: 1 },
    ]);
    const floresta = await call("GET", `/api/beo/birthday-packages/${staged["Birthday package, Central Floresta (weekday)"]}`, { cookie: cookieC });
    assert.equal(floresta.body.name, "Birthday package, Central Floresta", "the weekday row is the merged package");
    for (const [key, value] of Object.entries(FLORESTA_FIELDS)) assert.equal(floresta.body[key], value, key);
    assert.equal(floresta.body.basePrice, 1_690_000);
    assert.equal(floresta.body.slipsTime, "11:00:00");
    assert.equal(floresta.body.branchId, C.branch);
    assert.equal(floresta.body.isActive, true);
    const menuId = (await q<{ id: string }>("select id from beo_set_menu_templates where tenant_id = $1 and name = 'Birthday set menu, Central Floresta'", [C.tenant]))[0].id;
    assert.equal(floresta.body.setMenuTemplateId, menuId);
    const labels = floresta.body.lineItems.map((l: { label: string }) => l.label);
    assert.ok(!labels.includes("Extra child") && !labels.includes("Additional adult"), "now the package's own extra prices");
    const table = floresta.body.lineItems.find((l: { label: string }) => l.label.startsWith("Reserved table"));
    assert.deepEqual([table.fnbCredit, table.printsVoucher], [500_000, true]);
    const upgrade = floresta.body.lineItems.find((l: { label: string }) => l.label.startsWith("Upgrade"));
    assert.equal(upgrade.priceIsFrom, true);

    const weekend = await call("GET", `/api/beo/birthday-packages/${staged["Birthday package, Central Floresta (weekend)"]}`, { cookie: cookieC });
    assert.equal(weekend.body.isActive, false, "archived, the way Event Settings archives a package");
    assert.equal(weekend.body.lineItems.length, 13, "and otherwise left as it was");

    const as10 = await call("GET", `/api/beo/birthday-packages/${staged.as10}`, { cookie: cookieC });
    assert.deepEqual(
      [as10.body.kidsIncluded, as10.body.adultsIncluded, as10.body.socksIncluded, as10.body.hours, as10.body.branchId],
      [10, 10, null, null, null],
    );
    assert.equal(as10.body.setMenuTemplateId, staged.menu10);
    const zone = as10.body.lineItems.find((l: { label: string }) => l.label === "Private Zone (guaranteed)");
    assert.equal(zone.fnbCredit, 300_000);
    assert.equal(as10.body.lineItems.filter((l: { label: string }) => l.label === "Private Zone (guaranteed)").length, 1);

    const zombie = (await call("GET", "/api/beo/entertainment-templates", { cookie: cookieC })).body.filter((t: { name: string }) => t.name === "Zombie game");
    assert.equal(zombie.length, 1);
    assert.equal(zombie[0].id, staged.zombie);
    assert.deepEqual(
      [zombie[0].ageRange, zombie[0].maxKids, zombie[0].extraChildPrice, zombie[0].unit, zombie[0].priceIsFrom, zombie[0].defaultPrice],
      ["6+", 10, 40_000, "session", false, 400_000],
    );
    assert.ok(!zombie[0].description.startsWith("Age 6+"), "the facts are fields now");
    assert.equal((await q("select 1 from entertainment_package_templates where tenant_id = $1", [C.tenant])).length, 19);

    const menus = (await call("GET", "/api/beo/set-menu-templates", { cookie: cookieC })).body as Array<{ id: string; name: string; items: unknown[] }>;
    assert.equal(menus.length, 3);
    const menu10 = menus.find((m) => m.id === staged.menu10)!;
    assert.deepEqual(menu10.items.slice(0, 1), [{ id: "item_as10_fries", type: "always_included", label: "French Fries", productCode: "CF-11", qty: 3 }]);
    assert.deepEqual(menu10.items.find((i) => (i as { id: string }).id === "item_as10_fish_chips"), {
      id: "item_as10_fish_chips", type: "always_included", label: "Fish & Chips", productCode: "CF-36", qty: 1,
      note: "Can be replaced with 2 portions of Chicken Schnitzel",
    });
    const skewers = menu10.items.find((i) => (i as { id: string }).id === "item_as10_fruit_skewers") as { productCode?: string };
    assert.equal(skewers.productCode, undefined, "no catalogue product: no code");
  });

  await check("a second run of the seed changes nothing", async () => {
    const before = await fingerprint();
    const { result } = await seed();
    assert.deepEqual(
      [result.created, result.updated, result.renamed, result.archived, result.removed],
      [0, 0, 0, 0, 0],
    );
    assert.ok(result.unchanged > 50);
    assert.equal(await fingerprint(), before);
  });

  console.log(`birthday-packages.check: ${checks} checks passed`);
} catch (err) {
  console.error("birthday-packages.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
