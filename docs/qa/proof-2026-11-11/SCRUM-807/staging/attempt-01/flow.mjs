import assert from 'node:assert/strict';

export async function prove({ till, display, call, expect, phase, shot, identify, receipt, save, branchId, station, prefix }) {
  phase('buy a Golden Ticket on the own test till');
  await till.goto('/merch-station');
  await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  await till.getByRole('button', { name: /Golden Ticket/ }).click();
  await till.getByRole('button', { name: /^Charge/ }).click();
  await till.getByText('Cash', { exact: true }).click();
  await till.getByRole('button', { name: 'Record cash', exact: true }).click();
  await till.getByRole('heading', { name: 'Sale Confirmed', exact: true }).waitFor();
  const sold = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales.find(s => s.status === 'finalised');
  assert.ok(sold);
  receipt.created.push({ kind: 'voucher-sale', id: sold.id }); save();
  const voucher = (await call('GET', `/sales/${sold.id}`)).body.issuedVouchers.find(v => v.definitionCode === 'golden-ticket');
  assert.ok(voucher?.code);
  receipt.created.push({ kind: 'voucher', id: voucher.id }); save();

  phase('redeem the Golden Ticket as drop-off');
  await till.goto('/');
  await identify(0);
  await till.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await till.getByPlaceholder(/^Voucher code/).fill(voucher.code);
  await till.getByRole('button', { name: 'Redeem', exact: true }).click();
  const gift = till.getByTestId('golden-ticket');
  await gift.getByLabel("Child's age", { exact: true }).selectOption('7');
  await gift.getByRole('button', { name: 'Drop-off', exact: true }).click();
  await gift.getByTestId('golden-ticket-ring-up').click();

  phase('complete the family form and synthetic reception photo');
  const consent = display.getByTestId('display-consent');
  await consent.getByPlaceholder('Full name', { exact: true }).fill('ZZ TEST SCRUM-807 child');
  const keyboardDone = display.getByRole('button', { name: 'Done', exact: true });
  if (await keyboardDone.isVisible()) await keyboardDone.click();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByTestId('consent-care').waitFor();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.getByPlaceholder('Your full name', { exact: true }).fill('ZZ TEST SCRUM-807 guardian');
  if (await keyboardDone.isVisible()) await keyboardDone.click();
  for (const checkbox of await consent.getByRole('checkbox').all()) await checkbox.check();
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await till.getByRole('button', { name: 'Private child details', exact: true }).click();
  const details = till.getByRole('dialog', { name: 'Private child details', exact: true });
  await details.getByRole('button', { name: 'Start camera', exact: true }).click();
  await details.getByRole('button', { name: 'Take photo', exact: true }).click();
  await details.getByAltText('Captured', { exact: true }).waitFor();
  await details.getByRole('button', { name: 'Close', exact: true }).click();
  await consent.getByRole('button', { name: 'Done', exact: true }).click();

  phase('hold the real pricing response while entering payment');
  let releaseQuote;
  const release = new Promise(resolve => { releaseQuote = resolve; });
  let quoteHeld = false;
  const delayedQuote = async route => {
    if (route.request().method() !== 'POST' || quoteHeld) return route.continue();
    quoteHeld = true;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    receipt.checks.delayedQuote = { status: 200, heldAt: new Date().toISOString() }; save();
    await release;
    await route.fulfill({ response });
  };
  await till.route('**/api/sales/quote', delayedQuote);
  try {
    const [registered] = await Promise.all([
      till.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST'),
      till.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
    ]);
    assert.equal(registered.status(), 200);
    const reg = await registered.json();
    assert.equal(reg.guardianName, 'ZZ TEST SCRUM-807 guardian');
    receipt.created.push({ kind: 'registration', id: reg.id }); save();
    const payment = till.getByTestId('payment-step');
    await expect(payment.getByRole('status')).toHaveText('Waiting for the voucher price...');
    await expect.poll(() => Boolean(receipt.checks.delayedQuote)).toBe(true);
    await expect(payment.getByRole('heading', { name: 'Amount Due', exact: true }).locator('..')).toContainText('—');
    await expect(payment.getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeDisabled();
    const before = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
    assert.equal(before.filter(s => s.id !== sold.id).length, 0, 'no sale is written at the local estimate');
    await shot(till, 's807-waiting-for-voucher-price.png');
    releaseQuote();

    phase('returned price matches Amount Due and the automatic saved sale');
    await expect(payment.getByRole('heading', { name: 'Amount Due', exact: true }).locator('..')).toContainText('฿0');
    await expect(payment.getByText('No payment needed', { exact: true })).toBeVisible();
    const complete = payment.getByRole('button', { name: 'Complete Sale', exact: true });
    await expect(complete).toBeEnabled();
    let redemption;
    await expect.poll(async () => {
      redemption = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales.find(s => s.id !== sold.id && s.status === 'tendering');
      return Boolean(redemption);
    }).toBe(true);
    const saved = (await call('GET', `/sales/${redemption.id}`)).body.sale;
    assert.equal(saved.totals.grossSatang, 0);
    await expect(till.getByText('Total', { exact: true }).locator('..')).toContainText('฿0');
    receipt.created.push({ kind: 'redemption-sale', id: redemption.id });
    receipt.checks.pricing = { amountDueSatang: 0, orderTotalSatang: 0, automaticSaleTotalSatang: 0,
      noBackOrSecondPay: true, confirmationEnabledAfterPricing: true }; save();
    await shot(till, 's807-priced-payment-zero.png');
    await complete.click();
    await till.getByRole('button', { name: 'Check in now', exact: true }).click();
    await expect.poll(async () => {
      const current = (await call('GET', `/checkin/registrations/${reg.id}`)).body;
      return current.children.every(child => child.status === 'in_park');
    }).toBe(true);
    assert.equal((await call('GET', `/sales/${redemption.id}`)).body.sale.status, 'finalised');
    receipt.checks.completed = { saleId: redemption.id, status: 'finalised', totalSatang: 0 }; save();
    await shot(till, 's807-completed-zero-sale.png');
  } finally {
    releaseQuote();
    await till.unroute('**/api/sales/quote', delayedQuote);
  }
}
