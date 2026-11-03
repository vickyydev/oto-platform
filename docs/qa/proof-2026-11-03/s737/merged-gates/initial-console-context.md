# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-state-review.spec.ts >> AUDIT: late booth A version history cannot replace selected booth B history
- Location: e2e\page-state-review.spec.ts:9:1

# Error details

```
Error: route.fulfill: Route is already handled!
```

# Test source

```ts
  1   | import { expect, test, type Page } from '@playwright/test';
  2   | import { signInAndWait } from './console';
  3   |
  4   | const secondId = '018f1d2c-0000-7000-8000-000000009998';
  5   | const version = (note: string, number: number) => ({ id: `018f1d2c-0000-7000-8000-${String(number).padStart(12, '0')}`,
  6   |   version: number, publishedAt: '2026-10-28T10:00:00.000Z', bundleHash: '0123456789abcdef', note, publishedByAccountId: null });
  7   | const frames = async (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  8   |
  9   | test('AUDIT: late booth A version history cannot replace selected booth B history', async ({ page }) => {
  10  |   let firstId = '';
  11  |   let armed = false;
  12  |   let heldRequests = 0;
  13  |   let release!: () => void;
  14  |   let answered!: () => void;
  15  |   const waiting = new Promise<void>(resolve => { release = resolve; });
  16  |   const completed = new Promise<void>(resolve => { answered = resolve; });
  17  |   await page.route(/\/api\/branches\/[^/]+\/booths(?:\?|$)/, async route => {
  18  |     const response = await route.fetch();
  19  |     const body = await response.json();
  20  |     expect(body.booths.length).toBeGreaterThan(0);
  21  |     firstId = body.booths[0].id;
  22  |     await route.fulfill({ response, json: { ...body, booths: [body.booths[0], { ...body.booths[0], id: secondId, name: 'ZZ TEST Audit second booth' }] } });
  23  |   });
  24  |   await page.route(new RegExp(`/api/booths/${secondId}/`), async route => {
  25  |     const response = await route.fetch({ url: route.request().url().replace(secondId, firstId) });
  26  |     if (!response.headers()['content-type']?.includes('json')) return route.fulfill({ response });
  27  |     const body = await response.json();
> 28  |     await route.fulfill({ response, json: body.booth ? { ...body, booth: { ...body.booth, id: secondId, name: 'ZZ TEST Audit second booth' } } : body });
      |                 ^ Error: route.fulfill: Route is already handled!
  29  |   });
  30  |   await page.route(/\/api\/booths\/[^/]+\/versions(?:\?|$)/, async route => {
  31  |     const target = new URL(route.request().url()).pathname.split('/').at(-2);
  32  |     if (target === secondId) return route.fulfill({ json: { versions: [version('ZZ TEST Current booth history', 2)] } });
  33  |     if (armed) {
  34  |       heldRequests++;
  35  |       await waiting;
  36  |       await route.fulfill({ json: { versions: [version('ZZ TEST Previous booth late history', 1)] } });
  37  |       answered();
  38  |       return;
  39  |     }
  40  |     await route.fulfill({ json: { versions: [version('ZZ TEST Initial booth history', 1)] } });
  41  |   });
  42  |   await signInAndWait(page);
  43  |   await page.goto('/devices/booths');
  44  |   await expect(page.getByText(/ZZ TEST Initial booth history/)).toBeVisible();
  45  |   armed = true;
  46  |   await page.locator('header').getByRole('button', { name: 'Refresh', exact: true }).click();
  47  |   await expect.poll(() => heldRequests).toBeGreaterThan(0);
  48  |   try {
  49  |     await page.getByRole('group', { name: 'Booth', exact: true }).getByRole('button', { name: /ZZ TEST Audit second booth/ }).click();
  50  |     await expect(page.getByText(/ZZ TEST Current booth history/)).toBeVisible();
  51  |     release();
  52  |     await completed;
  53  |     await frames(page);
  54  |     await expect(page.getByText(/ZZ TEST Current booth history/)).toBeVisible();
  55  |     await expect(page.getByText(/ZZ TEST Previous booth late history/)).toHaveCount(0);
  56  |   } finally {
  57  |     release();
  58  |     // The booth panels also fetch their own records. Let those forwarded
  59  |     // responses finish before Playwright disposes this test's request context.
  60  |     await page.unrouteAll({ behavior: 'wait' });
  61  |   }
  62  | });
  63  |
  64  | test('AUDIT: a real missing booth404 keeps the native resource reason instead of claiming an undeployed route', async ({ page }) => {
  65  |   await page.route(/\/api\/booths\/[^/]+\/draft(?:\?|$)/, route => route.fulfill({ status: 404,
  66  |     json: { error: { code: 'BOOTH_NOT_FOUND', message: 'No booth with that id' } } }));
  67  |   await signInAndWait(page);
  68  |   await page.goto('/devices/booths');
  69  |   // The GET exists; its selected record is missing. This is the actual native service reason.
  70  |   await expect(page.getByText('No booth with that id', { exact: false }).first()).toBeVisible();
  71  |   await expect(page.getByText(/The draft route is not deployed here yet/)).toHaveCount(0);
  72  | });
  73  |
  74  | test('AUDIT: shrinking voucher data does not show an impossible current-page range', async ({ page }) => {
  75  |   const row = (n: number) => ({ id: `018f1d2c-0000-7000-8000-${String(2000 + n).padStart(12, '0')}`,
  76  |     issuedAt: '2026-10-28T10:00:00.000Z', businessDate: '2026-10-28', type: { id: '018f1d2c-0000-7000-8000-000000001999', code: 'audit-type', nameEn: 'ZZ TEST Audit voucher', nameTh: null, kind: 'amount' },
  77  |     prize: null, value: { kind: 'money', text: '100 THB', redeemedSatang: null }, place: { kind: 'counter', stationId: null, name: 'Counter' },
  78  |     issuedBy: null, codeLast4: '0000', source: 'counter', status: 'issued', printCount: 0, expiresAt: null, redeemed: null });
  79  |   await page.route(/\/api\/vouchers\?/, route => {
  80  |     const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0);
  81  |     return route.fulfill({ json: { range: { from: '2026-10-28', to: '2026-10-28' },
  82  |       total: offset ? 1 : 51, rows: offset ? [] : Array.from({ length: 50 }, (_, n) => row(n)), totals: [] } });
  83  |   });
  84  |   await signInAndWait(page);
  85  |   await page.goto('/catalogue/vouchers');
  86  |   await expect(page.getByText('1–50 of 51', { exact: true })).toBeVisible();
  87  |   await page.getByRole('button', { name: 'Next', exact: true }).click();
  88  |   await expect(page.getByText('No matching vouchers', { exact: true })).toBeVisible();
  89  |   await expect(page.getByText('51–50 of 1', { exact: true })).toHaveCount(0);
  90  | });
  91  |
  92  | test('AUDIT: choosing another park hides the previous park fleet while its own read is pending', async ({ page }) => {
  93  |   let parks: { id: string; name: string }[] = [];
  94  |   let parksLoaded!: () => void;
  95  |   const parksReady = new Promise<void>(resolve => { parksLoaded = resolve; });
  96  |   let firstBoxName = '';
  97  |   let held = false;
  98  |   let release!: () => void;
  99  |   let answered!: () => void;
  100 |   const waiting = new Promise<void>(resolve => { release = resolve; });
  101 |   const completed = new Promise<void>(resolve => { answered = resolve; });
  102 |   await page.route(/\/api\/branches\/?(?:\?|$)/, async route => {
  103 |     const response = await route.fetch();
  104 |     const body = await response.json();
  105 |     parks = body.branches.filter((branch: { archived: boolean }) => !branch.archived);
  106 |     parksLoaded();
  107 |     await route.fulfill({ response, json: body });
  108 |   });
  109 |   await page.route(/\/api\/branches\/[^/]+\/boxes(?:\?|$)/, async route => {
  110 |     // Fleet can answer before directory metadata; name its fixture before the switch.
  111 |     await parksReady;
  112 |     const id = new URL(route.request().url()).pathname.split('/').at(-2);
  113 |     if (id === parks[1]?.id) { held = true; await waiting; }
  114 |     const response = await route.fetch();
  115 |     const body = await response.json();
  116 |     if (id === parks[0]?.id) {
  117 |       expect(body.boxes.length).toBeGreaterThan(0);
  118 |       firstBoxName = 'ZZ TEST Original park fleet';
  119 |       body.boxes[0].name = firstBoxName;
  120 |     }
  121 |     await route.fulfill({ response, json: body });
  122 |     if (id === parks[1]?.id) answered();
  123 |   });
  124 |   await signInAndWait(page);
  125 |   await page.goto('/devices');
  126 |   await expect.poll(() => parks.length).toBeGreaterThan(1);
  127 |   const picker = page.getByLabel('Branch');
  128 |   if (await picker.inputValue() !== parks[0]!.id) await picker.selectOption(parks[0]!.id);
```