// seed: full
import { test, expect } from '@playwright/test';
import { login, testId } from './helpers';

test.describe('Checklist Creation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    // Navigate to checklists page
    await page.goto('/studio/checklists');
    await page.waitForLoadState('networkidle');
  });

  test('should create a basic operational checklist', async ({ page }) => {
    // Open the create dialog
    await page.getByTestId('button-create-checklist').click();
    await expect(page.getByRole('heading', { name: 'Create Checklist Template' })).toBeVisible({ timeout: 5000 });

    // Fill in checklist name and first item
    const checklistName = `Test Operational Checklist ${testId()}`;
    await page.getByTestId('input-checklist-name').fill(checklistName);
    await page.getByTestId('input-item-0').fill('Test Item 1');

    // Submit the form
    await page.getByTestId('button-submit-checklist').click();
    await page.waitForTimeout(2000);

    // Verify success toast appears
    await expect(page.getByText('Checklist template created')).toBeVisible({ timeout: 5000 });

    // Verify checklist appears in the list
    await expect(page.getByText(checklistName)).toBeVisible({ timeout: 5000 });
  });

  test('should create checklist with weekly recurrence', async ({ page }) => {
    // Open the create dialog
    await page.getByTestId('button-create-checklist').click();
    await expect(page.getByRole('heading', { name: 'Create Checklist Template' })).toBeVisible({ timeout: 5000 });

    // Fill in checklist name
    await page.getByTestId('input-checklist-name').fill(`Weekly Checklist ${testId()}`);

    // Select weekly recurrence via Radix Select
    await page.getByTestId('select-recurrence').click();
    await page.getByRole('option', { name: 'Weekly' }).click();

    // Select specific days using the day buttons that appear after selecting weekly
    await page.getByTestId('btn-day-mon').click();
    await page.getByTestId('btn-day-wed').click();
    await page.getByTestId('btn-day-fri').click();

    // Fill in first item
    await page.getByTestId('input-item-0').fill('Weekly Task');

    // Submit the form
    await page.getByTestId('button-submit-checklist').click();
    await page.waitForTimeout(2000);

    // Verify success
    await expect(page.getByText('Checklist template created')).toBeVisible({ timeout: 5000 });
  });

  test('should create checker type checklist', async ({ page }) => {
    // Open the create dialog
    await page.getByTestId('button-create-checklist').click();
    await expect(page.getByRole('heading', { name: 'Create Checklist Template' })).toBeVisible({ timeout: 5000 });

    // Fill in checklist name
    await page.getByTestId('input-checklist-name').fill(`Quality Check ${testId()}`);

    // Select Checker / Inspection type via Radix Select
    await page.getByTestId('select-checklist-type').click();
    await page.getByRole('option', { name: 'Checker / Inspection' }).click();

    // Set number of rounds to 3
    await page.getByTestId('select-checker-rounds').click();
    await page.getByRole('option', { name: '3 times per day' }).click();

    // Fill in first item
    await page.getByTestId('input-item-0').fill('Check Item');

    // Submit the form
    await page.getByTestId('button-submit-checklist').click();
    await page.waitForTimeout(2000);

    // Verify success
    await expect(page.getByText('Checklist template created')).toBeVisible({ timeout: 5000 });
  });

  test('persists per-item camera and gallery methods and applies them to runs', async ({ page }) => {
    const suffix = testId();
    const branchesResponse = await page.request.get('/api/studio/branches');
    expect(branchesResponse.ok()).toBeTruthy();
    const branches = await branchesResponse.json();
    const branch = branches[0];
    expect(branch?.id).toBeTruthy();

    const defaultResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Evidence defaults ${suffix}`,
        branchIds: [branch.id],
        checklistType: 'operational',
        items: [{ title: 'Default evidence item' }],
      },
    });
    expect(defaultResponse.ok()).toBeTruthy();
    const defaultTemplate = await defaultResponse.json();
    expect(defaultTemplate.items[0]).toMatchObject({
      cameraEnabled: true,
      galleryEnabled: false,
    });

    const invalidResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Invalid evidence ${suffix}`,
        branchIds: [branch.id],
        checklistType: 'operational',
        items: [{
          title: 'Impossible required photo',
          requiresPhoto: true,
          cameraEnabled: false,
          galleryEnabled: false,
        }],
      },
    });
    expect(invalidResponse.status()).toBe(400);

    const legacyChecklistWideResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Legacy checklist-wide evidence ${suffix}`,
        branchIds: [branch.id],
        checklistType: 'operational',
        requiresPhotoEvidence: true,
        items: [{ title: 'Legacy required photo' }],
      },
    });
    expect(legacyChecklistWideResponse.ok()).toBeTruthy();
    const legacyChecklistWideTemplate = await legacyChecklistWideResponse.json();
    expect(legacyChecklistWideTemplate.requiresPhotoEvidence).toBe(false);
    expect(legacyChecklistWideTemplate.items[0]).toMatchObject({
      requiresPhoto: true,
      cameraEnabled: true,
    });

    const invalidTypesResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Invalid evidence types ${suffix}`,
        branchIds: [branch.id],
        checklistType: 'operational',
        items: [{
          title: 'Invalid evidence flags',
          requiresPhoto: 'true',
          cameraEnabled: 'false',
          galleryEnabled: 'false',
        }],
      },
    });
    expect(invalidTypesResponse.status()).toBe(400);

    const templateResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Evidence methods ${suffix}`,
        branchIds: [branch.id],
        checklistType: 'operational',
        items: [
          { title: 'Camera only', cameraEnabled: true, galleryEnabled: false },
          { title: 'Gallery only', cameraEnabled: false, galleryEnabled: true },
          { title: 'Both methods', cameraEnabled: true, galleryEnabled: true, requiresPhoto: true },
          { title: 'No methods', cameraEnabled: false, galleryEnabled: false },
        ],
      },
    });
    expect(templateResponse.ok()).toBeTruthy();
    const template = await templateResponse.json();

    const reorderedItems = [...template.items].reverse();
    const updateResponse = await page.request.patch(`/api/checklists/templates/${template.id}`, {
      data: { items: reorderedItems },
    });
    expect(updateResponse.ok()).toBeTruthy();
    const updated = await updateResponse.json();
    expect(updated.items.map((item: any) => [item.title, item.cameraEnabled, item.galleryEnabled])).toEqual([
      ['No methods', false, false],
      ['Both methods', true, true],
      ['Gallery only', false, true],
      ['Camera only', true, false],
    ]);

    const invalidUpdateResponse = await page.request.patch(`/api/checklists/templates/${template.id}`, {
      data: {
        items: updated.items.map((item: any) => item.title === 'Both methods'
          ? { ...item, cameraEnabled: false, galleryEnabled: false }
          : item),
      },
    });
    expect(invalidUpdateResponse.status()).toBe(400);

    const legacyPartialBaseResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Legacy partial update ${suffix}`,
        branchIds: [branch.id],
        checklistType: 'operational',
        items: [{ title: 'Legacy partial item', cameraEnabled: false, galleryEnabled: false }],
      },
    });
    expect(legacyPartialBaseResponse.ok()).toBeTruthy();
    const legacyPartialBase = await legacyPartialBaseResponse.json();
    const legacyPartialUpdateResponse = await page.request.patch(`/api/checklists/templates/${legacyPartialBase.id}`, {
      data: { requiresPhotoEvidence: true },
    });
    expect(legacyPartialUpdateResponse.ok()).toBeTruthy();
    const legacyPartialUpdate = await legacyPartialUpdateResponse.json();
    expect(legacyPartialUpdate.requiresPhotoEvidence).toBe(false);
    expect(legacyPartialUpdate.items.every((item: any) => item.requiresPhoto === true)).toBe(true);

    const requiredPhotoTemplateResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Required photo completion ${suffix}`,
        branchIds: [branch.id],
        checklistType: 'operational',
        items: [{ title: 'Photo required item', requiresPhoto: true, cameraEnabled: true, galleryEnabled: false }],
      },
    });
    expect(requiredPhotoTemplateResponse.ok()).toBeTruthy();
    const requiredPhotoTemplate = await requiredPhotoTemplateResponse.json();
    const requiredPhotoRunResponse = await page.request.post('/api/checklist-runs/start', {
      data: { templateId: requiredPhotoTemplate.id, branchId: branch.id },
    });
    expect(requiredPhotoRunResponse.ok()).toBeTruthy();
    const requiredPhotoRun = await requiredPhotoRunResponse.json();
    const requiredPhotoRunDetailsResponse = await page.request.get(`/api/checklist-runs/${requiredPhotoRun.id}`);
    const requiredPhotoRunDetails = await requiredPhotoRunDetailsResponse.json();
    const requiredPhotoItem = requiredPhotoRunDetails.items[0];

    await page.request.patch(`/api/checklist-run-items/${requiredPhotoItem.id}`, {
      data: { completed: true },
    });
    const blockedCompletionResponse = await page.request.patch(`/api/checklist-runs/${requiredPhotoRun.id}`, {
      data: { status: 'completed' },
    });
    expect(blockedCompletionResponse.status()).toBe(400);
    expect(await blockedCompletionResponse.json()).toMatchObject({
      message: 'Cannot complete checklist: 1 item(s) need photo evidence',
    });

    const runResponse = await page.request.post('/api/checklist-runs/start', {
      data: { templateId: template.id, branchId: branch.id },
    });
    expect(runResponse.ok()).toBeTruthy();
    const startedRun = await runResponse.json();
    const runDetailsResponse = await page.request.get(`/api/checklist-runs/${startedRun.id}`);
    expect(runDetailsResponse.ok()).toBeTruthy();
    const runDetails = await runDetailsResponse.json();
    const byTitle = Object.fromEntries(runDetails.items.map((item: any) => [item.templateItem.title, item]));
    expect(byTitle['Camera only'].templateItem).toMatchObject({ cameraEnabled: true, galleryEnabled: false });
    expect(byTitle['Gallery only'].templateItem).toMatchObject({ cameraEnabled: false, galleryEnabled: true });

    await page.goto(`/core/checklist/${startedRun.id}?embedded=1`);
    await expect(page.getByTestId(`button-add-photo-${byTitle['Camera only'].id}`)).toBeVisible();
    await expect(page.getByTestId(`button-add-photo-library-${byTitle['Camera only'].id}`)).toHaveCount(0);
    await expect(page.getByTestId(`button-add-photo-${byTitle['Gallery only'].id}`)).toHaveCount(0);
    await expect(page.getByTestId(`button-add-photo-library-${byTitle['Gallery only'].id}`)).toBeVisible();
    await expect(page.getByTestId(`button-add-photo-${byTitle['No methods'].id}`)).toHaveCount(0);
    await expect(page.getByTestId(`button-add-photo-library-${byTitle['No methods'].id}`)).toHaveCount(0);
  });

  test('links operational items to multiple Fix reports with server-derived context', async ({ page }) => {
    const suffix = testId();
    const branchesResponse = await page.request.get('/api/studio/branches');
    expect(branchesResponse.ok()).toBeTruthy();
    const branches = await branchesResponse.json();
    const branch = branches[0];
    expect(branch?.id).toBeTruthy();

    const templateResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Fix-linked checklist ${suffix}`,
        description: 'Checklist-to-Fix lifecycle coverage',
        branchIds: [branch.id],
        recurrence: 'once',
        checklistType: 'operational',
        items: [{
          title: `Broken equipment ${suffix}`,
          description: 'Inspect this equipment',
          linkedToFix: true,
        }],
      },
    });
    expect(templateResponse.ok()).toBeTruthy();
    const template = await templateResponse.json();
    expect(template.items).toHaveLength(1);
    expect(template.items[0].linkedToFix).toBe(true);

    const runResponse = await page.request.post('/api/checklist-runs/start', {
      data: { templateId: template.id, branchId: branch.id },
    });
    expect(runResponse.ok()).toBeTruthy();
    const startedRun = await runResponse.json();

    const initialRunResponse = await page.request.get(`/api/checklist-runs/${startedRun.id}`);
    expect(initialRunResponse.ok()).toBeTruthy();
    const initialRun = await initialRunResponse.json();
    const runItem = initialRun.items[0];
    expect(runItem.templateItem.linkedToFix).toBe(true);
    expect(runItem.linkedFixReports).toEqual([]);

    const contextResponse = await page.request.get(`/api/fix-reports/checklist-source/${runItem.id}`);
    expect(contextResponse.ok()).toBeTruthy();
    const context = await contextResponse.json();
    expect(context.runId).toBe(startedRun.id);
    expect(context.itemTitle).toBe(`Broken equipment ${suffix}`);
    expect(context.branch.id).toBe(branch.id);

    await page.goto(`/core/checklist/${startedRun.id}?embedded=1`);
    await expect(page.getByTestId(`button-report-fix-${runItem.id}`)).toBeVisible();
    await page.getByTestId(`button-report-fix-${runItem.id}`).click();
    await expect(page).toHaveURL(new RegExp(`checklistSource=${runItem.id}.*returnEmbedded=1`));

    for (const priority of ['normal', 'high']) {
      const reportResponse = await page.request.post('/api/fix-reports', {
        data: {
          media: [`/api/files/fix-media/test-${suffix}-${priority}.jpg`],
          title: 'Client supplied title must not win',
          location: 'Client supplied location must not win',
          note: `Issue ${priority}`,
          tags: ['equipment'],
          priority,
          branchId: 'client-supplied-branch',
          sourceChecklistRunItemId: runItem.id,
        },
      });
      expect(reportResponse.ok()).toBeTruthy();
      const report = await reportResponse.json();
      expect(report.title).toBe(`Broken equipment ${suffix}`);
      expect(report.branchId).toBe(branch.id);
      expect(report.location).toBe(context.location?.name || '');
      expect(report.sourceChecklistRunItemId).toBe(runItem.id);
    }

    const failedReportResponse = await page.request.post('/api/fix-reports', {
      data: {
        media: [],
        title: 'Should not be created',
        branchId: branch.id,
        sourceChecklistRunItemId: runItem.id,
      },
    });
    expect(failedReportResponse.status()).toBe(400);

    await page.request.patch(`/api/checklist-run-items/${runItem.id}`, {
      data: { completed: true },
    });
    await page.request.patch(`/api/checklist-runs/${startedRun.id}`, {
      data: { status: 'completed' },
    });

    const completedRunResponse = await page.request.get(`/api/checklist-runs/${startedRun.id}`);
    expect(completedRunResponse.ok()).toBeTruthy();
    const completedRun = await completedRunResponse.json();
    expect(completedRun.status).toBe('completed');
    const currentUserResponse = await page.request.get('/api/user');
    expect(currentUserResponse.ok()).toBeTruthy();
    const currentUser = await currentUserResponse.json();
    const expectedDisplayName = currentUser.preferredName || currentUser.fullName;
    expect(completedRun.completedBy).toBe(currentUser.id);
    expect(completedRun.completedByName).toBe(expectedDisplayName);
    expect(completedRun.completedAt).toBeTruthy();
    expect(completedRun.items[0].completedBy).toBe(currentUser.id);
    expect(completedRun.items[0].completedByName).toBe(expectedDisplayName);
    expect(completedRun.items[0].completedAt).toBeTruthy();
    expect(completedRun.items[0].linkedFixReports).toHaveLength(2);

    await page.goto(`/core/checklist/${startedRun.id}?embedded=1`);
    await expect(page.getByTestId('checklist-completion-audit')).toContainText(`Completed by ${expectedDisplayName}`);
    await expect(page.getByTestId(`item-completion-audit-${runItem.id}`)).toContainText(`Completed by ${expectedDisplayName}`);
    await expect(page.getByTestId(`button-item-${runItem.id}`)).toBeDisabled();
    await expect(page.getByTestId('button-complete-checklist')).toHaveCount(0);

    const checkerResponse = await page.request.post('/api/checklists/templates', {
      data: {
        name: `Checker ignores Fix link ${suffix}`,
        branchIds: [branch.id],
        recurrence: 'once',
        checklistType: 'checker',
        checkerRounds: 1,
        items: [{ title: `Checker item ${suffix}`, linkedToFix: true }],
      },
    });
    expect(checkerResponse.ok()).toBeTruthy();
    const checker = await checkerResponse.json();
    expect(checker.items[0].linkedToFix).toBe(false);
  });
});
