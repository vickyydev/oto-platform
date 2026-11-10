// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) and a
// stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built. Renders the Quote PDF with Chromium, as the app's image
// does: PUPPETEER_EXECUTABLE_PATH names it, or a usual install path is found.
//
// SCRUM-822 — a party's money in the BEO, read from the till; the server's
// half (the screens' is tests/till-billing-ui.check.ts):
//
//   - the money rules on their own: satang shown as baht one way only
//     (฿16,900 for 1,690,000 satang: SCRUM-833), the three figures the screens
//     show taken from the till's quote or sale and from nothing else, and the
//     words when there are none ("Till not reachable");
//   - the client asks the platform with this app's provisioning key as a
//     Bearer, never a session, and reads its answers and its refusals;
//   - GET /api/events/:eventId/beo/till-billing answers the till's figures for
//     a linked party, and says why not otherwise (the platform not answering,
//     the park not linked, this deployment without the key) — never a figure
//     of its own; another park group's party is not found; an event the till
//     never settles (a camp, a workshop) answers "not_a_party" without asking
//     the platform, and every screen and the BEO PDF say "Not settled at the
//     till", never "Till not reachable";
//   - the Quote PDF's content is the till's quote line by line, the deposit,
//     the balance and a validity note under the park's name; the PDF is made
//     for a party with a quote, refused for one settled, one the till cannot
//     price, or when the till is not reachable;
//   - the BEO PDF's POS section prints the till's total, deposit and
//     outstanding, never Party Details' typed base price and extras added up,
//     and "Till not reachable" with no figure without the till; the PDF route
//     asks the till when it is made and still prints without it;
//   - the billing module's Deposit Paid against the real billing route: the
//     party's writes run in one queue, so 300, 3000, 300, 3000 sent together
//     end at ฿3,000 (sent all at once they could end at ฿300); clearing the
//     field and retyping is one write and keeps the deposit's day.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/till-billing.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  NOT_SETTLED_AT_THE_TILL,
  TILL_NOT_REACHABLE,
  TillBillingSchema,
  bahtOfSatang,
  isTillPartyEventType,
  tillFiguresOf,
  tillProblemOf,
  type TillBillingReading,
} from "../shared/tillBilling";
import { noQuoteAnswer, quoteAnswer, saleAnswer } from "./fixtures/till-billing";

// The Quote PDF's module loads the app's PDF facility, which reads the app's environment.
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-822";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.LOG_LEVEL ??= "warn";
const { QUOTE_VALIDITY_NOTE, partyQuoteContent, quoteDayOf } = await import("../server/lib/partyQuote");
const { beoPdfHtml } = await import("../server/pdf");
const { readTillBilling } = await import("../server/lib/tillBilling");
const { DepositBuffer, beoBillingMutationScope } = await import("../client/src/lib/beo-deposit-buffer");
const { MutationObserver, QueryClient } = await import("@tanstack/react-query");

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("till-billing.check: DATABASE_URL is not set");
  process.exit(2);
}
const CHROMIUM = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p): p is string => !!p && existsSync(p));
if (!CHROMIUM) {
  console.error("till-billing.check: no Chromium to render the Quote PDF with — set PUPPETEER_EXECUTABLE_PATH (the app's image has /usr/bin/chromium)");
  process.exit(2);
}

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};
const ok = (billing: unknown): TillBillingReading => ({ status: "ok", billing: TillBillingSchema.parse(billing), readAt: "2026-11-10T08:00:00.000Z" });

// ─── The money rules, on their own ────────────────────────────────────────────

await check("satang in baht, one way: ฿16,900 for 1,690,000 satang, never ฿1,690,000 (SCRUM-833); cents only when there are some", () => {
  assert.equal(bahtOfSatang(1_690_000), "฿16,900");
  assert.equal(bahtOfSatang(1_702_500), "฿17,025");
  assert.equal(bahtOfSatang(12_550), "฿125.50");
  assert.equal(bahtOfSatang(5), "฿0.05");
  assert.equal(bahtOfSatang(0), "฿0");
  assert.equal(bahtOfSatang(-300_000), "-฿3,000");
  assert.equal(bahtOfSatang(123_456_789_00), "฿123,456,789");
});

await check("the three figures are the till's: the quote's total, deposit and balance; the sale's gross, deposit and outstanding", () => {
  const quote = tillFiguresOf(ok(quoteAnswer(randomUUID())))!;
  assert.deepEqual(
    [quote.kind, quote.expectedSatang, quote.depositSatang, quote.outstandingSatang, quote.packageSatang, quote.packageName],
    ["quote", 1_702_500, 300_000, 1_402_500, 1_690_000, "ZZ TEST Floresta Birthday"],
  );
  assert.equal(quote.lines.length, 7);
  const sale = tillFiguresOf(ok(saleAnswer(randomUUID())))!;
  assert.deepEqual(
    [sale.kind, sale.expectedSatang, sale.depositSatang, sale.outstandingSatang, sale.packageSatang, sale.receiptNumber, sale.saleState],
    ["sale", 1_702_500, 300_000, 0, 1_690_000, "T1-000822", "settled"],
  );
});

await check("no figures without the till: not reachable, not linked, no key, a party it cannot price — each said, none a number", () => {
  for (const status of ["not_reachable", "not_linked", "unconfigured"] as const) {
    const reading: TillBillingReading = { status, message: `ZZ ${status}` };
    assert.equal(tillFiguresOf(reading), null);
    assert.deepEqual(tillProblemOf(reading), { headline: TILL_NOT_REACHABLE, detail: `ZZ ${status}` });
  }
  const none = ok(noQuoteAnswer(randomUUID()));
  assert.equal(tillFiguresOf(none), null);
  assert.deepEqual(tillProblemOf(none), {
    headline: "No quote from the till",
    detail: "This party has no package in the OTO App, so it cannot be settled here",
  });
  assert.equal(tillProblemOf(ok(quoteAnswer(randomUUID()))), null);
  assert.equal(tillFiguresOf(undefined), null);
});

await check("the Quote PDF's content: the till's lines, ฿17,025, the deposit, ฿14,025 to pay, the day, the guests and the validity note", () => {
  const html = partyQuoteContent(TillBillingSchema.parse(quoteAnswer(randomUUID())), new Date("2026-11-10T08:00:00.000Z"))!;
  assert.ok(html);
  for (const words of [
    "Party quote",
    "Issued 10/11/2026",
    "OTO, Oto Play Park, Central Floresta",
    "ZZ TEST Floresta party 822",
    "Wednesday 18 November 2026",
    "13:00 – 16:00",
    "10 children, 4 adults",
    "ZZ TEST Floresta Birthday (weekday price)",
    "ZZ TEST bubble tea",
    "Kids&#39; table reserved for 3 hours",
    "฿16,900",
    "฿125",
    "฿17,025",
    "-฿3,000",
    "฿14,025",
    QUOTE_VALIDITY_NOTE.replace(/'/g, "&#39;"),
  ]) {
    assert.ok(html.includes(words), `the quote says ${words}`);
  }
  assert.equal((html.match(/data-quote-line/g) ?? []).length, 7, "one row per line the till priced");
  assert.equal((html.match(/>Included</g) ?? []).length, 5, "the free lines read Included");
  assert.ok(!html.includes("1,690,000"), "no satang shown as baht");
  assert.equal(partyQuoteContent(TillBillingSchema.parse(saleAnswer(randomUUID())), new Date()), null, "a settled party has a receipt, not a quote");
  assert.equal(partyQuoteContent(TillBillingSchema.parse(noQuoteAnswer(randomUUID())), new Date()), null);
  assert.equal(quoteDayOf("2026-11-21"), "Saturday 21 November 2026");
  assert.equal(quoteDayOf("not a day"), "not a day");
  const odd = quoteAnswer(randomUUID());
  odd.party.title = "<script>alert(1)</script>";
  assert.ok(!partyQuoteContent(TillBillingSchema.parse(odd), new Date())!.includes("<script>"), "the party's name is escaped");
});

/**
 * The BEO PDF of the quoted party, its Party Details as staff typed them
 * before: a base price of 16,900 and a ฿500 extra (a typed sum of 17,400,
 * 14,400 outstanding after the ฿3,000 deposit) — none of which is the till's.
 */
const beoPdfOf = (till: TillBillingReading | undefined) =>
  beoPdfHtml({
    eventTitle: "ZZ TEST Floresta party 822",
    eventDate: "2026-11-18",
    startTime: "13:00",
    status: "upcoming",
    partyDetails: {
      packageName: "ZZ TEST Floresta Birthday",
      packageBasePrice: 16_900,
      items: [
        { label: "Kids' table", type: "included", price: 0 },
        { label: "Bubble show", type: "extra", price: 500 },
      ],
      prepaymentReceived: 3_000,
      depositDate: "2026-11-01",
    },
    till,
  });
/** The printed POS section alone. */
const posSection = (html: string) => {
  const at = html.indexOf("<h2>POS");
  return at < 0 ? "" : html.slice(at, html.indexOf("</div>", at));
};

await check("the BEO PDF's POS section prints the till's ฿17,025 / ฿3,000 / ฿14,025, never Party Details' typed sum", async () => {
  const pos = posSection(await beoPdfOf(ok(quoteAnswer(randomUUID()))));
  assert.ok(pos, "the section is printed");
  for (const words of ["Expected total (from the till):", "฿17,025", "Deposit paid:", "฿3,000", "Deposit Date:", "2026-11-01", "Outstanding:", "฿14,025", "Bubble show", "EXTRA"]) {
    assert.ok(pos.includes(words), `the POS section says ${words}`);
  }
  for (const typed of ["POS Total", "Base Price", "Outstanding Balance", "Prepayment Received", "17,400", "14,400", "16,900", "500฿", "-3,000"]) {
    assert.ok(!pos.includes(typed), `the POS section never prints ${typed}`);
  }
  const settled = posSection(await beoPdfOf(ok(saleAnswer(randomUUID()))));
  assert.ok(settled.includes("Total (from the till):") && settled.includes("฿17,025") && settled.includes("Receipt:") && settled.includes("T1-000822"));
  assert.match(settled, /Outstanding:<\/td><td[^>]*>฿0</);
});

await check("the BEO PDF without the till: 'Till not reachable' and no figure; a party the till cannot price says so; no Party Details and no till, no section", async () => {
  const down = posSection(await beoPdfOf({ status: "not_reachable", message: "The till did not answer." }));
  assert.ok(down.includes("Till not reachable"));
  assert.ok(!down.includes("฿") && !/\d{1,3},\d{3}/.test(down), `no figure: ${down}`);
  const none = posSection(await beoPdfOf(ok(noQuoteAnswer(randomUUID()))));
  assert.ok(none.includes("No quote from the till") && !none.includes("฿"));
  const bare = await beoPdfHtml({ eventTitle: "ZZ TEST bare", eventDate: "2026-11-18", startTime: "13:00", status: "upcoming", till: { status: "not_linked", message: "x" } });
  assert.equal(posSection(bare), "", "nothing to say about a party with no Party Details and no till figures");
});

await check("an event the till never settles: 'Not settled at the till' on screen and on the BEO PDF, never 'Till not reachable', no figure", async () => {
  for (const type of ["birthday", "private_event", "school_group"]) assert.equal(isTillPartyEventType(type), true, type);
  for (const type of ["camp", "workshop", "other", "studio_event", "", null, undefined]) assert.equal(isTillPartyEventType(type), false, String(type));
  const reading: TillBillingReading = { status: "not_a_party", message: "ZZ not a party" };
  assert.equal(tillFiguresOf(reading), null);
  assert.deepEqual(tillProblemOf(reading), { headline: "Not settled at the till", detail: "ZZ not a party" });
  assert.equal(NOT_SETTLED_AT_THE_TILL, "Not settled at the till");
  const pos = posSection(await beoPdfOf(reading));
  assert.ok(pos.includes("Not settled at the till"), pos);
  assert.ok(!pos.includes(TILL_NOT_REACHABLE) && !pos.includes("฿"), `no figure and no "Till not reachable": ${pos}`);
});

// ─── The stand-in platform ────────────────────────────────────────────────────

type Asked = { url: string; method: string; headers: IncomingMessage["headers"] };
const asked: Asked[] = [];
type Reply = (req: IncomingMessage, res: ServerResponse) => void;
const answers = new Map<string, unknown>();
const answer: Reply = (req, res) => {
  const id = /^\/otoapp\/parties\/([^/]+)\/billing$/.exec(req.url ?? "")?.[1] ?? "";
  const body = answers.get(id);
  if (!body) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Party not found" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
let reply: Reply = answer;
const platform = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    asked.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers });
    reply(req, res);
  });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
const refuse = (status: number, code: string, message: string): Reply => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
};
const hangUp: Reply = (req) => {
  req.socket.destroy();
};

await check("the client: the key as a Bearer, no session, a GET; the platform's answers and refusals read", async () => {
  const config = { apiUrl: PLATFORM_API_URL, key: "zz-822-key" };
  const eventId = randomUUID();
  answers.set(eventId, quoteAnswer(eventId));
  const read = await readTillBilling(config, eventId, "req-822");
  assert.ok(read.ok && read.billing.state === "quote" && read.billing.quote?.totalSatang === 1_702_500);
  const sent = asked.at(-1)!;
  assert.equal(sent.method, "GET");
  assert.equal(sent.url, `/otoapp/parties/${eventId}/billing`);
  assert.equal(sent.headers.authorization, "Bearer zz-822-key");
  assert.equal(sent.headers.cookie, undefined, "no platform session travels");
  assert.equal(sent.headers["x-request-id"], "req-822");

  reply = refuse(401, "OTOAPP_PROVISION_UNAUTHORIZED", "x");
  const key = await readTillBilling(config, eventId);
  assert.ok(!key.ok && key.status === 503 && /provisioning key/.test(key.message) && !key.message.includes("zz-822-key"));
  reply = answer;
  const unknown = await readTillBilling(config, randomUUID());
  assert.ok(!unknown.ok && unknown.status === 404 && /does not know this party/.test(unknown.message));
  reply = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ eventId, state: "quote", quote: { totalSatang: "a lot" } }));
  };
  const unreadable = await readTillBilling(config, eventId);
  assert.ok(!unreadable.ok && unreadable.code === "PLATFORM_UNREADABLE");
  reply = hangUp;
  const gone = await readTillBilling(config, eventId);
  assert.ok(!gone.ok && gone.code === "PLATFORM_UNREACHABLE" && gone.status === 502);
  reply = answer;
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
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-822-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST address, Phuket', $4)", [
    branch,
    tenant,
    `ZZ TEST ${label} park ${run}`,
    coreBranch,
  ]);
  return { tenant, branch, coreBranch };
}
async function user(g: { tenant: string }, role: string) {
  const id = randomUUID();
  const email = `zz-822-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
     values ($1, $2, $3, $4, $5, true, false, true)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [g.tenant, id]);
  return { id, email };
}
async function party(g: { tenant: string; branch: string }, title: string, eventType = "birthday") {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
     values ($1, $2, $3, $5, $4, '2026-11-18', '13:00', '16:00', 10, 4, 'upcoming')`,
    [id, g.tenant, g.branch, `ZZ TEST ${title} ${run}`, eventType],
  );
  return id;
}

const A = await parkGroup("a", true);
const B = await parkGroup("b", true);
const unlinked = await parkGroup("unlinked", false);
const managerA = await user(A, "manager");
const staffA = await user(A, "staff");
const adminU = await user(unlinked, "admin");
const quoted = await party(A, "quoted");
const settled = await party(A, "settled");
const unpriced = await party(A, "unpriced");
const partyB = await party(B, "b");
const partyU = await party(unlinked, "unlinked");
const camp = await party(A, "camp", "camp");
const workshop = await party(A, "workshop", "workshop");
const privateEvent = await party(A, "private", "private_event");
const schoolGroup = await party(A, "school", "school_group");
answers.set(quoted, quoteAnswer(quoted));
answers.set(privateEvent, quoteAnswer(privateEvent));
answers.set(schoolGroup, quoteAnswer(schoolGroup));
answers.set(settled, saleAnswer(settled));
answers.set(unpriced, noQuoteAnswer(unpriced));

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
      PUPPETEER_EXECUTABLE_PATH: CHROMIUM,
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

const get = async (origin: string, path: string, cookie: string) => {
  const res = await fetch(`${origin}${path}`, { headers: { cookie } });
  const bytes = Buffer.from(await res.arrayBuffer());
  let body: any = bytes.toString("utf8"); // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
  try {
    body = JSON.parse(body);
  } catch {
    /* text or bytes */
  }
  return { status: res.status, type: res.headers.get("content-type") ?? "", disposition: res.headers.get("content-disposition") ?? "", bytes, body };
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
  const keyed = await serve({ OTOAPP_PROVISION_KEY: "zz-822-key" });
  const unkeyed = await serve({ OTOAPP_PROVISION_KEY: "" });
  const manager = await signIn(keyed, managerA.email);
  const staff = await signIn(keyed, staffA.email);
  const reading = (origin: string, cookie: string, eventId: string) => get(origin, `/api/events/${eventId}/beo/till-billing`, cookie);

  await check("a linked party: the till's quote, as the platform answered it, asked with the key and never a session", async () => {
    const before = asked.length;
    const res = await reading(keyed, manager, quoted);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "ok");
    assert.deepEqual(res.body.billing, TillBillingSchema.parse(quoteAnswer(quoted)));
    assert.ok(typeof res.body.readAt === "string");
    const figures = tillFiguresOf(res.body as TillBillingReading)!;
    assert.deepEqual([figures.expectedSatang, figures.depositSatang, figures.outstandingSatang], [1_702_500, 300_000, 1_402_500]);
    assert.equal(asked.length, before + 1);
    assert.equal(asked.at(-1)!.headers.authorization, "Bearer zz-822-key");
    assert.equal(asked.at(-1)!.headers.cookie, undefined);
  });

  await check("staff read it too, as they read the BEO and its day-of view; a settled party answers its sale", async () => {
    const res = await reading(keyed, staff, settled);
    assert.equal(res.status, 200);
    assert.equal(res.body.billing.state, "sale");
    assert.equal(res.body.billing.sale.receiptNumber, "T1-000822");
    assert.deepEqual(res.body.billing.sale.payments.map((p: { label: string }) => p.label), ["Deposit paid in advance", "Cash"]);
  });

  await check("without the till, a reason and no figure: not answering, the park not linked, no key here", async () => {
    reply = hangUp;
    const down = await reading(keyed, manager, quoted);
    assert.equal(down.status, 200);
    assert.equal(down.body.status, "not_reachable");
    assert.equal(tillFiguresOf(down.body), null);
    assert.equal(tillProblemOf(down.body)!.headline, "Till not reachable");
    reply = answer;
    const before = asked.length;
    const notLinked = await reading(keyed, await signIn(keyed, adminU.email), partyU);
    assert.equal(notLinked.body.status, "not_linked");
    const none = await reading(unkeyed, await signIn(unkeyed, managerA.email), quoted);
    assert.equal(none.body.status, "unconfigured");
    assert.match(none.body.message, /OTOAPP_PROVISION_KEY/);
    assert.equal(asked.length, before, "the platform was never asked for those");
  });

  await check("another park group's party, or no party at all, is not found — and the platform is not asked", async () => {
    const before = asked.length;
    assert.equal((await reading(keyed, manager, partyB)).status, 404);
    assert.equal((await reading(keyed, manager, randomUUID())).status, 404);
    assert.equal((await reading(keyed, manager, "not-a-uuid")).status, 404);
    assert.equal((await fetch(`${keyed}/api/events/${quoted}/beo/till-billing`)).status, 401, "signed in first");
    assert.equal(asked.length, before);
  });

  await check("a camp or a workshop: 'not_a_party' and the platform never asked; no Quote PDF; the BEO PDF still printed; a private event and a school group are asked", async () => {
    const before = asked.length;
    for (const eventId of [camp, workshop]) {
      const res = await reading(keyed, manager, eventId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, "not_a_party");
      assert.equal(tillFiguresOf(res.body), null);
      assert.equal(tillProblemOf(res.body)!.headline, "Not settled at the till");
    }
    const noKey = await reading(unkeyed, await signIn(unkeyed, managerA.email), camp);
    assert.equal(noKey.body.status, "not_a_party", "not a party, whatever this deployment's key");
    const quote = await get(keyed, `/api/events/${camp}/beo/quote.pdf`, manager);
    assert.equal(quote.status, 409);
    assert.equal(quote.body.code, "NOT_A_PARTY");
    assert.match(quote.body.message, /^Not settled at the till: /);
    const beo = await get(keyed, `/api/events/${camp}/beo/pdf`, staff);
    assert.equal(beo.status, 200, beo.bytes.toString("utf8").slice(0, 300));
    assert.equal(beo.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(asked.length, before, "the platform was never asked for a camp or a workshop");
    for (const eventId of [privateEvent, schoolGroup]) {
      const res = await reading(keyed, manager, eventId);
      assert.equal(res.body.status, "ok", JSON.stringify(res.body));
    }
    assert.equal(asked.length, before + 2, "a private event and a school group are the till's parties");
  });

  await check("the Quote PDF: a PDF of the till's quote, opened inline under the party's name", async () => {
    const pdf = await get(keyed, `/api/events/${quoted}/beo/quote.pdf`, staff);
    assert.equal(pdf.status, 200, pdf.bytes.toString("utf8").slice(0, 300));
    assert.equal(pdf.type, "application/pdf");
    assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.match(pdf.disposition, /^inline; filename="Quote_ZZ_TEST_quoted_[0-9a-f]+_2026-11-18\.pdf"$/);
  });

  await check("no Quote PDF for a settled party, one the till cannot price, or when the till is not reachable", async () => {
    const sale = await get(keyed, `/api/events/${settled}/beo/quote.pdf`, manager);
    assert.equal(sale.status, 409);
    assert.equal(sale.body.code, "PARTY_SETTLED");
    const none = await get(keyed, `/api/events/${unpriced}/beo/quote.pdf`, manager);
    assert.equal(none.status, 409);
    assert.equal(none.body.code, "PARTY_NO_PACKAGE");
    reply = hangUp;
    const down = await get(keyed, `/api/events/${quoted}/beo/quote.pdf`, manager);
    assert.equal(down.status, 502);
    assert.match(down.body.message, /^Till not reachable: /);
    reply = answer;
    assert.equal((await get(keyed, `/api/events/${partyB}/beo/quote.pdf`, manager)).status, 404);
  });

  await check("the BEO PDF asks the till for the party's money when it is made, and is still made when the till does not answer", async () => {
    const before = asked.length;
    const pdf = await get(keyed, `/api/events/${quoted}/beo/pdf`, staff);
    assert.equal(pdf.status, 200, pdf.bytes.toString("utf8").slice(0, 300));
    assert.equal(pdf.type, "application/pdf");
    assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(asked.length, before + 1, "the till was asked once");
    assert.equal(asked.at(-1)!.url, `/otoapp/parties/${quoted}/billing`);
    assert.equal(asked.at(-1)!.headers.authorization, "Bearer zz-822-key");
    reply = hangUp;
    const down = await get(keyed, `/api/events/${quoted}/beo/pdf`, staff);
    reply = answer;
    assert.equal(down.status, 200, "the BEO is printed without the money");
    assert.equal(down.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  // ─── The billing module's deposit, against the real billing route ─────────
  //
  // The Deposit Paid field is the party's one deposit (SCRUM-813), the figure
  // the till reads. Its writes used to go one per keystroke, all in flight
  // together: in a scratch run, 12 rounds of 30 left the party at the older
  // ฿300 rather than the ฿3,000 typed last, and an emptied field's 0 wiped the
  // deposit's day. Now the section sends one write per figure, and the
  // party's writes run in one queue (beoBillingMutationScope).
  const putBilling = async (eventId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${keyed}/api/events/${eventId}/beo/billing`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: manager },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PUT billing: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const depositOf = async (eventId: string) => {
    const [row] = await q<{ add_ons: { partyDetails?: { prepaymentReceived?: number; depositDate?: string } } | null; deposit_paid_amount: number | null; deposit_paid_at: Date | null }>(
      "select add_ons, deposit_paid_amount, deposit_paid_at from beo_event_billing where event_id = $1",
      [eventId],
    );
    const [event] = await q<{ prepayment_amount: number | null; prepayment_date: string | null }>(
      "select prepayment_amount, prepayment_date::text from core_events where id = $1",
      [eventId],
    );
    return {
      partyDetails: row?.add_ons?.partyDetails?.prepaymentReceived ?? null,
      partyDetailsDay: row?.add_ons?.partyDetails?.depositDate ?? null,
      billing: row?.deposit_paid_amount ?? null,
      billingDay: row?.deposit_paid_at ? row.deposit_paid_at.toISOString().slice(0, 10) : null,
      event: event?.prepayment_amount ?? null,
      eventDay: event?.prepayment_date ?? null,
    };
  };
  const deposited = await party(A, "deposited");

  await check("the party's billing writes run in one queue: 300, 3000, 300, 3000 sent together always end at the ฿3,000 sent last", async () => {
    await putBilling(deposited, { depositPaidAmount: 30, depositPaid: true, depositPaidAt: "2026-11-01T00:00:00.000Z" });
    const client = new QueryClient();
    const write = (amount: number) =>
      new MutationObserver(client, {
        scope: beoBillingMutationScope(deposited),
        mutationFn: (a: number) => putBilling(deposited, { depositPaidAmount: a, depositPaid: a > 0 }),
      }).mutate(amount);
    for (let round = 0; round < 10; round += 1) {
      await Promise.all([write(300), write(3000), write(300), write(3000)]);
      const now = await depositOf(deposited);
      assert.deepEqual([now.partyDetails, now.billing, now.event], [3000, 3000, 3000], `round ${round}: ${JSON.stringify(now)}`);
    }
    client.clear();
  });

  await check("clearing the Deposit Paid field and retyping sends one write and keeps the deposit's day everywhere the app keeps it", async () => {
    await putBilling(deposited, { depositPaidAmount: 3000, depositPaid: true, depositPaidAt: "2026-11-01T00:00:00.000Z" });
    const sent: Array<Promise<unknown>> = [];
    const buffer = new DepositBuffer({
      send: (patch) => {
        const put = putBilling(deposited, patch as Record<string, unknown>);
        sent.push(put);
        return put;
      },
      saved: () => 3000,
    });
    for (const field of ["300", "30", "3", "", "5", "50", "500", "5000"]) buffer.type(field === "" ? null : Number(field));
    buffer.flush();
    assert.equal(sent.length, 1, "one write");
    await Promise.all(sent);
    assert.deepEqual(await depositOf(deposited), {
      partyDetails: 5000,
      partyDetailsDay: "2026-11-01",
      billing: 5000,
      billingDay: "2026-11-01",
      event: 5000,
      eventDay: "2026-11-01",
    });
    buffer.dispose();
  });

  console.log(`till-billing.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
process.exit(checks === 18 ? 0 : 1);
