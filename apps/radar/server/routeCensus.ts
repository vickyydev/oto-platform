import type { NextFunction, Request, Response } from "express";
import { requireRadarSession } from "./platformSession";

/**
 * Every route Radar serves, in exactly one of three classes (S2-18 R2).
 *
 *  - PUBLIC: no sign-in. What a customer or a reception tablet opens without
 *    an account — the campaign pages under /c/:id, the visitor survey, the
 *    reception /redeem page — plus the sign-on itself and the health check.
 *  - KEY: a machine caller presenting a shared key, checked by the handler
 *    itself (OTO_RADAR_MARKETING_API_KEY, SPIN_WIN_REDEEM_KEY).
 *  - GUARDED: a signed-in platform session holding `app:radar:access`.
 *
 * The guard below lets PUBLIC and KEY through and sends everything else under
 * /api through `requireRadarSession` — including a route nobody listed, so an
 * unclassified addition is refused at runtime as well as failing the census
 * test (`server/routeCensus.test.ts`), which walks the router and requires
 * every registered route to appear here exactly once.
 *
 * Static assets and the client's own pages are not /api routes and are served
 * to anyone: a private page shows "open Radar from the launcher" until the
 * signed-in /api/me answers.
 */

export const PUBLIC_ROUTES = [
  "GET /healthz",
  "POST /api/auth/handoff",
  "POST /api/auth/sign-out",
  // Customer campaign pages (/c/:id).
  "GET /api/public/campaigns/:id",
  "POST /api/public/campaigns/:id/qr",
  "POST /api/public/qr/:token/saved",
  // Visitor survey page (/survey).
  "GET /api/visitor-survey/branches",
  "POST /api/visitor-survey",
  // Reception /redeem page, until redemption moves into the POS.
  "POST /api/qr/redeem",
  "GET /api/spin-wheel/rewards",
  "POST /api/spin-wheel/redeem",
] as const;

export const KEY_ROUTES = [
  // OTO_RADAR_MARKETING_API_KEY (Bearer).
  "GET /api/external/marketing-summary",
  // SPIN_WIN_REDEEM_KEY (X-API-Key). Kept only until the legacy wheel URL is
  // retired at cutover; the booth's own spins live on the platform (S2-07).
  "POST /api/spin-wheel/issue",
  "POST /api/booth/events",
  "POST /api/ingest/spin-events",
] as const;

export const GUARDED_ROUTES = [
  "GET /api/me",
  "DELETE /api/campaigns/:id",
  "DELETE /api/events/link",
  "DELETE /api/funtopia/product-registry/:key/override",
  "DELETE /api/funtopia/voucher-mappings/:faceValue",
  "DELETE /api/staff-birthdays/:id",
  "GET /api/booth/claims",
  "GET /api/campaigns",
  "GET /api/campaigns/stats",
  "GET /api/campaigns/timeseries",
  "GET /api/events/candidates",
  "GET /api/events/range",
  "GET /api/funtopia/adjustments",
  "GET /api/funtopia/calendar-notes",
  "GET /api/funtopia/calendar-range",
  "GET /api/funtopia/cash-reports",
  "GET /api/funtopia/formulas",
  "GET /api/funtopia/hourly-compare",
  "GET /api/funtopia/locked-months",
  "GET /api/funtopia/order/:orderId",
  "GET /api/funtopia/preferences/birthday-allocation",
  "GET /api/funtopia/product-registry",
  "GET /api/funtopia/range",
  "GET /api/funtopia/reports/cash-collections",
  "GET /api/funtopia/reports/detail-transactions",
  "GET /api/funtopia/source-watchdog",
  "GET /api/funtopia/sync-health",
  "GET /api/funtopia/sync-status",
  "GET /api/funtopia/today",
  "GET /api/funtopia/voucher-mappings",
  "GET /api/pace-snapshots/:branch/:month",
  "GET /api/papaya/calendar-range",
  "GET /api/papaya/daily/:date",
  "GET /api/papaya/invoice-settings",
  "GET /api/papaya/invoices",
  "GET /api/papaya/invoices/:terminal/:id",
  "GET /api/papaya/orders-by-discount",
  "GET /api/papaya/range",
  "GET /api/papaya/status",
  "GET /api/papaya/sync-health",
  "GET /api/papaya/sync-status",
  "GET /api/papaya/today",
  "GET /api/planner/plan",
  "GET /api/planner/target",
  "GET /api/pos-staleness",
  "GET /api/qr/lookup/:token",
  "GET /api/spin-wheel/report",
  "GET /api/staff-birthdays",
  "GET /api/sync-status/calendar",
  "GET /api/sync-status/overview",
  "GET /api/visitor-survey/summary",
  "PATCH /api/campaigns/:id",
  "PATCH /api/staff-birthdays/:id",
  "POST /api/campaigns",
  "POST /api/events/link",
  "POST /api/funtopia/calendar-notes",
  "POST /api/funtopia/chart-builder",
  "POST /api/funtopia/locked-months",
  "POST /api/funtopia/product-registry/:key/override",
  "POST /api/funtopia/seed-cash-reports",
  "POST /api/funtopia/trends",
  "POST /api/funtopia/trends-parse",
  "POST /api/funtopia/voucher-mappings/seed",
  "POST /api/pace-snapshots",
  "POST /api/staff-birthdays",
  "PUT /api/funtopia/preferences/birthday-allocation",
  "PUT /api/funtopia/voucher-mappings",
  "PUT /api/papaya/invoice-settings",
  "PUT /api/planner/plan",
  "PUT /api/planner/target",
] as const;

export type RouteKey = string;

function compile(entry: string): { method: string; pattern: RegExp } {
  const [method, path] = entry.split(" ");
  const source = path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { method, pattern: new RegExp(`^${source}/?$`) };
}

const OPEN = [...PUBLIC_ROUTES, ...KEY_ROUTES].map(compile);

/** True when a request may reach its handler without a signed-in session. */
export function isOpenRoute(method: string, path: string): boolean {
  const m = method === "HEAD" ? "GET" : method;
  return OPEN.some((r) => r.method === m && r.pattern.test(path));
}

/** The census guard. Registered before every /api route. */
export function censusGuard(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/")) return next();
  if (isOpenRoute(req.method, req.path)) return next();
  requireRadarSession(req, res, next);
}
