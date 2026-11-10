// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) and a
// stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built (0047 included).
//
// SCRUM-828 — a new menu item added from the BEO's food lines, the server's
// half (the form's is tests/party-menu-item-ui.check.ts):
//
//   - the platform is asked with this app's provisioning key as a Bearer and
//     the press's action id as the Idempotency-Key, never a session; it is
//     sent the party's platform branch, the name, the station, the price in
//     satang (null for a free / included / alternate item) and the BEO line;
//   - the line is written to the kitchen plan's list with the till's code, the
//     name kept, one of it, the price or "included"; a retry of the press is
//     the same line, never a second;
//   - a refusal — the platform's own, its key refused, the platform not
//     answering — is said in words and writes nothing; a staff role, another
//     park group's event, a park not linked to the till, a deployment without
//     the key and a form that does not read are refused before the platform
//     is asked;
//   - the BEO's own Save and read keep the line's code, and the till's plan
//     view (otoapp_v.event_packages, migration 0047) names it by its code.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/party-menu-item.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPartyMenuProduct } from "../server/lib/partyMenuItem";
import { partyMenuItemProblem, partyMenuLineOf, satangOfBaht } from "../shared/partyMenuItem";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("party-menu-item.check: DATABASE_URL is not set");
  process.exit(2);
}

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

// ─── The shared rules, on their own ──────────────────────────────────────────

await check("the form's rules: a name, and a price or the tick, never both; baht to satang; the line a new item becomes", () => {
  assert.equal(partyMenuItemProblem({ name: " ", price: 10, free: false }), "Give the item a name.");
  assert.equal(partyMenuItemProblem({ name: "Cake", price: null, free: false }), "Give the item a price, or tick free / included / alternate item.");
  assert.equal(partyMenuItemProblem({ name: "Cake", price: 0, free: false }), "Give the item a price, or tick free / included / alternate item.");
  assert.match(partyMenuItemProblem({ name: "Cake", price: 50, free: true }) ?? "", /has no price/);
  assert.equal(partyMenuItemProblem({ name: "Cake", price: null, free: true }), null);
  assert.equal(partyMenuItemProblem({ name: "Cake", price: 450.5, free: false }), null);
  assert.equal(satangOfBaht(450.5), 45_050);
  assert.equal(satangOfBaht(0.1 + 0.2), 30, "rounded to the satang");
  const actionId = randomUUID();
  assert.deepEqual(partyMenuLineOf({ actionId, menu: "kids", name: " Cake ", station: "bar", price: null, free: true }, "PARTY-1", true), {
    id: `party_${actionId}`, itemName: "Cake", quantity: 1, notes: "", included: true, price: 0, productCode: "PARTY-1", source: "additional",
  });
  assert.deepEqual(partyMenuLineOf({ actionId, menu: "adults", name: "Tea", station: "kitchen", price: 125, free: false }, "PARTY-2", false), {
    id: `party_${actionId}`, itemName: "Tea", quantity: 1, notes: "", included: false, price: 125, productCode: "PARTY-2",
  });
});

// ─── The stand-in platform ────────────────────────────────────────────────────

type Asked = { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
const asked: Asked[] = [];
const made = new Map<string, { productId: string; code: string }>();
type Reply = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
const succeed: Reply = (req, res) => {
  const key = String(req.headers["idempotency-key"] ?? "");
  const held = made.get(key);
  const product = held ?? { productId: randomUUID(), code: `PARTY-ZZ${made.size.toString(16).toUpperCase().padStart(6, "0")}` };
  made.set(key, product);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ...product, categoryId: "33333333-3333-4333-8333-333333333333", replayed: !!held }));
};
let reply: Reply = succeed;
const platform = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    asked.push({ url: req.url ?? "", headers: req.headers, body });
    reply(req, res, body);
  });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
const refuse = (status: number, code: string, message: string): Reply => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
};
const hangUp: Reply = (req) => { req.socket.destroy(); };

await check("the client: the key as a Bearer and the press as the Idempotency-Key, no session; the platform's answers and refusals read", async () => {
  const config = { apiUrl: PLATFORM_API_URL, key: "zz-828-key" };
  const actionId = randomUUID();
  const input = {
    actionId, branchId: randomUUID(), name: "ZZ TEST unicorn cake", station: "kitchen" as const, priceSatang: null, free: true,
    source: { eventId: randomUUID(), lineLabel: "ZZ TEST unicorn cake" },
  };
  const first = await createPartyMenuProduct(config, input, "req-828");
  assert.equal(first.ok, true);
  const sent = asked.at(-1)!;
  assert.equal(sent.url, "/otoapp/party-menu/products");
  assert.equal(sent.headers.authorization, "Bearer zz-828-key");
  assert.equal(sent.headers["idempotency-key"], actionId);
  assert.equal(sent.headers.cookie, undefined, "no platform session travels");
  assert.equal(sent.headers["x-request-id"], "req-828");
  const { actionId: _press, ...body } = input;
  assert.deepEqual(sent.body, body, "the press travels as the key, never in the body");
  const again = await createPartyMenuProduct(config, input);
  assert.ok(again.ok && first.ok && again.code === first.code && again.replayed, "the same press answers the same item");

  reply = refuse(409, "IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used with a different request");
  const refused = await createPartyMenuProduct(config, input);
  assert.deepEqual(refused, { ok: false, status: 409, code: "IDEMPOTENCY_MISMATCH", message: "Idempotency-Key was already used with a different request The line was not added." });
  reply = refuse(401, "OTOAPP_PROVISION_UNAUTHORIZED", "x");
  const keyRefused = await createPartyMenuProduct(config, input);
  assert.ok(!keyRefused.ok && keyRefused.status === 503 && /provisioning key/.test(keyRefused.message) && !keyRefused.message.includes("zz-828-key"));
  reply = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ productId: "x" })); };
  const unreadable = await createPartyMenuProduct(config, input);
  assert.ok(!unreadable.ok && unreadable.code === "PLATFORM_UNREADABLE");
  reply = hangUp;
  const gone = await createPartyMenuProduct(config, input);
  assert.ok(!gone.ok && gone.code === "PLATFORM_UNREACHABLE" && gone.status === 502);
  reply = succeed;
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

async function parkGroup(label: string, linked: boolean) {
  const tenant = randomUUID();
  const branch = randomUUID();
  const coreBranch = linked ? randomUUID() : null;
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-828-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)", [branch, tenant, `ZZ TEST ${label} park ${run}`, coreBranch]);
  return { tenant, branch, coreBranch };
}
async function user(g: { tenant: string }, role: string) {
  const id = randomUUID();
  const email = `zz-828-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
     values ($1, $2, $3, $4, $5, true, false, true)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [g.tenant, id]);
  return { id, email };
}
async function party(g: { tenant: string; branch: string }, title: string, withPackage = false) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
     values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming')`,
    [id, g.tenant, g.branch, `ZZ TEST BEO ${title} ${run}`],
  );
  if (withPackage) {
    await q("insert into beo_package_snapshots (id, event_id, package_name, base_price) values ($1, $2, 'ZZ TEST package', 1690000)", [randomUUID(), id]);
  }
  return id;
}

const A = await parkGroup("a", true);
const B = await parkGroup("b", true);
const unlinked = { ...(await parkGroup("unlinked", false)) };
const adminA = await user(A, "admin");
const managerA = await user(A, "manager");
const staffA = await user(A, "staff");
const adminU = await user(unlinked, "admin");
const partyA = await party(A, "a", true);
const partyB = await party(B, "b");
const partyU = await party(unlinked, "unlinked");
const kitchenOf = async (eventId: string) =>
  (await q<{ menus: Record<string, unknown> | null; simplified_menus: Record<string, unknown> | null }>(
    "select menus, simplified_menus from beo_kitchen_plans where event_id = $1",
    [eventId],
  ))[0] ?? null;

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
  return { status: res.status, body };
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
  const keyed = await serve({ OTOAPP_PROVISION_KEY: "zz-828-key" });
  const unkeyed = await serve({ OTOAPP_PROVISION_KEY: "" });
  const admin = await signIn(keyed, adminA.email);
  const manager = await signIn(keyed, managerA.email);
  const staff = await signIn(keyed, staffA.email);
  const add = (origin: string, cookie: string, eventId: string, over: Record<string, unknown> = {}) =>
    call(origin, "POST", `/api/events/${eventId}/beo/party-menu-items`, cookie, {
      actionId: randomUUID(), menu: "kids", name: "ZZ TEST unicorn cake", station: "kitchen", price: null, free: true, ...over,
    });

  let cake: { actionId: string; code: string } = { actionId: "", code: "" };

  await check("an admin adds a free kitchen item: the platform is asked with the key and the press, and the line is written with its code", async () => {
    const actionId = randomUUID();
    const before = asked.length;
    const res = await add(keyed, admin, partyA, { actionId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(asked.length, before + 1);
    const sent = asked.at(-1)!;
    assert.equal(sent.headers.authorization, "Bearer zz-828-key");
    assert.equal(sent.headers["idempotency-key"], actionId);
    assert.equal(sent.headers.cookie, undefined);
    assert.deepEqual(sent.body, {
      branchId: A.coreBranch, name: "ZZ TEST unicorn cake", station: "kitchen", priceSatang: null, free: true,
      source: { eventId: partyA, lineLabel: "ZZ TEST unicorn cake" },
    });
    const line = { id: `party_${actionId}`, itemName: "ZZ TEST unicorn cake", quantity: 1, notes: "", included: true, price: 0, productCode: res.body.productCode };
    assert.match(res.body.productCode, /^PARTY-ZZ/);
    assert.deepEqual(res.body.line, line);
    assert.equal(res.body.replayed, false);
    const plan = await kitchenOf(partyA);
    assert.deepEqual(plan?.menus?.kids, [line], "a kitchen plan made for it, the line in the kids' list");
    assert.deepEqual(plan?.simplified_menus?.kids, [line]);
    cake = { actionId, code: res.body.productCode };
  });

  await check("a manager adds a priced bar item to the adults' list: satang to the platform, baht on the line", async () => {
    const res = await add(keyed, manager, partyA, { menu: "adults", name: "ZZ TEST bubble tea", station: "bar", price: 450.5, free: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(asked.at(-1)!.body.priceSatang, 45_050);
    assert.equal(asked.at(-1)!.body.station, "bar");
    assert.deepEqual(res.body.line, {
      id: res.body.line.id, itemName: "ZZ TEST bubble tea", quantity: 1, notes: "", included: false, price: 450.5, productCode: res.body.productCode,
    });
    const plan = await kitchenOf(partyA);
    assert.equal((plan?.menus?.kids as unknown[]).length, 1, "the kids' list as it was");
    assert.deepEqual(plan?.menus?.adults, [res.body.line]);
  });

  await check("the same press again is the same item and the same line, never a second", async () => {
    const res = await add(keyed, admin, partyA, { actionId: cake.actionId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.replayed, true);
    assert.equal(res.body.productCode, cake.code);
    const kids = (await kitchenOf(partyA))?.menus?.kids as Array<{ id: string }>;
    assert.deepEqual(kids.map((l) => l.id), [`party_${cake.actionId}`]);
  });

  await check("a refusal is said in words and writes nothing: the platform's own, its key refused, no answer at all", async () => {
    const before = JSON.stringify(await kitchenOf(partyA));
    reply = refuse(409, "PARTY_MENU_CODE_TAKEN", "Every code this item could take is already on another product.");
    const taken = await add(keyed, admin, partyA, { name: "ZZ TEST refused" });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.message, "Every code this item could take is already on another product. The line was not added.");
    reply = refuse(401, "OTOAPP_PROVISION_UNAUTHORIZED", "This request does not carry a provisioning key this platform accepts");
    const key = await add(keyed, admin, partyA, { name: "ZZ TEST refused" });
    assert.equal(key.status, 503);
    assert.match(key.body.message, /provisioning key/);
    reply = hangUp;
    const gone = await add(keyed, admin, partyA, { name: "ZZ TEST refused" });
    assert.equal(gone.status, 502);
    assert.equal(gone.body.code, "PLATFORM_UNREACHABLE");
    reply = succeed;
    assert.equal(JSON.stringify(await kitchenOf(partyA)), before, "the kitchen plan as it was");
  });

  await check("refused before the platform is asked: staff, another park group's party, a park not linked, no key here, a form that does not read", async () => {
    const before = asked.length;
    assert.equal((await add(keyed, staff, partyA)).status, 403, "staff cannot create a BEO, so cannot add to one");
    assert.equal((await add(keyed, admin, partyB)).status, 404, "another park group's party is not found");
    const otherAdmin = await signIn(keyed, adminU.email);
    const notLinked = await add(keyed, otherAdmin, partyU);
    assert.equal(notLinked.status, 409);
    assert.equal(notLinked.body.code, "PARK_NOT_LINKED");
    const none = await add(unkeyed, await signIn(unkeyed, adminA.email), partyA);
    assert.equal(none.status, 503);
    assert.match(none.body.message, /OTOAPP_PROVISION_KEY/);
    for (const bad of [
      { free: true, price: 50 },
      { free: false, price: null },
      { name: "   " },
      { actionId: "not-a-uuid" },
      { station: "none" },
      { menu: "bar" },
    ]) {
      const res = await add(keyed, admin, partyA, bad);
      assert.equal(res.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
      assert.ok(typeof res.body.message === "string" && res.body.message.length > 0);
    }
    assert.equal(asked.length, before, "the platform was never asked");
    assert.equal((await kitchenOf(partyB)), null);
    assert.equal((await kitchenOf(partyU)), null);
  });

  await check("the BEO's own Save and read keep the line's code", async () => {
    const shown = await call(keyed, "GET", `/api/events/${partyA}/beo`, admin);
    assert.equal(shown.status, 200);
    const kids = shown.body.kitchenPlan.menus.kids as Array<Record<string, unknown>>;
    assert.equal(kids[0]!.productCode, cake.code);
    // The editor's Save sends the lists back as it holds them, quantity changed.
    const saved = await call(keyed, "PUT", `/api/events/${partyA}/beo`, admin, {
      kitchenPlan: {
        foodRequired: true,
        cakeMode: "NONE",
        setMenuEnabled: false,
        setMenuTemplateId: null,
        menus: { kids: [{ ...kids[0], quantity: 3 }], adults: shown.body.kitchenPlan.menus.adults, kidsFoodTime: "14:00", adultsFoodTime: "" },
        serviceSchedule: [],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const again = await kitchenOf(partyA);
    assert.deepEqual((again?.menus?.kids as Array<Record<string, unknown>>)[0], { ...kids[0], quantity: 3 });
  });

  await check("the till's plan view names the new items by their codes, after the set menu's own lines, kids before adults", async () => {
    const [row] = await q<{ set_menu: unknown[] }>("select set_menu from otoapp_v.event_packages where event_id = $1", [partyA]);
    const adults = ((await kitchenOf(partyA))?.menus?.adults as Array<{ productCode: string }>)[0]!;
    assert.deepEqual(row?.set_menu, [
      { product_code: cake.code, name: "ZZ TEST unicorn cake", qty: 3, choice_group: null, chosen_option: null, note: null },
      { product_code: adults.productCode, name: "ZZ TEST bubble tea", qty: 1, choice_group: null, chosen_option: null, note: null },
    ]);
  });

  console.log(`party-menu-item.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
process.exit(checks === 9 ? 0 : 1);
