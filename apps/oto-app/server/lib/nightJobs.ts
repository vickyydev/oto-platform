import { scrubText } from "./telemetry/redact";

/**
 * The app's night work, as the platform's job runner asks for it (S2-17b
 * round 3, plan section 5 "The app's jobs on the platform runner").
 *
 * The app has always run three batches on its own timers
 * (`server/scheduled-jobs.ts`): at 00:01 Bangkok, at 03:00 Bangkok, and a
 * presence check every six hours. Under `OTOAPP_JOBS=platform` those timers
 * are not started, and the platform's runner calls
 * `POST /api/directory/jobs/:name/run` instead, once per park group, with a
 * directory key bound to that park group (`server/directory/jobRoutes.ts`).
 *
 * This file holds what both sides of that call agree on — the job names, the
 * shape of an answer, and the words a refusal is given in — and nothing that
 * reaches the database, so the platform's tests can load it without the app's
 * dependency tree.
 */

export type NightJobName = "midnight" | "reconcile" | "presence";

export const NIGHT_JOB_NAMES: readonly NightJobName[] = ["midnight", "reconcile", "presence"];

export function isNightJobName(value: string): value is NightJobName {
  return (NIGHT_JOB_NAMES as readonly string[]).includes(value);
}

/**
 * What the app's own batch does when this step fails — read from the app, not
 * chosen here:
 *
 *  - `continue`: the step catches its own error, logs it and returns, so the
 *    batch goes on to the next step. Every step but one is written this way.
 *  - `stop`: the step's error is not caught. In the app it escapes the batch,
 *    so nothing after it runs — and, because `scheduleDaily` re-arms its timer
 *    only after the batch returns, the in-process schedule stops with it.
 *    `availabilityCleanup`, the last step of the 03:00 batch, is the only one.
 */
export type OnStepFailure = "continue" | "stop";

/** One step of a batch, as the endpoint answers it. */
export interface NightStepResult {
  /** The step's name, e.g. `autoClockOut`. */
  step: string;
  /** False when the step failed, or did not run because an earlier step stopped the batch. */
  ok: boolean;
  onFailure: OnStepFailure;
  /** What the step did (or got through before it failed): counts only, never a name. */
  counts: Record<string, number>;
  /** The error the app swallowed or let escape, in words, scrubbed of phone numbers and emails. */
  error?: string;
  /** True when an earlier `stop` step failed, so this one never ran — as in the app. */
  skipped?: boolean;
}

/** One park group's run of one batch. */
export interface NightBatchResult {
  /** Every step succeeded. */
  ok: boolean;
  steps: NightStepResult[];
}

/** The endpoint's answer: the batch it ran, whose it was, and each step. */
export interface NightJobAnswer extends NightBatchResult {
  job: NightJobName;
  tenantId: string;
  startedAt: string;
  finishedAt: string;
}

// --- The refusals, in the directory API's `{ error, message }` shape ---------

/** While this app runs its own timers, the platform may not run the same batches beside them. */
export const JOBS_INPROCESS_REFUSAL = {
  error: "jobs_inprocess",
  message:
    "This OTO App runs its own night work (OTOAPP_JOBS=inprocess), so the platform may not run it as well. Set OTOAPP_JOBS=platform on the OTO App first.",
} as const;

/** The same park group's batch is already running: it is never started twice at once. */
export const JOB_RUNNING_REFUSAL = {
  error: "job_running",
  message: "This park group's batch is already running, so it was not started a second time.",
} as const;

export const JOB_NOT_FOUND_REFUSAL = {
  error: "job_not_found",
  message: `There is no night job of that name. The night jobs are ${NIGHT_JOB_NAMES.join(", ")}.`,
} as const;

/** The park group the request names is not the key's: the same answer as another tenant's event. */
export const PARK_GROUP_NOT_FOUND_REFUSAL = {
  error: "park_group_not_found",
  message: "Park group not found",
} as const;

/** The longest error text one step answers with. */
const MAX_ERROR_WORDS = 300;

/**
 * An error the app caught, as words a person on the Failures page can read:
 * the message only (never a stack), scrubbed of phone numbers and emails the
 * way every log line of this app is, and cut short.
 */
export function errorWords(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || error.name || "Error"
      : typeof error === "string"
        ? error
        : "Unknown error";
  const text = scrubText(raw.replace(/\s+/g, " ").trim()) || "Unknown error";
  return text.length > MAX_ERROR_WORDS ? `${text.slice(0, MAX_ERROR_WORDS)}…` : text;
}
