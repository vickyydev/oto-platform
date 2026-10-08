import { storage } from "./storage";
import { db, pool } from "./db";
import { employeeRoleAvailability, employees, users, tenants, timeEvents, scheduleAssignments, scheduleShiftRows, branches } from "@shared/schema";
import { serviceCheckins } from "./db/coreSchema";
import { lt, eq, and, isNull, isNotNull, gte, lte, desc, sql } from "drizzle-orm";
import { generateTaskInstances } from "./core/taskGeneration";
import { ATTENTION_WRITES_READY } from "./attention-availability";
import { JOBS_MODE } from "./config/env";
import type { JobsMode } from "./lib/routeFences";
import {
  errorWords,
  type NightBatchResult,
  type NightJobName,
  type NightStepResult,
  type OnStepFailure,
} from "./lib/nightJobs";
import { holdNightBatch } from "./lib/nightBatchLock";

/**
 * Who a night job runs for, and who hears about an error it swallows (S2-17b
 * round 3).
 *
 * The app's own timers pass nothing, and nothing changes for them: every park
 * group, and an error is logged and swallowed exactly as it always was. The
 * platform's job endpoint (`server/directory/jobRoutes.ts`) passes the park
 * group its directory key is bound to, and a listener, so an error the step
 * swallows is still named in the endpoint's answer as a failed step — the
 * step itself carries on (or stops) just as it does in-process.
 */
export interface NightJobOptions {
  /** Only this park group's rows. Unset: every park group, as the app's own timers run it. */
  tenantId?: string;
  /** Told about every error the step catches. The step still logs it and carries on. */
  onError?: (error: unknown) => void;
}

const THAILAND_OFFSET_MS = 7 * 60 * 60 * 1000;

function getThailandTimeParts(): { hour: number; minute: number; second: number; millisecond: number } {
  const utcNow = Date.now();
  const thailandMs = utcNow + THAILAND_OFFSET_MS;
  const hour = Math.floor((thailandMs / (60 * 60 * 1000)) % 24);
  const minute = Math.floor((thailandMs / (60 * 1000)) % 60);
  const second = Math.floor((thailandMs / 1000) % 60);
  const millisecond = thailandMs % 1000;
  return { hour, minute, second, millisecond };
}

function getThailandMidnightUTC(): Date {
  const utcNow = Date.now();
  const thailandMs = utcNow + THAILAND_OFFSET_MS;
  const msSinceMidnight = thailandMs % (24 * 60 * 60 * 1000);
  const thailandMidnightInUtc = utcNow - msSinceMidnight;
  return new Date(thailandMidnightInUtc);
}

interface ReconciliationSummary {
  stuckClockIns: number;
  presenceMismatches: number;
  repairs: number;
  anomalies: number;
  statusTransitions: number;
}

export async function runPresenceReconciliation(opts: NightJobOptions = {}): Promise<ReconciliationSummary> {
  console.log("[RECONCILIATION] Starting presence reconciliation job...");
  const summary: ReconciliationSummary = {
    stuckClockIns: 0,
    presenceMismatches: 0,
    repairs: 0,
    anomalies: 0,
    statusTransitions: 0,
  };

  try {
    const stuckHoursThreshold = 18;
    const stuckPresences = await storage.getStuckClockIns(stuckHoursThreshold, opts.tenantId);
    summary.stuckClockIns = stuckPresences.length;

    for (const presence of stuckPresences) {
      if (ATTENTION_WRITES_READY) await storage.createAttentionItem({
        tenantId: presence.tenantId,
        type: 'TIMEKEEPING_STUCK_CLOCK_IN',
        severity: 'high',
        employeeId: presence.employeeId,
        branchId: presence.currentWorkBranchId || undefined,
        title: `Stuck clock-in: over ${stuckHoursThreshold} hours`,
        description: `Employee has been clocked in for over ${stuckHoursThreshold} hours without clocking out. Last clock-in: ${presence.lastInAt?.toISOString() || 'unknown'}`,
      });
      summary.anomalies++;
    }

    const repairResult = await storage.repairPresenceMismatches(opts.tenantId);
    summary.presenceMismatches = repairResult.mismatches;
    summary.repairs = repairResult.repairs;
    summary.anomalies += repairResult.anomalies;

    console.log(`[RECONCILIATION] Complete - Stuck: ${summary.stuckClockIns}, Mismatches: ${summary.presenceMismatches}, Repairs: ${summary.repairs}, Anomalies: ${summary.anomalies}`);
  } catch (error) {
    console.error("[RECONCILIATION] Error during reconciliation:", error);
    opts.onError?.(error);
  }

  return summary;
}

export async function runStatusTransitions(opts: NightJobOptions = {}): Promise<number> {
  console.log("[STATUS_TRANSITION] Starting LEAVING->LEFT status transition job...");
  let transitioned = 0;

  try {
    const today = getThailandMidnightUTC();
    transitioned = await storage.transitionLeavingToLeft(today, opts.tenantId);
    console.log(`[STATUS_TRANSITION] Transitioned ${transitioned} employees from LEAVING to LEFT`);
  } catch (error) {
    console.error("[STATUS_TRANSITION] Error during status transition:", error);
    opts.onError?.(error);
  }

  return transitioned;
}

/**
 * Switch off the app login of everyone whose last working day has passed.
 *
 * The 03:00 batch calls it with no tenant, across every park group, as it
 * always has. The manual trigger (`POST /api/admin/run-departed-deactivation`)
 * passes the caller's own park group, so one park group's admin never
 * switches off another's people (S2-17b round 1), and so does the platform's
 * job endpoint, for the park group its key is bound to (round 3).
 *
 * Only the app's own login: a leaver's platform account (the launcher, the
 * till) is not this app's to switch off. The platform's 03:00 run lists the
 * ones still active on its Failures page instead (plan Q4).
 */
export async function runDepartedAccountDeactivation(opts: NightJobOptions = {}): Promise<number> {
  console.log("[ACCOUNT_DEACTIVATION] Checking for departed employees with active accounts...");
  let deactivated = 0;

  try {
    const today = getThailandMidnightUTC();

    const departed = await db
      .select({ userId: employees.userId })
      .from(employees)
      .innerJoin(users, eq(employees.userId, users.id))
      .where(
        and(
          isNotNull(employees.lastWorkingDay),
          lt(employees.lastWorkingDay, today),
          isNotNull(employees.userId),
          eq(users.isActive, true),
          opts.tenantId ? eq(employees.tenantId, opts.tenantId) : undefined,
        ),
      );

    for (const row of departed) {
      await db
        .update(users)
        .set({ isActive: false })
        .where(eq(users.id, row.userId!));
      deactivated++;
    }

    console.log(`[ACCOUNT_DEACTIVATION] Deactivated ${deactivated} user account(s)`);
  } catch (error) {
    console.error("[ACCOUNT_DEACTIVATION] Error:", error);
    opts.onError?.(error);
  }

  return deactivated;
}

export async function runMidnightTimekeepingAutoClockOut(opts: NightJobOptions = {}): Promise<number> {
  console.log("[AUTO_CLOCK_OUT] Checking for employees with missing clock-out...");
  let autoClocked = 0;

  try {
    const midnight = getThailandMidnightUTC();
    // Look for IN events from before midnight that have no subsequent OUT event
    const staleIns = await db.execute(sql`
      SELECT te.id, te.employee_id, te.branch_id, te.event_time, te.tenant_id
      FROM time_events te
      WHERE te.event_type = 'IN'
        AND te.event_time < ${midnight}
        ${opts.tenantId ? sql`AND te.tenant_id = ${opts.tenantId}` : sql``}
        AND NOT EXISTS (
          SELECT 1 FROM time_events te2
          WHERE te2.employee_id = te.employee_id
            AND te2.event_type = 'OUT'
            AND te2.event_time > te.event_time
        )
      ORDER BY te.event_time DESC
    `);

    const rows = Array.isArray(staleIns) ? staleIns : (staleIns as any).rows || [];

    for (const row of rows) {
      await db.insert(timeEvents).values({
        tenantId: row.tenant_id,
        employeeId: row.employee_id,
        branchId: row.branch_id,
        eventType: "OUT",
        eventTime: midnight,
        authMethod: "FACE",
        notes: "[Auto-clocked out at midnight — missing clock-out]",
      });

      // Create attention item for the missing clock-out
      if (ATTENTION_WRITES_READY) await storage.createAttentionItem({
        tenantId: row.tenant_id,
        type: 'TIMEKEEPING_STUCK_CLOCK_IN',
        severity: 'medium',
        employeeId: row.employee_id,
        branchId: row.branch_id || undefined,
        title: `Missing clock-out — auto-clocked out at midnight`,
        description: `Employee clocked in at ${new Date(row.event_time).toISOString()} but never clocked out. An automatic clock-out at midnight was recorded.`,
      });
      autoClocked++;
    }

    console.log(`[AUTO_CLOCK_OUT] Auto-clocked out ${autoClocked} employee(s)`);
  } catch (error) {
    console.error("[AUTO_CLOCK_OUT] Error:", error);
    opts.onError?.(error);
  }

  return autoClocked;
}

function scheduleDaily(hour: number, minute: number, job: () => Promise<void>): void {
  const calculateDelayUntilThailandTime = (targetHour: number, targetMinute: number): number => {
    const { hour: currentHour, minute: currentMinute, second, millisecond } = getThailandTimeParts();
    
    let totalMinutesUntil = (targetHour * 60 + targetMinute) - (currentHour * 60 + currentMinute);
    
    if (totalMinutesUntil <= 0) {
      totalMinutesUntil += 24 * 60;
    }
    
    const currentSecondsAndMs = second * 1000 + millisecond;
    return (totalMinutesUntil * 60 * 1000) - currentSecondsAndMs;
  };
  
  const scheduleNextRun = () => {
    const delay = calculateDelayUntilThailandTime(hour, minute);
    const { hour: currentHour, minute: currentMinute } = getThailandTimeParts();
    console.log(`[SCHEDULED_JOBS] Current Bangkok time: ${currentHour}:${currentMinute.toString().padStart(2, '0')}. Next daily job in ${Math.round(delay / (60 * 1000))} minutes (at ${hour}:${minute.toString().padStart(2, '0')} Bangkok time)`);
    
    setTimeout(async () => {
      await job();
      scheduleNextRun();
    }, delay);
  };
  
  scheduleNextRun();
}

/**
 * Delete availability records older than seven days.
 *
 * The one step of a batch that does NOT catch its own error: as the app wrote
 * it, a failure here escapes the 03:00 batch (it is the batch's last step, so
 * nothing after it is lost) and, because `scheduleDaily` re-arms its timer
 * only after the batch returns, it also stops the in-process 03:00 schedule
 * until the next restart. Worse, the rejection of `scheduleDaily`'s timer
 * callback is unhandled: with SENTRY_DSN set, Sentry's handler logs it and
 * only the 03:00 timer stops; with no SENTRY_DSN nothing handles it, and Node
 * ends the WHOLE app process (plan Q26). Kept so in-process. Under the
 * platform's runner the schedule is the platform's, and the escaped error is
 * a failed step of the run (`runNightBatchForTenant`).
 *
 * It answers how many records it deleted; the app's version answered 0 every
 * time, and nothing read the answer until the platform's run detail did.
 */
export async function cleanupOldAvailabilityRecords(opts: NightJobOptions = {}): Promise<number> {
  // Delete availability records older than 7 days to keep the table clean
  // Since availability resets daily, old records are no longer needed
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoffDate = sevenDaysAgo.toISOString().split("T")[0];

  const result = await db.delete(employeeRoleAvailability)
    .where(
      and(
        lt(employeeRoleAvailability.unavailableDate, cutoffDate),
        opts.tenantId ? eq(employeeRoleAvailability.tenantId, opts.tenantId) : undefined,
      ),
    );

  console.log(`[SCHEDULED_JOBS] Cleaned up old availability records before ${cutoffDate}`);
  return result.rowCount ?? 0;
}

// Auto-checkout any in_park check-ins from before midnight (forgotten checkouts)
export async function runMidnightAutoCheckout(opts: NightJobOptions = {}): Promise<number> {
  console.log("[AUTO_CHECKOUT] Starting midnight auto-checkout for forgotten check-ins...");

  try {
    // Get Thailand midnight (start of today)
    const thailandMidnight = getThailandMidnightUTC();

    // Find all service check-ins that are still "in_park" but were created before midnight
    const staleCheckins = await db.select()
      .from(serviceCheckins)
      .where(
        and(
          eq(serviceCheckins.status, "in_park"),
          lt(serviceCheckins.checkedInAt, thailandMidnight),
          isNull(serviceCheckins.checkedOutAt),
          opts.tenantId ? eq(serviceCheckins.tenantId, opts.tenantId) : undefined,
        )
      );
    
    console.log(`[AUTO_CHECKOUT] Found ${staleCheckins.length} stale in_park check-ins`);
    
    // Auto-checkout each one
    for (const checkin of staleCheckins) {
      await db.update(serviceCheckins)
        .set({
          status: "checked_out",
          checkedOutAt: thailandMidnight, // Set checkout to midnight
          staffNotes: (checkin.staffNotes || "") + " [Auto-checked out at midnight]",
        })
        .where(eq(serviceCheckins.id, checkin.id));
    }
    
    if (staleCheckins.length > 0) {
      console.log(`[AUTO_CHECKOUT] Auto-checked out ${staleCheckins.length} forgotten check-ins`);
    }
    
    return staleCheckins.length;
  } catch (error) {
    console.error("[AUTO_CHECKOUT] Error during auto-checkout:", error);
    opts.onError?.(error);
    return 0;
  }
}

// Generate scheduled tasks for all tenants at midnight (or, from the
// platform's endpoint, for the one park group its key is bound to). It
// answers how many it made; the app's version answered nothing.
export async function runMidnightTaskGeneration(opts: NightJobOptions = {}): Promise<number> {
  console.log("[TASK_GENERATION] Starting midnight task generation job...");
  let totalGenerated = 0;

  try {
    // Get all tenants
    const allTenants = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(opts.tenantId ? eq(tenants.id, opts.tenantId) : undefined);

    // Use Thailand timezone for the target date (midnight just passed)
    const thailandNow = new Date(Date.now() + THAILAND_OFFSET_MS);

    for (const tenant of allTenants) {
      try {
        const generated = await generateTaskInstances(tenant.id, thailandNow);
        totalGenerated += generated;
        if (generated > 0) {
          console.log(`[TASK_GENERATION] Generated ${generated} tasks for tenant ${tenant.id}`);
        }
      } catch (err) {
        console.error(`[TASK_GENERATION] Error for tenant ${tenant.id}:`, err);
        opts.onError?.(err);
      }
    }

    console.log(`[TASK_GENERATION] Complete - generated ${totalGenerated} total tasks`);
  } catch (error) {
    console.error("[TASK_GENERATION] Error during task generation:", error);
    opts.onError?.(error);
  }

  return totalGenerated;
}

export async function runNoShowAlertCheck(): Promise<number> {
  if (!ATTENTION_WRITES_READY) return 0;
  console.log("[NO_SHOW_CHECK] Checking for scheduled no-shows...");
  let alertsCreated = 0;
  let alertsResolved = 0;

  try {
    const now = new Date();
    const thailandNow = new Date(now.getTime() + THAILAND_OFFSET_MS);
    const { hour: bangkokHour } = getThailandTimeParts();

    // Only run during operating hours (7am - 10pm Bangkok)
    if (bangkokHour < 7 || bangkokHour >= 22) {
      console.log(`[NO_SHOW_CHECK] Outside operating hours (Bangkok ${bangkokHour}:xx), skipping`);
      return 0;
    }

    const todayBangkok = thailandNow.toISOString().split("T")[0]; // YYYY-MM-DD

    // Get all schedule assignments for today across all tenants
    const todaysAssignments = await db
      .select({
        assignmentId: scheduleAssignments.id,
        employeeId: scheduleAssignments.employeeId,
        shiftDate: scheduleAssignments.shiftDate,
        tenantId: scheduleAssignments.tenantId,
        branchId: scheduleShiftRows.branchId,
        startTime: scheduleShiftRows.startTime,
        endTime: scheduleShiftRows.endTime,
      })
      .from(scheduleAssignments)
      .innerJoin(scheduleShiftRows, eq(scheduleAssignments.shiftRowId, scheduleShiftRows.id))
      .where(
        and(
          eq(scheduleAssignments.shiftDate, todayBangkok),
          isNotNull(scheduleAssignments.employeeId),
        )
      );

    const NO_SHOW_GRACE_MINUTES = 30;

    for (const assignment of todaysAssignments) {
      if (!assignment.employeeId || !assignment.startTime) continue;

      // Parse the shift start time (HH:MM format) into UTC for today
      const [shiftHour, shiftMin] = assignment.startTime.split(":").map(Number);
      // Convert Bangkok shift time to UTC
      const shiftStartUTC = new Date(
        Date.UTC(
          parseInt(todayBangkok.split("-")[0]),
          parseInt(todayBangkok.split("-")[1]) - 1,
          parseInt(todayBangkok.split("-")[2]),
          shiftHour,
          shiftMin,
          0,
        ) - THAILAND_OFFSET_MS
      );

      const graceEndUTC = new Date(shiftStartUTC.getTime() + NO_SHOW_GRACE_MINUTES * 60 * 1000);

      // Only check if we're past the grace period
      if (now < graceEndUTC) continue;

      const ruleKey = "SCHEDULED_NO_SHOW_ALERT";
      const entityKey = `noshow:${assignment.employeeId}:${todayBangkok}`;

      // Check if employee has any clock-in event today at any branch
      const todayStartUTC = new Date(shiftStartUTC);
      todayStartUTC.setHours(0, 0, 0, 0);
      const todayEndUTC = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000);

      const clockInEvents = await db
        .select({ id: timeEvents.id })
        .from(timeEvents)
        .where(
          and(
            eq(timeEvents.employeeId, assignment.employeeId),
            eq(timeEvents.eventType, "IN"),
            gte(timeEvents.eventTime, todayStartUTC),
            lte(timeEvents.eventTime, todayEndUTC),
          )
        )
        .limit(1);

      if (clockInEvents.length > 0) {
        // Employee clocked in — auto-resolve any open no-show alert
        const resolved = await storage.autoResolveAttentionItems(ruleKey, entityKey);
        if (resolved > 0) {
          alertsResolved += resolved;
          console.log(`[NO_SHOW_CHECK] Auto-resolved no-show alert for employee ${assignment.employeeId} (clocked in)`);
        }
        continue;
      }

      // Employee has not clocked in — create/upsert a no-show alert
      const shiftTimeStr = assignment.startTime.slice(0, 5);
      const branch = assignment.branchId
        ? await db.select({ name: branches.name }).from(branches).where(eq(branches.id, assignment.branchId)).limit(1).then(r => r[0])
        : null;
      const employee = await db.select({ fullName: employees.fullName, nickname: employees.nickname }).from(employees).where(eq(employees.id, assignment.employeeId)).limit(1).then(r => r[0]);

      const employeeName = employee?.nickname || employee?.fullName || "Unknown";
      const branchName = branch?.name || "Unknown Branch";

      const result = await storage.upsertAttentionItem({
        tenantId: assignment.tenantId,
        branchId: assignment.branchId || undefined,
        employeeId: assignment.employeeId,
        type: "SCHEDULED_NO_SHOW_ALERT",
        severity: "high",
        title: `No-show: ${employeeName}`,
        description: `${employeeName} was scheduled at ${shiftTimeStr} (${branchName}) but has not clocked in after ${NO_SHOW_GRACE_MINUTES} minutes.`,
        ruleKey,
        entityKey,
        fingerprint: `${assignment.employeeId}:${todayBangkok}:${shiftTimeStr}`,
      });

      if (result.action === "created") {
        alertsCreated++;
        console.log(`[NO_SHOW_CHECK] Created no-show alert for ${employeeName} (scheduled ${shiftTimeStr})`);
      }
    }

    console.log(`[NO_SHOW_CHECK] Done — alerts created: ${alertsCreated}, resolved: ${alertsResolved}`);
  } catch (error) {
    console.error("[NO_SHOW_CHECK] Error during no-show check:", error);
  }

  return alertsCreated;
}

// ─── The batches, defined once ────────────────────────────────────────────────

/** One step of a batch: the app's own job function, and what it reports. */
interface NightStep {
  step: string;
  onFailure: OnStepFailure;
  run(opts: NightJobOptions): Promise<Record<string, number>>;
}

const presenceStep: NightStep = {
  step: "presenceReconciliation",
  onFailure: "continue",
  run: async (opts) => {
    const s = await runPresenceReconciliation(opts);
    return {
      stuckClockIns: s.stuckClockIns,
      presenceMismatches: s.presenceMismatches,
      repairs: s.repairs,
      anomalies: s.anomalies,
    };
  },
};

/**
 * The three batches, step by step, in the order the app has always run them.
 * The app's own timers (below) and the platform's job endpoint
 * (`runNightBatchForTenant`) both read this one list, so the two can never run
 * different steps.
 */
export const NIGHT_BATCHES: Record<NightJobName, readonly NightStep[]> = {
  /** 00:01 Bangkok: forgotten guest check-ins, missing clock-outs, the day's recurring tasks. */
  midnight: [
    {
      step: "autoCheckout",
      onFailure: "continue",
      run: async (opts) => ({ checkedOut: await runMidnightAutoCheckout(opts) }),
    },
    {
      step: "autoClockOut",
      onFailure: "continue",
      run: async (opts) => ({ autoClockedOut: await runMidnightTimekeepingAutoClockOut(opts) }),
    },
    {
      step: "taskGeneration",
      onFailure: "continue",
      run: async (opts) => ({ generated: await runMidnightTaskGeneration(opts) }),
    },
  ],
  /** 03:00 Bangkok: presence repaired, leavers moved to Left and their logins switched off, old availability cleared. */
  reconcile: [
    presenceStep,
    {
      step: "statusTransitions",
      onFailure: "continue",
      run: async (opts) => ({ transitioned: await runStatusTransitions(opts) }),
    },
    {
      step: "departedLogins",
      onFailure: "continue",
      run: async (opts) => ({ deactivated: await runDepartedAccountDeactivation(opts) }),
    },
    {
      step: "availabilityCleanup",
      onFailure: "stop",
      run: async (opts) => ({ deleted: await cleanupOldAvailabilityRecords(opts) }),
    },
  ],
  /** Every six hours: the presence check alone. */
  presence: [presenceStep],
};

/**
 * A batch as the app's own timers run it: every park group, every step in
 * order, each error the step catches logged and swallowed by the step itself.
 *
 * ONE PARK GROUP AT A TIME, UNDER THE ENDPOINT'S LOCK (S2-17b round 3 review,
 * F4). The switch (`OTOAPP_JOBS`) is read per process, so two instances that
 * disagree about it — a rolling deploy across the flip, a second service on
 * the same database — would run one night twice side by side: both read the
 * same stale clock-ins before either writes, and each writes its own OUT. So
 * each park group's part of the batch runs holding the same per-park-group
 * lock the platform's job endpoint takes (`lib/nightBatchLock.ts`), and a park
 * group whose batch is held elsewhere is skipped here, said in the log. Every
 * table the batch touches carries a NOT NULL `tenant_id` referencing
 * `tenants`, so the park groups one by one are every row the batch ever
 * reached at once.
 *
 * The app's behaviour otherwise, as it was:
 *  - an error a step does not catch (the availability clean-up) stops that
 *    park group's batch there, as it stopped the batch; the other park groups
 *    still run, and the first such error then escapes the batch, so the
 *    timer behaves as it always has (plan Q26);
 *  - when the park groups cannot be listed, or a lock cannot be asked for
 *    (the database unreachable), the batch runs as it always ran — every
 *    park group at once, or that park group without the lock — rather than
 *    adding a new way for a night to be lost or for the timer to fail.
 */
async function runNightBatchInProcess(name: NightJobName): Promise<void> {
  let parkGroups: string[];
  try {
    parkGroups = (await db.select({ id: tenants.id }).from(tenants)).map((t) => t.id);
  } catch (error) {
    console.error(`[SCHEDULED_JOBS] ${name}: the park groups could not be listed, so the batch runs for all of them at once, without the per-park-group lock:`, error);
    for (const s of NIGHT_BATCHES[name]) await s.run({});
    return;
  }

  let escaped: { error: unknown } | null = null;
  for (const tenantId of parkGroups) {
    let release: (() => Promise<void>) | null;
    try {
      release = await holdNightBatch(pool, name, tenantId);
    } catch (error) {
      console.error(`[SCHEDULED_JOBS] ${name}: the lock for park group ${tenantId} could not be asked for, so its batch runs without it:`, error);
      release = async () => undefined;
    }
    if (!release) {
      console.log(`[SCHEDULED_JOBS] ${name}: park group ${tenantId}'s batch is already running elsewhere (the platform's job endpoint), so it is not run here`);
      continue;
    }
    try {
      for (const s of NIGHT_BATCHES[name]) await s.run({ tenantId });
    } catch (error) {
      escaped ??= { error };
    } finally {
      await release();
    }
  }
  if (escaped) throw escaped.error;
}

/**
 * One park group's part of a batch, as the platform's job endpoint asks for
 * it (S2-17b round 3). The same steps in the same order, each told the park
 * group; every error a step swallows — and one that escapes it — makes that
 * step a failed step, named in words, and the whole run not ok.
 *
 * The continue-or-stop shape is the app's own, per step (`onFailure`): a
 * swallowed error never stopped the app's batch, so here it stops nothing
 * either; an escaped error did stop it, so here the steps after it are
 * reported as skipped rather than run.
 */
export async function runNightBatchForTenant(name: NightJobName, tenantId: string): Promise<NightBatchResult> {
  const steps: NightStepResult[] = [];
  let stopped = false;
  for (const s of NIGHT_BATCHES[name]) {
    if (stopped) {
      steps.push({ step: s.step, ok: false, onFailure: s.onFailure, counts: {}, skipped: true });
      continue;
    }
    const caught: unknown[] = [];
    let counts: Record<string, number> = {};
    let escaped = false;
    try {
      counts = await s.run({ tenantId, onError: (error) => caught.push(error) });
    } catch (error) {
      caught.push(error);
      escaped = true;
      console.error(`[SCHEDULED_JOBS] ${name}: step ${s.step} failed for park group ${tenantId}:`, error);
    }
    const ok = caught.length === 0;
    steps.push({
      step: s.step,
      ok,
      onFailure: s.onFailure,
      counts,
      ...(ok ? {} : { error: errorWords(caught[0]) }),
    });
    // In the app any error that escapes a step rejects the whole batch, so
    // nothing after it runs. Only `availabilityCleanup` lets one escape by
    // design; were another to, the app would stop there too.
    if (escaped) stopped = true;
  }
  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * Start the app's own timers — unless the platform runs the night work.
 *
 * Under `OTOAPP_JOBS=platform` NOT ONE timer is registered: the platform's job
 * runner owns the schedule (`job:otoapp.midnight`, `.reconcile`, `.presence`)
 * and calls the directory job endpoint, so a timer here would run every batch
 * twice. Under `inprocess`, the default, everything is as it always was.
 * Answers whether it started anything.
 */
export function startScheduledJobs(mode: JobsMode = JOBS_MODE): boolean {
  if (mode === "platform") {
    console.log("[SCHEDULED_JOBS] OTOAPP_JOBS=platform: the platform's job runner runs the night work, so no timer is started here");
    return false;
  }
  console.log("[SCHEDULED_JOBS] Initializing scheduled jobs...");

  // Run at midnight Bangkok time for task generation and auto-checkout
  scheduleDaily(0, 1, () => runNightBatchInProcess("midnight"));

  // Run at 3:00 AM Bangkok time for daily reconciliation
  scheduleDaily(3, 0, () => runNightBatchInProcess("reconcile"));

  // The presence check too, one park group at a time under the same lock
  // (review F4). Its one step catches its own error and a lock that cannot
  // be asked for runs it without one, so nothing escapes; the catch keeps it
  // that way, as `setInterval(runPresenceReconciliation)` could never reject.
  setInterval(() => {
    runNightBatchInProcess("presence").catch((error) => console.error("[SCHEDULED_JOBS] presence:", error));
  }, 6 * 60 * 60 * 1000);
  
  // No-show Attention writes resume with tenant ownership and a locked job.
  if (ATTENTION_WRITES_READY) {
    setInterval(runNoShowAlertCheck, 10 * 60 * 1000);
    runNoShowAlertCheck();
  }
  
  console.log("[SCHEDULED_JOBS] Jobs scheduled: Task generation at 00:01, daily reconciliation at 03:00 Bangkok time, every 6 hours presence check, availability cleanup, every 10 minutes no-show check");
  return true;
}
