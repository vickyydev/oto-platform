// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-851, an SOP from a document when the AI provider refuses.
//
// The route passed the provider's failure to the routes' general error
// handler, which answers 500 with the error's own message, so staff read the
// provider's raw answer in the "Failed to generate SOP" toast: its JSON, with
// its internal request id.
//
//   1. A refusal answers 500 with one plain line and nothing of the
//      provider's: not its JSON, its sentence, its request id or its status.
//   2. The technical detail is in the server log, with the request id it can
//      be traced by, and never the key.
//   3. The toast shows the route's message: the screen reads `message` from a
//      refusal, as every mutation on that page does.
//   4. The success path is as it was: the same model, no sampling setting,
//      the same token allowance, the same prompt and document, a draft SOP.
//
// No provider is called: ANTHROPIC_BASE_URL names a stand-in started here.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/s851-sop-refusal.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DEFAULT_AI_MODEL } from "../server/lib/anthropic";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("s851-sop-refusal.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 2 });
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const PLAIN_LINE = "The steps could not be generated just now. Please try again.";
const KEY = `zz-test-model-key-${run}`;
const DOCUMENT = `ZZ TEST closing the play floor ${run}: switch off the lights, lock the gate.`;

// ─── Rows ─────────────────────────────────────────────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST s851 ${run}`, `zz-s851-${run}`]);
const admin = randomUUID();
const email = `zz-s851-admin-${run}@example.com`;
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password)
   values ($1, $2, $3, $4, 'admin', true, false)`,
  [admin, email, hash(PASSWORD), `ZZ TEST Admin ${run}`],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, admin]);
const file = randomUUID();
await q(
  `insert into knowledge_files (id, tenant_id, filename, file_type, storage_url, index_status, title)
   values ($1, $2, $3, 'pdf', 'zz-test/s851.pdf', 'indexed', $4)`,
  [file, tenant, `ZZ TEST s851 ${run}.pdf`, `ZZ TEST s851 ${run}`],
);
await q("insert into knowledge_chunks (tenant_id, file_id, chunk_index, text) values ($1, $2, 0, $3)", [tenant, file, DOCUMENT]);

// ─── A stand-in provider ──────────────────────────────────────────────────────

const REQUEST_ID = `req_ZZTEST851${run}`;
const refusals = {
  sampling: { status: 400, type: "invalid_request_error", message: "`temperature` is deprecated for this model." },
  key: { status: 401, type: "authentication_error", message: "invalid x-api-key" },
} as const;
let answer: keyof typeof refusals | "steps" = "sampling";
const asked: Record<string, any>[] = [];
const provider = createServer((req, res) => {
  let text = "";
  req.on("data", chunk => { text += chunk; });
  req.on("end", () => {
    asked.push({ path: req.url, key: req.headers["x-api-key"], body: JSON.parse(text) });
    if (answer === "steps") {
      res.writeHead(200, { "content-type": "application/json", "request-id": REQUEST_ID });
      return res.end(JSON.stringify({
        id: "msg_zz", type: "message", role: "assistant", model: DEFAULT_AI_MODEL, stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: JSON.stringify({ title: `ZZ TEST closing ${run}`, steps: [
          { stepNumber: 1, title: "Switch off the lights", description: "ZZ TEST" },
          { stepNumber: 2, title: "Lock the gate", description: "ZZ TEST" },
        ] }) }],
      }));
    }
    const refusal = refusals[answer];
    res.writeHead(refusal.status, { "content-type": "application/json", "request-id": REQUEST_ID });
    res.end(JSON.stringify({ type: "error", error: { type: refusal.type, message: refusal.message }, request_id: REQUEST_ID }));
  });
});
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));

// ─── The server ──────────────────────────────────────────────────────────────

let child: ChildProcess | undefined;
let output = "";
async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test", APP_ENV: "dev", STORAGE_ENV_PREFIX: "zz-test", OTOAPP_LEGACY_LOGIN: "true", LOG_LEVEL: "warn",
      TZ: "UTC", DEPLOY_ENV: "local", OTOAPP_JOBS: "platform", USE_AWS_REKOGNITION: "false", OBJECT_STORAGE: "local",
      SESSION_SECRET: `zz-session-${run}`,
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
      ANTHROPIC_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    child!.stdout!.on("data", read);
    child!.stderr!.on("data", read);
    child!.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

let checks = 0;
const check = async (title: string, fn: () => void | Promise<void>) => {
  await fn();
  checks++;
  console.log(`  ok  ${title}`);
};

try {
  const ORIGIN = await serve();
  const signedIn = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(signedIn.status, 200, `sign-in: ${signedIn.status} ${await signedIn.text()}`);
  const cookie = signedIn.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const generate = async () => {
    const res = await fetch(`${ORIGIN}/api/knowledge-files/${file}/generate-sop`, { method: "POST", headers: { cookie } });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };
  const sops = async () => Number((await q("select count(*) as n from sop_articles where tenant_id = $1", [tenant]))[0].n);

  for (const kind of ["sampling", "key"] as const) {
    await check(`a provider refusal (${refusals[kind].status}) answers one plain line and nothing of the provider's`, async () => {
      answer = kind;
      const logged = output.length;
      const before = asked.length;
      const result = await generate();
      assert.equal(asked.length, before + 1, "the provider was asked once");
      assert.equal(result.status, 500);
      assert.deepEqual(result.body, { message: PLAIN_LINE });
      for (const leak of [REQUEST_ID, "request_id", refusals[kind].type, refusals[kind].message, "{", KEY]) {
        assert.equal(result.text.replace(/^\{|\}$/g, "").includes(leak), false, `the answer carries ${leak}`);
      }
      assert.equal(await sops(), 0, "a refusal made an SOP");
      // The detail is in the log, traceable, and the key is not.
      for (let i = 0; i < 100 && !output.slice(logged).includes(REQUEST_ID); i++) await new Promise(done => setTimeout(done, 20));
      const lines = output.slice(logged);
      assert.ok(lines.includes("[GenerateSOP] The AI provider did not answer"), `nothing was logged: ${lines}`);
      assert.ok(lines.includes(REQUEST_ID) && lines.includes(refusals[kind].type) && lines.includes(String(refusals[kind].status)));
      assert.equal(output.includes(KEY), false, "the key is in the log");
      assert.equal(output.includes(DOCUMENT), false, "the document is in the log");
    });
  }

  await check("the toast shows the route's message", () => {
    const screen = readFileSync(join(APP_DIR, "client/src/components/studio/knowledge-files.tsx"), "utf8");
    const client = readFileSync(join(APP_DIR, "client/src/lib/queryClient.ts"), "utf8");
    assert.ok(screen.includes('toast({ title: "Failed to generate SOP", description: error.message, variant: "destructive" });'));
    assert.ok(client.includes("message = body.message || body.error || res.statusText;"));
  });

  await check("the success path is as it was: the default model, no sampling, the same allowance, a draft", async () => {
    answer = "steps";
    const result = await generate();
    assert.equal(result.status, 201, result.text);
    assert.equal(result.body.message, "SOP created successfully"); assert.equal(result.body.stepsCount, 2);
    assert.equal(result.body.sop.status, "draft"); assert.equal(result.body.sop.title, `ZZ TEST closing ${run}`);
    const sent = asked.at(-1)!;
    assert.equal(sent.path, "/v1/messages"); assert.equal(sent.key, KEY);
    assert.equal(sent.body.model, DEFAULT_AI_MODEL); assert.equal(sent.body.max_tokens, 2000);
    for (const key of ["temperature", "top_p", "top_k"]) assert.equal(Object.hasOwn(sent.body, key), false);
    assert.ok(sent.body.system.startsWith("You are an expert at analyzing documents and extracting step-by-step procedures."));
    assert.deepEqual(sent.body.messages, [{ role: "user", content: `Please extract structured steps from this document:\n\n${DOCUMENT}` }]);
    assert.equal(await sops(), 1);
  });

  console.log(`s851-sop-refusal.check: ${checks} checks passed`);
} catch (err) {
  console.error("s851-sop-refusal.check FAILED:", err);
  process.exitCode = 1;
} finally {
  child?.kill();
  provider.close();
  await q("delete from sop_articles where tenant_id = $1", [tenant]).catch(() => {});
  await q("delete from knowledge_files where id = $1", [file]).catch(() => {});
  await pool.end();
}
