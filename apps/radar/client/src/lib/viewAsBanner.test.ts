import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewAsBannerView } from "../components/view-as-banner-view";
import { markViewAsOffset, timeLeft, VIEW_AS_ACTIVE, viewAsOf } from "./viewAsBanner";
import { viewAsFromMe, viewAsRefusal } from "../../../server/platformSession";

// SCRUM-648 (S2-23) — Radar's view-as banner and its read-only rule. Run with
// `npx tsx --test client/src/lib/viewAsBanner.test.ts`.

const NOW = Date.parse("2026-10-28T03:00:00.000Z");
const platformMe = {
  account: { id: "a2" },
  impersonation: {
    id: "01964800-0000-7000-8000-0000000000c1",
    actor: { accountId: "a1", name: "ZZ Admin" },
    subject: { accountId: "a2", name: "ZZ Analyst" },
    targetApp: "radar", mode: "read_only", expiresAt: "2026-10-28T03:05:00.000Z",
  },
};

test("the identity carries the platform's window, and nothing on an ordinary session", () => {
  assert.deepEqual(viewAsFromMe(platformMe), { id: platformMe.impersonation.id, actorName: "ZZ Admin", subjectName: "ZZ Analyst",
    mode: "read_only", expiresAt: "2026-10-28T03:05:00.000Z" });
  assert.equal(viewAsFromMe({ account: { id: "a2" }, impersonation: null }), null);
  assert.equal(viewAsFromMe({ account: { id: "a2" } }), null, "a platform from before the field");
  assert.equal(viewAsFromMe({ impersonation: { id: "x", mode: "admin", expiresAt: "t" } }), null, "an unreadable mark is no window");
});

test("a read-only window writes nothing in Radar; a write window and every read pass", () => {
  const ro = viewAsFromMe(platformMe)!;
  assert.match(viewAsRefusal(ro, "POST", "/api/me/preferences") ?? "", /read-only view-as window/);
  assert.equal(viewAsRefusal(ro, "GET", "/api/analytics"), null);
  assert.equal(viewAsRefusal(ro, "POST", "/api/auth/sign-out"), null);
  assert.equal(viewAsRefusal({ ...ro, mode: "write_allowed" }, "POST", "/api/me/preferences"), null);
  assert.equal(viewAsRefusal(null, "POST", "/api/me/preferences"), null);
});

test("no window, no banner; a window, both names and the countdown, fixed, with nothing to dismiss", () => {
  const me = { signedIn: true, accountId: "a2", viewAs: viewAsFromMe(platformMe) };
  assert.equal(renderToStaticMarkup(createElement(ViewAsBannerView, { viewAs: viewAsOf({ signedIn: true, viewAs: null }), now: NOW })), "");
  const out = renderToStaticMarkup(createElement(ViewAsBannerView, { viewAs: viewAsOf(me), now: NOW }));
  assert.ok(out.includes("ZZ Admin is viewing Radar as ZZ Analyst"), out);
  assert.ok(out.includes("ends in 5:00"));
  assert.ok(out.includes("fixed inset-x-0 top-0") && out.includes("h-9"));
  assert.ok(!/<button/.test(out));
  assert.equal(timeLeft("2026-10-28T02:00:00.000Z", NOW), "0:00");
});

test("the page moves below the banner, and it is mounted above every private page", () => {
  const tokens = new Set<string>();
  const root = { classList: { toggle: (token: string, on?: boolean) => { if (on) tokens.add(token); else tokens.delete(token); } } };
  markViewAsOffset(root, true);
  assert.deepEqual([...tokens], [VIEW_AS_ACTIVE]);
  markViewAsOffset(root, false);
  assert.deepEqual([...tokens], []);
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  assert.ok(css.includes("html.view-as-active body { padding-top: var(--view-as-offset); }"));
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("<ViewAsBanner me={me.data.body} />{children}"));
});
