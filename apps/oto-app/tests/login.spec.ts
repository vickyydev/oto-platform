// seed: full
import { test, expect } from "@playwright/test";
import { login, users } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "auth");

test("can log in as admin", async ({ page }) => {
  await page.goto("/");
  await page.screenshot({ path: path.join(imgDir, "login.png") });

  await page.getByTestId("button-toggle-login-mode").click();
  await page.getByTestId("input-login-email").fill(users.admin.email);
  await page.getByTestId("input-login-password").fill(users.admin.password);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL("**/today**", { timeout: 10000 });
  await expect(page.getByText("Today").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("Events Today")).toBeVisible({ timeout: 10000 });

  await page.screenshot({ path: path.join(imgDir, "today-empty.png") });
  expect(page.url()).toContain("/today");
});

test("wrong password fails to log in", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("button-toggle-login-mode").click();
  await page.getByTestId("input-login-email").fill(users.admin.email);
  await page.getByTestId("input-login-password").fill("wrongpassword");
  await page.click('button:has-text("Sign in")');
  await expect(page.getByText("Invalid credentials").first()).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: path.join(imgDir, "login-failed.png") });
});
