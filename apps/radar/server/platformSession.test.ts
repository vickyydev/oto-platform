import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  RADAR_SESSION_COOKIE,
  holdsRadarAccess,
  launcherUrl,
  platformSessionFromSetCookie,
  putPlatformPreferences,
  requireRadarSession,
  resolveIdentity,
} from "./platformSession";

test("reads the platform session token and its lifetime from an exchange", () => {
  assert.deepEqual(
    platformSessionFromSetCookie(["oto_session=abc%2Bdef; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax"]),
    { token: "abc+def", maxAgeS: 3600 },
  );
  assert.equal(platformSessionFromSetCookie(["other=1; Path=/"]), null);
});

test("app:radar:access at any scope opens Radar; anything else does not", () => {
  assert.equal(holdsRadarAccess({ permissions: [{ permission: "app:radar:access", scopeType: "branch" }] }), true);
  assert.equal(holdsRadarAccess({ permissions: [{ permission: "app:oto_app:access" }] }), false);
  assert.equal(holdsRadarAccess(null), false);
});

function call(cookie: string | null): Promise<{ status: number; body: any; passed: boolean }> {
  return new Promise((resolve) => {
    const req = { headers: cookie ? { cookie } : {} } as unknown as Request;
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(body: unknown) {
        resolve({ status, body, passed: false });
        return res;
      },
      append() {
        return res;
      },
    } as unknown as Response;
    requireRadarSession(req, res, () => resolve({ status: 200, body: (req as any).radar, passed: true }));
  });
}

test("the guard refuses no cookie, a dead session and a missing permission; admits a holder", async () => {
  process.env.PLATFORM_API_URL = "http://platform.test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const token = /oto_session=([^;]+)/.exec(init?.headers?.cookie ?? "")?.[1];
    if (token === "dead") return new Response("{}", { status: 401 });
    if (String(url).endsWith("/me/permissions")) {
      const permission = token === "holder" ? "app:radar:access" : "pos:sale:create";
      return Response.json({ permissions: [{ permission, scopeType: "operator", scopeId: null }] });
    }
    return Response.json({ account: { id: `acc-${token}` }, employee: { name: "Lek" }, branch: null });
  }) as typeof fetch;
  try {
    assert.equal((await call(null)).status, 401);
    assert.equal((await call(`${RADAR_SESSION_COOKIE}=dead`)).status, 401);
    const denied = await call(`${RADAR_SESSION_COOKIE}=stranger`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, "no_access");
    const ok = await call(`${RADAR_SESSION_COOKIE}=holder`);
    assert.equal(ok.passed, true);
    assert.equal(ok.body.token, "holder");
    assert.equal(ok.body.identity.accountId, "acc-holder");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a signed-out answer names the launcher when LAUNCHER_URL is set, and nothing else (SCRUM-529)", async () => {
  process.env.PLATFORM_API_URL = "http://platform.test";
  const before = process.env.LAUNCHER_URL;
  try {
    process.env.LAUNCHER_URL = "https://launcher.example.test";
    const refused = await call(null);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.reason, "signed_out");
    assert.equal(refused.body.launcherUrl, "https://launcher.example.test/");

    delete process.env.LAUNCHER_URL;
    assert.equal((await call(null)).body.launcherUrl, null);

    // Not an address a browser should be sent to: treated as unset.
    process.env.LAUNCHER_URL = "javascript:alert(1)";
    assert.equal(launcherUrl(), null);
    process.env.LAUNCHER_URL = "not a url";
    assert.equal(launcherUrl(), null);
  } finally {
    if (before === undefined) delete process.env.LAUNCHER_URL;
    else process.env.LAUNCHER_URL = before;
  }
});

test("SCRUM-653: the identity carries the account's preferences, and a write is forwarded as the person", async () => {
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith("/me/permissions")) {
      return Response.json({ permissions: [{ permission: "app:radar:access", scopeType: "operator", scopeId: null }] });
    }
    if (String(url).endsWith("/me/preferences")) {
      return Response.json({ preferences: { theme: "dark", language: "en" } });
    }
    return Response.json({ account: { id: "acc-prefs" }, employee: { name: "Lek" }, branch: null, preferences: { theme: "system", language: "th" } });
  }) as typeof fetch;
  try {
    const answer = await resolveIdentity("http://platform.test", "prefs-token");
    assert.equal(answer.kind, "ok");
    assert.deepEqual(answer.kind === "ok" ? answer.identity.preferences : null, { theme: "system", language: "th" });

    const put = await putPlatformPreferences("http://platform.test", "prefs-token", { theme: "dark" }, "key-1");
    assert.deepEqual(put, { status: 200, body: { preferences: { theme: "dark", language: "en" } } });
    const call = seen.find((c) => c.url === "http://platform.test/me/preferences")!;
    assert.equal(call.init?.method, "PUT");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers.cookie, "oto_session=prefs-token");
    assert.equal(headers["idempotency-key"], "key-1");
    assert.equal(call.init?.body, JSON.stringify({ theme: "dark" }));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("SCRUM-648: the identity carries the platform's view-as window, null on an ordinary session", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/me/permissions")) {
      return Response.json({ permissions: [{ permission: "app:radar:access", scopeType: "operator", scopeId: null }] });
    }
    const token = String(url).includes("window") ? "window" : "plain";
    return Response.json({ account: { id: `acc-${token}` }, employee: { name: "Lek" }, branch: null,
      impersonation: token === "window" ? {
        id: "01964800-0000-7000-8000-0000000000c1", actor: { accountId: "a1", name: "ZZ Admin" },
        subject: { accountId: "a2", name: "Lek" }, targetApp: "radar", mode: "read_only", expiresAt: "2026-10-28T03:05:00.000Z",
      } : null });
  }) as typeof fetch;
  try {
    const inWindow = await resolveIdentity("http://window.platform.test", "view-as-token");
    assert.equal(inWindow.kind, "ok");
    assert.deepEqual(inWindow.kind === "ok" ? inWindow.identity.viewAs : undefined, { id: "01964800-0000-7000-8000-0000000000c1",
      actorName: "ZZ Admin", subjectName: "Lek", mode: "read_only", expiresAt: "2026-10-28T03:05:00.000Z" });
    const plain = await resolveIdentity("http://plain.platform.test", "plain-token");
    assert.equal(plain.kind === "ok" ? plain.identity.viewAs : undefined, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
