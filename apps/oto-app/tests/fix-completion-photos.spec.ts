// seed: full
import { test, expect, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { db } from "../server/db";
import {
  branches,
  DEFAULT_TENANT_SLUG,
  fixReports,
  tenants,
  users,
} from "../shared/schema";
import { login } from "./helpers";

const COMPLETION_PHOTO_URL = "/api/fix-media/completion-photo-test.png";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function seedFixReport(title: string) {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "admin@example.com"))
    .limit(1);
  const [branch] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(
      eq(branches.tenantId, tenant.id),
      eq(branches.name, "Bangkok"),
    ))
    .limit(1);

  expect(tenant, "Full seed should include the default tenant").toBeTruthy();
  expect(admin, "Full seed should include the global admin").toBeTruthy();
  expect(branch, "Full seed should include a branch").toBeTruthy();

  const [report] = await db
    .insert(fixReports)
    .values({
      tenantId: tenant.id,
      branchId: branch.id,
      reportedBy: admin.id,
      title,
      location: "Completion photo regression test",
      status: "new",
      media: ["/api/fix-media/original-photo-test.png"],
    })
    .returning({ id: fixReports.id });

  return report;
}

async function openCompletionSheet(page: Page, reportId: string) {
  await page.goto("/core/fix-board");
  await page.getByTestId(`card-fix-report-${reportId}`).click();
  await page.getByTestId("select-status-change").click();
  await page.getByRole("option", { name: "Complete", exact: true }).click();
  await expect(page.getByTestId("dialog-completion-photos")).toBeVisible();
}

test("Fix create offers separate camera and gallery inputs", async ({ page }) => {
  await login(page);
  await page.goto("/core/fix?report=1");

  const cameraInput = page.getByTestId("input-camera");
  const galleryInput = page.getByTestId("input-gallery");
  await expect(cameraInput).toHaveAttribute("capture", "environment");
  await expect(galleryInput).not.toHaveAttribute("capture", /.+/);

  const galleryClickCount = await galleryInput.evaluate((input) => {
    let clicks = 0;
    input.addEventListener("click", () => clicks++);
    (window as Window & { getGalleryClickCount?: () => number }).getGalleryClickCount = () => clicks;
    return clicks;
  });
  expect(galleryClickCount).toBe(0);
  await page.getByTestId("button-choose-gallery").click();
  await expect.poll(() =>
    page.evaluate(() =>
      (window as Window & { getGalleryClickCount?: () => number }).getGalleryClickCount?.(),
    ),
  ).toBe(1);
});

test("completion photo is appended and appears in the report gallery", async ({ page }) => {
  const report = await seedFixReport(`Fix completion photo ${Date.now()}`);

  try {
    await login(page);
    await page.route("**/api/fix-reports/upload", async (route) => {
      expect(route.request().method()).toBe("POST");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ urls: [COMPLETION_PHOTO_URL] }),
      });
    });

    await openCompletionSheet(page, report.id);
    await page.getByTestId("input-completion-gallery").setInputFiles({
      name: "completion.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    await expect(page.getByTestId("button-confirm-complete")).toContainText("1 photo");

    const patchRequestPromise = page.waitForRequest((request) =>
      request.method() === "PATCH"
      && new URL(request.url()).pathname === `/api/fix-reports/${report.id}/update`,
    );
    await page.getByTestId("button-confirm-complete").click();
    const patchRequest = await patchRequestPromise;
    expect(patchRequest.postDataJSON()).toEqual({
      status: "done",
      appendMedia: [COMPLETION_PHOTO_URL],
    });

    await expect(page.getByTestId("dialog-completion-photos")).toBeHidden();
    await expect(page.getByTestId("photo-thumbnail-1")).toBeVisible();
    const [stored] = await db
      .select({ status: fixReports.status, media: fixReports.media })
      .from(fixReports)
      .where(eq(fixReports.id, report.id));
    expect(stored.status).toBe("done");
    expect(stored.media).toEqual([
      "/api/fix-media/original-photo-test.png",
      COMPLETION_PHOTO_URL,
    ]);
  } finally {
    await db.delete(fixReports).where(eq(fixReports.id, report.id));
  }
});


test("skipping completion photos marks the report done without appendMedia", async ({ page }) => {
  const report = await seedFixReport(`Fix completion skip ${Date.now()}`);

  try {
    await login(page);
    await openCompletionSheet(page, report.id);

    const patchRequestPromise = page.waitForRequest((request) =>
      request.method() === "PATCH"
      && new URL(request.url()).pathname === `/api/fix-reports/${report.id}/update`,
    );
    await page.getByTestId("button-skip-complete").click();
    const patchRequest = await patchRequestPromise;
    expect(patchRequest.postDataJSON()).toEqual({ status: "done" });

    await expect(page.getByTestId("dialog-completion-photos")).toBeHidden();
    const [stored] = await db
      .select({ status: fixReports.status, media: fixReports.media })
      .from(fixReports)
      .where(eq(fixReports.id, report.id));
    expect(stored.status).toBe("done");
    expect(stored.media).toEqual(["/api/fix-media/original-photo-test.png"]);
  } finally {
    await db.delete(fixReports).where(eq(fixReports.id, report.id));
  }
});