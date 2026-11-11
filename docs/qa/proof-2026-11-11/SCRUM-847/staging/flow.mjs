// SCRUM-847 and SCRUM-848 steps. The drop-off flow up to the family's "Done"
// is the committed SCRUM-807 flow (flow.mjs there); what differs is what the
// first pricing request after "Continue to payment" is answered with.
import assert from 'node:assert/strict';

export function makeSteps(ctx) {
  const { receipt, save, phase, call, expect, numbers, CHILD, GUARDIAN, knownSales } = ctx;
  const shot = (page, name) => ctx.shot(page, name);
  const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  const flat = text => text.replace(/\s+/g, ' ').trim();
  const stationSales = async () => (await call('GET', `/sales?branchId=${ctx.branchId}&stationId=${ctx.station.id}&limit=50`)).body.sales;
  const newSales = async () => (await stationSales()).filter(s => !knownSales.has(s.id));
  const isQuote = url => url.pathname === '/api/sales/quote';
  /** The till's own customer half: the second half of the split view. */
  const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
  const paymentStep = () => ctx.till.getByTestId('payment-step');
  const amountDue = () => paymentStep().getByRole('heading', { name: 'Amount Due', exact: true }).locator('..');

  async function pairDisplay() {
    phase('pair own customer display');
    const context = await ctx.browser.newContext({ baseURL: ctx.pos, viewport: { width: 1024, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
    context.setDefaultTimeout(30000);
    const page = await context.newPage();
    await page.goto(`${ctx.pos}/display`);
    await page.getByTestId('display-pairing-code').waitFor();
    const pairingCode = (await page.getByTestId('display-pairing-code').textContent()).trim();
    assert.match(pairingCode, /^\d{6}$/);
    const paired = await call('POST', `/stations/${ctx.station.id}/displays/claim`, { pairingCode, name: ctx.fixtureName });
    assert.equal(paired.status, 200);
    ctx.display = { context, page, id: paired.body.device.id, revoked: false };
    receipt.created.push({ kind: 'display', id: ctx.display.id }); save();
    await page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first().waitFor();
    return ctx.display;
  }
  async function dropDisplay(reason = 'ZZ TEST SCRUM-847 proof step complete') {
    if (!ctx.display) return;
    const d = ctx.display;
    if (!d.revoked) {
      assert.equal((await call('POST', `/credentials/${d.id}/revoke`, { reason })).status, 200);
      d.revoked = true;
      assert.ok(!(await call('GET', `/stations/${ctx.station.id}/displays`)).body.displays.some(x => x.id === d.id));
      receipt.cleanup.push({ kind: 'display', id: d.id, revoked: true }); save();
    }
    await d.context.close().catch(() => {});
    ctx.display = null;
  }
  const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
  /** Type the number on a surface: the paired display page, or the till page for its own customer half. */
  async function identify(surface, number) {
    await surface.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first().waitFor();
    if (await surface.getByTestId('language-choice').isVisible()) await surface.getByTestId('language-choice-en').click();
    await surface.getByTestId('identify-safety').waitFor();
    const scope = surface === ctx.till ? halfOf(surface.getByTestId('identify-safety')) : surface;
    await keypad(scope, number);
    return scope;
  }
  async function identifyAsWalkIn(surface, number) {
    const scope = await identify(surface, number);
    await scope.getByRole('button', { name: 'Continue', exact: true }).click();
    const offer = ctx.till.getByRole('dialog', { name: 'New member?', exact: true });
    await expect(offer).toContainText(spaced(number));
    await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  }

  async function buyVoucher() {
    const till = ctx.till;
    phase('buy a Golden Ticket on the own test till (cash)');
    await till.goto('/merch-station');
    await till.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
    await till.getByRole('button', { name: /Golden Ticket/ }).click();
    await till.getByRole('button', { name: /^Charge/ }).click();
    await till.getByRole('button', { name: /^Cash Collect/ }).click();
    await till.getByRole('button', { name: 'Record cash', exact: true }).click();
    await till.getByRole('heading', { name: 'Sale Confirmed', exact: true }).waitFor();
    let bought;
    await expect.poll(async () => { bought = (await newSales()).find(s => s.status === 'finalised'); return Boolean(bought); }, { timeout: 30000 }).toBe(true);
    knownSales.add(bought.id);
    receipt.created.push({ kind: 'voucher-sale', id: bought.id, paidBy: 'cash' }); save();
    const issued = (await call('GET', `/sales/${bought.id}`)).body.issuedVouchers.find(v => v.definitionCode === 'golden-ticket');
    assert.ok(issued?.code);
    receipt.created.push({ kind: 'voucher', id: issued.id }); save();
    ctx.sold = bought; ctx.voucher = issued;
  }

  /** A second run uses the Golden Ticket the first run bought and did not redeem. */
  async function useVoucher(saleId) {
    phase('reuse the unredeemed Golden Ticket bought on the first run');
    const body = (await call('GET', `/sales/${saleId}`)).body;
    assert.equal(body.sale.status, 'finalised');
    const issued = body.issuedVouchers.find(v => v.definitionCode === 'golden-ticket');
    assert.ok(issued?.code);
    receipt.checks.voucherReused = { saleId, voucherId: issued.id, statusBefore: issued.status ?? null };
    ctx.sold = { id: saleId }; ctx.voucher = issued; save();
  }

  /** The SCRUM-807 flow up to the family's "Done"; the pricing handler goes on before "Continue to payment". */
  async function dropOffToConsentDone(tag) {
    const till = ctx.till;
    phase(`${tag}: redeem the Golden Ticket as drop-off`);
    await till.goto('/');
    await pairDisplay();
    await identifyAsWalkIn(ctx.display.page, numbers[tag]);
    await till.getByRole('heading', { name: 'Tourist', exact: true }).click();
    await till.getByPlaceholder(/^Voucher code/).fill(ctx.voucher.code);
    await till.getByRole('button', { name: 'Redeem', exact: true }).click();
    const gift = till.getByTestId('golden-ticket');
    await gift.getByLabel("Child's age", { exact: true }).selectOption('7');
    await gift.getByRole('button', { name: 'Drop-off', exact: true }).click();
    await gift.getByTestId('golden-ticket-ring-up').click();
    phase(`${tag}: family form and synthetic reception photo`);
    const page = ctx.display.page;
    const consent = page.getByTestId('display-consent');
    await consent.getByPlaceholder('Full name', { exact: true }).fill(CHILD);
    const keyboardDone = page.getByRole('button', { name: 'Done', exact: true });
    if (await keyboardDone.isVisible()) await keyboardDone.click();
    await consent.getByRole('button', { name: 'Continue', exact: true }).click();
    await consent.getByTestId('consent-care').waitFor();
    await consent.getByRole('button', { name: 'Continue', exact: true }).click();
    await consent.getByPlaceholder('Your full name', { exact: true }).fill(GUARDIAN);
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
  }
  async function continueToPayment(tag) {
    const till = ctx.till;
    const [registered] = await Promise.all([
      till.waitForResponse(r => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST'),
      till.getByRole('button', { name: 'Continue to payment', exact: true }).click(),
    ]);
    assert.equal(registered.status(), 200);
    const reg = await registered.json();
    assert.equal(reg.guardianName, GUARDIAN);
    receipt.created.push({ kind: 'registration', id: reg.id, step: tag }); save();
    return reg;
  }
  /** Wait until the till draws its own customer half for the price wait, and read it. */
  async function neutralHalf() {
    const pending = ctx.till.getByTestId('customer-price-pending');
    await expect(pending).toBeVisible({ timeout: 30000 });
    const text = flat(await halfOf(pending).innerText());
    assert.ok(text.includes('Waiting for the cashier to confirm…'), 'customer half says it is waiting');
    assert.ok(!/Please pay/i.test(text), 'customer half does not ask for money');
    assert.ok(!text.includes('฿'), 'customer half shows no baht figure');
    return text;
  }
  async function cancelSale(tag) {
    phase(`${tag}: Cancel the sale from the order panel`);
    await ctx.till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await expect(paymentStep()).toHaveCount(0, { timeout: 30000 });
  }
  async function registrationState(id) {
    const reg = (await call('GET', '/checkin/registrations/' + id)).body;
    return { id, children: reg.children.map(c => ({ id: c.id, name: c.childName, status: c.status })) };
  }

  // ---- step c: the platform refuses the price ----
  async function stepRefused() {
    const s = receipt.steps.c = { pass: false, seen: {} }; save();
    await dropOffToConsentDone('c');
    const till = ctx.till;
    let posts = 0;
    const handler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      if (posts === 1) {
        s.quoteAnsweredByTest = { status: 409, code: 'VOUCHER_NOT_HELD', at: new Date().toISOString() };
        return route.fulfill({ status: 409, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'VOUCHER_NOT_HELD', message: 'Scan the voucher at this till first — it is not held for this sale.' } }) });
      }
      return route.continue();
    };
    await till.route(isQuote, handler);
    try {
      phase('c: Continue to payment with the first quote refused (409 VOUCHER_NOT_HELD)');
      const reg = await continueToPayment('c');
      const box = till.getByTestId('voucher-price-unavailable');
      await expect(box).toBeVisible();
      s.seen.staffBox = flat(await box.innerText());
      s.seen.boxRole = await box.getAttribute('role');
      s.seen.amountDue = flat(await amountDue().innerText());
      assert.equal(s.seen.staffBox, 'The voucher price could not be fetched: Scan the voucher at this till first — it is not held for this sale. Go Back to change the order, or Cancel the sale.');
      await expect(amountDue()).toContainText('—');
      await expect(paymentStep().getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeDisabled();
      await expect(paymentStep().getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
      s.seen.confirmDisabled = true; s.seen.backEnabled = true;
      await expect(paymentStep().getByText('Waiting for the voucher price...', { exact: true })).toHaveCount(0);
      s.seen.waitingLineGone = true;
      // The separate display, while it is still paired: its own idle line, no amount.
      const dtext = flat(await ctx.display.page.locator('body').innerText());
      s.seen.separateDisplay = { followStaff: dtext.includes('Please follow the staff screen.'), baht: dtext.includes('฿'), pleasePay: /Please pay/i.test(dtext) };
      await shot(ctx.display.page, '847-c2-refused-separate-display.png');
      await dropDisplay('ZZ TEST SCRUM-847 step c: show the own customer half');
      s.seen.customerHalf = await neutralHalf();
      assert.equal((await newSales()).length, 0, 'no redemption sale is written');
      s.seen.redemptionSalesWritten = 0;
      await till.waitForTimeout(4000); // the price is not asked again on a timer
      await expect(box).toBeVisible();
      s.seen.quotePostsAfterTheRefusal = posts - 1;
      s.seen.stillRefusedAfter4s = true;
      await box.scrollIntoViewIfNeeded();
      await shot(till, '847-c1-refused-both-halves.png');
      await cancelSale('c');
      s.seen.afterCancel = { newSales: (await newSales()).map(x => ({ id: x.id, status: x.status })), registration: await registrationState(reg.id) };
      assert.equal(s.seen.afterCancel.newSales.filter(x => x.status !== 'voided').length, 0);
      s.pass = true; save();
    } finally { await till.unroute(isQuote, handler).catch(() => {}); }
  }

  // ---- step d: nothing answers ----
  async function stepOffline() {
    const s = receipt.steps.d = { pass: false, seen: {} }; save();
    await dropOffToConsentDone('d');
    const till = ctx.till;
    let posts = 0;
    const handler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      if (posts === 1) { s.quoteAbortedByTest = { at: new Date().toISOString() }; return route.abort('internetdisconnected'); }
      return route.continue();
    };
    await till.route(isQuote, handler);
    try {
      phase('d: Continue to payment with the first quote aborted (nothing answers)');
      const reg = await continueToPayment('d');
      const box = till.getByTestId('voucher-price-unavailable');
      await expect(box).toBeVisible();
      s.seen.staffBox = flat(await box.innerText());
      s.seen.amountDue = flat(await amountDue().innerText());
      await box.scrollIntoViewIfNeeded();
      await shot(till, '847-d1-offline-staff-screen.png');
      assert.equal(s.seen.staffBox, 'The voucher price could not be fetched: Vouchers can only be redeemed online. Go Back to change the order, or Cancel the sale.');
      await expect(paymentStep().getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeDisabled();
      s.seen.confirmDisabled = true;
      s.seen.quotePostsAfterTheAbort = posts - 1;
      assert.equal((await newSales()).length, 0, 'no redemption sale is written');
      s.seen.redemptionSalesWritten = 0;
      await cancelSale('d');
      s.seen.afterCancel = { newSales: (await newSales()).map(x => ({ id: x.id, status: x.status })), registration: await registrationState(reg.id) };
      s.pass = true; save();
    } finally { await till.unroute(isQuote, handler).catch(() => {}); await dropDisplay().catch(() => {}); }
  }

  // ---- steps a and b: the price is held, then released ----
  async function stepPendingThenPriced() {
    const a = receipt.steps.a = { pass: false, seen: {} }; const b = receipt.steps.b = { pass: false, seen: {} }; save();
    await dropOffToConsentDone('a');
    const till = ctx.till;
    let releaseQuote; const release = new Promise(r => { releaseQuote = r; });
    const handler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      (a.heldQuotes ??= []).push({ status: response.status(), heldAt: new Date().toISOString() }); save();
      await release;
      await route.fulfill({ response }).catch(() => {});
    };
    await till.route(isQuote, handler);
    try {
      phase('a: Continue to payment with the real quote HELD');
      const reg = await continueToPayment('a');
      const status = paymentStep().getByRole('status');
      await expect(status).toHaveText('Waiting for the voucher price...');
      await expect.poll(() => Boolean(a.heldQuotes?.length)).toBe(true);
      assert.equal(a.heldQuotes[0].status, 200);
      await expect(amountDue()).toContainText('—');
      a.seen.staffLine = flat(await status.innerText());
      a.seen.amountDue = flat(await amountDue().innerText());
      await expect(paymentStep().getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeDisabled();
      a.seen.confirmDisabled = true;
      assert.equal((await newSales()).length, 0, 'no sale is written at the local estimate');
      a.seen.salesWrittenWhileWaiting = 0;
      // The separate display paired on the station: its own idle line, no amount.
      const page = ctx.display.page;
      await expect(page.getByText('Please follow the staff screen.', { exact: true })).toBeVisible();
      const dtext = flat(await page.locator('body').innerText());
      a.seen.separateDisplayText = dtext.slice(0, 300);
      assert.ok(!dtext.includes('฿'), 'separate display shows no baht figure');
      assert.ok(!/Please pay/i.test(dtext), 'separate display does not ask for money');
      a.seen.separateDisplay = { words: 'Please follow the staff screen.', baht: false, pleasePay: false };
      await status.scrollIntoViewIfNeeded();
      await shot(till, '847-a2-waiting-staff-screen-display-paired.png');
      await shot(page, '847-a3-separate-display-follow-staff.png');
      // Unpair the display so the till draws its own customer half (split view) for the same wait.
      await dropDisplay('ZZ TEST SCRUM-847 step a: show the own customer half');
      a.seen.customerHalf = await neutralHalf();
      await expect(status).toHaveText('Waiting for the voucher price...');
      await expect(amountDue()).toContainText('—');
      assert.equal((await newSales()).length, 0);
      await status.scrollIntoViewIfNeeded();
      await shot(till, '847-a1-waiting-both-halves.png');
      a.pass = true; save();

      phase('b: release the quote');
      releaseQuote();
      await expect(amountDue()).toContainText('฿0');
      await expect(paymentStep().getByText('No payment needed', { exact: true })).toBeVisible();
      b.seen.amountDue = flat(await amountDue().innerText());
      b.seen.staffCard = flat(await paymentStep().getByTestId('no-payment-needed').innerText());
      const free = till.getByTestId('customer-nothing-to-pay');
      await expect(free).toBeVisible();
      b.seen.customerHalf = flat(await halfOf(free).innerText());
      assert.ok(b.seen.customerHalf.includes('Complimentary — enjoy!'));
      assert.ok(!/Please pay/i.test(b.seen.customerHalf));
      await expect(till.getByTestId('customer-price-pending')).toHaveCount(0);
      const complete = paymentStep().getByRole('button', { name: 'Complete Sale', exact: true });
      await expect(complete).toBeEnabled();
      let redemption;
      await expect.poll(async () => { redemption = (await newSales()).find(x => x.status === 'tendering'); return Boolean(redemption); }, { timeout: 30000 }).toBe(true);
      const saved = (await call('GET', `/sales/${redemption.id}`)).body.sale;
      assert.equal(saved.totals.grossSatang, 0);
      receipt.created.push({ kind: 'redemption-sale', id: redemption.id }); save();
      b.seen.savedSale = { id: redemption.id, status: 'tendering', totalSatang: 0 };
      await shot(till, '847-b1-priced-zero-both-halves.png');
      await complete.click();
      await till.getByRole('button', { name: 'Check in now', exact: true }).click();
      await expect.poll(async () => (await registrationState(reg.id)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
      assert.equal((await call('GET', `/sales/${redemption.id}`)).body.sale.status, 'finalised');
      knownSales.add(redemption.id);
      b.seen.completed = { saleId: redemption.id, status: 'finalised', totalSatang: 0, child: 'in_park' };
      const after = (await call('GET', `/sales/${ctx.sold.id}`)).body.issuedVouchers.find(v => v.id === ctx.voucher.id);
      b.seen.voucherAfter = { status: after?.status ?? null };
      await shot(till, '847-b2-completed-zero-sale.png');
      b.pass = true; save();
    } finally { releaseQuote(); await till.unroute(isQuote, handler).catch(() => {}); }
  }

  // ---- step e: a plain walk-in ticket sale is unchanged ----
  async function stepPlainSale() {
    const s = receipt.steps.e = { pass: false, seen: {} }; save();
    const till = ctx.till;
    phase('e: plain walk-in ticket sale on the same till (no display paired)');
    await dropDisplay().catch(() => {});
    await till.goto('/');
    await identifyAsWalkIn(till, numbers.e);
    await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
    await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
    const quantity = async (label, target) => {
      const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
      const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
      const value = add.locator('xpath=preceding-sibling::span[1]');
      for (let count = 0; count < 8; count++) {
        const current = Number(await value.textContent());
        if (current === target) return;
        await (current < target ? add : remove).click();
      }
      assert.equal(Number(await value.textContent()), target);
    };
    await quantity('Kids', 1); await quantity('Adults', 1);
    await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
    await expect(paymentStep()).toBeVisible({ timeout: 30000 });
    await expect(amountDue()).toContainText(/฿\d/);
    s.seen.amountDue = flat(await amountDue().innerText());
    const figure = s.seen.amountDue.match(/฿[\d,.]+/)[0];
    const pay = till.getByText('Please pay', { exact: true });
    await expect(pay).toBeVisible();
    const text = flat(await halfOf(pay).innerText());
    s.seen.customerHalf = text;
    assert.ok(text.includes('Please pay') && text.includes('to our staff') && /฿\d/.test(text));
    s.seen.customerFigure = text.match(/฿[\d,.]+/)[0];
    assert.equal(Number(s.seen.customerFigure.replace(/[฿,]/g, '')), Number(figure.replace(/[฿,]/g, '')), 'both halves ask the same amount');
    await expect(till.getByTestId('customer-price-pending')).toHaveCount(0);
    await expect(till.getByTestId('voucher-price-unavailable')).toHaveCount(0);
    let open;
    await expect.poll(async () => { open = (await newSales()).find(x => ['tendering', 'open'].includes(x.status)); return Boolean(open); }, { timeout: 30000 }).toBe(true);
    receipt.created.push({ kind: 'plain-ticket-sale', id: open.id }); save();
    s.seen.saleWritten = { id: open.id, status: open.status };
    await shot(till, '847-e1-plain-sale-please-pay.png');
    await cancelSale('e');
    await expect.poll(async () => (await call('GET', `/sales/${open.id}`)).body.sale.status, { timeout: 30000 }).toBe('voided');
    knownSales.add(open.id);
    s.seen.afterCancel = { id: open.id, status: 'voided' };
    receipt.cleanup.push({ kind: 'sale', id: open.id, status: 'voided', by: 'Cancel on the till' });
    s.pass = true; save();
  }

  // ---- SCRUM-848: the New guest dialog ----
  async function stepNewGuestDialog() {
    const s = receipt.steps.s848 = { pass: false, seen: {} }; save();
    const till = ctx.till;
    const branchId = ctx.branchId;
    phase('848: open the New guest dialog for an unknown ZZ TEST number');
    await dropDisplay().catch(() => {});
    assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(numbers.guest)}`)).body.member, null, 'ZZ TEST number must be unused');
    const realPasses = (await call('GET', `/events/passes?branchId=${branchId}`)).body.passes;
    s.stagingPassesToday = realPasses.length;
    const isPasses = url => url.pathname === '/api/events/passes';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const handler = async route => {
      if (route.request().method() !== 'GET' || realPasses.length > 0) return route.continue();
      // Staging has no event on sale, and the dialog opens only from a pass card.
      // The card alone is supplied here; nothing is written anywhere for it.
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ branchId, date: today, passes: [{
        id: 'zz-test-scrum-848-pass', branchId, type: 'event', appEventType: 'workshop', status: 'upcoming', appStatus: 'upcoming', archived: false,
        title: 'ZZ TEST SCRUM-848 pass (test card)', startDate: today, endDate: null, cancelledDays: [], startTime: '10:00', endTime: '11:00',
        location: 'ZZ TEST', expectedKids: null, expectedAdults: null, entryPrice: { weekdaySatang: 10000, weekendSatang: 10000 }, party: null,
        attendeeCount: null, roster: null }] }) });
    };
    s.passCard = realPasses.length > 0 ? 'a real staging event' : 'supplied by the test in the browser (staging has no event on sale); nothing written';
    const writes = [];
    const watch = r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/members') && r.method() !== 'GET') writes.push(r.method() + ' ' + u.pathname); };
    till.on('request', watch);
    await till.route(isPasses, handler);
    try {
      await till.goto('/');
      await identify(till, numbers.guest); // typed on the till's own customer half; Continue is not pressed
      await till.getByRole('button', { name: /Sell pass/ }).first().click();
      const dialog = till.getByRole('dialog').filter({ hasText: 'New guest — enter name' });
      await expect(dialog).toBeVisible();
      s.seen.dialog = flat(await dialog.innerText());
      await expect(dialog).toContainText(`Phone ${spaced(numbers.guest)} is not recognised.`);
      assert.ok(!s.seen.dialog.includes('+660'), 'no composed +660 form');
      s.seen.number = spaced(numbers.guest);
      await shot(till, '848-1-new-guest-dialog.png');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await till.waitForTimeout(1500);
      assert.equal(writes.length, 0, 'no member write left the till');
      const after = await call('GET', `/members/lookup?phone=${encodeURIComponent(numbers.guest)}`);
      assert.equal(after.status, 200); assert.equal(after.body.member, null);
      s.seen.afterCancel = { memberWrites: 0, lookup: 'no member' };
      s.pass = true; save();
    } finally { till.off('request', watch); await till.unroute(isPasses, handler).catch(() => {}); }
  }

  return { pairDisplay, dropDisplay, buyVoucher, useVoucher, stepRefused, stepOffline, stepPendingThenPriced, stepPlainSale, stepNewGuestDialog, registrationState, stationSales };
}
