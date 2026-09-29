// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "hr");

test("can add an employee from the Employees page", async ({ page }) => {
  test.setTimeout(90000);
  await login(page);

  // Switch to Bangkok branch
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("branch-selector-trigger").click();
  await page.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await page.waitForTimeout(500);
  await page.getByTestId("section-toggle-hr-operations").click();
  await page.getByTestId("nav-employees").click();
  await expect(page.getByTestId("text-employees-title")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "employees-list.png") });

  // Click + Add
  await page.getByRole("link", { name: "Add" }).first().click();
  await expect(page.getByRole("heading", { name: "Add Employee" })).toBeVisible({ timeout: 45000 });

  // Fill Personal Information
  const suffix = testId();
  const fullName = `Test Employee ${suffix}`;
  await page.locator("input[name='fullName']").fill(fullName);
  await page.locator("input[name='nickname']").fill(`Emp${suffix}`);
  await page.locator("input[name='email']").fill(`emp-${suffix}@example.com`);
  await page.locator("input[name='phone']").fill(`+6680000${suffix.substring(0, 4)}`);

  await page.screenshot({ path: path.join(imgDir, "add-employee-personal.png") });

  // Fill Employment Details — Position Title
  await page.locator("input[name='defaultMergeData.positionTitle']").fill("Receptionist");

  // Select Branch
  await page.locator("label:has-text('Branch') >> .. >> button").first().click();
  await page.getByRole("option", { name: "Bangkok" }).click();

  // Select Department (enabled after branch selection)
  await page.locator("label:has-text('Department') >> .. >> button").first().click();
  await page.getByRole("option", { name: "Front Desk" }).click();

  // Monthly Salary
  await page.locator("input[placeholder*='50,000']").fill("25000");

  // Start Date — click the date picker button, then pick day 1
  await page.locator("label:has-text('Start Date') >> .. >> button").first().scrollIntoViewIfNeeded();
  await page.locator("label:has-text('Start Date') >> .. >> button").first().click();
  await page.locator("table button:has-text('1')").first().click();

  await page.screenshot({ path: path.join(imgDir, "add-employee-employment.png") });

  // Submit
  await page.getByTestId("button-section-save").first().click();

  // Verify employee appears in list
  const row = page.locator("tr", { hasText: fullName });
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.getByText("Receptionist")).toBeVisible();
  await page.screenshot({ path: path.join(imgDir, "employee-created.png") });

  // Employee documents survive the request in object storage and are served
  // through the employee-scoped route, never through the generic file route.
  const employeesResponse = await page.request.get("/api/employees");
  expect(employeesResponse.status()).toBe(200);
  const employees = await employeesResponse.json();
  const employee = employees.find((item: { fullName: string }) => item.fullName === fullName);
  expect(employee?.id).toBeTruthy();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN0AAAAASUVORK5CYII=", "base64");
  const uploaded = await page.request.post(`/api/employees/${employee.id}/documents`, {
    multipart: { documentType: "other", file: { name: "record.png", mimeType: "image/png", buffer: png } },
  });
  expect(uploaded.status()).toBe(201);
  const document = await uploaded.json();
  const file = await page.request.get(`/api/employees/${employee.id}/documents/${document.id}/file`);
  expect(file.status()).toBe(200);
  expect(await file.body()).toEqual(png);
  expect((await page.request.get(document.filePath)).status()).toBe(404);
  const otherEmployee = employees.find((item: { id: string }) => item.id !== employee.id);
  if (otherEmployee) {
    expect((await page.request.get(`/api/employees/${otherEmployee.id}/documents/${document.id}/file`)).status()).toBe(404);
  }
  expect((await page.request.delete(`/api/employees/${employee.id}/documents/${document.id}`)).status()).toBe(204);
  expect((await page.request.get(`/api/employees/${employee.id}/documents/${document.id}/file`)).status()).toBe(404);

  const sheet = XLSX.utils.aoa_to_sheet([["Full Name", "Email"], ["QA Preview", "qa-preview@example.com"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Employees");
  const spreadsheet = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  const preview = await page.request.post("/api/employees/bulk-upload-preview", {
    multipart: { file: { name: "preview.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: spreadsheet } },
  });
  expect(preview.status()).toBe(200);
});
