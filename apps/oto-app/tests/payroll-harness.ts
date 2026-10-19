// seed: none — a helper, not a check. The payroll DB checks' common harness
// (SCRUM-568): a scratch park group of ZZ TEST rows with one account per role,
// the app's real routes booted once (tests/harness/serve-routes.ts), sign-in
// and a JSON caller. The same shape tests/payroll-config.check.ts uses.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PASSWORD = "zz-test-password";
export const RUN = randomBytes(3).toString("hex");
export const SESSION_SECRET = randomBytes(24).toString("hex");
export const roles = ["global_admin", "admin", "operator_admin", "manager", "staff"] as const;
export type Role = typeof roles[number];

/** The environment the app's boot guard asks for, for the harness and for in-process imports. */
export const APP_ENV = {
  NODE_ENV: "test", APP_ENV: "dev", DEPLOY_ENV: "local", OTOAPP_JOBS: "inprocess",
  STORAGE_ENV_PREFIX: "zz-test", OBJECT_STORAGE: "local", LOG_LEVEL: "warn", SESSION_SECRET,
};

// In-process imports of the app's modules (the feed's pure builder, the loader) need the boot guard's environment too.
for (const [key, value] of Object.entries(APP_ENV)) process.env[key] ??= value;

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set"); process.exit(2); }
  const pool = new pg.Pool({ connectionString: url, options: "-c search_path=otoapp", max: 4 });
  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;
  const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
  return { pool, q, count };
}

const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

export interface Group { label: string; tenant: string; branches: string[]; accounts: Record<Role, { id: string; email: string }>; cookies: Record<Role, string> }

export async function makeGroup(q: ReturnType<typeof database>["q"], label: string, branchNames: string[]): Promise<Group> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 568 ${label} ${RUN}`, `zz-568-${label}-${RUN}`]);
  const branchIds: string[] = [];
  for (const name of branchNames) {
    const id = randomUUID();
    await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [id, tenant, `${name} ${RUN}`]);
    branchIds.push(id);
  }
  const accounts = {} as Group["accounts"];
  for (const role of roles) {
    const id = randomUUID();
    const email = `zz-568-${label}-${role}-${id.slice(0, 6)}-${RUN}@example.com`;
    await q(`insert into users (id, email, password, full_name, role, is_active, must_change_password)
             values ($1, $2, $3, $4, $5, true, false)`, [id, email, hash(PASSWORD), `ZZ TEST ${label} ${role}`, role]);
    await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
    accounts[role] = { id, email };
  }
  return { label, tenant, branches: branchIds, accounts, cookies: {} as Group["cookies"] };
}

export async function makeEmployee(q: ReturnType<typeof database>["q"], g: Group, branchId: string, fullName: string, startDate: string, weeklyOffDays: number[] = []) {
  const id = randomUUID();
  await q(`insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, start_date, weekly_off_days)
           values ($1, $2, $3, $4, $4, $5, 'active', $6, $7)`,
  [id, g.tenant, branchId, fullName, `zz-568-${g.label}-${id.slice(0, 8)}-${RUN}@example.com`, startDate, weeklyOffDays]);
  return id;
}

const children: ChildProcess[] = [];
export async function serve(env: Record<string, string> = {}): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR, env: { ...process.env, ...APP_ENV, OTOAPP_LEGACY_LOGIN: "true", ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 90_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`harness exited ${code}:\n${output}`)); });
  });
}
export function stopServers() { for (const child of children) child.kill(); }

export async function signIn(origin: string, g: Group) {
  for (const role of roles) {
    const login = await fetch(`${origin}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: g.accounts[role].email, password: PASSWORD }),
    });
    if (login.status !== 200) throw new Error(`${g.label} ${role} sign-in: ${login.status}`);
    g.cookies[role] = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
}

export function caller(origin: string) {
  return async (g: Group | null, role: Role, method: string, path: string, payload?: unknown) => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { "content-type": "application/json", ...(g ? { cookie: g.cookies[role] } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
    });
    const text = await res.text();
    let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
    try { body = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body };
  };
}
