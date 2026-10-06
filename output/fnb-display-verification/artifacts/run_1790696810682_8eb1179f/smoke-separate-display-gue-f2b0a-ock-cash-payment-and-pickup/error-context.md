# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> separate display guest F&B uses the captured order through lock, cash payment and pickup
- Location: e2e\smoke.spec.ts:518:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 409
```

# Test source

```ts
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
  524 |   const fnbSession = (stage: string, discounted = false) => {
  525 |     let lastStatus: number | null = null;
  526 |     let lastStage = 'none';
  527 |     let lastKind = 'none';
  528 |     let lastSupported = false;
  529 |     return fixture.display.waitForResponse(async response => {
  530 |       if (!response.url().endsWith('/api/display/session')) return false;
  531 |       lastStatus = response.status();
  532 |       if (lastStatus !== 200) return false;
  533 |       const document = (await response.json().catch(() => null))?.document;
  534 |       lastStage = ['identify', 'welcome', 'order', 'input', 'payment', 'thankyou'].includes(document?.stage) ? document.stage : 'other';
  535 |       lastKind = document?.cart?.kind === 'fnb' ? 'fnb' : 'other';
  536 |       lastSupported = document?.cart?.supported === true;
  537 |       return document?.stage === stage && lastKind === 'fnb' && lastSupported
  538 |         && (!discounted || document.cart.manualDiscounts?.length === 1);
  539 |     }).catch(() => {
  540 |       throw new Error(`F&B display ${stage} response missing (status=${lastStatus}, stage=${lastStage}, kind=${lastKind}, supported=${lastSupported})`);
  541 |     });
  542 |   };
  543 |   try {
  544 |     const welcome = fnbSession('welcome');
  545 |     await page.getByRole('button', { name: 'F&B', exact: true }).click();
  546 |     await expect(page.getByRole('heading', { name: 'Scan Wristband', exact: true })).toBeVisible();
  547 |     await welcome;
  548 |     const publicFnb = fixture.display.getByTestId('display-fnb');
  549 |     await expect(publicFnb.getByRole('heading', { name: 'Order here', exact: true })).toBeVisible({ timeout: 20_000 });
  550 |     await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  551 |     await page.getByPlaceholder('Search dish…').fill('French Fries');
  552 |     await page.getByRole('button', { name: /French Fries/ }).click();
  553 |     const options = page.getByRole('dialog');
  554 |     await options.getByRole('button', { name: /Cheese sauce/ }).click();
  555 |     await options.getByRole('button', { name: 'Add one French Fries', exact: true }).click();
  556 |     await options.getByPlaceholder('e.g. no pickles, extra crispy').fill('Local menu note');
  557 |     const added = fnbSession('order');
  558 |     await options.getByRole('button', { name: /^Add to order/ }).click();
  559 |     await added;
  560 |     await expect(publicFnb.getByTestId('fnb-display-line')).toHaveCount(1, { timeout: 20_000 });
  561 |     await expect(publicFnb.getByText('Cheese sauce', { exact: true })).toBeVisible();
  562 |     await expect(publicFnb.getByText('Local menu note', { exact: true })).toBeVisible();
  563 | 
  564 |     await page.getByRole('button', { name: 'Add manual discount', exact: true }).click();
  565 |     const discount = page.getByRole('dialog');
  566 |     await discount.getByRole('button', { name: '1', exact: true }).click();
  567 |     await discount.getByRole('button', { name: '0', exact: true }).click();
  568 |     await discount.getByText(/^Reason/).locator('..').getByRole('button').first().click();
  569 |     const quoted = page.waitForResponse(response => response.url().endsWith('/api/sales/quote')
  570 |       && response.request().method() === 'POST' && response.status() === 200
  571 |       && response.request().postDataJSON()?.manualDiscounts?.length === 1);
  572 |     const discounted = fnbSession('order', true);
  573 |     await discount.getByRole('button', { name: /^Apply/ }).click();
  574 |     const quote = (await (await quoted).json()).quote;
  575 |     const document = (await (await discounted).json()).document;
  576 |     const line = document.cart.lines[0];
  577 |     expect(document.step === null && document.member === null && document.prompt === null).toBe(true);
  578 |     expect(line.qty === 2 && line.name === 'French Fries' && line.basePrice === 90
  579 |       && line.modifiers.some((modifier: { optionName: string; price: number }) => modifier.optionName === 'Cheese sauce' && modifier.price === 25)).toBe(true);
  580 |     expect(Math.round(document.totals.total * 100) === quote.totals.grossSatang).toBe(true);
  581 |     const discountId = document.cart.manualDiscounts[0].id;
  582 |     expect(document.totals.manualAmounts[discountId] > 0).toBe(true);
  583 |     await expect(publicFnb.getByText(`฿${line.basePrice} base`, { exact: true })).toBeVisible();
  584 |     await expect(publicFnb.getByText(`฿${line.lineTotal}`, { exact: true })).toBeVisible();
  585 |     await expect(publicFnb.getByText(`−฿${document.totals.manualAmounts[discountId]}`, { exact: true })).toBeVisible();
  586 |     await expect(publicFnb.getByText(`฿${document.totals.total}`, { exact: true })).toBeVisible();
  587 |     await expect(publicFnb.getByText(/credit balance|remaining credit|allergy|medical|prepaid|staff benefit/i)).toHaveCount(0);
  588 |     for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
  589 |       await fixture.display.setViewportSize(viewport);
  590 |       expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  591 |     }
  592 |     await fixture.display.setViewportSize({ width: 1024, height: 768 });
  593 |     await captureLocalCheck(fixture.display, 'fnb-display-order-local.png');
  594 | 
  595 |     await page.getByLabel('Lock screen').click();
  596 |     await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  597 |     const locked = (await (await fnbSession('order', true)).json()).document;
  598 |     expect(JSON.stringify(locked.cart) === JSON.stringify(document.cart)
  599 |       && JSON.stringify(locked.totals) === JSON.stringify(document.totals)).toBe(true);
  600 |     await unlock(page);
  601 |     await expect(page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true })).toBeVisible();
  602 |     await expect(publicFnb.getByText('Local menu note', { exact: true })).toBeVisible();
  603 |     await publicFnb.getByLabel('Change language').click();
  604 |     const languageSet = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
  605 |       && response.request().postDataJSON()?.type === 'display.set_language'
  606 |       && response.request().postDataJSON()?.payload?.language === 'fr');
  607 |     await publicFnb.getByRole('button', { name: 'Français', exact: true }).click();
> 608 |     expect((await languageSet).status()).toBe(200);
      |                                          ^ Error: expect(received).toBe(expected) // Object.is equality
  609 |     await expect(publicFnb.getByText('Frites', { exact: true })).toBeVisible();
  610 |     await publicFnb.getByLabel('Change language').click();
  611 |     await publicFnb.getByRole('button', { name: 'English', exact: true }).click();
  612 | 
  613 |     const payment = fnbSession('payment');
  614 |     await page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true }).click();
  615 |     const pickup = page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  616 |     await pickup.getByRole('button', { name: '1', exact: true }).click();
  617 |     await pickup.getByRole('button', { name: '2', exact: true }).click();
  618 |     await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();
  619 |     const paymentDocument = (await (await payment).json()).document;
  620 |     expect(paymentDocument.cart.completion === null && paymentDocument.prompt === null
  621 |       && paymentDocument.payment.amountSatang === Math.round(document.totals.total * 100)).toBe(true);
  622 |     await expect(publicFnb.getByText('Amount to pay', { exact: true })).toBeVisible({ timeout: 20_000 });
  623 |     await captureLocalCheck(fixture.display, 'fnb-display-payment-local.png');
  624 |     await page.getByRole('button', { name: /^Cash / }).click();
  625 |     await page.getByLabel('Cash received', { exact: true }).fill((document.totals.total + 10).toFixed(2));
  626 |     const finalised = page.waitForResponse(response => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(response.url()).pathname)
  627 |       && response.request().method() === 'POST' && response.status() === 200);
  628 |     const thankyou = fnbSession('thankyou');
  629 |     await page.getByRole('button', { name: 'Record cash', exact: true }).click();
  630 |     const finalResponse = await finalised;
  631 |     const written = (await finalResponse.json()).sale;
  632 |     expect(written?.status === 'finalised' && written.totals.grossSatang === quote.totals.grossSatang).toBe(true);
  633 |     const completed = (await (await thankyou).json()).document;
  634 |     const summary = completed.cart.completion;
  635 |     expect(summary?.saleId === written.id && typeof summary.pickupCode === 'string' && summary.pickupCode.length > 0
  636 |       && Math.round(summary.total * 100) === written.totals.grossSatang
  637 |       && summary.payment.cash === summary.total && summary.payment.card === 0 && summary.payment.promptpay === 0).toBe(true);
  638 |     await expect(page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible();
  639 |     await expect(publicFnb.getByRole('heading', { name: 'Thank you!', exact: true })).toBeVisible({ timeout: 20_000 });
  640 |     await expect(publicFnb.getByText(summary.pickupCode, { exact: true })).toBeVisible();
  641 |     await expect(publicFnb.getByText('Cash', { exact: true })).toBeVisible();
  642 |     await expect(publicFnb.getByText(/credit balance|remaining credit|fnb credit/i)).toHaveCount(0);
  643 |     await captureLocalCheck(fixture.display, 'fnb-display-completed-local.png');
  644 |   } finally {
  645 |     try {
  646 |       if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
  647 |       if (await page.getByLabel('Lock screen').isVisible()) { await fixture.releaseLease(); await signOut(page); }
  648 |     } finally {
  649 |       try { await fixture.cleanup(); } finally { await clearStaffPage(page); }
  650 |     }
  651 |   }
  652 | });
  653 | 
```