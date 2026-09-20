import puppeteer from "puppeteer";
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
import fs from "fs/promises";
import path from "path";

interface PayslipData {
  companyName: string;
  companyAddress: string;
  branchName: string;
  employeeName: string;
  employeeId: string;
  employeeEmail: string;
  position: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  earnings: Array<{
    description: string;
    quantity: number | null;
    rate: number | null;
    amount: number;
  }>;
  deductions: Array<{
    description: string;
    amount: number;
  }>;
  statutoryContributions: {
    employeeSso: number;
    employerSso: number;
    incomeTax: number;
  };
  summary: {
    grossPay: number;
    totalDeductions: number;
    netPay: number;
  };
}

export async function generatePayslipPdf(
  runId: string,
  employeeId: string
): Promise<{ success: boolean; pdfPath?: string; error?: string }> {
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

    const [summary] = await db
      .select()
      .from(payrollEmployeeSummaries)
      .where(
        and(
          eq(payrollEmployeeSummaries.payrollRunId, runId),
          eq(payrollEmployeeSummaries.employeeId, employeeId)
        )
      );

    if (!summary) {
      return { success: false, error: "Employee summary not found for this run" };
    }

    const lineItems = await db
      .select()
      .from(payrollLineItems)
      .where(
        and(
          eq(payrollLineItems.payrollRunId, runId),
          eq(payrollLineItems.employeeId, employeeId)
        )
      );

    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employeeId));

    const [operator] = await db
      .select()
      .from(operators)
      .where(eq(operators.id, period.operatorId));

    const [branch] = employee?.branchId ? await db
      .select()
      .from(branches)
      .where(eq(branches.id, employee.branchId)) : [null];

    const earnings = lineItems
      .filter(item => item.lineType === "EARNING")
      .map(item => ({
        description: item.description,
        quantity: item.quantity ? parseFloat(item.quantity) : null,
        rate: item.rate ? parseFloat(item.rate) : null,
        amount: parseFloat(item.amount),
      }));

    const deductions = lineItems
      .filter(item => item.lineType === "DEDUCTION" && !item.statutory)
      .map(item => ({
        description: item.description,
        amount: parseFloat(item.amount),
      }));

    const employeeSso = lineItems
      .filter(item => item.code === "SSO_EMPLOYEE")
      .reduce((sum, item) => sum + parseFloat(item.amount), 0);

    const employerSso = lineItems
      .filter(item => item.code === "SSO_EMPLOYER")
      .reduce((sum, item) => sum + parseFloat(item.amount), 0);

    const incomeTax = lineItems
      .filter(item => item.code === "PIT")
      .reduce((sum, item) => sum + parseFloat(item.amount), 0);

    const payslipData: PayslipData = {
      companyName: operator?.name || "OTO Company Limited",
      companyAddress: branch?.address || "",
      branchName: branch?.name || "",
      employeeName: employee?.fullName || "",
      employeeId: employee?.id.slice(0, 8) || "",
      employeeEmail: employee?.email || "",
      position: (employee?.defaultMergeData as any)?.positionTitle || "",
      periodStart: period.startDate,
      periodEnd: period.endDate,
      payDate: period.endDate,
      earnings,
      deductions,
      statutoryContributions: {
        employeeSso,
        employerSso,
        incomeTax,
      },
      summary: {
        grossPay: parseFloat(summary.grossPay),
        totalDeductions: parseFloat(summary.totalDeductions),
        netPay: parseFloat(summary.netPay),
      },
    };

    const html = generatePayslipHtml(payslipData);

    const pdfDir = path.join(process.cwd(), "pdfs", "payslips");
    await fs.mkdir(pdfDir, { recursive: true });

    const fileName = `payslip_${employeeId.slice(0, 8)}_${period.startDate}.pdf`;
    const pdfPath = path.join(pdfDir, fileName);

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    await page.pdf({
      path: pdfPath,
      format: "A4",
      margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
      printBackground: true,
    });

    await browser.close();

    return { success: true, pdfPath: `/pdfs/payslips/${fileName}` };
  } catch (error: any) {
    console.error("Error generating payslip PDF:", error);
    return { success: false, error: error.message };
  }
}

function generatePayslipHtml(data: PayslipData): string {
  const formatCurrency = (amount: number) => 
    amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      font-size: 11px;
      color: #333;
      line-height: 1.4;
    }
    .payslip {
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #1a365d;
      padding-bottom: 15px;
      margin-bottom: 20px;
    }
    .company-info h1 {
      font-size: 18px;
      color: #1a365d;
      margin-bottom: 5px;
    }
    .company-info p {
      font-size: 10px;
      color: #666;
    }
    .payslip-title {
      text-align: right;
    }
    .payslip-title h2 {
      font-size: 16px;
      color: #1a365d;
      margin-bottom: 5px;
    }
    .payslip-title p {
      font-size: 10px;
      color: #666;
    }
    .employee-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      background: #f8fafc;
      padding: 15px;
      border-radius: 5px;
      margin-bottom: 20px;
    }
    .info-group {
      display: flex;
      flex-direction: column;
    }
    .info-label {
      font-size: 9px;
      color: #666;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .info-value {
      font-size: 11px;
      font-weight: 500;
    }
    .main-content {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 20px;
    }
    .section {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 5px;
      overflow: hidden;
    }
    .section-header {
      background: #1a365d;
      color: white;
      padding: 8px 12px;
      font-weight: 600;
      font-size: 11px;
    }
    .section-content {
      padding: 10px 12px;
    }
    .line-item {
      display: flex;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .line-item:last-child {
      border-bottom: none;
    }
    .line-item-desc {
      flex: 1;
    }
    .line-item-detail {
      color: #666;
      font-size: 9px;
    }
    .line-item-amount {
      font-weight: 500;
      text-align: right;
      min-width: 80px;
    }
    .statutory-section {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed #e2e8f0;
    }
    .statutory-label {
      font-size: 10px;
      color: #666;
      margin-bottom: 5px;
    }
    .summary-section {
      background: #1a365d;
      color: white;
      padding: 20px;
      border-radius: 5px;
      margin-bottom: 20px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
    }
    .summary-item {
      text-align: center;
    }
    .summary-label {
      font-size: 10px;
      opacity: 0.8;
      margin-bottom: 3px;
    }
    .summary-value {
      font-size: 16px;
      font-weight: 600;
    }
    .net-pay {
      font-size: 24px !important;
    }
    .footer {
      text-align: center;
      font-size: 9px;
      color: #999;
      padding-top: 15px;
      border-top: 1px solid #e2e8f0;
    }
    .footer p {
      margin-bottom: 3px;
    }
  </style>
</head>
<body>
  <div class="payslip">
    <div class="header">
      <div class="company-info">
        <h1>${data.companyName}</h1>
        <p>${data.branchName}</p>
        <p>${data.companyAddress}</p>
      </div>
      <div class="payslip-title">
        <h2>PAYSLIP</h2>
        <p>Pay Period: ${data.periodStart} to ${data.periodEnd}</p>
        <p>Pay Date: ${data.payDate}</p>
      </div>
    </div>

    <div class="employee-info">
      <div class="info-group">
        <span class="info-label">Employee Name</span>
        <span class="info-value">${data.employeeName}</span>
      </div>
      <div class="info-group">
        <span class="info-label">Employee ID</span>
        <span class="info-value">${data.employeeId}</span>
      </div>
      <div class="info-group">
        <span class="info-label">Position</span>
        <span class="info-value">${data.position}</span>
      </div>
      <div class="info-group">
        <span class="info-label">Email</span>
        <span class="info-value">${data.employeeEmail}</span>
      </div>
    </div>

    <div class="main-content">
      <div class="section">
        <div class="section-header">Earnings</div>
        <div class="section-content">
          ${data.earnings.map(item => `
            <div class="line-item">
              <div class="line-item-desc">
                ${item.description}
                ${item.quantity && item.rate ? `<div class="line-item-detail">${item.quantity} x ${formatCurrency(item.rate)}</div>` : ''}
              </div>
              <div class="line-item-amount">${formatCurrency(item.amount)}</div>
            </div>
          `).join('')}
          <div class="line-item" style="font-weight: 600; border-top: 2px solid #e2e8f0; margin-top: 5px; padding-top: 10px;">
            <div>Total Earnings</div>
            <div class="line-item-amount">${formatCurrency(data.summary.grossPay)}</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">Deductions</div>
        <div class="section-content">
          ${data.deductions.map(item => `
            <div class="line-item">
              <div class="line-item-desc">${item.description}</div>
              <div class="line-item-amount">${formatCurrency(item.amount)}</div>
            </div>
          `).join('')}
          <div class="statutory-section">
            <div class="statutory-label">Statutory Contributions</div>
            <div class="line-item">
              <div class="line-item-desc">Social Security (Employee)</div>
              <div class="line-item-amount">${formatCurrency(data.statutoryContributions.employeeSso)}</div>
            </div>
            <div class="line-item">
              <div class="line-item-desc">Personal Income Tax</div>
              <div class="line-item-amount">${formatCurrency(data.statutoryContributions.incomeTax)}</div>
            </div>
          </div>
          <div class="line-item" style="font-weight: 600; border-top: 2px solid #e2e8f0; margin-top: 5px; padding-top: 10px;">
            <div>Total Deductions</div>
            <div class="line-item-amount">${formatCurrency(data.summary.totalDeductions)}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="summary-section">
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">Gross Pay</div>
          <div class="summary-value">${formatCurrency(data.summary.grossPay)}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Total Deductions</div>
          <div class="summary-value">${formatCurrency(data.summary.totalDeductions)}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Net Pay</div>
          <div class="summary-value net-pay">${formatCurrency(data.summary.netPay)}</div>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>This is a computer-generated document. No signature is required.</p>
      <p>For questions about this payslip, please contact HR.</p>
      <p>Generated by OTO HR System</p>
    </div>
  </div>
</body>
</html>
  `;
}

export async function generateBulkPayslips(
  runId: string
): Promise<{ success: boolean; generated: number; errors: string[] }> {
  const errors: string[] = [];
  let generated = 0;

  const summaries = await db
    .select()
    .from(payrollEmployeeSummaries)
    .where(eq(payrollEmployeeSummaries.payrollRunId, runId));

  for (const summary of summaries) {
    const result = await generatePayslipPdf(runId, summary.employeeId);
    if (result.success) {
      generated++;
    } else {
      errors.push(`Employee ${summary.employeeId}: ${result.error}`);
    }
  }

  return { success: errors.length === 0, generated, errors };
}
