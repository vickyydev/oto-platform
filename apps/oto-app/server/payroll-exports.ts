import { db } from "./db";
import { 
  payrollRuns, 
  payrollPeriods,
  payrollLineItems, 
  payrollEmployeeSummaries,
  employees,
  branches,
  operators
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { uploadToObjectStorage } from "./file-storage";

interface BankTransferRow {
  employeeName: string;
  bankCode: string;
  bankAccountNumber: string;
  amount: number;
  reference: string;
  employeeId: string;
}

interface JournalEntry {
  date: string;
  accountCode: string;
  accountName: string;
  description: string;
  debit: number;
  credit: number;
  reference: string;
}

export async function generateBankTransferFile(
  runId: string,
  bankFormat: "SCB" | "KBANK" | "BBL" | "GENERIC" = "GENERIC"
): Promise<{ success: boolean; filePath?: string; error?: string; totalAmount?: number; rowCount?: number }> {
  try {
    if (!["SCB", "KBANK", "BBL", "GENERIC"].includes(bankFormat)) {
      return { success: false, error: "Invalid bank format" };
    }
    const [run] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, runId));

    if (!run) {
      return { success: false, error: "Payroll run not found" };
    }

    const [period] = await db
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, run.payrollPeriodId));

    if (!period) {
      return { success: false, error: "Payroll period not found" };
    }

    const summaries = await db
      .select()
      .from(payrollEmployeeSummaries)
      .where(eq(payrollEmployeeSummaries.payrollRunId, runId));

    const employeeIds = summaries.map(s => s.employeeId);
    const employeeData = await db
      .select()
      .from(employees);

    const employeeMap = new Map(
      employeeData
        .filter(e => employeeIds.includes(e.id))
        .map(e => [e.id, e])
    );

    const transferRows: BankTransferRow[] = [];
    let totalAmount = 0;

    for (const summary of summaries) {
      const employee = employeeMap.get(summary.employeeId);
      if (!employee) continue;

      const netPay = parseFloat(summary.netPay);
      if (netPay <= 0) continue;

      const mergeData = employee.defaultMergeData as any;
      const bankAccountNumber = mergeData?.bankAccountNumber || "";
      const bankCode = mergeData?.bankCode || "";

      transferRows.push({
        employeeName: employee.fullName,
        bankCode,
        bankAccountNumber,
        amount: netPay,
        reference: `PAY-${period.startDate}-${employee.id.slice(0, 8)}`,
        employeeId: employee.id,
      });

      totalAmount += netPay;
    }

    const fileName = `${runId}_bank_transfer_${period.startDate}_${bankFormat.toLowerCase()}.csv`;

    let csvContent = "";

    switch (bankFormat) {
      case "SCB":
        csvContent = generateScbFormat(transferRows, period.startDate);
        break;
      case "KBANK":
        csvContent = generateKbankFormat(transferRows, period.startDate);
        break;
      case "BBL":
        csvContent = generateBblFormat(transferRows, period.startDate);
        break;
      default:
        csvContent = generateGenericFormat(transferRows);
    }

    await uploadToObjectStorage(Buffer.from(csvContent, "utf-8"), "payroll-exports", fileName, "text/csv");

    return { 
      success: true, 
      filePath: `/api/payroll/exports/bank-transfers/${fileName}`,
      totalAmount,
      rowCount: transferRows.length,
    };
  } catch (error: any) {
    console.error("Error generating bank transfer file:", error);
    return { success: false, error: error.message };
  }
}

function generateGenericFormat(rows: BankTransferRow[]): string {
  const header = "Employee Name,Bank Code,Account Number,Amount (THB),Reference,Employee ID";
  const dataRows = rows.map(r => 
    `"${r.employeeName}","${r.bankCode}","${r.bankAccountNumber}",${r.amount.toFixed(2)},"${r.reference}","${r.employeeId}"`
  );
  return [header, ...dataRows].join("\n");
}

function generateScbFormat(rows: BankTransferRow[], payDate: string): string {
  const header = "Record Type,Account Number,Amount,Beneficiary Name,Email,Payment Date";
  const dataRows = rows.map(r => 
    `D,${r.bankAccountNumber},${r.amount.toFixed(2)},"${r.employeeName}",,${payDate.replace(/-/g, "")}`
  );
  return [header, ...dataRows].join("\n");
}

function generateKbankFormat(rows: BankTransferRow[], payDate: string): string {
  const header = "Seq,Account No,Amount,Name,Ref1,Ref2";
  const dataRows = rows.map((r, i) => 
    `${i + 1},${r.bankAccountNumber},${r.amount.toFixed(2)},"${r.employeeName}",${r.reference},SALARY`
  );
  return [header, ...dataRows].join("\n");
}

function generateBblFormat(rows: BankTransferRow[], payDate: string): string {
  const header = "No,Beneficiary Acct,Amount,Beneficiary Name,Advice Detail";
  const dataRows = rows.map((r, i) => 
    `${i + 1},${r.bankAccountNumber},${r.amount.toFixed(2)},"${r.employeeName}",Salary Payment`
  );
  return [header, ...dataRows].join("\n");
}

export async function generateAccountingJournal(
  runId: string,
  format: "CSV" | "SAGE" | "QUICKBOOKS" = "CSV"
): Promise<{ success: boolean; filePath?: string; error?: string; entryCount?: number }> {
  try {
    if (!["CSV", "SAGE", "QUICKBOOKS"].includes(format)) {
      return { success: false, error: "Invalid journal format" };
    }
    const [run] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, runId));

    if (!run) {
      return { success: false, error: "Payroll run not found" };
    }

    const [period] = await db
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, run.payrollPeriodId));

    if (!period) {
      return { success: false, error: "Payroll period not found" };
    }

    const summaries = await db
      .select()
      .from(payrollEmployeeSummaries)
      .where(eq(payrollEmployeeSummaries.payrollRunId, runId));

    const lineItems = await db
      .select()
      .from(payrollLineItems)
      .where(eq(payrollLineItems.payrollRunId, runId));

    const journalEntries: JournalEntry[] = [];
    const journalDate = period.endDate;
    const journalRef = `PAY-${period.startDate}`;

    let totalGross = 0;
    let totalSsoEmployee = 0;
    let totalSsoEmployer = 0;
    let totalPit = 0;
    let totalOtherDeductions = 0;
    let totalNetPay = 0;
    let totalFoodAllowance = 0;
    let totalOvertime = 0;

    for (const item of lineItems) {
      const amount = parseFloat(item.amount);
      switch (item.code) {
        case "BASE_SALARY":
          totalGross += amount;
          break;
        case "OVERTIME":
          totalOvertime += amount;
          break;
        case "FOOD_ALLOWANCE":
          totalFoodAllowance += amount;
          break;
        case "SSO_EMPLOYEE":
          totalSsoEmployee += amount;
          break;
        case "SSO_EMPLOYER":
          totalSsoEmployer += amount;
          break;
        case "PIT":
          totalPit += amount;
          break;
        default:
          if (item.lineType === "DEDUCTION") {
            totalOtherDeductions += amount;
          }
      }
    }

    for (const summary of summaries) {
      totalNetPay += parseFloat(summary.netPay);
    }

    journalEntries.push({
      date: journalDate,
      accountCode: "5100",
      accountName: "Salaries Expense",
      description: "Base Salaries",
      debit: totalGross,
      credit: 0,
      reference: journalRef,
    });

    if (totalOvertime > 0) {
      journalEntries.push({
        date: journalDate,
        accountCode: "5110",
        accountName: "Overtime Expense",
        description: "Overtime Pay",
        debit: totalOvertime,
        credit: 0,
        reference: journalRef,
      });
    }

    if (totalFoodAllowance > 0) {
      journalEntries.push({
        date: journalDate,
        accountCode: "5120",
        accountName: "Employee Benefits Expense",
        description: "Food Allowance",
        debit: totalFoodAllowance,
        credit: 0,
        reference: journalRef,
      });
    }

    if (totalSsoEmployer > 0) {
      journalEntries.push({
        date: journalDate,
        accountCode: "5200",
        accountName: "Employer SSO Expense",
        description: "Employer Social Security Contribution",
        debit: totalSsoEmployer,
        credit: 0,
        reference: journalRef,
      });
    }

    journalEntries.push({
      date: journalDate,
      accountCode: "1000",
      accountName: "Cash/Bank",
      description: "Net Salary Payment",
      debit: 0,
      credit: totalNetPay,
      reference: journalRef,
    });

    if (totalSsoEmployee > 0 || totalSsoEmployer > 0) {
      journalEntries.push({
        date: journalDate,
        accountCode: "2100",
        accountName: "SSO Payable",
        description: "Social Security Contributions Payable",
        debit: 0,
        credit: totalSsoEmployee + totalSsoEmployer,
        reference: journalRef,
      });
    }

    if (totalPit > 0) {
      journalEntries.push({
        date: journalDate,
        accountCode: "2110",
        accountName: "Withholding Tax Payable",
        description: "Personal Income Tax Withheld",
        debit: 0,
        credit: totalPit,
        reference: journalRef,
      });
    }

    if (totalOtherDeductions > 0) {
      journalEntries.push({
        date: journalDate,
        accountCode: "2120",
        accountName: "Other Deductions Payable",
        description: "Other Payroll Deductions",
        debit: 0,
        credit: totalOtherDeductions,
        reference: journalRef,
      });
    }

    const fileName = `${runId}_journal_${period.startDate}_${format.toLowerCase()}.csv`;

    let csvContent = "";

    switch (format) {
      case "SAGE":
        csvContent = generateSageFormat(journalEntries);
        break;
      case "QUICKBOOKS":
        csvContent = generateQuickBooksFormat(journalEntries);
        break;
      default:
        csvContent = generateJournalCsvFormat(journalEntries);
    }

    await uploadToObjectStorage(Buffer.from(csvContent, "utf-8"), "payroll-exports", fileName, "text/csv");

    return { 
      success: true, 
      filePath: `/api/payroll/exports/journals/${fileName}`,
      entryCount: journalEntries.length,
    };
  } catch (error: any) {
    console.error("Error generating accounting journal:", error);
    return { success: false, error: error.message };
  }
}

function generateJournalCsvFormat(entries: JournalEntry[]): string {
  const header = "Date,Account Code,Account Name,Description,Debit,Credit,Reference";
  const dataRows = entries.map(e => 
    `${e.date},"${e.accountCode}","${e.accountName}","${e.description}",${e.debit.toFixed(2)},${e.credit.toFixed(2)},"${e.reference}"`
  );
  return [header, ...dataRows].join("\n");
}

function generateSageFormat(entries: JournalEntry[]): string {
  const header = "Date,Nominal,Name,Reference,Details,T/C,Value";
  const dataRows = entries.flatMap(e => {
    const rows = [];
    if (e.debit > 0) {
      rows.push(`${e.date},${e.accountCode},"${e.accountName}",${e.reference},"${e.description}",T,${e.debit.toFixed(2)}`);
    }
    if (e.credit > 0) {
      rows.push(`${e.date},${e.accountCode},"${e.accountName}",${e.reference},"${e.description}",C,${e.credit.toFixed(2)}`);
    }
    return rows;
  });
  return [header, ...dataRows].join("\n");
}

function generateQuickBooksFormat(entries: JournalEntry[]): string {
  const header = "!TRNS,TRNSID,TRNSTYPE,DATE,ACCNT,AMOUNT,MEMO";
  const dataRows = entries.map(e => {
    const amount = e.debit > 0 ? e.debit : -e.credit;
    return `TRNS,,GENERAL JOURNAL,${e.date},"${e.accountName}",${amount.toFixed(2)},"${e.description}"`;
  });
  dataRows.push("ENDTRNS");
  return [header, ...dataRows].join("\n");
}

export async function generateSsoFilingReport(
  runId: string
): Promise<{ success: boolean; filePath?: string; error?: string; employeeCount?: number; totalContributions?: number }> {
  try {
    const [run] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, runId));

    if (!run) {
      return { success: false, error: "Payroll run not found" };
    }

    const [period] = await db
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, run.payrollPeriodId));

    if (!period) {
      return { success: false, error: "Payroll period not found" };
    }

    const lineItems = await db
      .select()
      .from(payrollLineItems)
      .where(
        and(
          eq(payrollLineItems.payrollRunId, runId),
          eq(payrollLineItems.code, "SSO_EMPLOYEE")
        )
      );

    const employeeIds = Array.from(new Set(lineItems.map(l => l.employeeId)));
    const employeeData = await db.select().from(employees);
    const employeeMap = new Map(employeeData.map(e => [e.id, e]));

    const rows: string[] = [];
    let totalContributions = 0;

    rows.push("SSO Number,Name,ID Number,Base Salary,Employee Contribution,Employer Contribution,Total");

    for (const item of lineItems) {
      const employee = employeeMap.get(item.employeeId);
      if (!employee) continue;

      const employeeContrib = parseFloat(item.amount);
      const employerContrib = employeeContrib;
      const baseSalary = (item.metadata as any)?.grossPay || 0;
      const total = employeeContrib + employerContrib;

      rows.push([
        employee.ssoNumber || "",
        `"${employee.fullName}"`,
        employee.taxIdNumber || "",
        baseSalary.toFixed(2),
        employeeContrib.toFixed(2),
        employerContrib.toFixed(2),
        total.toFixed(2),
      ].join(","));

      totalContributions += total;
    }

    const fileName = `${runId}_sso_filing_${period.startDate}.csv`;
    await uploadToObjectStorage(Buffer.from(rows.join("\n"), "utf-8"), "payroll-exports", fileName, "text/csv");

    return { 
      success: true, 
      filePath: `/api/payroll/exports/sso-filings/${fileName}`,
      employeeCount: employeeIds.length,
      totalContributions,
    };
  } catch (error: any) {
    console.error("Error generating SSO filing report:", error);
    return { success: false, error: error.message };
  }
}

export async function generatePitFilingReport(
  runId: string
): Promise<{ success: boolean; filePath?: string; error?: string; employeeCount?: number; totalTax?: number }> {
  try {
    const [run] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, runId));

    if (!run) {
      return { success: false, error: "Payroll run not found" };
    }

    const [period] = await db
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, run.payrollPeriodId));

    if (!period) {
      return { success: false, error: "Payroll period not found" };
    }

    const lineItems = await db
      .select()
      .from(payrollLineItems)
      .where(
        and(
          eq(payrollLineItems.payrollRunId, runId),
          eq(payrollLineItems.code, "PIT")
        )
      );

    const employeeData = await db.select().from(employees);
    const employeeMap = new Map(employeeData.map(e => [e.id, e]));

    const rows: string[] = [];
    let totalTax = 0;

    rows.push("Tax ID,Name,Taxable Income,Tax Withheld,Period");

    for (const item of lineItems) {
      const employee = employeeMap.get(item.employeeId);
      if (!employee) continue;

      const taxAmount = parseFloat(item.amount);
      const taxableIncome = (item.metadata as any)?.monthlyTaxable || 0;

      rows.push([
        employee.taxIdNumber || "",
        `"${employee.fullName}"`,
        taxableIncome.toFixed(2),
        taxAmount.toFixed(2),
        period.startDate,
      ].join(","));

      totalTax += taxAmount;
    }

    const fileName = `${runId}_pit_filing_${period.startDate}.csv`;
    await uploadToObjectStorage(Buffer.from(rows.join("\n"), "utf-8"), "payroll-exports", fileName, "text/csv");

    return { 
      success: true, 
      filePath: `/api/payroll/exports/pit-filings/${fileName}`,
      employeeCount: lineItems.length,
      totalTax,
    };
  } catch (error: any) {
    console.error("Error generating PIT filing report:", error);
    return { success: false, error: error.message };
  }
}
