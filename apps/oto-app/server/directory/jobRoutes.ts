import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { JobsMode } from "../lib/routeFences";
import {
  JOBS_INPROCESS_REFUSAL,
  JOB_NOT_FOUND_REFUSAL,
  JOB_RUNNING_REFUSAL,
  PARK_GROUP_NOT_FOUND_REFUSAL,
  isNightJobName,
  type NightBatchResult,
  type NightJobAnswer,
  type NightJobName,
} from "../lib/nightJobs";
import { holdNightBatch } from "../lib/nightBatchLock";
import { directoryClientOf, requireDirectoryClient } from "./clientAuth";

/**
 * The app's night work, run for the platform's job runner (S2-17b round 3,
 * plan section 5 "The app's jobs on the platform runner"):
 *
 *   POST /api/directory/jobs/:name/run      name: midnight | reconcile | presence
 *                                           | attention | no_show (round 4b)
 *
 * Authenticated by a tenant-bound directory key carrying `jobs:run`
 * (`clientAuth.ts`), never the shared HR key. The batch runs for the key's
 * park group only, synchronously, and the answer is a summary of each step
 * (`lib/nightJobs.ts`): its counts, and — for every error the step swallowed
 * or let escape — the error in words. A run with a failed step answers 200
 * with `ok: false`; the request did what it was asked, and the platform
 * records the run as failed.
 *
 * In order:
 *   - no key 401; a key this app did not issue, or one without `jobs:run`, 403;
 *   - while this app runs its own timers (`OTOAPP_JOBS=inprocess`), 409 in
 *     words: the platform may not run the same batch beside them;
 *   - a body other than `{}` or `{ "tenantId": "<uuid>" }` 400;
 *   - a job name that is not one of the five 404;
 *   - a body naming a park group other than the key's 404 — the same answer a
 *     key gets for another tenant's event: a key confines a caller to its own
 *     park group, and the platform names the park group it means so a key
 *     configured against the wrong one is refused rather than run;
 *   - the same park group's same batch already running 409: never twice at
 *     once, whoever asks (a session-level advisory lock on a connection of its
 *     own, held for the run and released after it — `lib/nightBatchLock.ts`,
 *     the lock the app's own timers take too).
 *
 * The pool and the batch runner are passed in, as `directoryEventRouter` takes
 * its pool, so the routes can be mounted on a bare server in a test.
 */

export interface NightJobRunner {
  run(name: NightJobName, tenantId: string): Promise<NightBatchResult>;
}

const bodySchema = z
  .object({ tenantId: z.string().uuid().optional() })
  .strict();

const invalid = (res: Response, error: z.ZodError) =>
  res.status(400).json({ error: "Validation error", message: "The request body is not valid", details: error.flatten() });

export function directoryJobRouter(pool: Pool, opts: { mode: JobsMode; jobs: NightJobRunner }): Router {
  const router = Router();
  const auth = requireDirectoryClient(pool, "jobs:run");

  router.post("/api/directory/jobs/:name/run", auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (opts.mode !== "platform") return res.status(409).json(JOBS_INPROCESS_REFUSAL);
      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, parsed.error);
      const name = req.params.name;
      if (!isNightJobName(name)) return res.status(404).json(JOB_NOT_FOUND_REFUSAL);
      const client = directoryClientOf(res);
      if (parsed.data.tenantId && parsed.data.tenantId.toLowerCase() !== client.tenantId.toLowerCase()) {
        return res.status(404).json(PARK_GROUP_NOT_FOUND_REFUSAL);
      }

      const release = await holdNightBatch(pool, name, client.tenantId);
      if (!release) return res.status(409).json(JOB_RUNNING_REFUSAL);
      const startedAt = new Date();
      let result: NightBatchResult;
      try {
        result = await opts.jobs.run(name, client.tenantId);
      } finally {
        await release();
      }
      const answer: NightJobAnswer = {
        job: name,
        tenantId: client.tenantId,
        ok: result.ok,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        steps: result.steps,
      };
      return res.status(200).json(answer);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
