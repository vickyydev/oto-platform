# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> separate display saved-child review persists before Done and retries a lost save reply
- Location: e2e\smoke.spec.ts:357:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('display-child-review')
Expected: visible
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByTestId('display-child-review') with timeout 20000ms
  - waiting for getByTestId('display-child-review')

```

```yaml
- text: Reception Till 1 · Local smoke display 1afdec1d
- button "Change language": English
- text: Customer Mali Your turn
- heading "Enter your details" [level=2]
- paragraph: For membership & so we can reach you
- text: Phone Number
- button "Select country code": 🇹🇭 +66
- text: 8X XXX XXXX
- button "1"
- button "2"
- button "3"
- button "4"
- button "5"
- button "6"
- button "7"
- button "8"
- button "9"
- button "Clear"
- button "0"
- button "Backspace"
- button "WhatsApp"
- button "Telegram"
- button "LINE"
- text: Nickname
- textbox "e.g. Mama, John"
- button "Done"
```

# Test source

```ts
  296 |     }
  297 |   }
  298 | });
  299 | 
  300 | test('unknown phone offers the create-member path (SCRUM-31)', async ({ page, browser, baseURL }) => {
  301 |   requireLocalFixture(baseURL);
  302 |   await page.goto('/');
  303 |   await signIn(page);
  304 |   const fixture = await pairedDisplay(browser, page, baseURL);
  305 |   let createdMemberId: string | null = null;
  306 |   try {
  307 |     await captureLocalCheck(fixture.display, 'ticket-fresh-display-local.png');
  308 |     const unknown = `06${String(Math.floor(10000000 + Math.random() * 89999999))}`;
  309 |     const expectedPhone = `+66${unknown.slice(1)}`;
  310 |     await typePhone(fixture.display, unknown.slice(1));
  311 |     const answered = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
  312 |       && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'display.identify');
  313 |     const lookup = page.waitForResponse(response => response.url().includes('/api/members/lookup?')
  314 |       && response.request().method() === 'GET').catch(() => null);
  315 |     await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
  316 |     const answer = await answered;
  317 |     expect(answer.status()).toBe(200);
  318 |     expect(answer.request().postDataJSON()?.payload?.phone === expectedPhone).toBe(true);
  319 |     const lookedUp = await lookup;
  320 |     expect(lookedUp?.status() === 200).toBe(true);
  321 |     if (!lookedUp) throw new Error('The staff till did not look up the entered phone');
  322 |     expect(new URL(lookedUp.url()).searchParams.get('phone') === expectedPhone).toBe(true);
  323 |     expect((await lookedUp.json()).member === null).toBe(true);
  324 |     await expect(page.getByText('New member?', { exact: true })).toBeVisible({ timeout: 20_000 });
  325 |     await page.getByPlaceholder('e.g. Mali').fill('Smoke visitor');
  326 |     const created = page.waitForResponse((response) => response.url().endsWith('/api/members') && response.request().method() === 'POST');
  327 |     await page.getByRole('button', { name: 'Create member', exact: true }).click();
  328 |     const response = await created;
  329 |     expect(response.ok()).toBe(true);
  330 |     const member = (await response.json()).member;
  331 |     expect(typeof member?.id === 'string').toBe(true);
  332 |     createdMemberId = member.id;
  333 |     expect(member.nickname === 'Smoke visitor').toBe(true);
  334 |     await expect(page.getByText('Member created', { exact: true })).toBeVisible({ timeout: 20_000 });
  335 |     await signOut(page);
  336 |   } finally {
  337 |     try {
  338 |       if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
  339 |       if (await page.getByLabel('Lock screen').isVisible()) {
  340 |         await fixture.releaseLease();
  341 |         await signOut(page);
  342 |       }
  343 |       if (createdMemberId) {
  344 |         const archived = await fixture.admin.delete(`/api/members/${createdMemberId}`, {
  345 |           headers: { 'Idempotency-Key': `display-smoke-member-cleanup-${crypto.randomUUID()}` },
  346 |         });
  347 |         expect(archived.ok()).toBe(true);
  348 |       }
  349 |     } finally {
  350 |       try { await fixture.cleanup(); } finally {
  351 |         await clearStaffPage(page);
  352 |       }
  353 |     }
  354 |   }
  355 | });
  356 | 
  357 | test('separate display saved-child review persists before Done and retries a lost save reply', async ({ page, browser, baseURL }) => {
  358 |   test.setTimeout(120_000);
  359 |   requireLocalFixture(baseURL);
  360 |   await page.goto('/');
  361 |   await signIn(page);
  362 |   const fixture = await pairedDisplay(browser, page, baseURL);
  363 |   let releaseLostReply: (() => void) | undefined;
  364 |   let restoredChild: { id: string; name: string; dateOfBirth: string | null; ageYears: number | null } | undefined;
  365 |   let unrelatedWrites = 0;
  366 |   const observeReviewWrite = (request: Request) => {
  367 |     if (request.method() !== 'POST') return;
  368 |     const pathname = new URL(request.url()).pathname;
  369 |     if (/^\/api\/(sales?|payments|children|check-?ins?|visits|checkout)(\/|$)/.test(pathname)
  370 |       || /^\/api\/members\/[^/]+\/children(\/|$)/.test(pathname)) unrelatedWrites += 1;
  371 |   };
  372 |   try {
  373 |     const lookup = page.waitForResponse(response => response.url().includes('/api/members/lookup?') && response.status() === 200);
  374 |     await typePhone(fixture.display, MEMBER_PHONE);
  375 |     await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
  376 |     const original = (await (await lookup).json()).member;
  377 |     expect(Array.isArray(original?.children) && original.children.length === 2).toBe(true);
  378 |     await expect(page.getByText("Who's visiting today?", { exact: true })).toBeVisible({ timeout: 20_000 });
  379 |     for (const button of await page.getByRole('dialog').getByRole('button', { name: /^Details/ }).all()) {
  380 |       if (await button.getAttribute('aria-expanded') === 'true') await button.click();
  381 |     }
  382 |     await page.getByRole('button', { name: /Confirm 2 children/ }).click();
  383 |     await expect(page.getByText('Visit confirmed', { exact: true })).toBeVisible();
  384 |     await page.getByRole('heading', { name: 'Thai', exact: true }).click();
  385 |     await page.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
  386 |     await page.getByRole('button', { name: 'Remove one Adults', exact: true }).first().click();
  387 |     await page.getByRole('button', { name: 'Add one Kids', exact: true }).first().click();
  388 |     const publishedReview = fixture.display.waitForResponse(async response => response.url().endsWith('/api/display/session')
  389 |       && response.status() === 200 && (await response.json()).document?.prompt?.kind === 'child_review');
  390 |     await page.getByRole('button', { name: 'Continue', exact: true }).click();
  391 |     const prompt = (await (await publishedReview).json()).document.prompt;
  392 |     expect(prompt.slots?.length === 2 && prompt.choices?.length === 2 && prompt.save?.status === 'idle').toBe(true);
  393 |     expect(prompt.slots.every((slot: Record<string, unknown>) => Object.keys(slot).every(key =>
  394 |       ['id', 'savedChildId', 'name', 'dateOfBirth', 'ageYears', 'confirmed'].includes(key)))).toBe(true);
  395 |     const review = fixture.display.getByTestId('display-child-review');
> 396 |     await expect(review).toBeVisible({ timeout: 20_000 });
      |                          ^ Error: expect(locator).toBeVisible() failed
  397 |     page.on('request', observeReviewWrite);
  398 |     fixture.display.on('request', observeReviewWrite);
  399 |     for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
  400 |       await fixture.display.setViewportSize(viewport);
  401 |       expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  402 |     }
  403 |     await fixture.display.setViewportSize({ width: 1024, height: 768 });
  404 |     await expect(review.getByText(/allergies|medical|dietary|food|photo|waiver/i)).toHaveCount(0);
  405 |     await expect(review.locator('video, canvas, input[type="file"]')).toHaveCount(0);
  406 |     const cards = review.getByTestId('saved-child-review-card');
  407 |     const firstName = review.getByLabel('Child 1 name', { exact: true });
  408 |     const secondName = review.getByLabel('Child 2 name', { exact: true });
  409 |     const childId = prompt.slots[0].savedChildId;
  410 |     const initialChild = original.children.find((child: { id: string }) => child.id === childId);
  411 |     expect(typeof childId === 'string' && initialChild !== undefined).toBe(true);
  412 |     restoredChild = { id: childId, name: initialChild.name, dateOfBirth: initialChild.dateOfBirth, ageYears: initialChild.ageYears };
  413 | 
  414 |     // A declared saved profile is explicitly selected; the other slot's draft survives its acknowledgement.
  415 |     await secondName.fill('Other child local draft');
  416 |     const selected = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
  417 |       && response.request().postDataJSON()?.payload?.action === 'select');
  418 |     await review.getByLabel('Child 1 saved profile', { exact: true }).selectOption(childId);
  419 |     expect((await selected).status()).toBe(200);
  420 |     await expect(firstName).toBeEnabled({ timeout: 20_000 });
  421 |     await expect(secondName).toHaveValue('Other child local draft');
  422 |     await firstName.fill('Local child correction');
  423 |     await cards.first().getByRole('button', { name: /yrs/ }).click();
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
  469 |     releaseLostReply();
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
```