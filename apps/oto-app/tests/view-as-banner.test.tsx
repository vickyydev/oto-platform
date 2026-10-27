// seed: none — this file talks to nothing. Run it with `npx tsx
// tests/view-as-banner.test.tsx`; the assertions are at module level.
//
// SCRUM-648 (S2-23): the OTO App's fixed view-as banner. No mark, no banner;
// a mark, both names and the countdown, fixed above the page at one height
// with the page moved below it, and nothing to dismiss it with. And the
// activity-log mark: rows written inside a window name who was really there.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewAsBannerView } from "../client/src/components/view-as-banner-view";
import { markViewAsOffset, timeLeft, VIEW_AS_ACTIVE, viewAsLine, viewAsOf } from "../client/src/lib/viewAsBanner";
import { viewAsForClient, viewAsMetadata } from "../server/lib/platformSession";

const NOW = Date.parse("2026-10-28T03:00:00.000Z");
const mark = {
  id: "01964800-0000-7000-8000-0000000000c1",
  actorAccountId: "01964800-0000-7000-8000-0000000000a1",
  subjectAccountId: "01964800-0000-7000-8000-0000000000a2",
  mode: "read_only" as const,
  expiresAt: "2026-10-28T03:07:30.000Z",
  actorName: "ZZ Admin",
  subjectName: "ZZ Manager",
};

// ─── /api/user → the client ────────────────────────────────────────────────────
const user = { id: "u1", platformViewAs: viewAsForClient(mark) };
assert.deepEqual(user.platformViewAs, { id: mark.id, actorName: "ZZ Admin", subjectName: "ZZ Manager", mode: "read_only",
  expiresAt: mark.expiresAt }, "the client gets the window and the names, nothing that acts");
assert.equal(viewAsForClient(null), null);
assert.equal(viewAsOf({ id: "u1", platformViewAs: null }), null, "an ordinary launcher session has no window");
assert.equal(viewAsOf({ id: "u1" }), null, "a legacy-login session has no window");
assert.equal(viewAsOf(null), null);

// ─── The banner ─────────────────────────────────────────────────────────────────
const none = renderToStaticMarkup(createElement(ViewAsBannerView, { viewAs: viewAsOf({ platformViewAs: null }), now: NOW }));
assert.equal(none, "", "no mark, no banner");
const out = renderToStaticMarkup(createElement(ViewAsBannerView, { viewAs: viewAsOf(user), now: NOW }));
assert.ok(out.includes("ZZ Admin is viewing the OTO App as ZZ Manager"), out);
assert.ok(out.includes("read-only, nothing can be changed"));
assert.ok(out.includes("ends in 7:30"));
assert.ok(out.includes('data-testid="impersonation-banner"'));
assert.ok(out.includes("fixed inset-x-0 top-0") && out.includes("h-9"));
assert.ok(!/<button/.test(out), "nothing to dismiss it with");
assert.ok(viewAsLine({ ...viewAsOf(user)!, mode: "write_allowed" }).includes("payroll and contracts closed"));
assert.equal(timeLeft("2026-10-28T02:00:00.000Z", NOW), "0:00");

// The page moves below the banner while it shows (index.css), so no header control is under it.
const tokens = new Set<string>();
const root = { classList: { toggle: (token: string, on?: boolean) => { if (on) tokens.add(token); else tokens.delete(token); } } };
markViewAsOffset(root, true);
assert.deepEqual([...tokens], [VIEW_AS_ACTIVE]);
markViewAsOffset(root, false);
assert.deepEqual([...tokens], []);
const css = readFileSync(new URL("../client/src/index.css", import.meta.url), "utf8");
assert.ok(css.includes("html.view-as-active body { padding-top: var(--view-as-offset); }"));
const app = readFileSync(new URL("../client/src/App.tsx", import.meta.url), "utf8");
assert.ok(app.indexOf("<ViewAsBanner />") > -1 && app.indexOf("<ViewAsBanner />") < app.indexOf("<Router />"), "mounted above every page");
const userRoute = readFileSync(new URL("../server/auth.ts", import.meta.url), "utf8");
assert.ok(userRoute.includes("platformViewAs: viewAsForClient(req.session?.platform?.impersonation)"), "/api/user carries the window");

// ─── The activity log's mark ────────────────────────────────────────────────────
const viewAs = { id: mark.id, actorAccountId: mark.actorAccountId, subjectAccountId: mark.subjectAccountId };
assert.equal(viewAsMetadata('{"x":1}', undefined), '{"x":1}', "outside a window the row is untouched");
assert.equal(viewAsMetadata(null, null), null);
assert.deepEqual(JSON.parse(viewAsMetadata('{"x":1}', viewAs)!), { x: 1, actor_type: "impersonated",
  actor_account_id: mark.actorAccountId, on_behalf_of: mark.subjectAccountId, impersonation_id: mark.id });
assert.deepEqual(JSON.parse(viewAsMetadata(null, viewAs)!), { actor_type: "impersonated", actor_account_id: mark.actorAccountId,
  on_behalf_of: mark.subjectAccountId, impersonation_id: mark.id });
assert.equal(viewAsMetadata("plain words", viewAs), "plain words", "metadata another reader parses as text is never rewritten");
assert.equal(viewAsMetadata("[1,2]", viewAs), "[1,2]");
const storage = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
assert.ok(storage.includes("viewAsMetadata(log.metadataJson, currentViewAs())"), "createActivityLog stamps the window");

console.log("view-as-banner: all assertions passed");
