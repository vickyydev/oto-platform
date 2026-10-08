import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { account, appTenantAnchors, opsRun, type Db } from '@oto/db';
import { isoDateInTz, wallClockMinutesInTz } from '@oto/shared';
import { AppError } from '../lib/errors';
import { JobFailedError } from './job-failure';
import { recordRun, scrubDetail } from './ops';
import {
  NIGHT_JOB_RUNNING,
  type NightStepAnswer,
  type OtoAppJobsClient,
  type OtoAppNightJob,
} from './otoapp-directory';
import { listAppEmployees, listAppParkGroups, otoAppEmployeesInstalled } from './otoapp-employees';
import { withTx, type Exec } from './tx';

/**
 * THE OTO APP'S NIGHT WORK, ON THIS PLATFORM'S RUNNER (S2-17b round 3; PLAN
 * section 5 "The app's jobs on the platform runner", hazards H7 to H9, Q4).
 *
 * The app ran three batches on in-process timers with no lock: a batch could
 * run twice (two instances), be lost (the process down at 00:01), or fail
 * without anyone hearing (every step catches, logs and carries on). Under
 * `OTOAPP_JOBS=platform` the app starts no timer, and these three jobs run
 * the batches instead, one park group at a time, through the app's directory
 * job endpoint (`POST /api/directory/jobs/:name/run`, a `jobs:run` key per
 * park group, `OTOAPP_JOBS_KEYS`):
 *
 *  - `job:otoapp.midnight` — the 00:01 batch: guests still checked in are
 *    checked out, missing clock-outs are closed at midnight, the day's
 *    recurring tasks are made.
 *  - `job:otoapp.reconcile` — the 03:00 batch: presence repaired, leavers
 *    moved to Left and their OTO App logins switched off, old availability
 *    records cleared; then the leavers whose PLATFORM account is still active
 *    are listed on Failures (below).
 *  - `job:otoapp.presence` — the presence check, every six hours.
 *
 * ONCE PER BANGKOK DATE. The runner only knows intervals
 * (`services/jobs.ts`), so the two daily batches tick every five minutes and
 * run a park group's batch only when Bangkok time is past the batch's hour and
 * no run has recorded that park group's batch done for that date. The record
 * is the run itself: each run's detail names the date and, per park group,
 * whether its batch finished (`groups[].ok`). A failed park group is not done,
 * so the next tick runs it again (H9); a done one is never run again that day
 * (H8, "two batches for one date: one success"). Both jobs are `exclusive` in
 * the runner, so the read of "done" and the record of "done" happen under one
 * lock even when Run now is pressed beside the schedule.
 *
 * EVERY SWALLOWED ERROR IS A FAILED STEP. The app answers each step with its
 * counts and, for an error it caught, the error in words. A park group with a
 * failed step, a refusal or no answer at all fails the run: the error names
 * each park group and step, the detail keeps every step, and Retry on
 * Failures runs the job again — which, for a daily batch, runs only the park
 * groups not yet done.
 *
 * A PARK GROUP NOBODY RUNS FAILS EVERY RUN (review F1). The switch is the
 * app's, not a park group's: under `OTOAPP_JOBS=platform` the app starts no
 * timer for ANY park group. So every run, once its keyed park groups are
 * done, reads the park groups the app holds staff in (the employee
 * repository, `otoapp-employees.ts`) and fails naming each one this
 * deployment holds no key for (`OTOAPP_NIGHT_JOB_UNKEYED`) — at every tick,
 * so Failures and the `ops.failing` alert see it until the key is added. The
 * keyed park groups still run and are still recorded done.
 *
 * "ALREADY RUNNING" TWICE IS A FAILURE (review F3). The app answers 409
 * `job_running` while it holds a park group's batch. Once, it is a call that
 * timed out still finishing (`locked`, not done, not failed: the next tick
 * asks again). Still so at a later tick of the same date — or, for the
 * six-hourly check, at the run after — the batch it holds has not finished
 * since, and the run fails with `OTOAPP_JOB_RUNNING` rather than stay green
 * all night while nothing is done.
 *
 * A deployment with no OTO App to run (no `OTOAPP_DIRECTORY_URL` or no
 * `OTOAPP_JOBS_KEYS`) runs each job as a no-op that says so: holding no key,
 * it has not taken the night work over, and the app's own timers run it
 * (`inprocess`, the app's default). One that holds keys but whose database
 * has no employee view of the app runs its keyed park groups and says that
 * no park group without a key could be looked for.
 */

export const OTOAPP_MIDNIGHT_JOB = 'job:otoapp.midnight';
export const OTOAPP_RECONCILE_JOB = 'job:otoapp.reconcile';
export const OTOAPP_PRESENCE_JOB = 'job:otoapp.presence';

/** The integration record a still-active leaver's platform account is filed under (Q4). */
export const OTOAPP_DEPARTED_ACCOUNT_RUN = 'otoapp:account.departed';
export const DEPARTED_ACCOUNT_CASE = 'OTOAPP_DEPARTED_ACCOUNT_ACTIVE';

const DEPARTED_ACCOUNT_WORDS =
  "This person's last working day in the OTO App has passed. The OTO App switches off only its own login for a leaver; their platform account is still active, so the launcher and the till still let them in. If they have left, deactivate the account on the Console's Login users page.";

const BANGKOK = 'Asia/Bangkok';

export interface NightJobSpec {
  /** The job's name in `ops_run`, `ops_last` and the alert key. */
  job: string;
  /** The app's name for the batch. */
  name: OtoAppNightJob;
  /** Bangkok minutes past midnight after which the day's batch is due; null for the six-hourly check. */
  dueAfterMinute: number | null;
  /** The batch's hour, as the Health page and the run say it. */
  at: string | null;
}

export const OTOAPP_NIGHT_JOBS: Record<OtoAppNightJob, NightJobSpec> = {
  midnight: { job: OTOAPP_MIDNIGHT_JOB, name: 'midnight', dueAfterMinute: 1, at: '00:01' },
  reconcile: { job: OTOAPP_RECONCILE_JOB, name: 'reconcile', dueAfterMinute: 3 * 60, at: '03:00' },
  presence: { job: OTOAPP_PRESENCE_JOB, name: 'presence', dueAfterMinute: null, at: null },
};

/** What became of one park group in one run. */
export interface NightGroupSummary {
  tenantId: string;
  /**
   *  - `ran`: the app ran the batch and every step finished;
   *  - `done`: the batch already finished for this date, so it was not run again;
   *  - `locked`: the app is running this park group's batch for somebody else
   *    right now, so it was not started twice (not done, not failed) — the
   *    first time; answered so again at a later tick, it is `failed`
   *    (`OTOAPP_JOB_RUNNING`, review F3);
   *  - `failed`: a step failed, the app refused, nothing answered, the batch
   *    was still running at a second tick, or the app holds staff in this
   *    park group and this deployment holds no key for it
   *    (`OTOAPP_NIGHT_JOB_UNKEYED`, review F1).
   */
  outcome: 'ran' | 'done' | 'locked' | 'failed';
  /** The batch is done for this run's date. What the next tick reads. */
  ok: boolean;
  /** The app's steps, as it answered them. */
  steps?: NightStepAnswer[];
  /** Why the park group failed: the code the Failures page groups by. */
  code?: string;
  /** Why the park group failed, in words: a refusal's code and message, or the failed steps. */
  error?: string;
  /** The reconcile batch only: the leavers whose platform account is still active (Q4). */
  departedAccounts?: DepartedAccounts;
}

/** The leavers a reconcile run filed, or why it could file none. */
export interface DepartedAccounts {
  listed: number;
  accountIds: string[];
  /** Why nobody could be read or settled for this park group. */
  reason?: string;
  error?: string;
}

export interface NightJobSummary extends Record<string, unknown> {
  /** False on a deployment with no OTO App night work to run: nothing was called. */
  configured: boolean;
  job: OtoAppNightJob;
  /** The Bangkok date a daily batch ran for; null for the six-hourly check and for a no-op. */
  date: string | null;
  /** Whether anything was due this tick. */
  due: boolean;
  /** Why nothing ran, in words, when nothing did. */
  reason?: string;
  groups: NightGroupSummary[];
  /** Park groups that failed this run. */
  failed: number;
  /** Still-active leavers' accounts filed on Failures by this run (the reconcile batch). */
  departedAccountsRaised: number;
  /**
   * Review F1: the park groups the app holds staff in, held against the keys
   * this deployment holds — on a run that was due. Each `unkeyed` one is a
   * failed park group of the run too. `checked` false with a `reason` where
   * the app publishes no employee view here, with an `error` where the list
   * could not be read (which fails the run: nobody can say none is missed).
   */
  parkGroups?: ParkGroupCheck;
}

export interface ParkGroupCheck {
  checked: boolean;
  /** How many park groups the app holds staff in. */
  held?: number;
  /** Those this deployment holds no jobs key for: nothing runs their night. */
  unkeyed: string[];
  reason?: string;
  error?: string;
}

// --- The forced failure (a staging test control) ----------------------------

/**
 * Armed by the Console's "Fail the OTO App's presence check once" (an
 * `OPS_TEST_CONTROLS` control, routes/ops.ts) for the one run it then starts:
 * that run fails before anything is sent to the app, so the failure can be
 * watched on Failures and its Retry seen to succeed. Process-local and
 * one-shot; the control disarms it whatever happens.
 */
const forcedFailures = new Set<OtoAppNightJob>();

export function armForcedNightJobFailure(name: OtoAppNightJob): void {
  forcedFailures.add(name);
}

export function disarmForcedNightJobFailure(name: OtoAppNightJob): void {
  forcedFailures.delete(name);
}

export const FORCED_FAILURE_CODE = 'OTOAPP_JOB_FORCED_FAILURE';
/** A park group whose batch answered with a failed step. */
export const NIGHT_STEP_FAILED = 'OTOAPP_NIGHT_STEP_FAILED';
/** The app's batch finished, but the platform's leaver listing did not. */
export const DEPARTED_LISTING_FAILED = 'OTOAPP_DEPARTED_LISTING_FAILED';
/** The app holds staff in a park group this deployment holds no jobs key for (review F1). */
export const NIGHT_JOB_UNKEYED = 'OTOAPP_NIGHT_JOB_UNKEYED';

const UNKEYED_WORDS =
  "the OTO App holds staff in this park group, but this deployment holds no jobs:run key for it in OTOAPP_JOBS_KEYS. While the platform runs the app's night work (OTOAPP_JOBS=platform) the app runs none of its own, for any park group, so nothing runs this one's night: issue it a jobs:run key in the OTO App and add it to OTOAPP_JOBS_KEYS, then redeploy the api, which reads the keys only when it starts";

/** The unkeyed park groups, as one clause of the run's error. */
const unkeyedLine = (ids: string[]): string =>
  ids.length === 1
    ? `park group ${ids[0]}: ${NIGHT_JOB_UNKEYED}: the OTO App holds staff there, but this deployment holds no jobs:run key for it (OTOAPP_JOBS_KEYS), so nothing runs its night; add the key and redeploy the api, which reads the keys only when it starts`
    : `park groups ${ids.join(', ')}: ${NIGHT_JOB_UNKEYED}: the OTO App holds staff there, but this deployment holds no jobs:run key for them (OTOAPP_JOBS_KEYS), so nothing runs their nights; add the keys and redeploy the api, which reads the keys only when it starts`;

// --- The run -----------------------------------------------------------------

/** Bangkok midnight of a yyyy-mm-dd date, as an instant. Thailand keeps no summer time. */
const bangkokMidnight = (date: string): Date => new Date(`${date}T00:00:00+07:00`);

/**
 * The park groups whose batch a run already recorded done for a date. Read
 * from the job's own runs, failed ones included: a run that failed for one
 * park group may well have finished another.
 */
export async function nightGroupsDone(db: Exec, job: string, date: string): Promise<Set<string>> {
  const rows = await db
    .select({ detail: opsRun.detail })
    .from(opsRun)
    .where(
      and(
        eq(opsRun.kind, 'job'),
        eq(opsRun.name, job),
        sql`${opsRun.detail} @> ${JSON.stringify({ date, groups: [{ ok: true }] })}::jsonb`,
      ),
    );
  const done = new Set<string>();
  for (const { detail } of rows) {
    const groups = (detail as { groups?: unknown } | null)?.groups;
    if (!Array.isArray(groups)) continue;
    for (const g of groups as Array<{ tenantId?: unknown; ok?: unknown }>) {
      if (g?.ok === true && typeof g.tenantId === 'string') done.add(g.tenantId);
    }
  }
  return done;
}

/** A refusal or a failed step, as one line: code and words, scrubbed. */
const words = (text: string): string => String(scrubDetail(text)).slice(0, 300);

function failedStepsLine(steps: NightStepAnswer[]): string {
  return steps
    .filter((s) => !s.ok)
    .map((s) =>
      s.skipped
        ? `${s.step} did not run (an earlier step stopped the batch)`
        : `${s.step} failed (the batch ${s.onFailure === 'stop' ? 'stopped there' : 'carried on'}): ${s.error ?? 'no words given'}`,
    )
    .join('; ');
}

/**
 * Run one of the app's batches for every park group this deployment holds a
 * key for. What the three jobs run; its answer is the run's detail. Throws a
 * `JobFailedError` carrying that detail when any park group failed.
 */
export async function runOtoAppNightJob(
  deps: { db: Db; client: OtoAppJobsClient },
  name: OtoAppNightJob,
  now: Date,
): Promise<NightJobSummary> {
  const spec = OTOAPP_NIGHT_JOBS[name];
  const { db, client } = deps;

  if (forcedFailures.delete(name)) {
    throw new JobFailedError(
      FORCED_FAILURE_CODE,
      'Deliberate failure, from the Console test controls. Nothing was sent to the OTO App; Retry runs the job for real.',
      { deliberate: true, job: name },
    );
  }

  const summary: NightJobSummary = {
    configured: client.configured,
    job: name,
    date: null,
    due: false,
    groups: [],
    failed: 0,
    departedAccountsRaised: 0,
  };

  if (!client.configured) {
    summary.reason =
      'No OTO App park group has handed its night work to this platform: OTOAPP_DIRECTORY_URL or OTOAPP_JOBS_KEYS is not set, so nothing was run here.';
    return summary;
  }

  let done = new Set<string>();
  if (spec.dueAfterMinute !== null) {
    const date = isoDateInTz(now, BANGKOK);
    summary.date = date;
    if (wallClockMinutesInTz(now, BANGKOK) < spec.dueAfterMinute) {
      summary.reason = `Not due before ${spec.at} Bangkok time.`;
      return summary;
    }
    done = await nightGroupsDone(db, spec.job, date);
  }
  summary.due = true;

  for (const tenantId of client.tenantIds) {
    if (done.has(tenantId)) {
      summary.groups.push({ tenantId, outcome: 'done', ok: true });
      continue;
    }
    const answer = await client.run(name, tenantId);
    if (!answer.ok) {
      if (answer.code === NIGHT_JOB_RUNNING) {
        // Review F3: once is a call still finishing; twice is a batch that
        // has not finished since, and nothing else would ever say so.
        if (await answeredRunningBefore(db, spec.job, tenantId, summary.date)) {
          summary.groups.push({
            tenantId,
            outcome: 'failed',
            ok: false,
            code: NIGHT_JOB_RUNNING,
            error: `${NIGHT_JOB_RUNNING}: the OTO App answered "already running" for this park group at an earlier tick${
              summary.date ? ` of ${summary.date}` : ''
            } too, so the batch it holds has not finished since and the ${spec.at ? 'night' : 'check'} is not done; a batch that never returns keeps holding it`,
          });
        } else {
          summary.groups.push({ tenantId, outcome: 'locked', ok: false });
        }
        continue;
      }
      summary.groups.push({
        tenantId,
        outcome: 'failed',
        ok: false,
        code: answer.code,
        error: `${answer.code}: ${words(answer.message)}`,
      });
      continue;
    }
    const steps = answer.body.steps.map((s) => ({ ...s, ...(s.error ? { error: words(s.error) } : {}) }));
    if (!answer.body.ok || steps.some((s) => !s.ok)) {
      summary.groups.push({
        tenantId,
        outcome: 'failed',
        ok: false,
        steps,
        code: NIGHT_STEP_FAILED,
        error: failedStepsLine(steps) || 'the OTO App answered the batch as not ok',
      });
      continue;
    }
    const group: NightGroupSummary = { tenantId, outcome: 'ran', ok: true, steps };
    if (name === 'reconcile') {
      try {
        const listed = await raiseDepartedAccounts(db, tenantId, summary.date ?? isoDateInTz(now, BANGKOK));
        group.departedAccounts = listed;
        summary.departedAccountsRaised += listed.listed;
      } catch (err) {
        // The app's batch finished, but the platform's own step did not: the
        // park group is not done, so the next tick runs both again (the app's
        // batch is safe to repeat; its second run finds nothing to change).
        const message = err instanceof Error ? err.message : String(err);
        group.outcome = 'failed';
        group.ok = false;
        group.code = DEPARTED_LISTING_FAILED;
        group.departedAccounts = { listed: 0, accountIds: [], error: words(message) };
        group.error = `the platform's departedAccounts step failed: ${words(message)}`;
      }
    }
    summary.groups.push(group);
  }

  // Review F1: after the keyed park groups, so a list that cannot be read
  // never costs them their night.
  summary.parkGroups = await checkParkGroups(db, client.tenantIds);
  for (const tenantId of summary.parkGroups.unkeyed) {
    summary.groups.push({
      tenantId,
      outcome: 'failed',
      ok: false,
      code: NIGHT_JOB_UNKEYED,
      error: `${NIGHT_JOB_UNKEYED}: ${UNKEYED_WORDS}`,
    });
  }

  const failed = summary.groups.filter((g) => g.outcome === 'failed');
  summary.failed = failed.length;
  const unreadable = summary.parkGroups.error;
  if (failed.length > 0 || unreadable) {
    // The Failures page groups by code: the first failed keyed park group's,
    // or, when only the check failed, the check's.
    const keyedFailed = failed.filter((g) => g.code !== NIGHT_JOB_UNKEYED);
    const code = keyedFailed.length > 0 ? keyedFailed[0]!.code ?? 'OTOAPP_NIGHT_JOB_FAILED' : NIGHT_JOB_UNKEYED;
    const parts = keyedFailed.map((g) => `park group ${g.tenantId}: ${g.error ?? 'failed'}`);
    if (summary.parkGroups.unkeyed.length > 0) parts.push(unkeyedLine(summary.parkGroups.unkeyed));
    if (unreadable) {
      parts.push(
        `${NIGHT_JOB_UNKEYED}: the park groups the OTO App holds staff in could not be read, so one this deployment holds no key for cannot be ruled out: ${unreadable}`,
      );
    }
    const message = `OTO App ${spec.at ? `${spec.at} ` : ''}${name} batch${summary.date ? ` for ${summary.date}` : ''}: ${parts.join('. ')}`;
    throw new JobFailedError(code, message.slice(0, 500), summary);
  }
  return summary;
}

/**
 * Review F1: the park groups the app holds staff in that this deployment holds
 * no key for. Read through the employee repository, the platform's one window
 * on the app's staff.
 */
async function checkParkGroups(db: Db, keyed: readonly string[]): Promise<ParkGroupCheck> {
  let held: string[] | null;
  try {
    held = await listAppParkGroups(db);
  } catch (err) {
    return { checked: false, unkeyed: [], error: words(err instanceof Error ? err.message : String(err)) };
  }
  if (held === null) {
    return {
      checked: false,
      unkeyed: [],
      reason: 'The OTO App publishes no employee view here, so no park group without a key could be looked for.',
    };
  }
  const ours = new Set(keyed.map((t) => t.toLowerCase()));
  return { checked: true, held: held.length, unkeyed: held.filter((t) => !ours.has(t)) };
}

/**
 * Review F3: did an earlier run find this park group's batch already running?
 * A daily batch asks every run of the same date; the six-hourly check asks the
 * last run that asked the app for this park group at all.
 */
async function answeredRunningBefore(db: Exec, job: string, tenantId: string, date: string | null): Promise<boolean> {
  if (date !== null) {
    const [hit] = await db
      .select({ id: opsRun.id })
      .from(opsRun)
      .where(
        and(
          eq(opsRun.kind, 'job'),
          eq(opsRun.name, job),
          sql`${opsRun.detail} @> ${JSON.stringify({ date, groups: [{ tenantId, outcome: 'locked' }] })}::jsonb`,
        ),
      )
      .limit(1);
    return hit !== undefined;
  }
  const [last] = await db
    .select({ detail: opsRun.detail })
    .from(opsRun)
    .where(
      and(
        eq(opsRun.kind, 'job'),
        eq(opsRun.name, job),
        sql`${opsRun.detail} @> ${JSON.stringify({ groups: [{ tenantId }] })}::jsonb`,
      ),
    )
    .orderBy(desc(opsRun.startedAt))
    .limit(1);
  const groups = (last?.detail as { groups?: NightGroupSummary[] } | null | undefined)?.groups ?? [];
  const before = groups.find((g) => g.tenantId === tenantId);
  return before !== undefined && (before.outcome === 'locked' || before.code === NIGHT_JOB_RUNNING);
}

// --- Q4: a leaver's platform account ----------------------------------------

/**
 * The app's 03:00 batch switches off a leaver's OTO App login once their last
 * working day has passed (`runDepartedAccountDeactivation`, the app's rule:
 * `last_working_day` before today's Bangkok midnight). Their platform account
 * — the launcher, the till — is not the app's to switch off, and stays on by
 * design (plan Q4, the app's behaviour as the default). So, after the batch
 * has run for a park group, each of its leavers whose platform account is
 * still `active` is filed on Failures for an administrator to decide.
 *
 * Read through the employee repository (`otoapp-employees.ts`): the leaver's
 * account is the one the app's own user-to-employee rule names
 * (`platform_user_id`), the same rule the employee copy and the booth roster
 * use (H24). And as for the copy (H23), a link counts only when the account
 * belongs to the operator the park group is anchored to; any other is the
 * copy's `OTOAPP_FOREIGN_ACCOUNT_LINK` case, not this one.
 *
 * Filed every night the batch runs while it stands, as the copy files its
 * standing cases (Q17). Answers how many were filed, and their account ids.
 */
export async function raiseDepartedAccounts(db: Db, tenantId: string, date: string): Promise<DepartedAccounts> {
  if (!(await otoAppEmployeesInstalled(db))) {
    return { listed: 0, accountIds: [], reason: 'The OTO App publishes no employee view here, so no leaver could be read.' };
  }
  const operators = (await appTenantAnchors(db)).get(tenantId) ?? [];
  if (operators.length !== 1) {
    return {
      listed: 0,
      accountIds: [],
      reason:
        operators.length === 0
          ? 'This park group is mapped to no branch of any operator, so no account can be its.'
          : "This park group is mapped to two operators' branches, so no account is settled as its.",
    };
  }
  const operatorId = operators[0]!;
  const midnight = bangkokMidnight(date);
  const leavers = (await listAppEmployees(db)).filter(
    (e) =>
      e.tenantId === tenantId &&
      e.platformUserId !== null &&
      e.lastWorkingDay !== null &&
      e.lastWorkingDay.getTime() < midnight.getTime(),
  );
  if (leavers.length === 0) return { listed: 0, accountIds: [] };

  const ids = [...new Set(leavers.map((e) => e.platformUserId!))];
  const active = await db
    .select({ id: account.id })
    .from(account)
    .where(and(inArray(account.id, ids), eq(account.operatorId, operatorId), eq(account.status, 'active')));
  const stillOn = new Set(active.map((a) => a.id));

  const accountIds: string[] = [];
  for (const leaver of leavers) {
    const accountId = leaver.platformUserId!;
    if (!stillOn.has(accountId) || accountIds.includes(accountId)) continue;
    accountIds.push(accountId);
    const at = new Date();
    // The case and its `ops_last` line together, on the pool, in a
    // transaction of its own: it outlives the run that found it.
    await withTx(db, { actorAccountId: null, operatorId }, 'otoapp.departed_account_raise', (tx) =>
      recordRun(tx, {
        kind: 'integration',
        name: OTOAPP_DEPARTED_ACCOUNT_RUN,
        outcome: 'failed',
        startedAt: at,
        finishedAt: at,
        operatorId,
        detail: {
          case: DEPARTED_ACCOUNT_CASE,
          accountId,
          externalId: leaver.id,
          tenantId,
          date,
        },
        error: new AppError(409, DEPARTED_ACCOUNT_CASE, DEPARTED_ACCOUNT_WORDS),
      }),
    );
  }
  return { listed: accountIds.length, accountIds };
}

// --- What a Console press says ------------------------------------------------

/**
 * The newest run of one of these jobs, in a sentence for the person who just
 * pressed Run now: what ran, what was already done, or why nothing was due.
 */
export async function describeLatestNightRun(db: Exec, name: OtoAppNightJob): Promise<string | null> {
  const spec = OTOAPP_NIGHT_JOBS[name];
  const [run] = await db
    .select({ outcome: opsRun.outcome, detail: opsRun.detail, errorMessage: opsRun.errorMessage })
    .from(opsRun)
    .where(and(eq(opsRun.kind, 'job'), eq(opsRun.name, spec.job)))
    .orderBy(desc(opsRun.startedAt))
    .limit(1);
  if (!run) return null;
  const detail = (run.detail ?? {}) as Partial<NightJobSummary>;
  if (run.outcome === 'failed') return run.errorMessage ?? 'It failed; the run is on Failures.';
  if (detail.configured === false) return 'No OTO App park group has handed its night work to this platform, so nothing ran.';
  if (detail.due === false) return detail.reason ?? 'Nothing was due.';
  const groups = detail.groups ?? [];
  const count = (o: NightGroupSummary['outcome']) => groups.filter((g) => g.outcome === o).length;
  const parts = [
    count('ran') ? `ran for ${count('ran')} park group${count('ran') === 1 ? '' : 's'}` : null,
    count('done') ? `${count('done')} already done${detail.date ? ` for ${detail.date}` : ''}` : null,
    count('locked') ? `${count('locked')} already running elsewhere` : null,
  ].filter(Boolean);
  const departed = detail.departedAccountsRaised ?? 0;
  return `${parts.join(', ') || 'no park group to run'}${
    departed ? `; ${departed} leaver account${departed === 1 ? '' : 's'} still active, listed on Failures` : ''
  }.`;
}
