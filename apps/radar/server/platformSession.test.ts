import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  RADAR_SESSION_COOKIE,
  holdsRadarAccess,
  launcherUrl,
  platformSessionFromSetCookie,
  requireRadarSession,
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
