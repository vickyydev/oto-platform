// seed: none — this file talks to nothing. Run it with `npx tsx
// tests/platform-theme.check.ts`.
//
// SCRUM-653 — the OTO App's theme follows the person's suite account: a
// launcher session's `/api/user` carries `platformPreferences`, the
// ThemeProvider paints it ('system' following the device), and a toggle is
// written back through `PUT /api/platform/preferences` with one retry.
import assert from "node:assert/strict";
import { isPlatformSession, savePlatformTheme, themeFromPlatform } from "../client/src/lib/platformTheme";
import { readPreferencesUpdate, readUiPreferences } from "../shared/uiPreferences";

// ─── Reading the account's choice ─────────────────────────────────────────────

const user = (theme: unknown) => ({ id: "u1", platformPreferences: { theme, language: "en" } });

assert.deepEqual(themeFromPlatform(user("dark"), false), { theme: "dark", followSystem: false }, "an explicit dark is painted dark");
assert.deepEqual(themeFromPlatform(user("light"), true), { theme: "light", followSystem: false }, "an explicit light ignores the device");
assert.deepEqual(themeFromPlatform(user("system"), true), { theme: "dark", followSystem: true }, "'system' on a dark device paints dark and follows it");
assert.deepEqual(themeFromPlatform(user("system"), false), { theme: "light", followSystem: true }, "'system' on a light device paints light");
assert.equal(themeFromPlatform({ id: "u1", platformPreferences: null }, true), null, "a launcher session the platform said nothing about keeps the fast-start theme");
assert.equal(themeFromPlatform({ id: "u1" }, true), null, "a legacy-login session keeps the fast-start theme");
assert.equal(themeFromPlatform(user("neon"), true), null, "an unknown value is ignored");

assert.equal(isPlatformSession({ id: "u1", platformPreferences: null }), true, "a launcher session writes back");
assert.equal(isPlatformSession({ id: "u1" }), false, "a legacy-login session does not");
assert.equal(isPlatformSession(null), false);

assert.deepEqual(readUiPreferences({ preferences: { theme: "system", language: "th" } }), { theme: "system", language: "th" });
assert.equal(readUiPreferences({ account: {} }), null, "a /me from before the column reads as nothing");

// ─── The body the app's proxy forwards ───────────────────────────────────────

assert.deepEqual(readPreferencesUpdate({ theme: "dark" }), { theme: "dark" });
assert.deepEqual(readPreferencesUpdate({ language: "th" }), { language: "th" });
assert.equal(readPreferencesUpdate({}), null, "an empty body is refused");
assert.equal(readPreferencesUpdate({ theme: "dark", accountId: "x" }), null, "no field but theme and language");
assert.equal(readPreferencesUpdate({ language: "fr" }), null, "only the staff-side languages");

// ─── Writing a toggle back ────────────────────────────────────────────────────

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

const ok = recorder([200]);
assert.equal(await savePlatformTheme("dark", ok.deps), true);
assert.equal(ok.calls.length, 1);
assert.equal(ok.calls[0]!.url, "/api/platform/preferences");
assert.equal(ok.calls[0]!.init.method, "PUT");
assert.equal(ok.calls[0]!.init.body, JSON.stringify({ theme: "dark" }));
assert.equal((ok.calls[0]!.init.headers as Record<string, string>)["idempotency-key"], "key-1");

const flaky = recorder(["throw", 200]);
assert.equal(await savePlatformTheme("light", flaky.deps), true, "one retry after a dropped request");
assert.deepEqual(
  flaky.calls.map((c) => (c.init.headers as Record<string, string>)["idempotency-key"]),
  ["key-1", "key-1"],
  "the retry carries the same replay key",
);

const refused = recorder([409]);
assert.equal(await savePlatformTheme("light", refused.deps), false);
assert.equal(refused.calls.length, 1, "a refusal is not asked twice");

const down = recorder([503, "throw"]);
assert.equal(await savePlatformTheme("light", down.deps), false, "gives up quietly after the retry");
assert.equal(down.calls.length, 2);

console.log("platform-theme: all checks passed");
