import { storage } from "./storage";
import { db } from "./db";
import { employeeRoleAvailability, employees, users, tenants, timeEvents, scheduleAssignments, scheduleShiftRows, branches } from "@shared/schema";
import { serviceCheckins } from "./db/coreSchema";
import { lt, eq, and, isNull, isNotNull, gte, lte, desc, sql } from "drizzle-orm";
import { generateTaskInstances } from "./core/taskGeneration";
import { ATTENTION_WRITES_READY } from "./attention-availability";

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

export async function runPresenceReconciliation(): Promise<ReconciliationSummary> {
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
    const stuckPresences = await storage.getStuckClockIns(stuckHoursThreshold);
    summary.stuckClockIns = stuckPresences.length;

    for (const presence of stuckPresences) {
      if (ATTENTION_WRITES_READY) await storage.createAttentionItem({
        type: 'TIMEKEEPING_STUCK_CLOCK_IN',
        severity: 'high',
        employeeId: presence.employeeId,
        branchId: presence.currentWorkBranchId || undefined,
        title: `Stuck clock-in: over ${stuckHoursThreshold} hours`,
        description: `Employee has been clocked in for over ${stuckHoursThreshold} hours without clocking out. Last clock-in: ${presence.lastInAt?.toISOString() || 'unknown'}`,
      });
      summary.anomalies++;
    }

    const repairResult = await storage.repairPresenceMismatches();
    summary.presenceMismatches = repairResult.mismatches;
    summary.repairs = repairResult.repairs;
    summary.anomalies += repairResult.anomalies;

    console.log(`[RECONCILIATION] Complete - Stuck: ${summary.stuckClockIns}, Mismatches: ${summary.presenceMismatches}, Repairs: ${summary.repairs}, Anomalies: ${summary.anomalies}`);
  } catch (error) {
    console.error("[RECONCILIATION] Error during reconciliation:", error);
  }

  return summary;
}

export async function runStatusTransitions(): Promise<number> {
  console.log("[STATUS_TRANSITION] Starting LEAVING->LEFT status transition job...");
  let transitioned = 0;

  try {
    const today = getThailandMidnightUTC();
    transitioned = await storage.transitionLeavingToLeft(today);
    console.log(`[STATUS_TRANSITION] Transitioned ${transitioned} employees from LEAVING to LEFT`);
  } catch (error) {
    console.error("[STATUS_TRANSITION] Error during status transition:", error);
  }

  return transitioned;
}

/**
 * Switch off the app login of everyone whose last working day has passed.
 *
 * The 03:00 batch calls it with no tenant, across every park group, as it
 * always has. The manual trigger (`POST /api/admin/run-departed-deactivation`)
 * passes the caller's own park group, so one park group's admin never
 * switches off another's people (S2-17b round 1).
 */
export async function runDepartedAccountDeactivation(opts: { tenantId?: string } = {}): Promise<number> {
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
  }

  return deactivated;
}

export async function runMidnightTimekeepingAutoClockOut(): Promise<number> {
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

async function cleanupOldAvailabilityRecords(): Promise<number> {
  // Delete availability records older than 7 days to keep the table clean
  // Since availability resets daily, old records are no longer needed
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoffDate = sevenDaysAgo.toISOString().split("T")[0];
  
  const result = await db.delete(employeeRoleAvailability)
    .where(lt(employeeRoleAvailability.unavailableDate, cutoffDate));
  
  console.log(`[SCHEDULED_JOBS] Cleaned up old availability records before ${cutoffDate}`);
  return 0;
}

// Auto-checkout any in_park check-ins from before midnight (forgotten checkouts)
export async function runMidnightAutoCheckout(): Promise<number> {
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
          isNull(serviceCheckins.checkedOutAt)
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
    return 0;
  }
}

// Generate scheduled tasks for all tenants at midnight
export async function runMidnightTaskGeneration(): Promise<void> {
  console.log("[TASK_GENERATION] Starting midnight task generation job...");
  
  try {
    // Get all tenants
    const allTenants = await db.select({ id: tenants.id }).from(tenants);
    
    // Use Thailand timezone for the target date (midnight just passed)
    const thailandNow = new Date(Date.now() + THAILAND_OFFSET_MS);
    
    let totalGenerated = 0;
    
    for (const tenant of allTenants) {
      try {
        const generated = await generateTaskInstances(tenant.id, thailandNow);
        totalGenerated += generated;
        if (generated > 0) {
          console.log(`[TASK_GENERATION] Generated ${generated} tasks for tenant ${tenant.id}`);
        }
      } catch (err) {
        console.error(`[TASK_GENERATION] Error for tenant ${tenant.id}:`, err);
      }
    }
    
    console.log(`[TASK_GENERATION] Complete - generated ${totalGenerated} total tasks`);
  } catch (error) {
    console.error("[TASK_GENERATION] Error during task generation:", error);
  }
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

export function startScheduledJobs(): void {
  console.log("[SCHEDULED_JOBS] Initializing scheduled jobs...");
  
  // Run at midnight Bangkok time for task generation and auto-checkout
  scheduleDaily(0, 1, async () => {
    await runMidnightAutoCheckout();
    await runMidnightTimekeepingAutoClockOut();
    await runMidnightTaskGeneration();
  });
  
  // Run at 3:00 AM Bangkok time for daily reconciliation
  scheduleDaily(3, 0, async () => {
    await runPresenceReconciliation();
    await runStatusTransitions();
    await runDepartedAccountDeactivation();
    await cleanupOldAvailabilityRecords();
  });
  
  setInterval(runPresenceReconciliation, 6 * 60 * 60 * 1000);
  
  // No-show Attention writes resume with tenant ownership and a locked job.
  if (ATTENTION_WRITES_READY) {
    setInterval(runNoShowAlertCheck, 10 * 60 * 1000);
    runNoShowAlertCheck();
  }
  
  console.log("[SCHEDULED_JOBS] Jobs scheduled: Task generation at 00:01, daily reconciliation at 03:00 Bangkok time, every 6 hours presence check, availability cleanup, every 10 minutes no-show check");
}
