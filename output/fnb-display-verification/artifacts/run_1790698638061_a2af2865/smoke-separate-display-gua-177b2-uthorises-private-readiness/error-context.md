# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> separate display guardian acknowledgement retains lock and retry, while staff authorises private readiness
- Location: e2e\smoke.spec.ts:665:1

# Error details

```
TimeoutError: locator.click: Timeout 20000ms exceeded.
Call log:
  - waiting for getByRole('dialog', { name: 'Private child details', exact: true }).getByRole('button', { name: 'Take photo', exact: true })

```

# Test source

```ts
  665 | test('separate display guardian acknowledgement retains lock and retry, while staff authorises private readiness', async ({ page, browser, baseURL }) => {
  666 |   test.setTimeout(150_000);
  667 |   requireLocalFixture(baseURL);
  668 |   await page.goto('/');
  669 |   await signIn(page);
  670 |   const fixture = await pairedDisplay(browser, page, baseURL);
  671 |   let blockRead = false;
  672 |   let publicWrites = 0;
  673 |   let businessWrites = 0;
  674 |   const observe = (request: Request) => {
  675 |     if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) return;
  676 |     const pathname = new URL(request.url()).pathname;
  677 |     if (/^\/api\/(payments|check-?ins?|registrations?|visits|checkout)(\/|$)/.test(pathname)
  678 |       || pathname === '/api/sales' || /^\/api\/sales\/[^/]+\/finalise$/.test(pathname)
  679 |       || /^\/api\/members\/[^/]+\/children(\/|$)/.test(pathname)) businessWrites += 1;
  680 |   };
  681 |   const readConsent = (ready?: boolean, completed?: boolean) => fixture.display.waitForResponse(async response => {
  682 |     if (!response.url().endsWith('/api/display/session') || response.status() !== 200) return false;
  683 |     const document = (await response.json()).document;
  684 |     return document?.prompt?.kind === 'consent' && (ready === undefined || document.prompt.canContinue === ready)
  685 |       && (completed === undefined || document.prompt.completed === completed);
  686 |   });
  687 |   try {
  688 |     const lookup = page.waitForResponse(response => response.url().includes('/api/members/lookup?') && response.status() === 200);
  689 |     await typePhone(fixture.display, MEMBER_PHONE);
  690 |     await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
  691 |     await lookup;
  692 |     await expect(page.getByText("Who's visiting today?", { exact: true })).toBeVisible({ timeout: 20_000 });
  693 |     for (const button of await page.getByRole('dialog').getByRole('button', { name: /^Details/ }).all()) {
  694 |       if (await button.getAttribute('aria-expanded') === 'true') await button.click();
  695 |     }
  696 |     await page.getByRole('button', { name: /Confirm 2 children/ }).click();
  697 |     await page.getByRole('heading', { name: 'Thai', exact: true }).click();
  698 |     await page.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
  699 |     await page.getByRole('button', { name: 'Remove one Adults', exact: true }).first().click();
  700 |     await page.getByRole('button', { name: 'Continue', exact: true }).click();
  701 |     const review = fixture.display.getByTestId('display-child-review');
  702 |     await expect(review).toBeVisible({ timeout: 20_000 });
  703 |     await review.getByRole('button', { name: 'Confirm', exact: true }).click();
  704 |     await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeEnabled({ timeout: 20_000 });
  705 |     const opened = readConsent(false);
  706 |     await review.getByRole('button', { name: 'Done', exact: true }).click();
  707 |     const document = (await (await opened).json()).document;
  708 |     expect(document.step === null && document.prompt.slots.length === 1 && document.prompt.staffReady === false).toBe(true);
  709 |     const consent = fixture.display.getByTestId('display-consent');
  710 |     await expect(consent).toBeVisible({ timeout: 20_000 });
  711 |     expect(document.prompt.slots.every((slot: Record<string, unknown>) => Object.keys(slot).every(key =>
  712 |       ['id', 'name', 'ageYears', 'requirement'].includes(key)))).toBe(true);
  713 |     expect(/allergies|medical|foodRestrictions|childPhotoUrl|waived|savedChildId|policy/.test(JSON.stringify(document))).toBe(false);
  714 |     await expect(consent.locator('video, canvas, input[type="file"]')).toHaveCount(0);
  715 |     for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
  716 |       await fixture.display.setViewportSize(viewport);
  717 |       expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  718 |     }
  719 |     await fixture.display.setViewportSize({ width: 1024, height: 768 });
  720 |     page.on('request', observe); fixture.display.on('request', observe);
  721 |     await consent.getByLabel('Parent / guardian name', { exact: true }).fill('Local guardian');
  722 |     for (const checkbox of await consent.getByRole('checkbox').all()) await checkbox.check();
  723 |     await page.getByLabel('Lock screen').click();
  724 |     await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  725 |     await expect(consent.getByLabel('Parent / guardian name', { exact: true })).toHaveValue('Local guardian');
  726 |     let originalGesture: { actionId: string; payload: unknown } | undefined;
  727 |     await fixture.display.route('**/api/display/session', async route => {
  728 |       if (blockRead) await route.abort('failed'); else await route.continue();
  729 |     });
  730 |     await fixture.display.route('**/api/display/intents', async route => {
  731 |       const body = route.request().postDataJSON();
  732 |       if (body.type !== 'display.consent' || body.payload.action !== 'acknowledge') { await route.continue(); return; }
  733 |       publicWrites += 1;
  734 |       if (publicWrites === 1) {
  735 |         originalGesture = { actionId: body.actionId, payload: body.payload };
  736 |         blockRead = true;
  737 |         const actual = await route.fetch();
  738 |         expect(actual.status()).toBe(200);
  739 |         await route.abort('failed');
  740 |       } else {
  741 |         expect(body.actionId === originalGesture?.actionId && JSON.stringify(body.payload) === JSON.stringify(originalGesture?.payload)).toBe(true);
  742 |         blockRead = false;
  743 |         await route.continue();
  744 |       }
  745 |     });
  746 |     await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  747 |     await expect(fixture.display.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({ timeout: 20_000 });
  748 |     await fixture.display.getByRole('button', { name: 'Retry', exact: true }).click();
  749 |     await expect.poll(() => publicWrites).toBe(2);
  750 |     await unlock(page);
  751 |     await expect(consent.getByLabel('Parent / guardian name', { exact: true })).toHaveValue('Local guardian');
  752 |     await expect(consent.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  753 |     await captureLocalCheck(fixture.display, 'ticket-display-consent-pending-local.png');
  754 | 
  755 |     // This deterministic local camera frame exercises the existing staff-only capture component.
  756 |     await page.evaluate(() => {
  757 |       const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
  758 |       const context = canvas.getContext('2d')!; context.fillStyle = '#285646'; context.fillRect(0, 0, 320, 240);
  759 |       Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => canvas.captureStream(5) });
  760 |     });
  761 |     await page.getByRole('button', { name: 'Private child details', exact: true }).click();
  762 |     const privateForm = page.getByRole('dialog', { name: 'Private child details', exact: true });
  763 |     await privateForm.getByPlaceholder(/^e.g. peanut allergy/).fill('Private local health marker');
  764 |     await privateForm.getByRole('button', { name: 'Start camera', exact: true }).click();
> 765 |     await privateForm.getByRole('button', { name: 'Take photo', exact: true }).click();
      |                                                                                ^ TimeoutError: locator.click: Timeout 20000ms exceeded.
  766 |     await expect(privateForm.getByAltText('Captured', { exact: true })).toBeVisible();
  767 |     const ready = readConsent(true);
  768 |     await privateForm.getByRole('button', { name: 'Close', exact: true }).click();
  769 |     const valid = (await (await ready).json()).document;
  770 |     expect(valid.prompt.staffReady === true && valid.prompt.consentAcknowledged === true
  771 |       && valid.prompt.confirmations.every((item: { required: boolean; acknowledged: boolean }) => !item.required || item.acknowledged)).toBe(true);
  772 |     expect(/Private local health marker|childPhotoUrl|data:image|medical|foodRestrictions|waived/.test(JSON.stringify(valid))).toBe(false);
  773 |     await expect(consent.getByRole('button', { name: 'Done', exact: true })).toBeEnabled({ timeout: 20_000 });
  774 |     const finished = readConsent(true, true);
  775 |     await consent.getByRole('button', { name: 'Done', exact: true }).click();
  776 |     await finished;
  777 |     await expect(page.getByRole('heading', { name: 'Children playing alone', exact: true })).toBeVisible();
  778 |     await expect(consent.getByText('Thank you. The team will complete the staff checks.', { exact: true })).toBeVisible();
  779 |     expect(businessWrites === 0).toBe(true);
  780 |     await captureLocalCheck(fixture.display, 'ticket-display-consent-complete-local.png');
  781 | 
  782 |     await page.getByRole('button', { name: 'Private child details', exact: true }).click();
  783 |     await privateForm.getByPlaceholder('Your full name', { exact: true }).fill('Local guardian updated');
  784 |     await privateForm.getByRole('button', { name: 'Close', exact: true }).click();
  785 |     await expect(consent.getByRole('button', { name: 'Ask the team', exact: true })).toBeVisible({ timeout: 20_000 });
  786 |     await consent.getByRole('button', { name: 'Ask the team', exact: true }).click();
  787 |     await expect(fixture.display.getByText('Please follow the staff screen.', { exact: true })).toBeVisible({ timeout: 20_000 });
  788 |     await expect(page.getByPlaceholder('Your full name', { exact: true })).toBeVisible();
  789 |     expect(businessWrites === 0).toBe(true);
  790 |   } catch (error) {
  791 |     await captureLocalCheck(page, 'consent-failure-staff-local.png').catch(() => undefined);
  792 |     throw error;
  793 |   } finally {
  794 |     blockRead = false;
  795 |     page.off('request', observe); fixture.display.off('request', observe);
  796 |     try {
  797 |       await fixture.releaseLease();
  798 |     } finally {
  799 |       try { await fixture.cleanup(); } finally { await clearStaffPage(page); }
  800 |     }
  801 |   }
  802 | });
  803 | 
  804 | test('separate display guest shop uses captured sizes, lock retention, disconnect fallback and settled cash split', async ({ page, browser, baseURL }) => {
  805 |   test.setTimeout(120_000);
  806 |   requireLocalFixture(baseURL);
  807 |   await page.goto('/');
  808 |   await signIn(page);
  809 |   const fixture = await pairedDisplay(browser, page, baseURL);
  810 |   const shopSession = (stage: string, quantity?: number, amountSatang?: number) => {
  811 |     let lastStatus: number | null = null;
  812 |     let lastStage = 'none';
  813 |     let lastSupported = false;
  814 |     return fixture.display.waitForResponse(async response => {
  815 |       if (!response.url().endsWith('/api/display/session')) return false;
  816 |       lastStatus = response.status();
  817 |       if (lastStatus !== 200) return false;
  818 |       const document = (await response.json().catch(() => null))?.document;
  819 |       lastStage = ['welcome', 'order', 'payment', 'thankyou'].includes(document?.stage) ? document.stage : 'other';
  820 |       lastSupported = document?.cart?.kind === 'merch' && document.cart.supported === true;
  821 |       return lastStage === stage && lastSupported
  822 |         && (quantity === undefined || document.cart.lines[0]?.qty === quantity)
  823 |         && (amountSatang === undefined || document.payment?.amountSatang === amountSatang);
  824 |     }).catch(() => { throw new Error(`Shop display ${stage} response missing (status=${lastStatus}, stage=${lastStage}, supported=${lastSupported})`); });
  825 |   };
  826 |   try {
  827 |     const welcome = shopSession('welcome');
  828 |     await page.getByRole('button', { name: 'Shop', exact: true }).click();
  829 |     await expect(page.getByRole('heading', { name: 'Retail Sale', exact: true })).toBeVisible();
  830 |     await welcome;
  831 |     const publicShop = fixture.display.getByTestId('display-merch');
  832 |     await expect(publicShop.getByRole('heading', { name: 'Oto Shop', exact: true })).toBeVisible({ timeout: 20_000 });
  833 |     await expect(publicShop.getByText(/wristband|credit balance|remaining credit/i)).toHaveCount(0);
  834 |     await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  835 |     await page.getByRole('button', { name: /Grip Socks/ }).click();
  836 |     const picked = shopSession('order', 1);
  837 |     await page.getByRole('dialog', { name: 'Choose size — Grip Socks', exact: true })
  838 |       .getByRole('button', { name: 'M', exact: true }).click();
  839 |     await picked;
  840 |     const quoted = page.waitForResponse(response => response.url().endsWith('/api/sales/quote')
  841 |       && response.request().method() === 'POST' && response.status() === 200
  842 |       && response.request().postDataJSON()?.items?.some((item: { quantity: number }) => item.quantity === 2));
  843 |     const doubled = shopSession('order', 2);
  844 |     await page.getByRole('button', { name: 'Add one Grip Socks', exact: true }).click();
  845 |     const quote = (await (await quoted).json()).quote;
  846 |     const document = (await (await doubled).json()).document;
  847 |     const line = document.cart.lines[0];
  848 |     const captured = Object.values(quote.itemPresentation)[0] as { name: string; basePriceSatang: number };
  849 |     expect(line.qty === 2 && line.name === captured.name && line.name.includes('Grip Socks') && line.name.includes('M')
  850 |       && Math.round(line.unitPrice * 100) === captured.basePriceSatang
  851 |       && Math.round(line.lineTotal * 100) === captured.basePriceSatang * 2
  852 |       && Math.round(document.totals.total * 100) === quote.totals.grossSatang
  853 |       && document.step === null && document.member === null && document.prompt === null).toBe(true);
  854 |     await expect(publicShop.getByTestId('merch-display-line')).toHaveCount(1);
  855 |     await expect(publicShop.getByText(line.name, { exact: true })).toBeVisible();
  856 |     await expect(publicShop.getByText(`฿${line.unitPrice} each`, { exact: true })).toBeVisible();
  857 |     await expect(publicShop.getByText(`฿${document.totals.total}`, { exact: true }).last()).toBeVisible();
  858 |     await expect(publicShop.getByText(/medical|allergy|wallet|remaining credit|stock|cost/i)).toHaveCount(0);
  859 |     for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
  860 |       await fixture.display.setViewportSize(viewport);
  861 |       expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  862 |     }
  863 |     await fixture.display.setViewportSize({ width: 1024, height: 768 });
  864 |     await captureLocalCheck(fixture.display, 'shop-display-order-local.png');
  865 | 
```