// seed: its own — three park groups of ZZ TEST rows, made here. Not a
// Playwright file. Boots the app's real routes (tests/harness/serve-routes.ts)
// and a stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built (0048 included).
//
// SCRUM-905 — the till's menu inside the BEO, the server's half (the screens'
// is tests/till-menu-ui.check.ts):
//
//   - the shared rules: one index over the parks' menus; a code is "dead" only
//     once a menu was read; a pick writes the till's name and code, and an
//     EXTRA's price (a set-menu line keeps its own); "Not from the till" drops
//     only the code;
//   - the client: the platform asked with this app's provisioning key as a
//     Bearer, never a session, for the park's platform branch; one park's
//     answer held a minute and asked once while in flight, a refusal never
//     held; every refusal said in words;
//   - the route: one park (the party's) or every park of the caller's park
//     group they may open, with a status per park (the till's items, a park
//     not linked, a deployment without the key, a till not answering); a
//     staff role, another park group's park and a park that is no uuid
//     refused before the platform is asked; nothing written to the app's
//     tables;
//   - a picked line keeps its code through the BEO's Save — a bar line too —
//     and the till's plan view names a picked kitchen line by its code;
//   - a set menu the parent chose through the link: a dish the template
//     resolved takes no pick (its code is the template's), so the till's
//     plan view names each set-menu dish once and keeps the parent's choice;
//     a line added on the set menu block and an EXTRA, picked, reach it once.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/till-menu.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { TILL_MENU_CACHE_MS, forgetTillMenus, readTillMenu } from "../server/lib/tillMenu";
import {
  bahtOfSatang,
  isTemplateSetMenuLine,
  lineWithTillItem,
  lineWithoutTillItem,
  tillCodeState,
  tillMenuIndexOf,
  type TillMenuItem,
  type TillMenuPark,
} from "../shared/tillMenu";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("till-menu.check: DATABASE_URL is not set");
  process.exit(2);
}

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const PIZZA: TillMenuItem = { code: "CF-24", name: "Margherita", category: "Pizza", parentCategory: "Food", station: "kitchen", priceSatang: 29_000, priceWeekendSatang: 29_000, beoOnly: false };
const JUICE: TillMenuItem = { code: "CF-66-1", name: "Kids juice Apple", category: "Juice", parentCategory: "Drinks", station: "bar", priceSatang: 9_050, priceWeekendSatang: 9_050, beoOnly: false };
const CAKE: TillMenuItem = { code: "PARTY-3F9A21C4", name: "ZZ TEST unicorn cake", category: "Party menu", parentCategory: null, station: "kitchen", priceSatang: 0, priceWeekendSatang: 0, beoOnly: true };
const park = (over: Partial<TillMenuPark>): TillMenuPark => ({ parkId: randomUUID(), parkName: "ZZ park", status: "ok", message: null, items: [], readAt: null, ...over });

// ─── The shared rules, on their own ──────────────────────────────────────────

await check("one index over the parks' menus; a code is dead only once a menu was read", () => {
  const none = tillMenuIndexOf(null);
  assert.equal(none.known, false);
  assert.equal(tillCodeState(none, "CF-24"), "unknown", "no menu: nothing is called dead");
  const unread = tillMenuIndexOf([park({ status: "not_reachable", message: "The till did not answer." })]);
  assert.equal(unread.known, false);
  assert.equal(tillCodeState(unread, "CF-99"), "unknown", "a till that does not answer marks nothing");
  const index = tillMenuIndexOf([park({ items: [PIZZA, CAKE] }), park({ status: "not_linked" }), park({ items: [JUICE, { ...PIZZA, name: "other park's name" }] })]);
  assert.equal(index.known, true);
  assert.deepEqual(index.items.map((i) => i.code), ["CF-24", "PARTY-3F9A21C4", "CF-66-1"], "a code at two parks is one item");
  assert.equal(index.byCode.get("CF-24")?.name, "Margherita", "the first park's reading kept");
  assert.equal(tillCodeState(index, "CF-24"), "live");
  assert.equal(tillCodeState(index, " CF-66-1 "), "live");
  assert.equal(tillCodeState(index, "CF-99"), "dead");
  assert.equal(tillCodeState(index, ""), "unknown");
  assert.equal(tillCodeState(index, undefined), "unknown");
});

await check("a pick writes the till's name and code; an EXTRA takes the till's price in baht, a set-menu line keeps its own; un-picking drops only the code", () => {
  assert.equal(bahtOfSatang(9_050), 90.5);
  const extra = { id: "m1", itemName: "pizza", quantity: 6, notes: "no basil", included: false, price: 0 };
  assert.deepEqual(lineWithTillItem(extra, PIZZA), { ...extra, itemName: "Margherita", productCode: "CF-24", price: 290 });
  const firstLine = { id: "m2", itemName: "", quantity: 1, notes: "", included: true, price: 0, source: "additional" };
  assert.deepEqual(lineWithTillItem(firstLine, JUICE), { ...firstLine, itemName: "Kids juice Apple", productCode: "CF-66-1", price: 90.5 }, "an EXTRA by its badge");
  const setLine = { id: "m3", itemName: "Pizza", quantity: 1, notes: "", included: true, price: 0, source: "set_menu" };
  assert.deepEqual(lineWithTillItem(setLine, PIZZA), { ...setLine, itemName: "Margherita", productCode: "CF-24" }, "part of the package: no price");
  const picked = lineWithTillItem(extra, PIZZA);
  assert.deepEqual(lineWithoutTillItem(picked), { ...extra, itemName: "Margherita", price: 290 }, "the name and the price stay, the code goes");
  assert.equal("productCode" in lineWithoutTillItem(picked), false);
});

await check("a set-menu dish the template resolved takes no pick: its code is the template's; a line added on the set menu block does", () => {
  const chosen = { id: "set_g2_Veggie", itemName: "Veggie", quantity: 10, notes: "(Fried rice)", included: true, price: 0, source: "set_menu", groupId: "g2" };
  assert.equal(isTemplateSetMenuLine(chosen), true);
  assert.equal(lineWithTillItem(chosen, PIZZA), chosen, "the parent's choice as it was: no name, no code");
  const always = { id: "set_g1", itemName: "Veggie sticks", quantity: 10, notes: "", included: true, price: 0, source: "set_menu", groupId: "g1" };
  assert.equal(lineWithTillItem(always, PIZZA), always);
  const added = { id: "menu_1", itemName: "", quantity: 2, notes: "", included: true, price: 0, source: "set_menu" };
  assert.equal(isTemplateSetMenuLine(added), false, "+ Add item: no groupId");
  assert.equal(isTemplateSetMenuLine({ ...added, groupId: "" }), false);
  assert.equal(isTemplateSetMenuLine({ source: "additional", groupId: "g1" }), false, "an EXTRA is never the template's");
  assert.deepEqual(lineWithTillItem(added, PIZZA), { ...added, itemName: "Margherita", productCode: "CF-24" });
});

// ─── The stand-in platform ────────────────────────────────────────────────────

type Asked = { method: string; url: string; headers: IncomingMessage["headers"] };
const asked: Asked[] = [];
type Reply = (req: IncomingMessage, res: ServerResponse) => void;
const menuOf = (branchId: string) => ({ branchId, items: [PIZZA, JUICE, CAKE] });
const succeed: Reply = (req, res) => {
  const branchId = new URL(req.url ?? "/", "http://x").searchParams.get("branchId") ?? "";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(menuOf(branchId)));
};
let reply: Reply = succeed;
/** Per platform branch, when a test wants one park's till to behave otherwise. */
const replyFor = new Map<string, Reply>();
const platform = createServer((req, res) => {
  asked.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
  const branchId = new URL(req.url ?? "/", "http://x").searchParams.get("branchId") ?? "";
  (replyFor.get(branchId) ?? reply)(req, res);
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
const refuse = (status: number, code: string, message: string): Reply => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
};
const hangUp: Reply = (req) => { req.socket.destroy(); };

await check("the client: the key as a Bearer, no session, the park's platform branch; the till's items read", async () => {
  forgetTillMenus();
  const config = { apiUrl: PLATFORM_API_URL, key: "zz-905-key" };
  const branchId = randomUUID();
  const read = await readTillMenu(config, branchId.toUpperCase(), "req-905");
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual(read.items, [PIZZA, JUICE, CAKE]);
  const sent = asked.at(-1)!;
  assert.equal(sent.method, "GET");
  assert.equal(sent.url, `/otoapp/party-menu/catalogue?branchId=${branchId}`, "the branch as the till spells it");
  assert.equal(sent.headers.authorization, "Bearer zz-905-key");
  assert.equal(sent.headers.cookie, undefined, "no platform session travels");
  assert.equal(sent.headers["x-request-id"], "req-905");
});

await check("a minute in memory: one park's answer held 60 s, asked once while in flight; another park asked on its own", async () => {
  forgetTillMenus();
  const config = { apiUrl: PLATFORM_API_URL, key: "zz-905-key" };
  const branchId = randomUUID();
  let clock = 1_000_000;
  const now = () => clock;
  const before = asked.length;
  const [a, b] = await Promise.all([readTillMenu(config, branchId, undefined, now), readTillMenu(config, branchId, undefined, now)]);
  assert.ok(a.ok && b.ok);
  assert.equal(asked.length, before + 1, "two screens at once: one ask");
  clock += TILL_MENU_CACHE_MS - 1;
  assert.ok((await readTillMenu(config, branchId, undefined, now)).ok);
  assert.equal(asked.length, before + 1, "within the minute: the held answer");
  await readTillMenu(config, randomUUID(), undefined, now);
  assert.equal(asked.length, before + 2, "another park is its own answer");
  clock += 2;
  assert.ok((await readTillMenu(config, branchId, undefined, now)).ok);
  assert.equal(asked.length, before + 3, "after the minute: asked again");
  assert.equal(TILL_MENU_CACHE_MS, 60_000);
});

await check("a refusal is said in words and never held: its key refused, a park it does not know, no answer, an answer it cannot read", async () => {
  forgetTillMenus();
  const config = { apiUrl: PLATFORM_API_URL, key: "zz-905-key" };
  const branchId = randomUUID();
  reply = refuse(401, "OTOAPP_PROVISION_UNAUTHORIZED", "x");
  const key = await readTillMenu(config, branchId);
  assert.ok(!key.ok && key.status === 503 && /provisioning key/.test(key.message) && !key.message.includes("zz-905-key"));
  reply = refuse(404, "NOT_FOUND", "Branch not found");
  const unknown = await readTillMenu(config, branchId);
  assert.ok(!unknown.ok && unknown.status === 404 && /does not know this park/.test(unknown.message));
  reply = refuse(500, "INTERNAL", "Something broke at the till");
  const broke = await readTillMenu(config, branchId);
  assert.ok(!broke.ok && broke.status === 502 && broke.message === "Something broke at the till");
  reply = hangUp;
  const gone = await readTillMenu(config, branchId);
  assert.ok(!gone.ok && gone.code === "PLATFORM_UNREACHABLE" && gone.status === 502);
  reply = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ items: [{ code: "" }] })); };
  const unreadable = await readTillMenu(config, branchId);
  assert.ok(!unreadable.ok && unreadable.code === "PLATFORM_UNREADABLE");
  reply = succeed;
  const before = asked.length;
  assert.ok((await readTillMenu(config, branchId)).ok, "the till answering again is asked again");
  assert.equal(asked.length, before + 1);
  forgetTillMenus();
});

// ─── Rows ─────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

async function parkGroup(label: string) {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-905-${label}-${run}`]);
  return tenant;
}
async function parkOf(tenant: string, name: string, linked: boolean) {
  const id = randomUUID();
  const coreBranch = linked ? randomUUID() : null;
  await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)", [id, tenant, `ZZ TEST ${name} ${run}`, coreBranch]);
  return { id, coreBranch, name: `ZZ TEST ${name} ${run}` };
}
async function user(tenant: string, role: string) {
  const id = randomUUID();
  const email = `zz-905-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
     values ($1, $2, $3, $4, $5, true, false, true)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  return { id, email };
}
async function party(tenant: string, branch: string) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
     values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming')`,
    [id, tenant, branch, `ZZ TEST BEO 905 ${run}`],
  );
  await q("insert into beo_package_snapshots (id, event_id, package_name, base_price) values ($1, $2, 'ZZ TEST package', 1690000)", [randomUUID(), id]);
  return id;
}

const A = await parkGroup("a");
const floresta = await parkOf(A, "Floresta", true);
const headOffice = await parkOf(A, "Head office", false);
const B = await parkGroup("b");
const theirs = await parkOf(B, "Their park", true);
const C = await parkGroup("c");
const silent = await parkOf(C, "Silent park", true);
const managerA = await user(A, "manager");
const staffA = await user(A, "staff");
const adminC = await user(C, "admin");
const partyA = await party(A, floresta.id);
const partySet = await party(A, floresta.id);
const SET_MENU_ID = randomUUID();
await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, $3, $4)", [
  SET_MENU_ID, A, `ZZ TEST 905 set menu ${run}`,
  JSON.stringify([
    { id: "zz905-veg", type: "always_included", label: "Veggie sticks", qty: 10, productCode: "CF-12" },
    { id: "zz905-pizza", type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-25" } },
  ]),
]);

// ─── The app ──────────────────────────────────────────────────────────────────

const SESSION_SECRET = randomBytes(24).toString("hex");
const children: ChildProcess[] = [];
async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "dev",
      DEPLOY_ENV: "local",
      OTOAPP_JOBS: "inprocess",
      STORAGE_ENV_PREFIX: "zz-test",
      OBJECT_STORAGE: "local",
      LOG_LEVEL: "warn",
      TZ: "UTC",
      USE_AWS_REKOGNITION: "false",
      OTOAPP_LEGACY_LOGIN: "true",
      SESSION_SECRET,
      PLATFORM_API_URL,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
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

const call = async (origin: string, method: string, path: string, cookie: string, payload?: unknown) => {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body, cacheControl: res.headers.get("cache-control") };
};
const signIn = async (origin: string, email: string) => {
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status}`);
  return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

try {
  const keyed = await serve({ OTOAPP_PROVISION_KEY: "zz-905-key" });
  const unkeyed = await serve({ OTOAPP_PROVISION_KEY: "" });
  const manager = await signIn(keyed, managerA.email);
  const staff = await signIn(keyed, staffA.email);
  const menu = (origin: string, cookie: string, parkId?: string) =>
    call(origin, "GET", parkId === undefined ? "/api/beo/till-menu" : `/api/beo/till-menu?parkId=${encodeURIComponent(parkId)}`, cookie);

  await check("the party's park: the till's items, asked with the key for the park's platform branch, and held a minute", async () => {
    const before = asked.length;
    const res = await menu(keyed, manager, floresta.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.cacheControl, "private, no-store");
    assert.equal(res.body.parks.length, 1);
    const [one] = res.body.parks;
    assert.deepEqual({ ...one, readAt: typeof one.readAt }, {
      parkId: floresta.id, parkName: floresta.name, status: "ok", message: null, items: [PIZZA, JUICE, CAKE], readAt: "string",
    });
    assert.equal(asked.length, before + 1);
    const sent = asked.at(-1)!;
    assert.equal(sent.url, `/otoapp/party-menu/catalogue?branchId=${floresta.coreBranch}`);
    assert.equal(sent.headers.authorization, "Bearer zz-905-key");
    assert.equal(sent.headers.cookie, undefined, "the person's session never travels to the platform");
    assert.equal((await menu(keyed, manager, floresta.id)).status, 200);
    assert.equal(asked.length, before + 1, "the second screen within the minute: the held answer");
  });

  await check("no park named: every park of the caller's park group, a park not linked said so, never another park group's", async () => {
    const res = await menu(keyed, manager);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byId = new Map<string, TillMenuPark>(res.body.parks.map((p: TillMenuPark) => [p.parkId, p]));
    assert.deepEqual([...byId.keys()].sort(), [floresta.id, headOffice.id].sort());
    assert.equal(byId.get(floresta.id)?.status, "ok");
    assert.deepEqual(byId.get(headOffice.id), {
      parkId: headOffice.id, parkName: headOffice.name, status: "not_linked",
      message: "This park is not linked to the till yet, so the till's menu cannot be offered. Type the item instead.", items: [], readAt: null,
    });
    assert.equal(byId.has(theirs.id), false);
  });

  await check("refused before the platform is asked: no sign-in, a staff role, another park group's park, a park that is no uuid", async () => {
    const before = asked.length;
    assert.equal((await menu(keyed, "", floresta.id)).status, 401);
    assert.equal((await menu(keyed, staff, floresta.id)).status, 403, "a role that cannot edit a BEO");
    const other = await menu(keyed, manager, theirs.id);
    assert.equal(other.status, 404);
    assert.equal(other.body.message, "Park not found");
    assert.equal((await menu(keyed, manager, "not-a-uuid")).status, 404);
    assert.equal((await menu(keyed, manager, "")).status, 404);
    assert.equal(asked.length, before, "the platform was never asked");
  });

  await check("a deployment without the key says so and asks nothing; a till that does not answer is said and asked again next time", async () => {
    const before = asked.length;
    const none = await menu(unkeyed, await signIn(unkeyed, managerA.email), floresta.id);
    assert.equal(none.status, 200);
    assert.equal(none.body.parks[0].status, "unconfigured");
    assert.match(none.body.parks[0].message, /OTOAPP_PROVISION_KEY/);
    assert.deepEqual(none.body.parks[0].items, []);
    assert.equal(asked.length, before);

    const admin = await signIn(keyed, adminC.email);
    replyFor.set(silent.coreBranch!, hangUp);
    const quiet = await menu(keyed, admin, silent.id);
    assert.equal(quiet.status, 200);
    assert.equal(quiet.body.parks[0].status, "not_reachable");
    assert.match(quiet.body.parks[0].message, /did not answer/);
    assert.deepEqual(quiet.body.parks[0].items, []);
    replyFor.delete(silent.coreBranch!);
    const back = await menu(keyed, admin, silent.id);
    assert.equal(back.body.parks[0].status, "ok", "a silence is never held");
  });

  await check("nothing of the till's menu is written here: the door and its client hold no database write", () => {
    for (const file of ["server/till-menu-routes.ts", "server/lib/tillMenu.ts"]) {
      const src = readFileSync(join(APP_DIR, file), "utf8");
      assert.doesNotMatch(src, /\bdb\.(insert|update|delete|execute|transaction)\(|\btx\./, `${file} writes nothing`);
    }
  });

  await check("a picked line keeps its code through the BEO's Save and read — a bar line too — and the till's plan view names the kitchen line by it", async () => {
    const kids = [lineWithTillItem({ id: "menu_905_1", itemName: "pizza", quantity: 6, notes: "", included: false, price: 0 }, PIZZA)];
    const bar = [lineWithTillItem({ id: "bar_905_1", itemName: "juice", quantity: 10, notes: "", included: false, price: 0 }, JUICE)];
    const saved = await call(keyed, "PUT", `/api/events/${partyA}/beo`, manager, {
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null,
        menus: { kids, adults: [], adultsDiffer: false, kidsFoodTime: "14:00", adultsFoodTime: "" }, serviceSchedule: [],
      },
      barPlan: { serviceTime: "14:00", items: bar },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const shown = await call(keyed, "GET", `/api/events/${partyA}/beo`, manager);
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.body.kitchenPlan.menus.kids, [{ id: "menu_905_1", itemName: "Margherita", quantity: 6, notes: "", included: false, price: 290, productCode: "CF-24" }]);
    assert.deepEqual(shown.body.barPlan.items, [{ id: "bar_905_1", itemName: "Kids juice Apple", quantity: 10, notes: "", included: false, price: 90.5, productCode: "CF-66-1" }]);
    const [row] = await q<{ set_menu: Array<Record<string, unknown>> }>("select set_menu from otoapp_v.event_packages where event_id = $1", [partyA]);
    assert.ok(
      row?.set_menu.some((l) => l.product_code === "CF-24" && l.name === "Margherita" && l.qty === 6),
      `the till's plan names the picked dish by its code: ${JSON.stringify(row?.set_menu)}`,
    );
  });

  await check("a set menu the parent chose: its dishes reach the till's plan once, the choice kept; an added line and an EXTRA, picked, once each", async () => {
    // The editor's Save sends the parent's submit time it read (setMenuSelectionSubmittedAt),
    // as here; without it the server keeps its own set-menu lines over the staff's.
    const setPlan = (kids: unknown[], setMenuSelectionSubmittedAt: string | null = null) => ({
      foodRequired: true, cakeMode: "NONE", setMenuEnabled: true, setMenuTemplateId: SET_MENU_ID, setMenuSelectionSubmittedAt,
      menus: { kids, adults: [], adultsDiffer: false, kidsFoodTime: "14:00", adultsFoodTime: "" }, serviceSchedule: [],
    });
    assert.equal((await call(keyed, "PUT", `/api/events/${partySet}/beo`, manager, { kitchenPlan: setPlan([]) })).status, 200);
    const link = await call(keyed, "POST", "/api/beo/set-menu-selections", manager, { eventId: partySet, templateId: SET_MENU_ID });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    const submitted = await fetch(`${keyed}/api/beo/set-menu-selections/public/${link.body.token}/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selections: [{ groupId: "zz905-pizza", chosenOptions: ["Margherita"] }] }),
    });
    assert.equal(submitted.status, 200, await submitted.text());
    const viewOf = async () =>
      (await q<{ set_menu: Array<Record<string, unknown>> }>("select set_menu from otoapp_v.event_packages where event_id = $1", [partySet]))[0]?.set_menu ?? [];
    const before = await viewOf();
    assert.deepEqual(before.map((l) => [l.product_code, l.name, l.chosen_option]), [["CF-12", "Veggie sticks", null], ["CF-24", "Pizza", "Margherita"]],
      "before any pick: the template's dishes, each once, by the template's codes");
    type Kid = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; groupId?: string; productCode?: string };
    const opened = (await call(keyed, "GET", `/api/events/${partySet}/beo`, manager)).body.kitchenPlan;
    const submittedAt = opened.setMenuSelectionStatus?.submittedAt as string;
    assert.equal(typeof submittedAt, "string", "the BEO names the parent's submit");
    const resolved = opened.menus.kids as Kid[];
    assert.deepEqual(resolved.map((l) => [l.itemName, l.source, l.groupId, l.productCode ?? null]), [
      ["Veggie sticks", "set_menu", "zz905-veg", null], ["Margherita", "set_menu", "zz905-pizza", null],
    ], "the parent's submit wrote the template's dishes, with no code");

    // The screen: a pick tried on every line keeps the template's dishes as they were; one line is
    // added on the set menu block and one EXTRA, each picked from the till's menu.
    const GARLIC: TillMenuItem = { code: "CF-31", name: "Garlic bread", category: "Sides", parentCategory: "Food", station: "kitchen", priceSatang: 9_000, priceWeekendSatang: 9_000, beoOnly: false };
    const kids: Kid[] = [
      ...resolved.map((l) => lineWithTillItem(l, PIZZA)),
      lineWithTillItem<Kid>({ id: "menu_905_add", itemName: "", quantity: 2, notes: "", included: true, price: 0, source: "set_menu" }, GARLIC),
      lineWithTillItem<Kid>({ id: "menu_905_extra", itemName: "juice", quantity: 10, notes: "", included: false, price: 0, source: "additional" }, JUICE),
    ];
    assert.deepEqual(kids.slice(0, 2), resolved, "no pick on a dish the template resolved");
    assert.equal((await call(keyed, "PUT", `/api/events/${partySet}/beo`, manager, { kitchenPlan: setPlan(kids, submittedAt) })).status, 200);

    const shown = (await call(keyed, "GET", `/api/events/${partySet}/beo`, manager)).body.kitchenPlan.menus.kids as Kid[];
    assert.deepEqual(shown.map((l) => [l.itemName, l.notes, l.productCode ?? null, l.price]), [
      ["Veggie sticks", "", null, 0], ["Margherita", "(Pizza)", null, 0], ["Garlic bread", "", "CF-31", 0], ["Kids juice Apple", "", "CF-66-1", 90.5],
    ], "the parent's choice keeps its name on the BEO");
    const after = await viewOf();
    assert.deepEqual(after.slice(0, before.length), before, "the template's dishes as before the picks");
    const codesOf = (code: string) => after.filter((l) => l.product_code === code).length;
    assert.equal(codesOf("CF-12"), 1, `the veggie sticks once: ${JSON.stringify(after)}`);
    assert.equal(codesOf("CF-24"), 1, `the pizza once: ${JSON.stringify(after)}`);
    assert.equal(after.filter((l) => l.name === "Margherita" || l.name === "Veggie sticks").length, 1, "no second line for a set-menu dish");
    assert.equal(after.find((l) => l.product_code === "CF-24")?.chosen_option, "Margherita", "the parent's choice kept");
    assert.deepEqual(after.slice(before.length).map((l) => [l.product_code, l.name, l.qty]), [["CF-31", "Garlic bread", 2], ["CF-66-1", "Kids juice Apple", 10]]);
  });

  console.log(`till-menu.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
process.exit(checks === 13 ? 0 : 1);
