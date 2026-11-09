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
//      choices give the kitchen plan the set menu's portions.
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

  console.log(`birthday-packages.check: ${checks} checks passed`);
} catch (err) {
  console.error("birthday-packages.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
