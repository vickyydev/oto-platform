// seed: its own — one park group of ZZ TEST rows (a camp, two children), made
// here. Not a Playwright file (the suite collects *.spec.ts and *.test.ts; this
// is neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated, and renders the real Camp check-in list under jsdom
// against them.
//
// SCRUM-601 — tapping a child's card in Check-ins (Camp) opens the child's
// quick details:
//
//   1. The details show a large photo, the child's name, age and birthday, the
//      camp, the parent's contact, the notes the registration holds, and
//      today's state.
//   2. Tapping the large photo shows it full size; closing that leaves the
//      details open.
//   3. Check-in from the details opens the same check-in dialog as the card's
//      button and writes the same record: one child checked in from the
//      details, another from its card's button, the two requests and the two
//      attendance rows alike. A card's own button never opens the details.
//   4. Once checked in, the details show it and offer Check Out (and Undo In);
//      Check Out from the details checks the child out.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/checkin-child-card.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("checkin-child-card.check: DATABASE_URL is not set");
  process.exit(2);
}

// ─── jsdom, before React loads ────────────────────────────────────────────────

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/core/checkins", pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLImageElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "PointerEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history"]) {
  try { g[key] = (dom.window as unknown as Record<string, unknown>)[key]; } catch { /* read-only global */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = (dom.window as unknown as Record<string, (...a: unknown[]) => unknown>)[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = ResizeObserverStub;
(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
(dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
const doc = dom.window.document;

// ─── One park group, a camp running today, two children ──────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST cc ${run}`, `zz-cc-${run}`]);
const branch = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [branch, tenant, `ZZ TEST cc ${run}`]);
const userId = randomUUID();
const email = `zz-cc-${run}@example.com`;
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password)
   values ($1, $2, $3, $4, 'manager', true, false)`,
  [userId, email, hash(PASSWORD), `ZZ TEST Reception ${run}`],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [tenant, userId, branch]);

// Open-ended dates and no chosen days, so the camp runs "today" whatever the clock says.
const CAMP = `ZZ TEST Camp ${run}`;
const [{ id: eventId }] = await q<{ id: string }>(
  "insert into core_events (tenant_id, branch_id, event_type, title, event_date, start_time, camp_end_date) values ($1, $2, 'camp', $3, '2000-01-01', '09:00', '2999-12-31') returning id",
  [tenant, branch, CAMP],
);
async function registration(fields: Record<string, unknown>): Promise<string> {
  const row = {
    tenant_id: tenant,
    event_id: eventId,
    date_of_birth: "2019-03-14",
    parent_guardian_name: `ZZ TEST Mum ${run}`,
    emergency_contact_number: "+66 81 000 0001",
    parent_signature: "ZZ TEST signature",
    signature_date: "2026-01-01",
    ...fields,
  };
  const cols = Object.keys(row);
  const [{ id }] = await q<{ id: string }>(
    `insert into camp_registrations (${cols.join(", ")}) values (${cols.map((c, i) => (c === "parent_contacts" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ")}) returning id`,
    Object.values(row),
  );
  return id;
}
const AVA = `ZZ TEST Ava ${run}`;
const BEN = `ZZ TEST Ben ${run}`;
const ava = await registration({
  child_full_name: AVA,
  allergies: "Peanuts",
  special_notes: "Naps after lunch",
  parent_contacts: JSON.stringify([{ name: "ZZ TEST Dad", phone: "+66 81 000 0002" }]),
  authorized_pickup_persons: "ZZ TEST Grandma",
  child_photo_url: "/uploads/camp-photos/zz-test-ava.jpg",
});
const ben = await registration({ child_full_name: BEN, date_of_birth: "2017-06-01" });

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
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
      SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(24).toString("hex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise<string>((resolve, reject) => {
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

let checks = 0;
const check = async (title: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

try {
  const ORIGIN = await serve();
  const login = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status} ${await login.text()}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  /** Every call the page makes, sent to the real routes as the signed-in person. */
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const method = (options.method ?? "GET").toUpperCase();
    if (method !== "GET") sent.push({ method, path: url, body: options.body ? JSON.parse(String(options.body)) : null });
    return fetch(`${ORIGIN}${url}`, { ...options, headers: { ...(options.headers as Record<string, string> | undefined), cookie } });
  };

  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { queryClient } = await import("../client/src/lib/queryClient");
  const { CampCheckins } = await import("../client/src/pages/core/checkins");

  const settle = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  const waitFor = async <T,>(what: string, find: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found) return found;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await settle(50);
    }
  };
  const byTestId = (id: string, within: ParentNode = doc) => within.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const buttonByText = (text: string) =>
    (Array.from(doc.querySelectorAll("button")) as HTMLButtonElement[]).find((b) => b.textContent?.includes(text) && !b.disabled) ?? null;
  const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const escape = async () => {
    await act(async () => {
      (doc.activeElement ?? doc.body).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle(50);
  };
  const details = () => byTestId("camp-child-details");
  const card = (id: string) => byTestId(`camp-card-${id}`);

  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(CampCheckins, { activeBranchId: branch, fetchWithAuth })));
  });
  await waitFor("both children's cards", () => card(ava) && card(ben));

  const yearsSince = (iso: string) => {
    const born = new Date(`${iso}T00:00:00`);
    const now = new Date();
    return now.getFullYear() - born.getFullYear() - (now < new Date(now.getFullYear(), born.getMonth(), born.getDate()) ? 1 : 0);
  };

  await check("tapping a child's card opens the quick details with the child's fields", async () => {
    assert.equal(details(), null, "the details are open before any card is tapped");
    await click(card(ava)!);
    const view = await waitFor("the details", details);
    const text = view.textContent ?? "";
    for (const expected of [AVA, `${yearsSince("2019-03-14")}y`, "14 Mar 2019", CAMP, `ZZ TEST Mum ${run}`, "+66 81 000 0001", "ZZ TEST Dad", "+66 81 000 0002", "ZZ TEST Grandma", "Peanuts", "Naps after lunch", "Waiting to check in"]) {
      assert.ok(text.includes(expected), `the details do not show "${expected}"`);
    }
    const photo = byTestId("camp-child-details-photo", view)?.querySelector("img");
    assert.ok(photo, "the details show no large photo");
    assert.match(photo!.getAttribute("src") ?? "", /^\/api\/public\/camp-photo\//, "the large photo is not the signed preview the card uses");
    assert.equal(photo!.getAttribute("src"), card(ava)!.querySelector("img")?.getAttribute("src"), "the large photo is not the card's photo");
    assert.ok(byTestId("camp-details-check-in", view), "the details do not offer Check In");
  });

  await check("tapping the large photo shows it full size; closing that leaves the details open", async () => {
    await click(byTestId("camp-child-details-photo")!);
    const full = await waitFor("the full-size photo", () => byTestId("camp-child-photo-full"));
    assert.ok(full.querySelector("img"), "the full-size view has no photo");
    await escape();
    await waitFor("the full-size photo to close", () => !byTestId("camp-child-photo-full"));
    assert.ok(details(), "closing the full-size photo closed the details too");
  });

  await check("check-in from the details writes the same record as the card's button; a card's button never opens the details", async () => {
    // Ava, from the details.
    await click(byTestId("camp-details-check-in", details()!)!);
    await waitFor("the details to close", () => !details());
    await waitFor("the check-in dialog", () => buttonByText("Confirm Check In"));
    await type(doc.querySelector('input[placeholder="Name of person dropping off"]') as HTMLInputElement, "ZZ TEST Mum");
    await click(buttonByText("Confirm Check In")!);
    await waitFor("Ava's check-in to be sent", () => sent.find((r) => r.path.includes(ava)));
    await waitFor("Ava's card to read checked in", () => byTestId("camp-card-check-out", card(ava)!));

    // Ben, from his card's own button.
    await click(byTestId("camp-card-check-in", card(ben)!)!);
    assert.equal(details(), null, "the card's Check In button opened the details");
    await waitFor("the check-in dialog", () => buttonByText("Confirm Check In"));
    await type(doc.querySelector('input[placeholder="Name of person dropping off"]') as HTMLInputElement, "ZZ TEST Mum");
    await click(buttonByText("Confirm Check In")!);
    await waitFor("Ben's check-in to be sent", () => sent.find((r) => r.path.includes(ben)));
    await waitFor("Ben's card to read checked in", () => byTestId("camp-card-check-out", card(ben)!));

    const fromDetails = sent.find((r) => r.path.includes(ava))!;
    const fromCard = sent.find((r) => r.path.includes(ben))!;
    assert.equal(fromDetails.method, "POST");
    assert.equal(fromDetails.path, `/api/core/camp-checkins/${ava}/check-in`, "the details' check-in went somewhere else");
    assert.equal(fromCard.path, `/api/core/camp-checkins/${ben}/check-in`);
    assert.deepEqual(fromDetails.body, fromCard.body, "the two check-ins sent different bodies");

    const rows = await q<Record<string, unknown>>(
      `select camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_by, payment_method, drop_off_person,
              checked_in_at is not null as has_checked_in_at, checked_out_at is null as not_checked_out
         from camp_attendance where camp_registration_id = any($1::uuid[])`,
      [[ava, ben]],
    );
    const byReg = new Map(rows.map(({ camp_registration_id, ...rest }) => [String(camp_registration_id), rest]));
    assert.ok(byReg.get(ava) && byReg.get(ben), "a check-in wrote no attendance row");
    assert.deepEqual(byReg.get(ava), byReg.get(ben), "the details' check-in wrote a different record from the card's");
    assert.equal(byReg.get(ava)!.status, "checked_in");
    assert.equal(byReg.get(ava)!.checked_in_by, userId);
    assert.equal(byReg.get(ava)!.drop_off_person, "ZZ TEST Mum");
  });

  await check("once checked in, the details show it and offer Check Out, which checks the child out", async () => {
    await click(card(ava)!);
    const view = await waitFor("the details", details);
    assert.match(byTestId("camp-child-details-state", view)?.textContent ?? "", /^In \d\d:\d\d$/, "the details do not show today's check-in");
    assert.ok(byTestId("camp-details-undo-in", view), "the details do not offer Undo In");
    await click(byTestId("camp-details-check-out", view)!);
    await waitFor("the details to close", () => !details());
    await waitFor("the check-out dialog", () => buttonByText("Confirm Check Out"));
    await click(buttonByText("Confirm Check Out")!);
    await waitFor("Ava's card to read left", () => byTestId("camp-card-undo-out", card(ava)!));
    const [row] = await q<{ status: string }>("select status from camp_attendance where camp_registration_id = $1", [ava]);
    assert.equal(row.status, "checked_out");
  });

  await act(async () => root.unmount());
  console.log(`checkin-child-card.check: ${checks} checks passed`);
} catch (err) {
  console.error("checkin-child-card.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
process.exit(process.exitCode ?? 0);
