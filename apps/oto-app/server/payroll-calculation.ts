import { db } from "./db";
import {
  employees,
  payrollDayReconciliations,
  payrollLineItems,
  payrollEmployeeSummaries,
  payrollRuns,
  salaryAdvances,
  salaryAdvanceRepayments,
} from "@shared/schema";
import { and, eq, inArray, lte, gte, ne } from "drizzle-orm";
import { storage } from "./storage";

export interface CalculationConfig {
  payrollRunId: string;
  periodId: string;
  startDate: string;
  endDate: string;
  branchIds: string[];
  tenantId: string;
  operatorId: string;
  standardWorkingDays: number;
  overtimeRate: number;
  holidayRate: number;
}

interface EmployeePayData {
  employeeId: string;
  baseSalary: number;
  foodAllowancePerDay: number | null;
  scheduledMinutes: number;
  actualMinutes: number;
  overtimeMinutes: number;
  workDays: number;
}

interface LineItemResult {
  lineType: "EARNING" | "DEDUCTION" | "EMPLOYER_CONTRIBUTION";
  code: string;
  description: string;
  quantity: number | null;
  rate: number | null;
  amount: number;
  taxable: boolean;
  statutory: boolean;
  metadata?: Record<string, unknown>;
}

interface CalculationResult {
  employeesProcessed: number;
  lineItemsCreated: number;
  summariesCreated: number;
  errors: string[];
}

export async function runPayrollCalculation(
  config: CalculationConfig
): Promise<CalculationResult> {
  const result: CalculationResult = {
    employeesProcessed: 0,
    lineItemsCreated: 0,
    summariesCreated: 0,
    errors: [],
  };

  try {
    // SCRUM-276: a recalculation replaces this period's deductions, so the
    // balance reductions recorded for them are given back first.
    await reversePeriodAdvanceRepayments(config.periodId);
    await storage.deletePayrollLineItemsByRun(config.payrollRunId);
    await storage.deletePayrollEmployeeSummariesByRun(config.payrollRunId);
    const reconciliations = await db
      .select()
      .from(payrollDayReconciliations)
      .where(eq(payrollDayReconciliations.payrollRunId, config.payrollRunId));
    const employeeIdSet = new Set(reconciliations.map((r) => r.employeeId));
    const employeeIds = Array.from(employeeIdSet);
    if (employeeIds.length === 0) {
      result.errors.push("No reconciliations found for this payroll run");
      return result;
    }
    const employeeRecords = await db
      .select()
      .from(employees)
      .where(inArray(employees.id, employeeIds));
    const employeeMap = new Map(employeeRecords.map((e) => [e.id, e]));
    const employeePayData = buildEmployeePayData(reconciliations, employeeMap);
    const payDataEntries = Array.from(employeePayData.entries());
    for (const [employeeId, payData] of payDataEntries) {
      try {
        const lineItems = await calculateEmployeeLineItems(
          config,
          employeeId,
          payData
        );
        for (const item of lineItems) {
          await storage.createPayrollLineItem({
            payrollRunId: config.payrollRunId,
            employeeId,
            lineType: item.lineType,
            code: item.code,
            description: item.description,
            quantity: item.quantity?.toString() || null,
            rate: item.rate?.toString() || null,
            amount: item.amount.toFixed(2),
            taxable: item.taxable,
            statutory: item.statutory,
            metadata: item.metadata || null,
          });
          result.lineItemsCreated++;
          // SCRUM-276: the deduction just stored reduces the advance, once
          // per payroll period. The stored two-decimal amount is the one
          // recorded, so the ledger, the payslip line and the balance agree.
          if (item.code === "ADVANCE_REPAYMENT" && item.metadata?.advanceId) {
            await recordAdvanceRepayment(
              item.metadata.advanceId as string,
              config.payrollRunId,
              parseFloat(item.amount.toFixed(2))
            );
          }
        }
        const summary = calculateEmployeeSummary(lineItems);
        await storage.createPayrollEmployeeSummary({
          payrollRunId: config.payrollRunId,
          employeeId,
          grossPay: summary.grossPay.toFixed(2),
          taxableIncome: summary.taxableIncome.toFixed(2),
          totalDeductions: summary.totalDeductions.toFixed(2),
          netPay: summary.netPay.toFixed(2),
          employerCost: summary.employerCost.toFixed(2),
          currency: "THB",
          status: "DRAFT",
        });
        result.summariesCreated++;
        result.employeesProcessed++;
      } catch (error: any) {
        result.errors.push(`Employee ${employeeId}: ${error.message}`);
      }
    }
  } catch (error: any) {
    result.errors.push(error.message || "Unknown error");
  }

  return result;
}

function buildEmployeePayData(
  reconciliations: any[],
  employeeMap: Map<string, any>
): Map<string, EmployeePayData> {
  const payDataMap = new Map<string, EmployeePayData>();

  for (const rec of reconciliations) {
    const employee = employeeMap.get(rec.employeeId);
    if (!employee) continue;
    if (!payDataMap.has(rec.employeeId)) {
      const mergeData = employee.defaultMergeData as any || {};
      payDataMap.set(rec.employeeId, {
        employeeId: rec.employeeId,
        baseSalary: mergeData.salaryThb || 0,
        foodAllowancePerDay: employee.foodAllowancePerDay,
        scheduledMinutes: 0,
        actualMinutes: 0,
        overtimeMinutes: 0,
        workDays: 0,
      });
    }
    const data = payDataMap.get(rec.employeeId)!;
    data.scheduledMinutes += rec.scheduledMinutes || 0;
    data.actualMinutes += rec.actualMinutes || 0;
    data.overtimeMinutes += rec.overtimeMinutes || 0;
    const flags = rec.flags as any;
    if (flags?.status === "MATCHED" || flags?.status === "VARIANCE") {
      data.workDays++;
    }
  }

  return payDataMap;
}

async function calculateEmployeeLineItems(
  config: CalculationConfig,
  employeeId: string,
  payData: EmployeePayData
): Promise<LineItemResult[]> {
  const lineItems: LineItemResult[] = [];
  lineItems.push({
    lineType: "EARNING",
    code: "BASE_SALARY",
    description: "Base Monthly Salary",
    quantity: 1,
    rate: payData.baseSalary,
    amount: payData.baseSalary,
    taxable: true,
    statutory: false,
  });
  if (payData.overtimeMinutes > 0) {
    const hourlyRate = payData.baseSalary / (config.standardWorkingDays * 8);
    const overtimeHours = payData.overtimeMinutes / 60;
    const overtimeAmount = overtimeHours * hourlyRate * config.overtimeRate;
    lineItems.push({
      lineType: "EARNING",
      code: "OVERTIME",
      description: "Overtime Pay",
      quantity: overtimeHours,
      rate: hourlyRate * config.overtimeRate,
      amount: Math.round(overtimeAmount * 100) / 100,
      taxable: true,
      statutory: false,
      metadata: {
        overtimeMinutes: payData.overtimeMinutes,
        baseHourlyRate: hourlyRate,
        multiplier: config.overtimeRate,
      },
    });
  }
  if (payData.foodAllowancePerDay && payData.workDays > 0) {
    const foodAllowance = payData.foodAllowancePerDay * payData.workDays;
    lineItems.push({
      lineType: "EARNING",
      code: "FOOD_ALLOWANCE",
      description: "Food Allowance",
      quantity: payData.workDays,
      rate: payData.foodAllowancePerDay,
      amount: foodAllowance,
      taxable: false,
      statutory: false,
    });
  }
  const currentGrossPay = lineItems
    .filter(item => item.lineType === "EARNING")
    .reduce((sum, item) => sum + item.amount, 0);
  const activeAdvances = await getActiveAdvances(
    employeeId,
    config.tenantId,
    config.operatorId
  );
  for (const advance of activeAdvances) {
    const repayment = calculateAdvanceRepayment(advance, currentGrossPay);
    if (repayment > 0) {
      lineItems.push({
        lineType: "DEDUCTION",
        code: "ADVANCE_REPAYMENT",
        description: `Salary Advance Repayment (${advance.id.slice(0, 8)})`,
        quantity: null,
        rate: null,
        amount: repayment,
        taxable: false,
        statutory: false,
        metadata: {
          advanceId: advance.id,
          remainingBalance: advance.remainingBalance,
          principalAmount: advance.principalAmount,
        },
      });
    }
  }

  return lineItems;
}

async function getActiveAdvances(
  employeeId: string,
  tenantId: string,
  operatorId: string
): Promise<any[]> {
  return await db
    .select()
    .from(salaryAdvances)
    .where(
      and(
        eq(salaryAdvances.employeeId, employeeId),
        eq(salaryAdvances.tenantId, tenantId),
        eq(salaryAdvances.status, "ACTIVE")
      )
    );
}

function calculateAdvanceRepayment(advance: any, grossPay: number): number {
  const remainingBalance = parseFloat(advance.remainingBalance) || 0;
  if (remainingBalance <= 0) return 0;

  let repayment = 0;

  if (advance.repaymentType === "FIXED") {
    repayment = parseFloat(advance.repaymentAmount) || 0;
  } else if (advance.repaymentType === "PERCENT_OF_NET") {
    const percent = parseFloat(advance.percentOfNet) || 0;
    const maxCap = parseFloat(advance.maxPercentOfNetCap) || 0.3;
    repayment = grossPay * Math.min(percent, maxCap);
  } else if (advance.repaymentType === "INSTALLMENT") {
    const months = advance.repaymentMonths || 1;
    repayment = parseFloat(advance.principalAmount) / months;
  }

  return Math.min(repayment, remainingBalance);
}

function calculateEmployeeSummary(lineItems: LineItemResult[]): {
  grossPay: number;
  taxableIncome: number;
  totalDeductions: number;
  netPay: number;
  employerCost: number;
} {
  let grossPay = 0;
  let taxableIncome = 0;
  let totalDeductions = 0;
  let employerCost = 0;

  for (const item of lineItems) {
    if (item.lineType === "EARNING") {
      grossPay += item.amount;
      if (item.taxable) {
        taxableIncome += item.amount;
      }
    } else if (item.lineType === "DEDUCTION") {
      totalDeductions += item.amount;
    } else if (item.lineType === "EMPLOYER_CONTRIBUTION") {
      employerCost += item.amount;
    }
  }

  const netPay = grossPay - totalDeductions;
  employerCost += grossPay;

  return {
    grossPay,
    taxableIncome,
    totalDeductions,
    netPay,
    employerCost,
  };
}

export async function getEmployeePayrollDetails(
  runId: string,
  employeeId: string
): Promise<{
  summary: any;
  lineItems: any[];
  reconciliations: any[];
} | null> {
  const summary = await storage.getPayrollEmployeeSummary(runId, employeeId);
  if (!summary) return null;

  const lineItems = await db
    .select()
    .from(payrollLineItems)
    .where(
      and(
        eq(payrollLineItems.payrollRunId, runId),
        eq(payrollLineItems.employeeId, employeeId)
      )
    );

  const reconciliations = await db
    .select()
    .from(payrollDayReconciliations)
    .where(
      and(
        eq(payrollDayReconciliations.payrollRunId, runId),
        eq(payrollDayReconciliations.employeeId, employeeId)
      )
    );

  return { summary, lineItems, reconciliations };
}

/**
 * SCRUM-276: an advance is repaid at most once per payroll period.
 *
 * The anchor is the app's own run identity: the repayment row carries the
 * payroll run, and the run carries its period. A period may hold several runs
 * (`run_number`), each a full recalculation of the same pay, so a second
 * repayment for the same advance in the same period is skipped rather than
 * taken again. The advance row is locked for the check and the write, so two
 * calculations arriving together still record one repayment.
 */
export async function recordAdvanceRepayment(
  advanceId: string,
  payrollRunId: string,
  amount: number
): Promise<void> {
  await db.transaction(async (tx) => {
    const advance = await tx
      .select()
      .from(salaryAdvances)
      .where(eq(salaryAdvances.id, advanceId))
      .for("update")
      .then((rows) => rows[0]);

    if (!advance) throw new Error("Advance not found");

    const run = await tx
      .select({ payrollPeriodId: payrollRuns.payrollPeriodId })
      .from(payrollRuns)
      .where(eq(payrollRuns.id, payrollRunId))
      .then((rows) => rows[0]);
    if (!run) throw new Error("Payroll run not found");

    const alreadyRepaid = await tx
      .select({ id: salaryAdvanceRepayments.id })
      .from(salaryAdvanceRepayments)
      .innerJoin(payrollRuns, eq(payrollRuns.id, salaryAdvanceRepayments.payrollRunId))
      .where(
        and(
          eq(salaryAdvanceRepayments.salaryAdvanceId, advanceId),
          eq(payrollRuns.payrollPeriodId, run.payrollPeriodId)
        )
      )
      .limit(1);
    if (alreadyRepaid.length > 0) return;

    const currentBalance = parseFloat(advance.remainingBalance) || 0;
    const newBalance = Math.max(0, currentBalance - amount);

    await tx.insert(salaryAdvanceRepayments).values({
      salaryAdvanceId: advanceId,
      payrollRunId,
      employeeId: advance.employeeId,
      amount: amount.toFixed(2),
      remainingBalanceAfter: newBalance.toFixed(2),
    });

    const updates: any = { remainingBalance: newBalance.toFixed(2) };
    if (newBalance <= 0) {
      updates.status = "PAID_OFF";
    }
    await tx.update(salaryAdvances).set(updates).where(eq(salaryAdvances.id, advanceId));
  });
}

/**
 * SCRUM-276: give back the repayments recorded for a period before it is
 * calculated again, so the recalculation reads the balance as it stood before
 * this period and records its own deduction once.
 *
 * A finalized run's repayment stays: that pay is settled, and the period-level
 * check in `recordAdvanceRepayment` then keeps a later run from taking it
 * again. Each reversal locks the advance and deletes the repayment row in one
 * transaction, so a concurrent reversal of the same row restores nothing twice.
 */
async function reversePeriodAdvanceRepayments(periodId: string): Promise<void> {
  const recorded = await db
    .select({
      id: salaryAdvanceRepayments.id,
      salaryAdvanceId: salaryAdvanceRepayments.salaryAdvanceId,
    })
    .from(salaryAdvanceRepayments)
    .innerJoin(payrollRuns, eq(payrollRuns.id, salaryAdvanceRepayments.payrollRunId))
    .where(and(eq(payrollRuns.payrollPeriodId, periodId), ne(payrollRuns.status, "FINALIZED")));

  for (const repayment of recorded) {
    await db.transaction(async (tx) => {
      const advance = await tx
        .select()
        .from(salaryAdvances)
        .where(eq(salaryAdvances.id, repayment.salaryAdvanceId))
        .for("update")
        .then((rows) => rows[0]);
      if (!advance) return;
      const removed = await tx
        .delete(salaryAdvanceRepayments)
        .where(eq(salaryAdvanceRepayments.id, repayment.id))
        .returning({ amount: salaryAdvanceRepayments.amount });
      if (removed.length === 0) return;

      const currentBalance = parseFloat(advance.remainingBalance) || 0;
      const restored = currentBalance + (parseFloat(removed[0].amount) || 0);
      const updates: any = { remainingBalance: restored.toFixed(2) };
      // Only the status this file sets is undone; a pause or close made by
      // hand in the meantime is left as it is.
      if ((advance.status as string) === "PAID_OFF" && restored > 0) {
        updates.status = "ACTIVE";
      }
      await tx.update(salaryAdvances).set(updates).where(eq(salaryAdvances.id, advance.id));
    });
  }
}
