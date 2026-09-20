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
import { and, eq, inArray, lte, gte } from "drizzle-orm";
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

export async function recordAdvanceRepayment(
  advanceId: string,
  payrollRunId: string,
  amount: number
): Promise<void> {
  const advance = await db
    .select()
    .from(salaryAdvances)
    .where(eq(salaryAdvances.id, advanceId))
    .then((rows) => rows[0]);

  if (!advance) throw new Error("Advance not found");

  const currentBalance = parseFloat(advance.remainingBalance) || 0;
  const newBalance = Math.max(0, currentBalance - amount);

  await storage.createSalaryAdvanceRepayment({
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
  await storage.updateSalaryAdvance(advanceId, updates);
}
