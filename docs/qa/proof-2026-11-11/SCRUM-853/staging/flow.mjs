// SCRUM-853 and SCRUM-854 staging steps. Adapted from the committed SCRUM-847
// harness (docs/qa/proof-2026-11-11/SCRUM-847/staging/flow.mjs): the drop-off
// flow up to the family's "Done" is unchanged; what differs is what is read
// at the payment step, the member-card pass and the two-account hand-over.
import assert from 'node:assert/strict';

export function makeSteps(ctx) {
  const { receipt, save, phase, call, expect, numbers, CHILD, GUARDIAN, knownSales, T } = ctx;
  const shot = (page, name, opts) => ctx.shot(page, name, opts);
  const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  const flat = text => text.replace(/\s+/g, ' ').trim();
  const stationSales = async () => (await call('GET', `/sales?branchId=${ctx.branchId}&stationId=${ctx.station.id}&limit=50`)).body.sales;
  const newSales = async () => (await stationSales()).filter(s => !knownSales.has(s.id));
  const isQuote = url => url.pathname === '/api/sales/quote';
  const isSales = url => url.pathname === '/api/sales';
  /** The till's own customer half: the second half of the split view. */
  const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
  const paymentStep = () => ctx.till.getByTestId('payment-step');
  const amountDue = () => paymentStep().getByRole('heading', { name: 'Amount Due', exact: true }).locator('..');
  const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
  const SAVING = 'The sale is still being saved';

  /** What stands under "Hold sale" right now. */
  async function holdArea() {
    const till = ctx.till;
    const area = till.getByTestId('hold-sale-buttons');
    const present = await area.count();
    if (!present) return { present: 0 };
    const hold = area.getByRole('button', { name: 'Hold sale', exact: true });
    const part = area.getByRole('button', { name: 'Save as partly paid', exact: true });
    const reason = till.getByTestId('hold-sale-reason');
    const partReason = till.getByTestId('part-paid-reason');
    return {
      present,
      holdSaleDisabled: await hold.isDisabled(),
      holdSaleReasonCount: await reason.count(),
      holdSaleReason: (await reason.count()) ? flat(await reason.first().innerText()) : null,
      partPaidButtonShown: (await part.count()) > 0,
      partPaidDisabled: (await part.count()) ? await part.isDisabled() : null,
      partPaidReason: (await partReason.count()) ? flat(await partReason.first().innerText()) : null,
      stillBeingSavedAnywhereOnPage: await till.getByText(SAVING, { exact: false }).count(),
      text: flat(await area.innerText()),
    };
  }

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
    await landing(page).waitFor();
    return ctx.display;
  }
  async function dropDisplay(reason = `ZZ TEST SCRUM-${T} proof step complete`) {
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
    await landing(surface).waitFor();
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

  /** A later run uses the Golden Ticket an earlier run bought and did not redeem. */
  async function useVoucher(saleId) {
    phase('reuse the unredeemed Golden Ticket bought on an earlier run');
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
    assert.ok(!/Please pay/i.test(text), 'customer half does not ask for money');
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
  /** The hold area must carry no "still being saved" line, with Hold sale shut. */
  function assertNoSavingLine(area) {
    assert.equal(area.present, 1, 'the Hold sale row is on the payment step');
    assert.equal(area.holdSaleDisabled, true, 'Hold sale is disabled');
    assert.equal(area.holdSaleReasonCount, 0, 'no line under Hold sale');
    assert.equal(area.stillBeingSavedAnywhereOnPage, 0, 'the words are nowhere on the page');
  }

  // ---- SCRUM-853 step 3: the platform refuses the price (409 VOUCHER_NOT_HELD) ----
  async function stepRefused() {
    const s = receipt.steps.s853_3_refused = { pass: false, seen: {} }; save();
    await dropOffToConsentDone('r');
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
      phase('r: Continue to payment with the first quote refused (409 VOUCHER_NOT_HELD)');
      const reg = await continueToPayment('r');
      const box = till.getByTestId('voucher-price-unavailable');
      await expect(box).toBeVisible();
      s.seen.staffBox = flat(await box.innerText());
      s.seen.amountDue = flat(await amountDue().innerText());
      assert.equal(s.seen.staffBox, 'The voucher price could not be fetched: Scan the voucher at this till first — it is not held for this sale. Go Back to change the order, or Cancel the sale.');
      await expect(paymentStep().getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeDisabled();
      s.seen.confirmDisabled = true;
      await dropDisplay('ZZ TEST SCRUM-853 step 3: show the own customer half');
      s.seen.customerHalf = await neutralHalf();
      await till.waitForTimeout(1500);
      s.seen.holdArea = await holdArea(); save();
      assertNoSavingLine(s.seen.holdArea);
      assert.equal((await newSales()).length, 0, 'no redemption sale is written');
      s.seen.redemptionSalesWritten = 0;
      await till.getByTestId('hold-sale-buttons').scrollIntoViewIfNeeded();
      await box.scrollIntoViewIfNeeded();
      s.seen.inPicture = { amberBox: await box.isVisible(), holdSaleRow: await till.getByTestId('hold-sale-buttons').isVisible() };
      await shot(till, '853-3-refused-platform-words-no-saving-line.png');
      await cancelSale('r');
      s.seen.afterCancel = { newSales: (await newSales()).map(x => ({ id: x.id, status: x.status })), registration: await registrationState(reg.id) };
      assert.equal(s.seen.afterCancel.newSales.filter(x => x.status !== 'voided').length, 0);
      s.pass = true; save();
    } finally { await till.unroute(isQuote, handler).catch(() => {}); }
  }

  // ---- SCRUM-853 step 1: the platform does not answer and the box does ----
  async function stepOffline() {
    const s = receipt.steps.s853_1_offline = { pass: false, seen: {} }; save();
    await dropOffToConsentDone('o');
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
      phase('o: Continue to payment with the first quote aborted (the platform does not answer)');
      const reg = await continueToPayment('o');
      const box = till.getByTestId('voucher-price-unavailable');
      await expect(box).toBeVisible();
      await till.waitForTimeout(1500);
      s.seen.staffBox = flat(await box.innerText());
      s.seen.amountDue = flat(await amountDue().innerText());
      s.seen.holdArea = await holdArea(); save();
      await box.scrollIntoViewIfNeeded();
      await shot(till, '853-1-box-answered-online-only.png');
      assert.equal(s.seen.staffBox, 'The voucher price could not be fetched: Vouchers can only be redeemed online. Go Back to change the order, or Cancel the sale.');
      assert.ok(!/Member not found/i.test(flat(await till.locator('body').innerText())), 'the box\'s own refusal is not on the page');
      s.seen.memberNotFoundOnPage = false;
      await expect(paymentStep().getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeDisabled();
      s.seen.confirmDisabled = true;
      s.seen.quotePostsAfterTheAbort = posts - 1;
      assert.equal((await newSales()).length, 0, 'no redemption sale is written');
      s.seen.redemptionSalesWritten = 0;
      await cancelSale('o');
      s.seen.afterCancel = { newSales: (await newSales()).map(x => ({ id: x.id, status: x.status })), registration: await registrationState(reg.id) };
      assert.equal(s.seen.afterCancel.newSales.filter(x => x.status !== 'voided').length, 0);
      s.pass = true; save();
    } finally { await till.unroute(isQuote, handler).catch(() => {}); await dropDisplay().catch(() => {}); }
  }

  // ---- SCRUM-853 step 2: the price is held, then released and the zero sale completed ----
  async function stepPending() {
    const a = receipt.steps.s853_2_pending = { pass: false, seen: {} };
    const b = receipt.steps.s853_2_release = { pass: false, seen: {} }; save();
    await dropOffToConsentDone('p');
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
      phase('p: Continue to payment with the real quote HELD');
      const reg = await continueToPayment('p');
      const status = paymentStep().getByRole('status');
      await expect(status).toHaveText('Waiting for the voucher price...');
      await expect.poll(() => Boolean(a.heldQuotes?.length)).toBe(true);
      assert.equal(a.heldQuotes[0].status, 200);
      await expect(amountDue()).toContainText('—');
      a.seen.staffLine = flat(await status.innerText());
      a.seen.amountDue = flat(await amountDue().innerText());
      await expect(paymentStep().getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeDisabled();
      a.seen.confirmDisabled = true;
      assert.equal((await newSales()).length, 0, 'no sale is written while waiting');
      a.seen.salesWrittenWhileWaiting = 0;
      await dropDisplay('ZZ TEST SCRUM-853 step 2: show the own customer half');
      a.seen.customerHalf = await neutralHalf();
      await expect(status).toHaveText('Waiting for the voucher price...');
      await till.waitForTimeout(1500);
      a.seen.holdArea = await holdArea(); save();
      assertNoSavingLine(a.seen.holdArea);
      assert.equal((await newSales()).length, 0);
      await till.getByTestId('hold-sale-buttons').scrollIntoViewIfNeeded();
      await status.scrollIntoViewIfNeeded();
      a.seen.inPicture = { waitingLine: await status.isVisible(), holdSaleRow: await till.getByTestId('hold-sale-buttons').isVisible() };
      await shot(till, '853-2-price-pending-no-saving-line.png');
      a.pass = true; save();

      phase('p: release the quote');
      releaseQuote();
      await expect(amountDue()).toContainText('฿0');
      await expect(paymentStep().getByText('No payment needed', { exact: true })).toBeVisible();
      b.seen.amountDue = flat(await amountDue().innerText());
      const complete = paymentStep().getByRole('button', { name: 'Complete Sale', exact: true });
      await expect(complete).toBeEnabled();
      let redemption;
      await expect.poll(async () => { redemption = (await newSales()).find(x => x.status === 'tendering'); return Boolean(redemption); }, { timeout: 30000 }).toBe(true);
      const saved = (await call('GET', `/sales/${redemption.id}`)).body.sale;
      assert.equal(saved.totals.grossSatang, 0);
      receipt.created.push({ kind: 'redemption-sale', id: redemption.id }); save();
      b.seen.savedSale = { id: redemption.id, status: 'tendering', totalSatang: 0 };
      await till.waitForTimeout(1000);
      b.seen.holdAreaAfterPrice = await holdArea(); save();
      await shot(till, '853-2b-price-arrived-zero.png');
      await complete.click();
      await till.getByRole('button', { name: 'Check in now', exact: true }).click();
      await expect.poll(async () => (await registrationState(reg.id)).children.every(c => c.status === 'in_park'), { timeout: 30000 }).toBe(true);
      assert.equal((await call('GET', `/sales/${redemption.id}`)).body.sale.status, 'finalised');
      knownSales.add(redemption.id);
      b.seen.completed = { saleId: redemption.id, status: 'finalised', totalSatang: 0, child: 'in_park' };
      const after = (await call('GET', `/sales/${ctx.sold.id}`)).body.issuedVouchers.find(v => v.id === ctx.voucher.id);
      b.seen.voucherAfter = { status: after?.status ?? null };
      b.pass = true; save();
    } finally { releaseQuote(); await till.unroute(isQuote, handler).catch(() => {}); }
  }

  // ---- SCRUM-853 step 4: a plain walk-in ticket sale, as before ----
  async function stepPlainSale() {
    const s = receipt.steps.s853_4_plain = { pass: false, seen: {} }; save();
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
    // The write of the sale is delayed by the test, unchanged, so that the
    // moment the step opens can be read before the sale is saved.
    const DELAY = 4000;
    const delay = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      (s.saleWriteDelayedByTest ??= []).push({ ms: DELAY, seenAt: new Date().toISOString() });
      await new Promise(r => setTimeout(r, DELAY));
      return route.continue().catch(() => {});
    };
    await till.route(isSales, delay);
    try {
      await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
      await expect(paymentStep()).toBeVisible({ timeout: 30000 });
      await expect(till.getByTestId('hold-sale-buttons')).toBeVisible();
      s.seen.atOpen = { readAt: new Date().toISOString(), salesWritten: (await newSales()).length, holdArea: await holdArea() }; save();
      await shot(till, '853-4a-plain-sale-step-opens.png');
      await expect(amountDue()).toContainText(/฿\d/);
      s.seen.amountDue = flat(await amountDue().innerText());
      await expect(till.getByTestId('customer-price-pending')).toHaveCount(0);
      await expect(till.getByTestId('voucher-price-unavailable')).toHaveCount(0);
      let open;
      await expect.poll(async () => { open = (await newSales()).find(x => ['tendering', 'open'].includes(x.status)); return Boolean(open); }, { timeout: 30000 }).toBe(true);
      receipt.created.push({ kind: 'plain-ticket-sale', id: open.id }); save();
      s.seen.saleWritten = { id: open.id, status: open.status };
      await expect(till.getByText(SAVING, { exact: false })).toHaveCount(0, { timeout: 15000 });
      await till.waitForTimeout(1500);
      s.seen.afterSaved = { readAt: new Date().toISOString(), holdArea: await holdArea() }; save();
      const pay = till.getByText('Please pay', { exact: true });
      s.seen.customerHalf = (await pay.count()) ? flat(await halfOf(pay.first()).innerText()) : null;
      await shot(till, '853-4b-plain-sale-saved.png');
      await cancelSale('e');
      await expect.poll(async () => (await call('GET', `/sales/${open.id}`)).body.sale.status, { timeout: 30000 }).toBe('voided');
      knownSales.add(open.id);
      s.seen.afterCancel = { id: open.id, status: 'voided' };
      receipt.cleanup.push({ kind: 'sale', id: open.id, status: 'voided', by: 'Cancel on the till' });
      s.pass = true; save();
    } finally { await till.unroute(isSales, delay).catch(() => {}); }
  }

  // ---- SCRUM-853 step 5: the member card of a saved guardian ----
  async function stepMemberCard() {
    const s = receipt.steps.s853_5_member_card = { pass: false, seen: {} }; save();
    const till = ctx.till;
    phase('m: a pass on a number whose ZZ TEST guardian this run saved');
    await dropDisplay().catch(() => {});
    let number = null, member = null;
    for (const key of ['r', 'o', 'p']) {
      const found = (await call('GET', `/members/lookup?phone=${encodeURIComponent(numbers[key])}`)).body.member;
      if (found) { number = numbers[key]; member = found; s.savedByPass = key; break; }
    }
    assert.ok(member, 'an earlier pass of this run saved a guardian');
    assert.ok((member.nickname ?? '').startsWith('ZZ TEST SCRUM-853'), 'own ZZ TEST guardian');
    s.seen.memberOnPlatform = { id: member.id, nickname: member.nickname, phoneStored: member.phone };
    const writes = [];
    const watch = r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.method() !== 'GET') writes.push(r.method() + ' ' + u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')); };
    const before = (await newSales()).length;
    await till.goto('/');
    till.on('request', watch);
    try {
      const scope = await identify(till, number);
      await scope.getByRole('button', { name: 'Continue', exact: true }).click();
      // By text, not by role: the "Who's visiting today?" dialog opens over the step and hides its roles.
      await expect(till.getByText('Select Customer Type', { exact: true })).toBeVisible({ timeout: 30000 });
      const visiting = till.getByRole('button', { name: 'Skip for now', exact: true });
      const shown = await visiting.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      s.seen.visitingDialog = shown ? 'shown; "Skip for now" pressed (it only closes the dialog)' : 'not shown';
      if (shown) { await visiting.click(); await expect(visiting).toHaveCount(0); }
      await expect(till.getByRole('heading', { name: 'Select Customer Type', exact: true })).toBeVisible();
      const card = till.locator('div.rounded-xl.border.bg-card').filter({ hasText: member.nickname }).first();
      await expect(card).toBeVisible();
      await till.waitForTimeout(800);
      s.seen.memberCard = flat(await card.innerText());
      s.seen.expected = spaced(number);
      assert.ok(s.seen.memberCard.includes(spaced(number)), 'the card reads the number spaced');
      assert.ok(!s.seen.memberCard.includes('+66' + number.slice(1)), 'the card does not read the number unspaced');
      await shot(till, '853-5-member-card-spaced-number.png');
      await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
      await landing(till).waitFor({ timeout: 30000 });
      await till.waitForTimeout(1500);
      s.seen.nonGetRequestsDuringThePass = [...writes];
      s.seen.salesWritten = (await newSales()).length - before;
      assert.equal(s.seen.salesWritten, 0, 'no sale written');
      const after = (await call('GET', `/members/lookup?phone=${encodeURIComponent(number)}`)).body.member;
      s.seen.memberAfter = { id: after?.id ?? null, same: after?.id === member.id, updatedAtSame: (after?.updatedAt ?? null) === (member.updatedAt ?? null) };
      s.pass = true; save();
    } finally { till.off('request', watch); }
  }

  // ---- SCRUM-854: a voucher sale left unpaid, handed over, voided from the refusal ----
  async function signInAtTill(page, phone, password) {
    await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(phone.replace(/^\+66/, '0'));
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const pick = page.getByRole('button', { name: ctx.fixtureName, exact: false }).first();
    // The station picker, or the till itself: the till may show for a moment before the picker takes its place.
    const picker = page.getByRole('heading', { name: 'Which station are you on?' });
    const deadline = Date.now() + 60000; let picked = false, steady = 0;
    while (Date.now() < deadline) {
      // Only on the picker: the till's own header carries a button with the station's name, which opens the picker.
      if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); picked = true; break; } steady = 0; }
      else if (await landing(page).isVisible()) { steady += 1; if (steady >= 6) break; } else steady = 0;
      await page.waitForTimeout(500);
    }
    await page.locator('a[href="/history"]').first().waitFor();
    await landing(page).waitFor({ timeout: 15000 }).catch(async () => { await page.goto('/'); await landing(page).waitFor(); });
    return { stationPickerShown: picked };
  }
  async function ticketOnCart(number) {
    const till = ctx.till;
    await identifyAsWalkIn(till, number);
    await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
    await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
    await expect(till.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15000 });
  }
  async function typeVoucher(code) {
    const field = ctx.till.getByLabel('Redeem voucher');
    await field.fill(code);
    await field.press('Enter');
  }
  const saleStatus = async id => (await call('GET', `/sales/${id}`)).body.sale.status;

  async function stepLeftUnpaid(secondAccount) {
    const S = receipt.steps;
    const a = S.s854_a_left_unpaid = { pass: false, seen: {} };
    const b = S.s854_b_notice = { pass: false, seen: {} };
    const c = S.s854_c_refusal = { pass: false, seen: {} };
    const d = S.s854_d_void_from_refusal = { pass: false, seen: {} };
    const e = S.s854_e_read_back = { pass: false, seen: {} }; save();
    const till = ctx.till;
    const code = ctx.voucher.code;
    const hide = text => text.split(code).join('[voucher]');

    phase('a: first account rings up a ticket with the voucher and leaves it unpaid');
    await till.goto('/');
    await ticketOnCart(numbers.h);
    await typeVoucher(code);
    await expect(till.getByTestId('voucher-card')).toBeVisible({ timeout: 20000 });
    const payButton = till.getByRole('button', { name: /^Pay ฿/ });
    await expect(payButton).toBeEnabled({ timeout: 30000 });
    a.seen.payButton = flat(await payButton.innerText());
    const [written] = await Promise.all([
      till.waitForResponse(r => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST', { timeout: 30000 }),
      payButton.click(),
    ]);
    assert.equal(written.status(), 200);
    const left = (await written.json()).sale;
    assert.equal(left.status, 'tendering');
    receipt.created.push({ kind: 'left-unpaid-sale', id: left.id }); save();
    await expect(paymentStep()).toBeVisible({ timeout: 20000 });
    await expect(paymentStep().getByText('Waiting for the voucher price...', { exact: true })).toHaveCount(0, { timeout: 30000 });
    a.seen.amountDue = flat(await amountDue().innerText());
    a.seen.leftSale = { id: left.id, status: await saleStatus(left.id) };
    await shot(till, '854-a-first-account-sale-rung-up-unpaid.png', { cardInner: true });
    phase('a: lock, then "Sign out and hand over the till"');
    await till.getByLabel('Lock screen').click();
    await expect(till.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
    const handOver = till.getByRole('button', { name: /Sign out and hand over the till/ });
    a.seen.handOverButton = flat(await handOver.innerText());
    await handOver.click();
    await expect(till.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible({ timeout: 20000 });
    // The till shows its lock screen at once and ends the session behind it; read until it has.
    const readAt = Date.now(); let reads = 0;
    await expect.poll(async () => { reads += 1; return (await till.request.get('/api/me')).status(); }, { timeout: 20000, intervals: [250, 500, 1000] }).toBe(401);
    a.seen.firstAccountSessionAfterHandOver = { status: 401, reads, withinMs: Date.now() - readAt };
    a.seen.leftSaleAfterHandOver = await saleStatus(left.id);
    assert.equal(a.seen.leftSaleAfterHandOver, 'tendering');
    a.pass = true; save();

    phase('b: second account signs in at the same till');
    b.seen.signIn = await signInAtTill(till, secondAccount.phone, secondAccount.password);
    const me = await (await till.request.get('/api/me')).json();
    b.seen.secondAccountIsAnotherAccount = Boolean(me?.account?.id) && me.account.id !== ctx.firstAccountId;
    assert.equal(b.seen.secondAccountIsAnotherAccount, true);
    const notices = till.getByTestId('left-behind-sale');
    let where = 'on the till as it opened';
    try { await expect(notices.first()).toBeVisible({ timeout: 12000 }); }
    catch { where = 'after the ticket was added'; }
    if (where !== 'on the till as it opened') await ticketOnCart(numbers.h);
    await expect(notices.first()).toContainText('A sale rung up at this till was left unpaid', { timeout: 20000 });
    b.seen.noticeShown = where;
    b.seen.noticeCount = await notices.count();
    b.seen.notice = flat(await notices.first().innerText());
    await notices.first().scrollIntoViewIfNeeded();
    await shot(till, '854-b-second-account-left-unpaid-notice.png', { cardInner: true });
    b.pass = true; save();

    phase('c: add a ticket and scan the same voucher');
    if (where === 'on the till as it opened') await ticketOnCart(numbers.h);
    await typeVoucher(code);
    const refusal = till.getByTestId('voucher-refusal');
    await expect(refusal).toContainText('pay or void that sale first', { timeout: 20000 });
    await expect(refusal.getByTestId('rung-up-sale')).toContainText('Unpaid sale');
    c.seen.refusal = hide(flat(await refusal.innerText()));
    c.seen.noticesBefore = await notices.count();
    c.seen.notice = flat(await notices.first().innerText());
    await expect(till.getByTestId('voucher-card')).toBeHidden();
    c.seen.voucherCardShown = false;
    c.seen.leftSaleBeforeThePress = await saleStatus(left.id);
    assert.equal(c.seen.leftSaleBeforeThePress, 'tendering');
    await refusal.scrollIntoViewIfNeeded();
    const inView = async l => { try { await expect(l).toBeInViewport({ timeout: 1500 }); return true; } catch { return false; } };
    c.seen.inPicture = { refusal: await inView(refusal), leftUnpaidNotice: await inView(notices.first()) };
    if (!c.seen.inPicture.leftUnpaidNotice) { await notices.first().scrollIntoViewIfNeeded(); c.seen.inPicture = { refusal: await inView(refusal), leftUnpaidNotice: await inView(notices.first()), scrolled: true }; }
    await shot(till, '854-c-refusal-and-left-unpaid-notice.png', { cardInner: true });
    assert.ok(c.seen.inPicture.refusal && c.seen.inPicture.leftUnpaidNotice, 'both are in the picture');
    c.pass = true; save();

    phase('d: press "Void that unpaid sale and use the voucher here"');
    const press = refusal.getByRole('button', { name: 'Void that unpaid sale and use the voucher here', exact: true });
    d.seen.button = flat(await press.innerText());
    await press.click();
    await expect(till.getByTestId('voucher-card')).toBeVisible({ timeout: 20000 });
    await expect(refusal).toBeHidden();
    d.seen.voucherCardShown = true; d.seen.refusalCount = await refusal.count();
    d.seen.leftSaleAfterThePress = await saleStatus(left.id);
    assert.equal(d.seen.leftSaleAfterThePress, 'voided');
    await expect(notices).toHaveCount(c.seen.noticesBefore - 1, { timeout: 10000 });
    await till.waitForTimeout(2500); // it does not come back
    d.seen.noticesBefore = c.seen.noticesBefore;
    d.seen.noticesAfter = await notices.count();
    assert.equal(d.seen.noticesAfter, c.seen.noticesBefore - 1);
    d.seen.leftUnpaidWordsOnPage = await till.getByText('rung up at this till was left unpaid', { exact: false }).count();
    await till.getByTestId('voucher-card').scrollIntoViewIfNeeded();
    await shot(till, '854-d-voided-voucher-on-notice-gone.png', { cardInner: true });
    d.pass = true; save();

    phase('e: read the left sale back; Cancel the new sale');
    const back = (await call('GET', `/sales/${left.id}`)).body.sale;
    e.seen.leftSale = { id: left.id, status: back.status, voidReason: back.voidReason ?? back.void?.reason ?? null };
    assert.equal(back.status, 'voided');
    knownSales.add(left.id);
    receipt.cleanup.push({ kind: 'sale', id: left.id, status: 'voided', by: 'the refusal\'s void, pressed by the second account' });
    await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await landing(till).waitFor({ timeout: 30000 });
    await till.waitForTimeout(2000);
    e.seen.afterCancel = { newSales: (await newSales()).map(x => ({ id: x.id, status: x.status })) };
    assert.equal(e.seen.afterCancel.newSales.filter(x => x.status !== 'voided').length, 0);
    e.seen.voucherAfter = await ctx.voucherStatus();
    e.pass = true; save();
  }

  return { pairDisplay, dropDisplay, buyVoucher, useVoucher, stepRefused, stepOffline, stepPending, stepPlainSale, stepMemberCard, stepLeftUnpaid, signInAtTill, registrationState, stationSales };
}
