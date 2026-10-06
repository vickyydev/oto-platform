# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> separate display guardian acknowledgement retains lock and retry, while staff authorises private readiness
- Location: e2e\smoke.spec.ts:664:1

# Error details

```
TimeoutError: locator.click: Timeout 20000ms exceeded.
Call log:
  - waiting for getByLabel('Lock screen')
    - locator resolved to <button title="Lock screen" aria-label="Lock screen" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover-elevate active-elevate-2 border [border-color:var(--button-outline)] shadow-xs active:shadow-none h-9 w-9">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div data-state="open" aria-hidden="true" data-aria-hidden="true" class="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"></div> intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div data-state="open" aria-hidden="true" data-aria-hidden="true" class="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"></div> intercepts pointer events
    - retrying click action
      - waiting 100ms
    38 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <div data-state="open" aria-hidden="true" data-aria-hidden="true" class="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"></div> intercepts pointer events
     - retrying click action
       - waiting 500ms

```

# Test source

```ts
  1   | import { expect, request, test, type Browser, type Page, type Request, type Response } from '@playwright/test';
  2   | import { mkdir } from 'node:fs/promises';
  3   | import { resolve } from 'node:path';
  4   | 
  5   | const PHONE = process.env.POS_E2E_PHONE ?? '';
  6   | const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
  7   | const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
  8   | const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
  9   | const MEMBER_PHONE = '0811111111';
  10  | const STATION_NAME = 'Reception Till 1';
  11  | const signedOutPages = new WeakSet<Page>();
  12  | 
  13  | // Playwright's failure DOM attachment is unmasked even when trace/video are off.
  14  | process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  15  | test.use({ trace: 'off', video: 'off', screenshot: 'off' });
  16  | test.setTimeout(120_000);
  17  | 
  18  | function requireLocalFixture(baseURL: string | undefined): asserts baseURL is string {
  19  |   test.skip(!PHONE || !PASSWORD || !ADMIN_PHONE || !ADMIN_PASSWORD,
  20  |     'Set POS_E2E_PHONE, POS_E2E_PASSWORD, POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD');
  21  |   test.skip(!baseURL || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname),
  22  |     'This smoke flow requires a disposable seeded local API');
  23  | }
  24  | 
  25  | async function signIn(page: Page): Promise<void> {
  26  |   signedOutPages.delete(page);
  27  |   await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
  28  |   await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE)
  29  |     .catch(() => { throw new Error('The staff phone field could not be filled'); });
  30  |   await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD)
  31  |     .catch(() => { throw new Error('The staff password field could not be filled'); });
  32  |   await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  33  |   const stationPicker = page.getByRole('heading', { name: 'Which station are you on?' });
  34  |   await expect.poll(async () => (await stationPicker.isVisible())
  35  |     || (await page.getByText('Membership Check', { exact: true }).isVisible())).toBe(true);
  36  |   if (await stationPicker.isVisible()) {
  37  |     await page.getByRole('button', { name: new RegExp(STATION_NAME) }).click();
  38  |   }
  39  |   await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
  40  | }
  41  | 
  42  | async function unlock(page: Page): Promise<void> {
  43  |   await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  44  |   await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD)
  45  |     .catch(() => { throw new Error('The unlock password field could not be filled'); });
  46  |   await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  47  |   await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeHidden({ timeout: 20_000 });
  48  |   await expect(page.getByLabel('Lock screen')).toBeVisible();
  49  | }
  50  | 
  51  | async function signOut(page: Page): Promise<void> {
> 52  |   await page.getByLabel('Lock screen').click();
      |                                        ^ TimeoutError: locator.click: Timeout 20000ms exceeded.
  53  |   const completed = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-out')
  54  |     && response.request().method() === 'POST');
  55  |   await page.getByRole('button', { name: /Sign out and hand over the till/ }).click();
  56  |   expect((await completed).status()).toBe(200);
  57  |   signedOutPages.add(page);
  58  |   await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
  59  | }
  60  | 
  61  | async function clearStaffPage(page: Page): Promise<void> {
  62  |   try {
  63  |     if (!signedOutPages.has(page)) {
  64  |       const session = await page.request.get('/api/me').catch(() => null);
  65  |       if (session?.status() === 200) await page.request.post('/api/auth/sign-out').catch(() => undefined);
  66  |     }
  67  |   } finally {
  68  |     await page.goto('about:blank').catch(() => undefined);
  69  |   }
  70  | }
  71  | 
  72  | async function displayPrompt(page: Page, expectedId?: string): Promise<string> {
  73  |   const response = await page.waitForResponse(async candidate => {
  74  |     if (!candidate.url().endsWith('/api/display/session') || candidate.request().method() !== 'GET'
  75  |       || candidate.status() !== 200) return false;
  76  |     return expectedId === undefined || (await candidate.json()).document?.prompt?.requestId === expectedId;
  77  |   });
  78  |   const body = await response.json();
  79  |   expect(typeof body.document?.prompt?.requestId === 'string').toBe(true);
  80  |   return body.document.prompt.requestId;
  81  | }
  82  | 
  83  | async function typePhone(page: Page, phone: string): Promise<void> {
  84  |   for (const digit of phone) await page.getByRole('button', { name: digit, exact: true }).click();
  85  | }
  86  | 
  87  | async function captureLocalCheck(page: Page, name: string): Promise<void> {
  88  |   const directory = process.env.POS_E2E_EVIDENCE_DIR;
  89  |   if (!directory) return;
  90  |   await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll('.animate-in'))
  91  |     .filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
  92  |     .every(element => Number(getComputedStyle(element).opacity) >= 0.99)), { timeout: 5000 }).toBe(true);
  93  |   await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  94  |   await mkdir(directory, { recursive: true });
  95  |   await page.evaluate(() => {
  96  |     const stamp = document.createElement('div');
  97  |     stamp.dataset.localCheck = 'true';
  98  |     stamp.textContent = 'LOCAL CHECK';
  99  |     stamp.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 12px;background:#111;color:#fff;font:700 14px sans-serif';
  100 |     document.body.append(stamp);
  101 |   });
  102 |   try {
  103 |     await page.screenshot({ path: resolve(directory, name), fullPage: true,
  104 |       mask: [page.getByTestId('display-pairing-code'), page.locator('input[type="password"]')] });
  105 |   } finally {
  106 |     await page.locator('[data-local-check="true"]').evaluateAll(elements => elements.forEach(element => element.remove()));
  107 |   }
  108 | }
  109 | 
  110 | async function pairedDisplay(browser: Browser, staff: Page, baseURL: string) {
  111 |   const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 } });
  112 |   const display = await context.newPage();
  113 |   const admin = await request.newContext({ baseURL });
  114 |   let credentialId: string | null = null;
  115 |   let stationId: string | null = null;
  116 |   let ownLeaseId: string | null = null;
  117 |   const pendingClaims = new Set<Promise<void>>();
  118 |   const observeLease = (response: Response) => {
  119 |     if (!stationId || response.url().split('?')[0] !== new URL(`/api/stations/${stationId}/lease`, baseURL).href
  120 |       || response.request().method() !== 'POST' || response.status() !== 200) return;
  121 |     const pending = response.json().then(body => {
  122 |       if (body.document?.stationId === stationId && typeof body.lease?.leaseId === 'string') ownLeaseId = body.lease.leaseId;
  123 |     }).catch(() => undefined);
  124 |     pendingClaims.add(pending);
  125 |     void pending.finally(() => pendingClaims.delete(pending));
  126 |   };
  127 |   staff.on('response', observeLease);
  128 |   const releaseLease = async () => {
  129 |     await Promise.allSettled([...pendingClaims]);
  130 |     if (!stationId || !ownLeaseId) return;
  131 |     const response = await staff.request.post(`/api/stations/${stationId}/lease/release`, {
  132 |       data: { leaseId: ownLeaseId }, headers: { 'Idempotency-Key': `display-smoke-release-${crypto.randomUUID()}` },
  133 |     });
  134 |     expect(response.status()).toBe(200);
  135 |     ownLeaseId = null;
  136 |   };
  137 |   let revoked = false;
  138 |   const revoke = async () => {
  139 |     if (!credentialId || revoked) return;
  140 |     const response = await admin.post(`/api/credentials/${credentialId}/revoke`, {
  141 |       data: { reason: 'Local separate-display smoke cleanup' },
  142 |       headers: { 'Idempotency-Key': `display-smoke-revoke-${crypto.randomUUID()}` },
  143 |     });
  144 |     expect(response.status()).toBe(200);
  145 |     revoked = true;
  146 |   };
  147 |   const cleanup = async () => {
  148 |     let revokeFailed = false;
  149 |     try { await revoke(); } catch { revokeFailed = true; }
  150 |     // The browser-held credential never leaves this context or enters an artifact.
  151 |     await display.evaluate(async () => {
  152 |       const bearer = localStorage.getItem('oto.display.credential');
```