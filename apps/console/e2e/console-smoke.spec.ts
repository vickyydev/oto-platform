import { expect, test } from '@playwright/test';
import {
  CENTRAL_FLORESTA,
  ROBINSON_CHALONG,
  chooseBranch,
  openSection,
  pressLandsOn,
  signIn,
  signInAndWait,
} from './console';

/**
 * The Console, on the three things it is opened for and the one thing it has
 * to refuse.
 *
 * Nothing here is a screenshot test. Each case names a reading somebody acts
 * on — how many spins a booth has had today, which parks exist, whether a
 * password was accepted — and the page either produces it from the platform or
 * it does not.
 */

/**
 * BOOTHS — SCRUM-257's surface.
 *
 * "Spins today" is the line a manager looks at to decide whether the wheel is
 * still playing, and it is read from what the booth's box last reported rather
 * than from anything this page asks it now. The assertion is deliberately on
 * the SHAPE of the reading — a number, today's business date — and not on a
 * particular count: a seeded booth has had no spins, and a case that insisted
 * on "0" would start failing the moment somebody demonstrates the wheel
 * against the same seed.
 */
test('Booths: Booth 1 at Central Floresta says how many spins it has had today', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Booths');
  await chooseBranch(page, CENTRAL_FLORESTA);

  const booth = page.getByRole('button', { name: /Booth 1/ });
  await expect(booth).toBeVisible({ timeout: 30_000 });
  await booth.click();

  await expect(page.getByRole('heading', { name: 'What this booth is running' })).toBeVisible({
    timeout: 30_000,
  });
  // Case-insensitive: the label is upper-cased by CSS, not in the markup.
  const spinsToday = page.getByText(/^spins today \(\d{4}-\d{2}-\d{2}\)$/i);
  await expect(spinsToday).toBeVisible();
  // The figure beside the label: a count, or "n of cap" where the booth has one.
  await expect(spinsToday.locator('xpath=following-sibling::dd[1]')).toHaveText(/\d+( of \d+)?/);
});

/**
 * BRANCHES — the estate, which is the page every branch-scoped picker is fed
 * from. Both seeded parks, by name.
 */
test('Branches: both parks are listed', async ({ page }) => {
  await signInAndWait(page);
  await openSection(page, 'Branches');

  await expect(page.getByText(CENTRAL_FLORESTA, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(ROBINSON_CHALONG, { exact: true })).toBeVisible();
});

/**
 * DEVICES — adding a box, with a real mouse rather than a dispatched event.
 *
 * SCRUM-377: the dialog behind "Add a box" rendered inside the Boxes panel,
 * and that panel's `backdrop-blur` made it the containing block and the
 * stacking context for everything fixed inside it — so the dialog was sized to
 * the panel instead of the viewport and the Stations card painted over its
 * foot. It LOOKED right in a screenshot and read as visible to a locator;
 * Cancel and "Add the box" simply could not be pressed, and an administrator
 * could not add a box from the Console at all.
 *
 * Which is why this case asserts where a press lands before it asserts what a
 * press does: `toBeVisible` was true throughout the bug. Cancel is pressed
 * first and must add nothing — a dialog that closes on Cancel but files the
 * form anyway is the other half of the same button working.
 */
test('Devices: a box is added by pressing the dialog, and Cancel adds nothing', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);

  const boxes = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Boxes', exact: true }) });
  const trigger = boxes.getByRole('button', { name: 'Add a box', exact: true });
  await expect(trigger).toBeVisible({ timeout: 30_000 });

  // Named for this case, so the row asserted at the end is this run's own.
  const dialog = page.getByRole('dialog', { name: 'Add a box' });
  const added = boxes.getByRole('button', { name: 'Smoke box 377', exact: true });
  const openFilledIn = async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByLabel('Name').fill('Smoke box 377');
    await dialog.getByLabel('Slot').fill('smoke-377');
  };

  await openFilledIn();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const add = dialog.getByRole('button', { name: 'Add the box', exact: true });
  expect(await pressLandsOn(cancel)).toBe('button “Cancel”');
  expect(await pressLandsOn(add)).toBe('button “Add the box”');

  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(added).toHaveCount(0);

  await openFilledIn();
  await add.click();
  // The claim code, which is the dialog's whole point: it is shown once and
  // only its hash is kept, so "Done" is the only way out of this step.
  const done = dialog.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await done.click();
  await expect(added).toBeVisible({ timeout: 30_000 });
});

test('Devices: a display code is cleared after refusal and claim, and the paired screen can be revoked', async ({
  page,
}) => {
  await signInAndWait(page);
  const displayId = crypto.randomUUID();
  const displayName = 'Smoke display 201';
  let claimed = false;
  let revoked = false;
  let claimCount = 0;
  let validRequest = false;
  let submittedCode = '';
  let chosenStationId = '';
  let chosenStationName = '';

  await page.route('**/api/branches/*/credentials*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (claimed && !revoked) {
      body.credentials.push({
        id: displayId,
        kind: 'display',
        label: displayName,
        stationId: chosenStationId,
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        pairingOutstanding: false,
        revokedAt: null,
        scopes: ['display:read', 'display:intents'],
      });
    }
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/stations/*/displays/claim', async (route) => {
    const body = route.request().postDataJSON();
    claimCount += 1;
    submittedCode = body.pairingCode;
    validRequest =
      route.request().method() === 'POST' &&
      new URL(route.request().url()).pathname.endsWith(
        `/stations/${chosenStationId}/displays/claim`,
      ) &&
      /^[0-9]{6}$/.test(body.pairingCode) &&
      body.name === displayName &&
      Boolean(route.request().headers()['idempotency-key']);
    if (claimCount === 1) {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'DISPLAY_PAIRING_INVALID',
            message: `Unavailable code: ${body.pairingCode}`,
          },
        },
      });
    } else {
      claimed = true;
      await route.fulfill({
        json: {
          station: { id: chosenStationId, name: chosenStationName, kind: 'till' },
          device: { id: displayId, name: displayName },
        },
      });
    }
  });
  await page.route(`**/api/credentials/${displayId}/revoke`, async (route) => {
    revoked = true;
    await route.fulfill({ json: { ok: true } });
  });

  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  const pairedScreens = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Paired screens', exact: true }),
  });
  await pairedScreens.getByRole('button', { name: 'Pair a display', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair a display', exact: true });
  const station = dialog.getByRole('combobox', { name: 'Station', exact: true });
  chosenStationId = await station.inputValue();
  chosenStationName = await station.locator('option:checked').innerText();
  await dialog.getByLabel('Display name').fill(` ${displayName} `);
  const code = dialog.getByLabel('Pairing code');
  const submit = dialog.getByRole('button', { name: 'Pair the display', exact: true });
  await expect(code).toHaveAttribute('type', 'password');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  await code.fill(String(Math.floor(Math.random() * 90_000) + 10_000));
  await expect(submit).toBeDisabled();
  expect(claimCount).toBe(0);
  await code.fill(String(Math.floor(Math.random() * 900_000) + 100_000));
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('Get a new code on the display');
  expect((await code.inputValue()) === '').toBe(true);
  expect((await dialog.innerText()).includes(submittedCode)).toBe(false);
  expect(validRequest).toBe(true);

  await code.fill(String(Math.floor(Math.random() * 900_000) + 100_000));
  await submit.click();
  await expect(dialog.getByRole('status')).toContainText(
    `${displayName} is paired to ${chosenStationName}`,
  );
  expect(claimCount).toBe(2);
  expect(validRequest).toBe(true);
  await expect(code).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const row = pairedScreens.getByRole('listitem').filter({ hasText: displayName });
  await expect(row).toBeVisible();
  await expect(row).toContainText(chosenStationName);
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(revoked).toBe(true);
});

test('Devices: a display pairing grant for another branch does not offer this park a claim', async ({
  page,
}) => {
  await signInAndWait(page);
  await page.route('**/api/me/permissions', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.permissions = body.permissions.filter(
      (grant: { permission: string }) => grant.permission !== 'admin:device:pair',
    );
    body.permissions.push({
      permission: 'admin:device:pair',
      scopeType: 'branch',
      scopeId: crypto.randomUUID(),
    });
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  await expect(page.getByRole('heading', { name: 'Paired screens', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair a display', exact: true })).toHaveCount(0);
});

test('Devices: display diagnostics read the customer view and retain revoked status without private fields', async ({
  page,
}) => {
  await signInAndWait(page);
  const displayId = crypto.randomUUID();
  const revokedId = crypto.randomUUID();
  const displayName = 'Diagnostic display 201';
  const revokedName = 'Revoked diagnostic display';
  const hiddenMarker = 'Synthetic field that must stay hidden';
  let stationId = '';
  let snapshotReads = 0;
  let customerReadsOnly = true;
  let includesRevoked = false;
  await page.route('**/api/branches/*/credentials*', async (route) => {
    const url = new URL(route.request().url());
    const branchId = url.pathname.split('/')[3];
    const response = await route.fetch();
    const body = await response.json();
    const stationsResponse = await page.request.get(`/api/branches/${branchId}/stations`);
    const { stations } = await stationsResponse.json();
    stationId = stations.find(
      (station: { id: string; kind: string; boxId: string | null; archived: boolean }) =>
        station.kind === 'till' && station.boxId && !station.archived,
    ).id;
    includesRevoked = url.searchParams.get('includeRevoked') === 'true';
    const pairedAt = '2026-09-29T09:00:00.000Z';
    body.credentials.push({
      id: displayId,
      kind: 'display',
      label: displayName,
      stationId,
      pairedAt,
      lastSeenAt: '2026-09-29T09:30:00.000Z',
      revokedAt: null,
      pairingOutstanding: false,
    });
    if (includesRevoked)
      body.credentials.push({
        id: revokedId,
        kind: 'display',
        label: revokedName,
        stationId,
        pairedAt,
        lastSeenAt: '2026-09-29T09:20:00.000Z',
        revokedAt: '2026-09-29T09:35:00.000Z',
        pairingOutstanding: false,
      });
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/stations/*/session?view=customer', async (route) => {
    snapshotReads += 1;
    const url = new URL(route.request().url());
    customerReadsOnly &&=
      route.request().method() === 'GET' &&
      url.pathname.endsWith(`/stations/${stationId}/session`) &&
      url.searchParams.get('view') === 'customer';
    if (snapshotReads === 3) {
      await route.fulfill({
        json: { view: 'staff', document: { stationId, staffNotes: hiddenMarker } },
      });
      return;
    }
    await route.fulfill({
      json: {
        view: 'customer',
        serverTime: '2026-09-29T09:40:00.000Z',
        document: {
          stationId,
          boxId: crypto.randomUUID(),
          schemaVersion: 1,
          sequence: snapshotReads,
          stage: 'order',
          language: 'en',
          updatedAt: '2026-09-29T09:39:00.000Z',
          lease: { holder: hiddenMarker, leaseId: hiddenMarker },
          authToken: hiddenMarker,
          pairingCode: hiddenMarker,
          cart: {
            supported: true,
            nickname: 'Display visitor',
            nothingToPay: false,
            voucherPrize: null,
            sale: {
              id: 'sale-1',
              tier: 'tourist',
              total: 500,
              lines: [
                {
                  id: 'line-1',
                  name: 'Two-hour ticket',
                  lineTotal: 500,
                  breakdown: {
                    rows: [
                      {
                        key: 'adults',
                        kind: 'adults',
                        label: 'Adults',
                        unitPrice: 250,
                        quantity: 2,
                        subtotal: 500,
                      },
                    ],
                    priced: true,
                    lengthChosen: true,
                  },
                  allergiesMedical: hiddenMarker,
                  staffNotes: hiddenMarker,
                },
              ],
              manualDiscounts: [],
              creditGrants: [],
              bracelets: { adults: 2, children: 0 },
            },
            staffName: hiddenMarker,
          },
          member: {
            id: crypto.randomUUID(),
            nickname: 'Display visitor',
            tier: 'tourist',
            medicalNotes: hiddenMarker,
          },
          totals: {
            total: 500,
            manualAmounts: {},
            discountAmount: 0,
            taxBreakdown: { serviceChargeTotal: 0, categories: [] },
            staffNote: hiddenMarker,
          },
          payment: {
            saleId: 'sale-1',
            status: 'pending',
            amountSatang: 50_000,
            qrPayload: hiddenMarker,
            qrImageUrl: null,
            expiresAt: null,
            online: true,
            offline: false,
            approvalCode: hiddenMarker,
          },
          prompt: {
            kind: 'contact',
            requestId: 'prompt-1',
            nickname: 'Display visitor',
            phone: '',
            contactChannel: 'whatsapp',
            answer: {
              type: 'contact_done',
              actionId: 'answer-1',
              phone: '',
              nickname: 'Display visitor',
              contactChannel: 'whatsapp',
              token: hiddenMarker,
            },
            consent: hiddenMarker,
          },
        },
      },
    });
  });
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  const screens = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Paired screens', exact: true }) });
  const row = screens.getByRole('listitem').filter({ hasText: displayName });
  await expect(row).toContainText('Last seen');
  await expect(screens.getByRole('listitem').filter({ hasText: revokedName })).toHaveCount(0);
  await row.getByRole('button', { name: 'Snapshot', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${displayName} snapshot`, exact: true });
  const snapshot = dialog.getByLabel('Current customer snapshot');
  await expect(snapshot).toContainText('Display visitor');
  await expect(snapshot).toContainText('"unitPrice": 250');
  await expect(snapshot).toContainText('"qrAvailable": true');
  expect((await snapshot.innerText()).includes(hiddenMarker)).toBe(false);
  expect((await snapshot.innerText()).includes('lease')).toBe(false);
  await expect(dialog).toContainText('Current customer view');
  await dialog.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
  await expect(snapshot).toContainText('"sequence": 2');
  expect(snapshotReads).toBe(2);
  expect(customerReadsOnly).toBe(true);
  await dialog.getByRole('button', { name: 'Refresh snapshot', exact: true }).click();
  await expect(dialog).toContainText('The customer view could not be read');
  await expect(snapshot).toHaveCount(0);
  expect((await dialog.innerText()).includes(hiddenMarker)).toBe(false);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await screens.getByRole('button', { name: 'Show revoked', exact: true }).click();
  const revokedRow = screens.getByRole('listitem').filter({ hasText: revokedName });
  await expect(revokedRow).toContainText('Access revoked');
  await expect(revokedRow).toContainText('Last seen');
  await expect(revokedRow.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
  expect(includesRevoked).toBe(true);
});

test('Devices: a station-read grant for another park does not expose a display snapshot', async ({
  page,
}) => {
  await signInAndWait(page);
  const displayName = 'Restricted diagnostic display';
  await page.route('**/api/me/permissions', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.permissions = body.permissions.filter(
      (grant: { permission: string }) => grant.permission !== 'admin:station:read',
    );
    body.permissions.push({
      permission: 'admin:station:read',
      scopeType: 'branch',
      scopeId: crypto.randomUUID(),
    });
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/branches/*/credentials*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const branchId = new URL(route.request().url()).pathname.split('/')[3];
    const stationsResponse = await page.request.get(`/api/branches/${branchId}/stations`);
    const { stations } = await stationsResponse.json();
    const station = stations.find(
      (candidate: { kind: string; boxId: string | null; archived: boolean }) =>
        candidate.kind === 'till' && candidate.boxId && !candidate.archived,
    );
    body.credentials.push({
      id: crypto.randomUUID(),
      kind: 'display',
      label: displayName,
      stationId: station.id,
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
      pairingOutstanding: false,
    });
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  const row = page.getByRole('listitem').filter({ hasText: displayName });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Snapshot', exact: true })).toHaveCount(0);
});

test('Devices: display rule checks keep the live till unchanged and open the separate refusal log', async ({ page }) => {
  await signInAndWait(page);
  const displayId = crypto.randomUUID();
  const displayName = 'Rule-check display 201';
  const hiddenMarker = 'Synthetic private diagnostic detail';
  let stationId = '';
  let boxId = '';
  let rejectedCallObserved = false;
  let testBody: { stage: string; intent: string; actionId: string } | null = null;
  let idempotencyKey = '';
  const checks: { actionId: string; key: string }[] = [];
  let liveWrites = 0;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && (/\/api\/stations\/[^/]+\/intents$/.test(path)
      || path === '/api/display/intents' || /^\/api\/(payments|sales)(\/|$)/.test(path))) liveWrites += 1;
  });
  await page.route('**/api/branches/*/credentials*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const branchId = new URL(route.request().url()).pathname.split('/')[3];
    const { stations } = await (await page.request.get(`/api/branches/${branchId}/stations`)).json();
    const station = stations.find((candidate: { kind: string; boxId: string | null; archived: boolean }) =>
      candidate.kind === 'till' && candidate.boxId && !candidate.archived);
    stationId = station.id; boxId = station.boxId;
    body.credentials.push({
      id: displayId, kind: 'display', label: displayName, stationId, boxId,
      pairedAt: '2026-09-29T09:00:00.000Z', lastSeenAt: '2026-09-29T09:30:00.000Z',
      revokedAt: rejectedCallObserved ? '2026-09-29T09:35:00.000Z' : null,
      lastRejectedAt: rejectedCallObserved ? '2026-09-29T09:36:00.000Z' : null,
      lastRejectedCode: rejectedCallObserved ? 'DISPLAY_UNPAIRED' : null, pairingOutstanding: false,
    });
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/stations/*/displays/*/test-intent', async route => {
    const body = route.request().postDataJSON();
    expect(Object.keys(body).sort()).toEqual(['actionId', 'intent', 'stage']);
    expect(route.request().method()).toBe('POST');
    expect(new URL(route.request().url()).pathname).toBe(`/api/stations/${stationId}/displays/${displayId}/test-intent`);
    expect(body.actionId).toMatch(/^[0-9a-f-]{36}$/);
    testBody = body;
    idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    checks.push({ actionId: body.actionId, key: idempotencyKey });
    if (checks.length === 1) {
      await route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY', message: hiddenMarker } } });
      return;
    }
    await route.fulfill({ json: { actionId: body.actionId, testStage: body.stage,
      liveStage: 'input', sequence: 19, accepted: false, reason: 'wrong_stage',
      message: 'Consent is not accepted at the welcome stage.' } });
  });
  await page.route('**/api/boxes/*/station-events*', async route => {
    expect(new URL(route.request().url()).pathname).toBe(`/api/boxes/${boxId}/station-events`);
    await route.fulfill({ json: { events: [{ id: crypto.randomUUID(), stationId, deviceId: displayId,
      source: 'display', at: '2026-09-29T09:34:00.000Z', stage: 'input', intentType: 'display.consent_ack',
      outcome: 'refused', errorCode: 'wrong_stage', actionId: testBody?.actionId, test: true, testStage: 'welcome',
      payload: { phone: hiddenMarker, medicalNotes: hiddenMarker }, token: hiddenMarker }, {
      id: crypto.randomUUID(), stationId, deviceId: displayId, source: 'display', at: '2026-09-29T09:36:00.000Z',
      stage: null, intentType: 'display.session', outcome: null, errorCode: 'DISPLAY_UNPAIRED', actionId: null,
      test: false, testStage: null }], truncated: false } });
  });
  await page.route('**/api/boxes/*/log*', async route => {
    await route.fulfill({ json: { lines: [{ at: '2026-09-29T09:31:00.000Z', level: 'info', source: 'config',
      message: 'Uploaded box log is separate' }], collectedAt: '2026-09-29T09:32:00.000Z' } });
  });
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  const screens = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Paired screens', exact: true }) });
  const row = screens.getByRole('listitem').filter({ hasText: displayName });
  await expect(row).toContainText('No rejected protected call recorded');
  await row.getByRole('button', { name: 'Send test intent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${displayName} test intent`, exact: true });
  await expect(dialog.getByLabel('Stage to test').locator('option')).toHaveCount(6);
  await expect(dialog.getByLabel('Intent').locator('option')).toHaveCount(5);
  await dialog.getByLabel('Stage to test').selectOption('welcome');
  await dialog.getByLabel('Intent').selectOption('consent_ack');
  await dialog.getByRole('button', { name: 'Send test intent', exact: true }).click();
  await expect(dialog.getByText('The test result could not be read. Retry sends the same diagnostic check.', { exact: true })).toBeVisible();
  expect((await dialog.innerText()).includes(hiddenMarker)).toBe(false);
  await dialog.getByRole('button', { name: 'Send test intent', exact: true }).click();
  await expect(dialog.getByLabel('Display test result')).toContainText('wrong_stage');
  await expect(dialog).toContainText('Live stage: input');
  await expect(dialog).toContainText('Live till unchanged');
  expect(testBody).toMatchObject({ stage: 'welcome', intent: 'consent_ack' });
  expect(idempotencyKey).toBe(`display-test-${testBody!.actionId}`);
  expect(checks).toHaveLength(2);
  expect(checks[1]).toEqual(checks[0]);
  await dialog.getByRole('button', { name: 'Open Box refusal log', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const refusals = page.getByLabel('Station refusal events');
  await expect(refusals).toContainText('wrong_stage');
  await expect(refusals).toContainText('Test');
  await expect(refusals).toContainText('DISPLAY_UNPAIRED');
  await expect(refusals).toContainText('stage not recorded');
  await expect(refusals).toContainText('action not recorded');
  expect((await refusals.innerText()).includes(hiddenMarker)).toBe(false);
  await expect(page.getByRole('heading', { name: 'Box log', exact: true })).toBeVisible();
  await expect(page.getByText('Uploaded box log is separate', { exact: true })).toBeVisible();
  expect(liveWrites).toBe(0);

  rejectedCallObserved = true;
  await page.reload();
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  await screens.getByRole('button', { name: 'Show revoked', exact: true }).click();
  await expect(row).toContainText('Last seen');
  await expect(row).toContainText('Last protected call rejected');
  await expect(row).toContainText('DISPLAY_UNPAIRED');
  await expect(row.getByRole('button', { name: 'Send test intent', exact: true })).toHaveCount(0);
});

/**
 * THE CARD TERMINALS — SCRUM-206's Console surface.
 *
 * These buttons are what makes the tender ticket's hard cases demonstrable at
 * all: a host that declines, one that approves less than was asked, one that
 * says nothing and leaves a till blocked. None of them can be rehearsed on a
 * real EDC in Phuket from here.
 *
 * The case is about the seam this panel does NOT share with the ones around
 * it. Every other simulator control rides the box command queue and answers
 * "queued"; this one cannot — `terminal.outcome` can carry the approval code
 * the terminal will print, and a command payload is stored and rendered — so
 * it posts to `/payments/terminal-simulator` and the answer is immediate and
 * says whether it LANDED. The harness runs the api with the `edge` role
 * (`playwright.config.ts`), so the virtual box and its two simulated EDCs are
 * in that process and can actually be reached; a press that answered "sent"
 * over a simulator nobody set would pass a weaker assertion than this one.
 */
test('Devices: a simulated card terminal can be told what to do with the next tender', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);

  const terminals = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Card terminals', exact: true }) });
  // The park's NEXGO, by its own label — the seeded row this branch's till
  // routes a card tender to.
  const row = terminals.getByRole('listitem').filter({ hasText: 'EDC 1' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The dialect, so the panel is naming the real device and not a placeholder.
  await expect(row).toContainText('GHL LinkPOS');

  await row.getByRole('button', { name: 'Decline', exact: true }).click();

  // The platform's own answer, not a queue receipt: it either reached the
  // simulator or it did not.
  await expect(terminals.getByText('EDC 1 will decline the next tender.')).toBeVisible({
    timeout: 30_000,
  });
  // And the row says the setting is still standing, because it is chosen
  // before a tender is sent and stays until it is changed.
  await expect(row).toContainText('next: Decline');
});

/**
 * A WRONG PASSWORD.
 *
 * The console is a back-office door and this is the one case about it being
 * shut. The message is the API's own — "Phone or password is incorrect", which
 * names neither half on purpose (SCRUM-251) — and what matters as much as the
 * message is that the sign-in panel is still what is on screen afterwards.
 */
test('a wrong password is refused, and the console stays shut', async ({ page }) => {
  await signIn(page, 'not-the-password');

  await expect(page.getByText('Phone or password is incorrect')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});
