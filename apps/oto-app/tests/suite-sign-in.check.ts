// seed: none — this file talks only to a stand-in platform it starts itself.
// Not a Playwright file (it starts a server at module level, so it is a
// .check.ts): run it with `npx tsx tests/suite-sign-in.check.ts`.
//
// SCRUM-539 — the app's half of "Provision suite sign-in": what it sends the
// platform (its key as a Bearer, never a cookie; the press's action id; the
// acting administrator), and how it reads the answers back.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { provisionSuiteSignIn, readPhone, suiteProvisionConfig } from "../server/lib/suiteSignIn";

// ─── Configuration ────────────────────────────────────────────────────────────

delete process.env.OTOAPP_PROVISION_KEY;
process.env.PLATFORM_API_URL = "http://platform.invalid/";
assert.equal(suiteProvisionConfig(), null, "no key, no provisioning");
process.env.OTOAPP_PROVISION_KEY = "  zz-key  ";
assert.deepEqual(
  suiteProvisionConfig(),
  { apiUrl: "http://platform.invalid", key: "zz-key" },
  "the url loses its trailing slash and the key its whitespace",
);

// ─── Phones ───────────────────────────────────────────────────────────────────

assert.equal(readPhone(undefined), null);
assert.equal(readPhone(""), null);
assert.deepEqual(readPhone("081-234-5678"), { ok: true, phoneNumber: "081-234-5678", phoneE164: "+66812345678" });
assert.equal(readPhone("12")?.ok, false, "a number too short is refused in words");

// ─── The call ─────────────────────────────────────────────────────────────────

type Seen = { headers: IncomingMessage["headers"]; url: string; body: unknown };
const seen: Seen[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ headers: req.headers, url: req.url ?? "", body: JSON.parse(raw || "null") });
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = { apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, key: "zz-key" };
const input = {
  actionId: "0b6f6a8e-6a77-4a52-9a0a-3d8f1c0c2b11",
  appUserId: "user-1",
  phone: "+66812345678",
  actorAppUserId: "admin-1",
};

answer = {
  status: 200,
  body: { id: input.actionId, accountId: "acc-1", phone: "+66812345678", externalUserId: "user-1", temporaryPassword: "Ab12Cd34", replayed: false },
};
const made = await provisionSuiteSignIn(config, input, "req-1");
assert.deepEqual(made, { ok: true, accountId: "acc-1", phone: "+66812345678", temporaryPassword: "Ab12Cd34", replayed: false });
assert.equal(seen[0]!.url, "/admin/apps/oto_app/suite-sign-ins");
assert.equal(seen[0]!.headers.authorization, "Bearer zz-key", "the key travels as a Bearer");
assert.equal(seen[0]!.headers.cookie, undefined, "no platform session is ever sent");
assert.equal(seen[0]!.headers["x-request-id"], "req-1");
assert.deepEqual(seen[0]!.body, input, "the press's action id and the acting administrator are named");

answer = { status: 200, body: { ...(answer.body as object), temporaryPassword: null, replayed: true } };
const replay = await provisionSuiteSignIn(config, input);
assert.equal(replay.ok && replay.temporaryPassword, null, "a replay carries no password");
assert.equal(replay.ok && replay.replayed, true);

answer = { status: 409, body: { error: { code: "ACCOUNT_EXISTS", message: "That phone number already has a suite account." } } };
assert.deepEqual(await provisionSuiteSignIn(config, input), {
  ok: false,
  status: 409,
  code: "ACCOUNT_EXISTS",
  message: "That phone number already has a suite account.",
});

answer = { status: 401, body: { error: { code: "OTOAPP_PROVISION_UNAUTHORIZED", message: "x" } } };
const keyRefused = await provisionSuiteSignIn(config, input);
assert.equal(keyRefused.ok, false);
assert.equal(!keyRefused.ok && keyRefused.status, 503, "a refused key is this deployment's fault, not the administrator's");
assert.ok(!keyRefused.ok && !keyRefused.message.includes("zz-key"), "the key is never echoed");

server.close();
const unreachable = await provisionSuiteSignIn({ apiUrl: "http://127.0.0.1:1", key: "zz-key" }, input);
assert.equal(!unreachable.ok && unreachable.code, "PLATFORM_UNREACHABLE");

console.log("suite-sign-in.check: all checks passed");
