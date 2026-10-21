import { test } from "node:test";
import assert from "node:assert/strict";
import { savePlatformTheme, themeFromPlatform } from "./platformTheme";
import { readPreferencesUpdate } from "../../../shared/uiPreferences";

// SCRUM-653 — Radar's theme follows the person's platform account. Run with
// `npx tsx --test client/src/lib/platformTheme.test.ts`.

test("adopts the account's choice from /api/me and maps 'system' to the device", () => {
  const me = (theme: string) => ({ signedIn: true, preferences: { theme, language: "en" } });
  assert.deepEqual(themeFromPlatform(me("dark"), false), { theme: "dark", followSystem: false });
  assert.deepEqual(themeFromPlatform(me("light"), true), { theme: "light", followSystem: false });
  assert.deepEqual(themeFromPlatform(me("system"), true), { theme: "dark", followSystem: true });
  assert.deepEqual(themeFromPlatform(me("system"), false), { theme: "light", followSystem: true });
});

test("a /me without preferences leaves the fast-start theme alone", () => {
  assert.equal(themeFromPlatform({ signedIn: true, preferences: null }, true), null);
  assert.equal(themeFromPlatform({ signedIn: true }, true), null);
  assert.equal(themeFromPlatform({ preferences: { theme: "neon", language: "en" } }, true), null);
});

function recorder(answers: Array<number | "throw">) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift() ?? 200;
    if (next === "throw") throw new Error("offline");
    return new Response("{}", { status: next });
  }) as unknown as typeof fetch;
  return { calls, deps: { fetch: fetchFn, newKey: () => "key-1", wait: async () => {} } };
}

test("writes a toggle back through Radar's proxy with a replay key", async () => {
  const { calls, deps } = recorder([200]);
  assert.equal(await savePlatformTheme("dark", deps), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/me/preferences");
  assert.equal(calls[0]!.init.method, "PUT");
  assert.equal(calls[0]!.init.body, JSON.stringify({ theme: "dark" }));
  assert.equal((calls[0]!.init.headers as Record<string, string>)["idempotency-key"], "key-1");
});

test("retries once on the same key, then gives up quietly", async () => {
  const ok = recorder(["throw", 200]);
  assert.equal(await savePlatformTheme("light", ok.deps), true);
  assert.equal(ok.calls.length, 2);
  const keys = ok.calls.map((c) => (c.init.headers as Record<string, string>)["idempotency-key"]);
  assert.deepEqual(keys, ["key-1", "key-1"]);

  const down = recorder([503, "throw"]);
  assert.equal(await savePlatformTheme("light", down.deps), false);
  assert.equal(down.calls.length, 2);
});

test("the proxy takes a theme, a language or both, and nothing else", () => {
  assert.deepEqual(readPreferencesUpdate({ theme: "dark" }), { theme: "dark" });
  assert.deepEqual(readPreferencesUpdate({ language: "th" }), { language: "th" });
  assert.equal(readPreferencesUpdate({}), null);
  assert.equal(readPreferencesUpdate({ theme: "blue" }), null);
  assert.equal(readPreferencesUpdate({ theme: "dark", accountId: "x" }), null);
  assert.equal(readPreferencesUpdate(null), null);
});
