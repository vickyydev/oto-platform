# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> separate display guest F&B uses the captured order through lock, cash payment and pickup
- Location: e2e\smoke.spec.ts:518:1

# Error details

```
TimeoutError: page.waitForResponse: Timeout 20000ms exceeded while waiting for event "response"
```

# Test source

```ts
  424 |     const picker = fixture.display.getByRole('dialog');
  425 |     await picker.getByRole('button', { name: '8', exact: true }).click();
  426 |     await picker.getByRole('button', { name: 'Jan', exact: true }).click();
  427 |     await picker.getByRole('button', { name: '15', exact: true }).click();
  428 |     await picker.getByRole('button', { name: 'Confirm', exact: true }).click();
  429 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  430 | 
  431 |     let firstPatchBody: unknown;
  432 |     let firstPatchKey: string | undefined;
  433 |     let patchCount = 0;
  434 |     let signalCommitted: (() => void) | undefined;
  435 |     const committed = new Promise<void>(resolve => { signalCommitted = resolve; });
  436 |     const lostReply = new Promise<void>(resolve => { releaseLostReply = resolve; });
  437 |     await page.route(`**/api/members/children/${childId}`, async route => {
  438 |       if (route.request().method() !== 'PATCH') { await route.continue(); return; }
  439 |       patchCount += 1;
  440 |       const body = route.request().postDataJSON();
  441 |       const key = route.request().headers()['idempotency-key'];
  442 |       expect(Object.keys(body).every(field => ['name', 'dateOfBirth', 'ageYears'].includes(field))).toBe(true);
  443 |       if (patchCount === 1) {
  444 |         firstPatchBody = body;
  445 |         firstPatchKey = key;
  446 |         const actual = await route.fetch();
  447 |         expect(actual.status()).toBe(200);
  448 |         signalCommitted?.();
  449 |         await lostReply;
  450 |         await route.abort('failed');
  451 |       } else {
  452 |         expect(typeof key === 'string' && key === firstPatchKey && JSON.stringify(body) === JSON.stringify(firstPatchBody)).toBe(true);
  453 |         await route.continue();
  454 |       }
  455 |     });
  456 |     await cards.first().getByRole('button', { name: 'Confirm', exact: true }).click();
  457 |     await committed;
  458 |     await expect(fixture.display.getByText('Please wait for the team to confirm this change.', { exact: true })).toBeVisible({ timeout: 20_000 });
  459 |     await expect(firstName).toBeDisabled();
  460 |     await expect(secondName).toBeDisabled();
  461 |     await expect(review.getByLabel('Child 1 saved profile', { exact: true })).toBeDisabled();
  462 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  463 |     const profile = await fixture.admin.get(`/api/members/${original.id}`);
  464 |     expect(profile.status()).toBe(200);
  465 |     const saved = (await profile.json()).member.children.find((child: { id: string }) => child.id === childId);
  466 |     const submitted = firstPatchBody as { name: string; dateOfBirth: string; ageYears: number };
  467 |     expect(saved?.name === submitted.name && saved?.dateOfBirth === submitted.dateOfBirth && saved?.ageYears === submitted.ageYears).toBe(true);
  468 |     await captureLocalCheck(fixture.display, 'ticket-display-child-save-pending-local.png');
  469 |     releaseLostReply?.();
  470 |     await expect(review.getByRole('button', { name: 'Retry child save', exact: true })).toBeVisible({ timeout: 20_000 });
  471 |     await expect(firstName).toBeDisabled();
  472 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  473 |     await captureLocalCheck(fixture.display, 'ticket-display-child-retry-local.png');
  474 |     const replay = page.waitForResponse(response => response.url().endsWith(`/api/members/children/${childId}`)
  475 |       && response.request().method() === 'PATCH' && response.status() === 200);
  476 |     await review.getByRole('button', { name: 'Retry child save', exact: true }).click();
  477 |     await replay;
  478 |     await expect(cards.first().getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 20_000 });
  479 |     expect(patchCount === 2).toBe(true);
  480 |     await expect(secondName).toHaveValue('Other child local draft');
  481 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  482 |     await secondName.fill(prompt.slots[1].name);
  483 |     await cards.nth(1).getByRole('button', { name: 'Confirm', exact: true }).click();
  484 |     await expect(cards.nth(1).getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 20_000 });
  485 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  486 |     // Editing a confirmed record stays local and cannot use the old confirmation to continue.
  487 |     await firstName.fill('Another unsaved draft');
  488 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  489 |     await firstName.fill('Local child correction');
  490 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  491 |     await captureLocalCheck(fixture.display, 'ticket-display-child-confirmed-local.png');
  492 |     await review.getByRole('button', { name: 'Done', exact: true }).click();
  493 |     await expect(page.getByRole('heading', { name: 'Children playing alone', exact: true })).toBeVisible({ timeout: 20_000 });
  494 |     await expect(fixture.display.getByText('Please follow the staff screen.', { exact: true })).toBeVisible({ timeout: 20_000 });
  495 |     await expect(fixture.display.getByTestId('display-child-review')).toHaveCount(0);
  496 |     expect(unrelatedWrites === 0).toBe(true);
  497 |   } finally {
  498 |     releaseLostReply?.();
  499 |     page.off('request', observeReviewWrite);
  500 |     fixture.display.off('request', observeReviewWrite);
  501 |     try {
  502 |       if (restoredChild) {
  503 |         await page.unroute(`**/api/members/children/${restoredChild.id}`);
  504 |         const restored = await fixture.admin.patch(`/api/members/children/${restoredChild.id}`, {
  505 |           data: { name: restoredChild.name, dateOfBirth: restoredChild.dateOfBirth, ageYears: restoredChild.ageYears },
  506 |           headers: { 'Idempotency-Key': `display-smoke-child-cleanup-${crypto.randomUUID()}` },
  507 |         });
  508 |         expect(restored.status()).toBe(200);
  509 |       }
  510 |       if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
  511 |       if (await page.getByLabel('Lock screen').isVisible()) { await fixture.releaseLease(); await signOut(page); }
  512 |     } finally {
  513 |       try { await fixture.cleanup(); } finally { await clearStaffPage(page); }
  514 |     }
  515 |   }
  516 | });
  517 | 
  518 | test('separate display guest F&B uses the captured order through lock, cash payment and pickup', async ({ page, browser, baseURL }) => {
  519 |   test.setTimeout(120_000);
  520 |   requireLocalFixture(baseURL);
  521 |   await page.goto('/');
  522 |   await signIn(page);
  523 |   const fixture = await pairedDisplay(browser, page, baseURL);
> 524 |   const fnbSession = (stage: string, discounted = false) => fixture.display.waitForResponse(async response => {
      |                                                                             ^ TimeoutError: page.waitForResponse: Timeout 20000ms exceeded while waiting for event "response"
  525 |     if (!response.url().endsWith('/api/display/session') || response.status() !== 200) return false;
  526 |     const document = (await response.json()).document;
  527 |     return document?.stage === stage && document.cart?.kind === 'fnb' && document.cart.supported === true
  528 |       && (!discounted || document.cart.manualDiscounts?.length === 1);
  529 |   });
  530 |   try {
  531 |     const welcome = fnbSession('welcome');
  532 |     await page.goto('/order-station');
  533 |     await expect(page.getByRole('heading', { name: 'Scan Wristband', exact: true })).toBeVisible();
  534 |     await welcome;
  535 |     const publicFnb = fixture.display.getByTestId('display-fnb');
  536 |     await expect(publicFnb.getByRole('heading', { name: 'Order here', exact: true })).toBeVisible({ timeout: 20_000 });
  537 |     await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  538 |     await page.getByPlaceholder('Search dish…').fill('French Fries');
  539 |     await page.getByRole('button', { name: /French Fries/ }).click();
  540 |     const options = page.getByRole('dialog');
  541 |     await options.getByRole('button', { name: /Cheese sauce/ }).click();
  542 |     await options.getByRole('button', { name: 'Add one French Fries', exact: true }).click();
  543 |     await options.getByPlaceholder('e.g. no pickles, extra crispy').fill('Local menu note');
  544 |     const added = fnbSession('order');
  545 |     await options.getByRole('button', { name: /^Add to order/ }).click();
  546 |     await added;
  547 |     await expect(publicFnb.getByTestId('fnb-display-line')).toHaveCount(1, { timeout: 20_000 });
  548 |     await expect(publicFnb.getByText('Cheese sauce', { exact: true })).toBeVisible();
  549 |     await expect(publicFnb.getByText('Local menu note', { exact: true })).toBeVisible();
  550 | 
  551 |     await page.getByRole('button', { name: 'Add manual discount', exact: true }).click();
  552 |     const discount = page.getByRole('dialog');
  553 |     await discount.getByRole('button', { name: '1', exact: true }).click();
  554 |     await discount.getByRole('button', { name: '0', exact: true }).click();
  555 |     await discount.getByText(/^Reason/).locator('..').getByRole('button').first().click();
  556 |     const quoted = page.waitForResponse(response => response.url().endsWith('/api/sales/quote')
  557 |       && response.request().method() === 'POST' && response.status() === 200
  558 |       && response.request().postDataJSON()?.manualDiscounts?.length === 1);
  559 |     const discounted = fnbSession('order', true);
  560 |     await discount.getByRole('button', { name: /^Apply/ }).click();
  561 |     const quote = (await (await quoted).json()).quote;
  562 |     const document = (await (await discounted).json()).document;
  563 |     const line = document.cart.lines[0];
  564 |     expect(document.step === null && document.member === null && document.prompt === null).toBe(true);
  565 |     expect(line.qty === 2 && line.name === 'French Fries' && line.basePrice === 90
  566 |       && line.modifiers.some((modifier: { optionName: string; price: number }) => modifier.optionName === 'Cheese sauce' && modifier.price === 25)).toBe(true);
  567 |     expect(Math.round(document.totals.total * 100) === quote.totals.grossSatang).toBe(true);
  568 |     const discountId = document.cart.manualDiscounts[0].id;
  569 |     expect(document.totals.manualAmounts[discountId] > 0).toBe(true);
  570 |     await expect(publicFnb.getByText(`฿${line.basePrice} base`, { exact: true })).toBeVisible();
  571 |     await expect(publicFnb.getByText(`฿${line.lineTotal}`, { exact: true })).toBeVisible();
  572 |     await expect(publicFnb.getByText(`−฿${document.totals.manualAmounts[discountId]}`, { exact: true })).toBeVisible();
  573 |     await expect(publicFnb.getByText(`฿${document.totals.total}`, { exact: true })).toBeVisible();
  574 |     await expect(publicFnb.getByText(/credit balance|remaining credit|allergy|medical|prepaid|staff benefit/i)).toHaveCount(0);
  575 |     for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
  576 |       await fixture.display.setViewportSize(viewport);
  577 |       expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  578 |     }
  579 |     await fixture.display.setViewportSize({ width: 1024, height: 768 });
  580 |     await captureLocalCheck(fixture.display, 'fnb-display-order-local.png');
  581 | 
  582 |     await page.getByLabel('Lock screen').click();
  583 |     await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  584 |     const locked = (await (await fnbSession('order', true)).json()).document;
  585 |     expect(JSON.stringify(locked.cart) === JSON.stringify(document.cart)
  586 |       && JSON.stringify(locked.totals) === JSON.stringify(document.totals)).toBe(true);
  587 |     await unlock(page);
  588 |     await expect(page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true })).toBeVisible();
  589 |     await expect(publicFnb.getByText('Local menu note', { exact: true })).toBeVisible();
  590 |     await publicFnb.getByLabel('Change language').click();
  591 |     const languageSet = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
  592 |       && response.request().postDataJSON()?.type === 'display.set_language'
  593 |       && response.request().postDataJSON()?.payload?.language === 'fr');
  594 |     await publicFnb.getByRole('button', { name: 'Français', exact: true }).click();
  595 |     expect((await languageSet).status()).toBe(200);
  596 |     await expect(publicFnb.getByText('Frites', { exact: true })).toBeVisible();
  597 |     await publicFnb.getByLabel('Change language').click();
  598 |     await publicFnb.getByRole('button', { name: 'English', exact: true }).click();
  599 | 
  600 |     const payment = fnbSession('payment');
  601 |     await page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true }).click();
  602 |     const paymentDocument = (await (await payment).json()).document;
  603 |     expect(paymentDocument.cart.completion === null && paymentDocument.prompt === null
  604 |       && paymentDocument.payment.amountSatang === Math.round(document.totals.total * 100)).toBe(true);
  605 |     await expect(publicFnb.getByText('Amount to pay', { exact: true })).toBeVisible({ timeout: 20_000 });
  606 |     await captureLocalCheck(fixture.display, 'fnb-display-payment-local.png');
  607 |     await page.getByRole('button', { name: /^Cash / }).click();
  608 |     await page.getByLabel('Cash received', { exact: true }).fill((document.totals.total + 10).toFixed(2));
  609 |     const finalised = page.waitForResponse(response => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(response.url()).pathname)
  610 |       && response.request().method() === 'POST' && response.status() === 200);
  611 |     const thankyou = fnbSession('thankyou');
  612 |     await page.getByRole('button', { name: 'Record cash', exact: true }).click();
  613 |     const finalResponse = await finalised;
  614 |     const written = (await finalResponse.json()).sale;
  615 |     expect(written?.status === 'finalised' && written.totals.grossSatang === quote.totals.grossSatang).toBe(true);
  616 |     const completed = (await (await thankyou).json()).document;
  617 |     const summary = completed.cart.completion;
  618 |     expect(summary?.saleId === written.id && typeof summary.pickupCode === 'string' && summary.pickupCode.length > 0
  619 |       && Math.round(summary.total * 100) === written.totals.grossSatang
  620 |       && summary.payment.cash === summary.total && summary.payment.card === 0 && summary.payment.promptpay === 0).toBe(true);
  621 |     await expect(page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible();
  622 |     await expect(publicFnb.getByRole('heading', { name: 'Thank you!', exact: true })).toBeVisible({ timeout: 20_000 });
  623 |     await expect(publicFnb.getByText(summary.pickupCode, { exact: true })).toBeVisible();
  624 |     await expect(publicFnb.getByText('Cash', { exact: true })).toBeVisible();
```