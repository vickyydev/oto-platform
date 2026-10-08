import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { createHash, timingSafeEqual } from "crypto";
import { directoryClientOf, requireDirectoryClient } from "./clientAuth";

/**
 * Who may read the directory's six HR routes, and for which park group
 * (S2-17b round 4a; plan section 4 "Directory HR reads trust one shared key",
 * hazard H12, question Q13).
 *
 *   GET /api/directory/employee/:id
 *   GET /api/directory/employees/search
 *   GET /api/directory/branches/:branchId/employees
 *   GET /api/directory/roles
 *   GET /api/directory/departments
 *   GET /api/directory/branches
 *
 * Until now they took one shared key, `HR_DIRECTORY_API_KEY`, which names no
 * park group, and answered with every park group's staff. Now:
 *
 *  - A TENANT-BOUND KEY, `Authorization: Bearer <key>`, issued to one park
 *    group with the scope `hr:read` (`directory_clients`, the key the event
 *    writes and the night jobs already use; `npm run directory:client --
 *    create --tenant <uuid> --name <who> --scope hr:read`). The answers are
 *    that park group's only: another park group's employee or branch is 404,
 *    exactly as one that does not exist; the lists hold its own rows. A key
 *    without `hr:read` is 403, as `requireDirectoryClient` answers every
 *    missing scope; the key's own rate limit applies.
 *  - THE OLD SHARED KEY, `X-HR-API-KEY`, keeps working only where
 *    `HR_DIRECTORY_API_KEY` is set, and only for the default park group (Q13:
 *    whatever still calls it was written when there was one). Where it is not
 *    set — staging — the shared-key path is refused with a 403 in words (it
 *    used to be a 500), and the old per-key rate limit applies as before.
 *  - Neither: 401, naming the key to send.
 *
 * The park group the request reads for goes on `res.locals` for the route
 * (`hrDirectoryParkGroupOf`). No database or storage import here beyond the
 * pool the key lookup uses; the shared key, the default park group and the
 * old rate limit are passed in, so the words can be read without the app.
 */

export const HR_READ_SCOPE = "hr:read" as const;

/** No key of either kind. */
export const HR_DIRECTORY_NO_KEY = {
  error: "Authentication required",
  message: "Send a directory key issued to your park group with hr:read, as Authorization: Bearer <key>",
} as const;

/** The shared-key path where HR_DIRECTORY_API_KEY is not set. */
export const HR_DIRECTORY_SHARED_KEY_OFF = {
  error: "Shared key switched off",
  message:
    "The shared HR directory key is not set on this deployment. Use a directory key issued to your park group with hr:read, as Authorization: Bearer <key>.",
} as const;

/** A shared key that is not the one set. The old route's own words. */
export const HR_DIRECTORY_SHARED_KEY_INVALID = {
  error: "Invalid API key",
  message: "The provided API key is not valid",
} as const;

/** The shared key is set, but the database has no default park group for it to read. */
export const HR_DIRECTORY_NO_DEFAULT_PARK_GROUP = {
  error: "No default park group",
  message:
    "The shared HR directory key reads the default park group, and this database has none. Use a directory key issued to your park group with hr:read.",
} as const;

const SHARED_HEADER = "x-hr-api-key";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

export interface HrDirectoryCallerOptions {
  /** HR_DIRECTORY_API_KEY as set now; empty or unset turns the shared path off. */
  sharedKey: () => string | undefined;
  /** The default park group's tenant id, or null where there is none. */
  defaultParkGroup: () => Promise<string | null>;
  /** The old per-key rate limit, for the shared path only. */
  sharedRateLimit: Middleware;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function requireHrDirectoryCaller(pool: Pool, opts: HrDirectoryCallerOptions): Middleware {
  const tenantBound = requireDirectoryClient(pool, HR_READ_SCOPE);
  return (req, res, next) => {
    const authorization = req.headers.authorization;
    if (typeof authorization === "string" && authorization.trim() !== "") {
      tenantBound(req, res, (err?: unknown) => {
        if (err) return next(err);
        res.locals.hrDirectoryParkGroup = directoryClientOf(res).tenantId;
        next();
      });
      return;
    }

    const presented = req.headers[SHARED_HEADER];
    if (typeof presented !== "string" || presented === "") {
      res.status(401).json(HR_DIRECTORY_NO_KEY);
      return;
    }
    const expected = opts.sharedKey();
    if (!expected) {
      res.status(403).json(HR_DIRECTORY_SHARED_KEY_OFF);
      return;
    }
    if (!timingSafeEqual(digest(presented), digest(expected))) {
      res.status(403).json(HR_DIRECTORY_SHARED_KEY_INVALID);
      return;
    }
    opts.defaultParkGroup().then(
      (tenantId) => {
        if (!tenantId) {
          res.status(403).json(HR_DIRECTORY_NO_DEFAULT_PARK_GROUP);
          return;
        }
        res.locals.hrDirectoryParkGroup = tenantId;
        opts.sharedRateLimit(req, res, next);
      },
      (error: unknown) => next(error),
    );
  };
}

/** The park group an HR directory read answers for. Set by `requireHrDirectoryCaller`. */
export function hrDirectoryParkGroupOf(res: Response): string {
  const tenantId = res.locals.hrDirectoryParkGroup as string | undefined;
  if (!tenantId) throw new Error("hrDirectoryParkGroupOf called on a route without requireHrDirectoryCaller");
  return tenantId;
}
