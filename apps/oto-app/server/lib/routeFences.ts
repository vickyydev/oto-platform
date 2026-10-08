import type { NextFunction, Request, Response } from "express";

/**
 * The fences around the app's development and maintenance routes (S2-17b
 * round 1, plan section 4 and H26).
 *
 * The app arrived with tools that were safe on a developer's machine and are
 * not on a shared database: a seed with no sign-in, a production-to-dev copy
 * that empties and reloads 174 tables (`users.platform_user_id` and
 * `branches.core_branch_id` among them), an importer, a route that throws on
 * purpose, and a storage check that hands any signed-in person the bucket's
 * name and writes a file into it. Until now only `NODE_ENV` or `APP_ENV`
 * stood in front of some of them, and neither says where the process runs:
 * staging runs the production build (see `config/env.ts`).
 *
 * Three fences, each a middleware:
 *
 *  - `devOnly`: refused on every deployment, by `DEPLOY_ENV`, the key the
 *    boot guard already uses. On a laptop (`local`) the tool works as before.
 *    Placed FIRST on its route, so nothing the route does — not even reading
 *    the session — happens on a deployment.
 *  - `followsJobsSwitch`: the two manual job triggers, which no screen calls.
 *    Under `OTOAPP_JOBS=platform` the platform's job runner owns the night
 *    work, and a hand-run here would race it, so the trigger answers with
 *    where the button is. Under `inprocess` (the default) it runs as today.
 *  - `parkGroupOnly`: the maintenance routes act on the caller's own park
 *    group (tenant) and nobody else's. The tenant goes on `res.locals` for
 *    the handler; a caller with none is refused rather than treated as all.
 *
 * The last two sit after the route's own sign-in and role checks: they answer
 * "not now" and "whose rows", which are nobody else's business.
 *
 * Express is imported for its types only, so the platform's tests can load
 * this file without the app's dependency tree.
 */

export type DeployEnv = "local" | "staging" | "production";

/** Who runs the app's night work: this process's own timers, or the platform's job runner. */
export type JobsMode = "inprocess" | "platform";

export const JOBS_MODES: readonly JobsMode[] = ["inprocess", "platform"];

/**
 * `OTOAPP_JOBS`, read the way the boot guard reads every switch: unset is the
 * default, anything else must be one of the two words. An unknown value is a
 * problem the boot guard names (`config/env.ts`), never a silent default.
 */
export function readJobsMode(raw: string | undefined): JobsMode | null {
  const value = (raw ?? "").trim();
  if (value === "") return "inprocess";
  return (JOBS_MODES as readonly string[]).includes(value) ? (value as JobsMode) : null;
}

/** What a refused development route answers. */
export const DEV_ROUTE_REFUSAL = {
  reason: "dev_route_off",
  message:
    "This is a development tool. It is switched off on every deployment and runs only on a developer's machine.",
} as const;

/** What a manual job trigger answers while the platform runs the jobs. */
export const JOBS_ON_PLATFORM_REFUSAL = {
  reason: "jobs_on_platform",
  message:
    "The platform runs this job now. Use Run now on the Console's Health page, so it never runs twice at once.",
} as const;

/** What a maintenance route answers when the caller belongs to no park group. */
export const NO_PARK_GROUP_REFUSAL = {
  reason: "no_park_group",
  message: "Access denied: this account belongs to no park group, so there is nothing of its own to repair.",
} as const;

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/** Refused on every deployment; works as before on a developer's machine. */
export function devOnly(deployEnv: DeployEnv): Middleware {
  return (_req, res, next) => {
    if (deployEnv !== "local") {
      res.status(403).json(DEV_ROUTE_REFUSAL);
      return;
    }
    next();
  };
}

/** A manual job trigger: refused while the platform owns the schedule. */
export function followsJobsSwitch(mode: JobsMode): Middleware {
  return (_req, res, next) => {
    if (mode === "platform") {
      res.status(409).json(JOBS_ON_PLATFORM_REFUSAL);
      return;
    }
    next();
  };
}

/**
 * The caller's park group, put where the handler reads it. Placed after the
 * route's sign-in and role checks: it answers "whose rows", not "may they".
 */
export const parkGroupOnly: Middleware = (req, res, next) => {
  const tenantId = (req as Request & { userWithAccess?: { tenantId?: string | null } }).userWithAccess
    ?.tenantId;
  if (!tenantId) {
    res.status(403).json(NO_PARK_GROUP_REFUSAL);
    return;
  }
  res.locals.parkGroupId = tenantId;
  next();
};

/** The tenant `parkGroupOnly` put on the response. Only valid behind it. */
export function parkGroupOf(res: Response): string {
  const tenantId = res.locals.parkGroupId as string | undefined;
  if (!tenantId) throw new Error("parkGroupOf: the route is missing parkGroupOnly");
  return tenantId;
}
