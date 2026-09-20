import { db } from "./db";
import {
  statutoryRuleSets,
  statutoryCalculationResults,
  payrollLineItems,
  payrollEmployeeSummaries,
  employees,
} from "@shared/schema";
import { and, eq, lte, gte, isNull, or, inArray } from "drizzle-orm";
import { storage } from "./storage";

interface ThailandSSOConfig {
  contributionRate: number;
  ceilingAmount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface ThailandPITBracket {
  min: number;
  max: number | null;
  rate: number;
}

interface ThailandStatutoryRules {
  sso: ThailandSSOConfig;
  pit: {
    brackets: ThailandPITBracket[];
    personalExemption: number;
    spouseExemption: number;
    childExemption: number;
  };
}

interface StatutoryResult {
  employeeSSO: number;
  employerSSO: number;
  withholdingTax: number;
  annualizedIncome: number;
  annualTax: number;
  taxableIncome: number;
  effectiveTaxRate: number;
  details: {
    ssoWageCeiling: number;
    ssoRate: number;
    taxBrackets: Array<{
      bracket: number;
      income: number;
      rate: number;
      tax: number;
    }>;
  };
}

export interface StatutoryCalcConfig {
  payrollRunId: string;
  periodId: string;
  countryCode: string;
  asOfDate: string;
  periodMonthsInYear: number;
  tenantId: string;
  operatorId?: string;
  branchId?: string;
}

interface CalcResult {
  employeesProcessed: number;
  lineItemsCreated: number;
  errors: string[];
}

export async function runStatutoryCalculations(
  config: StatutoryCalcConfig
): Promise<CalcResult> {
  const result: CalcResult = {
    employeesProcessed: 0,
    lineItemsCreated: 0,
    errors: [],
  };

  try {
    await storage.deleteStatutoryCalculationResultsByRun(config.payrollRunId);
    const summaries = await storage.getPayrollEmployeeSummaries(config.payrollRunId);
    if (summaries.length === 0) {
      result.errors.push("No employee summaries found for this payroll run");
      return result;
    }
    let ruleSet = await storage.getActiveStatutoryRuleSet(
      config.countryCode,
      config.asOfDate,
      config.tenantId,
      config.operatorId,
      config.branchId
    );
    if (!ruleSet) {
      await seedThailandRules(config.tenantId);
      ruleSet = await storage.getActiveStatutoryRuleSet(
        config.countryCode,
        config.asOfDate,
        config.tenantId,
        config.operatorId,
        config.branchId
      );
      if (!ruleSet) {
        result.errors.push(`No statutory rules found for ${config.countryCode}`);
        return result;
      }
    }
    const rules = ruleSet.rules as ThailandStatutoryRules;
    const employeeIds = summaries.map((s) => s.employeeId);
    const employeeRecords = await db
      .select()
      .from(employees)
      .where(inArray(employees.id, employeeIds));
    const employeeMap = new Map(employeeRecords.map((e) => [e.id, e]));
    for (const summary of summaries) {
      try {
        const employee = employeeMap.get(summary.employeeId);
        const isForeign = employee?.isForeignStaff || false;
        const grossPay = parseFloat(summary.grossPay) || 0;
        const statutoryResult = calculateThailandStatutory(
          grossPay,
          rules,
          config.periodMonthsInYear,
          isForeign
        );
        await storage.createStatutoryCalculationResult({
          payrollRunId: config.payrollRunId,
          employeeId: summary.employeeId,
          countryCode: config.countryCode,
          results: statutoryResult,
        });
        if (!isForeign) {
          await storage.createPayrollLineItem({
            payrollRunId: config.payrollRunId,
            employeeId: summary.employeeId,
            lineType: "DEDUCTION",
            code: "SSO_EMPLOYEE",
            description: "Social Security (Employee)",
            quantity: null,
            rate: (rules.sso.contributionRate * 100).toString(),
            amount: statutoryResult.employeeSSO.toFixed(2),
            taxable: false,
            statutory: true,
            metadata: {
              ceiling: rules.sso.ceilingAmount,
              baseWage: grossPay,
            },
          });
          result.lineItemsCreated++;
          await storage.createPayrollLineItem({
            payrollRunId: config.payrollRunId,
            employeeId: summary.employeeId,
            lineType: "EMPLOYER_CONTRIBUTION",
            code: "SSO_EMPLOYER",
            description: "Social Security (Employer)",
            quantity: null,
            rate: (rules.sso.contributionRate * 100).toString(),
            amount: statutoryResult.employerSSO.toFixed(2),
            taxable: false,
            statutory: true,
            metadata: {
              ceiling: rules.sso.ceilingAmount,
              baseWage: grossPay,
            },
          });
          result.lineItemsCreated++;
        }
        await storage.createPayrollLineItem({
          payrollRunId: config.payrollRunId,
          employeeId: summary.employeeId,
          lineType: "DEDUCTION",
          code: "PIT_WITHHOLDING",
          description: "Personal Income Tax (Withholding)",
          quantity: null,
          rate: (statutoryResult.effectiveTaxRate * 100).toString(),
          amount: statutoryResult.withholdingTax.toFixed(2),
          taxable: false,
          statutory: true,
          metadata: {
            annualizedIncome: statutoryResult.annualizedIncome,
            annualTax: statutoryResult.annualTax,
            brackets: statutoryResult.details.taxBrackets,
          },
        });
        result.lineItemsCreated++;
        const totalDeductions =
          parseFloat(summary.totalDeductions) +
          statutoryResult.employeeSSO +
          statutoryResult.withholdingTax;
        const netPay = parseFloat(summary.grossPay) - totalDeductions;
        const employerCost =
          parseFloat(summary.employerCost) + statutoryResult.employerSSO;

        await storage.updatePayrollEmployeeSummary(summary.id, {
          totalDeductions: totalDeductions.toFixed(2),
          netPay: netPay.toFixed(2),
          employerCost: employerCost.toFixed(2),
        });

        result.employeesProcessed++;
      } catch (error: any) {
        result.errors.push(`Employee ${summary.employeeId}: ${error.message}`);
      }
    }
  } catch (error: any) {
    result.errors.push(error.message || "Unknown error");
  }

  return result;
}

function calculateThailandStatutory(
  monthlyGross: number,
  rules: ThailandStatutoryRules,
  periodsPerYear: number,
  isForeignStaff: boolean
): StatutoryResult {
  let employeeSSO = 0;
  let employerSSO = 0;

  if (!isForeignStaff) {
    const ssoWage = Math.min(monthlyGross, rules.sso.ceilingAmount);
    employeeSSO = Math.round(ssoWage * rules.sso.contributionRate * 100) / 100;
    employerSSO = employeeSSO;
  }
  const annualizedIncome = monthlyGross * periodsPerYear;
  const personalExemption = rules.pit.personalExemption;
  const ssoDeduction = employeeSSO * periodsPerYear;
  const taxableIncome = Math.max(0, annualizedIncome - personalExemption - ssoDeduction);
  let annualTax = 0;
  const taxBreakdown: Array<{
    bracket: number;
    income: number;
    rate: number;
    tax: number;
  }> = [];

  let remainingIncome = taxableIncome;
  for (let i = 0; i < rules.pit.brackets.length; i++) {
    const bracket = rules.pit.brackets[i];
    const bracketMin = bracket.min;
    const bracketMax = bracket.max ?? Infinity;
    const bracketSize = bracketMax - bracketMin;
    const incomeInBracket = Math.min(remainingIncome, bracketSize);

    if (incomeInBracket > 0) {
      const taxInBracket = Math.round(incomeInBracket * bracket.rate * 100) / 100;
      annualTax += taxInBracket;
      taxBreakdown.push({
        bracket: i + 1,
        income: incomeInBracket,
        rate: bracket.rate,
        tax: taxInBracket,
      });
      remainingIncome -= incomeInBracket;
    }

    if (remainingIncome <= 0) break;
  }
  const withholdingTax = Math.round((annualTax / periodsPerYear) * 100) / 100;
  const effectiveTaxRate = annualizedIncome > 0 ? annualTax / annualizedIncome : 0;

  return {
    employeeSSO,
    employerSSO,
    withholdingTax,
    annualizedIncome,
    annualTax,
    taxableIncome,
    effectiveTaxRate,
    details: {
      ssoWageCeiling: rules.sso.ceilingAmount,
      ssoRate: rules.sso.contributionRate,
      taxBrackets: taxBreakdown,
    },
  };
}

function getDefaultThailandRules(): ThailandStatutoryRules {
  return {
    sso: {
      contributionRate: 0.05,
      ceilingAmount: 17500,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2028-12-31",
    },
    pit: {
      brackets: [
        { min: 0, max: 150000, rate: 0 },
        { min: 150000, max: 300000, rate: 0.05 },
        { min: 300000, max: 500000, rate: 0.10 },
        { min: 500000, max: 750000, rate: 0.15 },
        { min: 750000, max: 1000000, rate: 0.20 },
        { min: 1000000, max: 2000000, rate: 0.25 },
        { min: 2000000, max: 5000000, rate: 0.30 },
        { min: 5000000, max: null, rate: 0.35 },
      ],
      personalExemption: 60000,
      spouseExemption: 60000,
      childExemption: 30000,
    },
  };
}

async function seedThailandRules(tenantId: string): Promise<void> {
  const existingRules = await storage.getStatutoryRuleSets("TH", tenantId);
  if (existingRules.length > 0) return;
  await storage.createStatutoryRuleSet({
    tenantId,
    countryCode: "TH",
    name: "Thailand Statutory Rules 2026-2028",
    description: "Default Thailand SSO and PIT rules for 2026-2028",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2028-12-31",
    status: "active",
    rules: {
      sso: {
        contributionRate: 0.05,
        ceilingAmount: 17500,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2028-12-31",
      },
      pit: {
        brackets: [
          { min: 0, max: 150000, rate: 0 },
          { min: 150000, max: 300000, rate: 0.05 },
          { min: 300000, max: 500000, rate: 0.10 },
          { min: 500000, max: 750000, rate: 0.15 },
          { min: 750000, max: 1000000, rate: 0.20 },
          { min: 1000000, max: 2000000, rate: 0.25 },
          { min: 2000000, max: 5000000, rate: 0.30 },
          { min: 5000000, max: null, rate: 0.35 },
        ],
        personalExemption: 60000,
        spouseExemption: 60000,
        childExemption: 30000,
      },
    },
  });
  await storage.createStatutoryRuleSet({
    tenantId,
    countryCode: "TH",
    name: "Thailand Statutory Rules 2029-2031",
    description: "Default Thailand SSO and PIT rules for 2029-2031",
    effectiveFrom: "2029-01-01",
    effectiveTo: "2031-12-31",
    status: "active",
    rules: {
      sso: {
        contributionRate: 0.05,
        ceilingAmount: 20000,
        effectiveFrom: "2029-01-01",
        effectiveTo: "2031-12-31",
      },
      pit: {
        brackets: [
          { min: 0, max: 150000, rate: 0 },
          { min: 150000, max: 300000, rate: 0.05 },
          { min: 300000, max: 500000, rate: 0.10 },
          { min: 500000, max: 750000, rate: 0.15 },
          { min: 750000, max: 1000000, rate: 0.20 },
          { min: 1000000, max: 2000000, rate: 0.25 },
          { min: 2000000, max: 5000000, rate: 0.30 },
          { min: 5000000, max: null, rate: 0.35 },
        ],
        personalExemption: 60000,
        spouseExemption: 60000,
        childExemption: 30000,
      },
    },
  });
  await storage.createStatutoryRuleSet({
    tenantId,
    countryCode: "TH",
    name: "Thailand Statutory Rules 2032+",
    description: "Default Thailand SSO and PIT rules for 2032 onwards",
    effectiveFrom: "2032-01-01",
    effectiveTo: null,
    status: "active",
    rules: {
      sso: {
        contributionRate: 0.05,
        ceilingAmount: 23000,
        effectiveFrom: "2032-01-01",
        effectiveTo: null,
      },
      pit: {
        brackets: [
          { min: 0, max: 150000, rate: 0 },
          { min: 150000, max: 300000, rate: 0.05 },
          { min: 300000, max: 500000, rate: 0.10 },
          { min: 500000, max: 750000, rate: 0.15 },
          { min: 750000, max: 1000000, rate: 0.20 },
          { min: 1000000, max: 2000000, rate: 0.25 },
          { min: 2000000, max: 5000000, rate: 0.30 },
          { min: 5000000, max: null, rate: 0.35 },
        ],
        personalExemption: 60000,
        spouseExemption: 60000,
        childExemption: 30000,
      },
    },
  });
}

export async function getStatutoryRules(
  countryCode: string,
  asOfDate: string
): Promise<ThailandStatutoryRules | null> {
  const ruleSet = await storage.getActiveStatutoryRuleSet(countryCode, asOfDate);
  if (!ruleSet) return null;
  return ruleSet.rules as ThailandStatutoryRules;
}

export async function seedThailandRulesPublic(tenantId: string): Promise<void> {
  await seedThailandRules(tenantId);
}
