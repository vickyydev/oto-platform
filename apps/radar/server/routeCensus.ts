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
  // SCRUM-653: the theme toggle, forwarded to the platform as the person.
  "PUT /api/me/preferences",
  // Figures: the OTO POS rollup through the platform (sources/otoPos.ts).
  "GET /api/figures/branches",
  "GET /api/figures/today",
  "GET /api/figures/range",
  "GET /api/figures/calendar",
  "GET /api/figures/freshness",
  "GET /api/spin-wheel/report",
  // The trends assistant and chart builder.
  "POST /api/trends",
  "POST /api/trends-parse",
  "POST /api/chart-builder",
  // Radar's own settings: planner, calendar notes, pace snapshots.
  "GET /api/planner/target",
  "PUT /api/planner/target",
  "GET /api/planner/plan",
  "PUT /api/planner/plan",
  "GET /api/calendar-notes",
  "POST /api/calendar-notes",
  "POST /api/pace-snapshots",
  "GET /api/pace-snapshots/:branch/:month",
  // Campaigns admin, their stats and the voucher lookup.
  "GET /api/campaigns",
  "POST /api/campaigns",
  "PATCH /api/campaigns/:id",
  "DELETE /api/campaigns/:id",
  "GET /api/campaigns/stats",
  "GET /api/campaigns/timeseries",
  "GET /api/qr/lookup/:token",
  // Booth claims from the legacy wheel's ingest, survey results, staff birthdays.
  "GET /api/booth/claims",
  "GET /api/visitor-survey/summary",
  "GET /api/staff-birthdays",
  "POST /api/staff-birthdays",
  "PATCH /api/staff-birthdays/:id",
  "DELETE /api/staff-birthdays/:id",
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
