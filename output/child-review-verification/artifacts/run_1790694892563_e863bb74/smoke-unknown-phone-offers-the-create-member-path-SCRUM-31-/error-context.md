# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> unknown phone offers the create-member path (SCRUM-31)
- Location: e2e\smoke.spec.ts:300:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  100 |       mask: [page.getByTestId('display-pairing-code'), page.locator('input[type="password"]')] });
  101 |   } finally {
  102 |     await page.locator('[data-local-check="true"]').evaluateAll(elements => elements.forEach(element => element.remove()));
  103 |   }
  104 | }
  105 | 
  106 | async function pairedDisplay(browser: Browser, staff: Page, baseURL: string) {
  107 |   const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 } });
  108 |   const display = await context.newPage();
  109 |   const admin = await request.newContext({ baseURL });
  110 |   let credentialId: string | null = null;
  111 |   let stationId: string | null = null;
  112 |   let ownLeaseId: string | null = null;
  113 |   const pendingClaims = new Set<Promise<void>>();
  114 |   const observeLease = (response: Response) => {
  115 |     if (!stationId || response.url().split('?')[0] !== new URL(`/api/stations/${stationId}/lease`, baseURL).href
  116 |       || response.request().method() !== 'POST' || response.status() !== 200) return;
  117 |     const pending = response.json().then(body => {
  118 |       if (body.document?.stationId === stationId && typeof body.lease?.leaseId === 'string') ownLeaseId = body.lease.leaseId;
  119 |     }).catch(() => undefined);
  120 |     pendingClaims.add(pending);
  121 |     void pending.finally(() => pendingClaims.delete(pending));
  122 |   };
  123 |   staff.on('response', observeLease);
  124 |   const releaseLease = async () => {
  125 |     await Promise.allSettled([...pendingClaims]);
  126 |     if (!stationId || !ownLeaseId) return;
  127 |     const response = await staff.request.post(`/api/stations/${stationId}/lease/release`, {
  128 |       data: { leaseId: ownLeaseId }, headers: { 'Idempotency-Key': `display-smoke-release-${crypto.randomUUID()}` },
  129 |     });
  130 |     expect(response.status()).toBe(200);
  131 |     ownLeaseId = null;
  132 |   };
  133 |   let revoked = false;
  134 |   const revoke = async () => {
  135 |     if (!credentialId || revoked) return;
  136 |     const response = await admin.post(`/api/credentials/${credentialId}/revoke`, {
  137 |       data: { reason: 'Local separate-display smoke cleanup' },
  138 |       headers: { 'Idempotency-Key': `display-smoke-revoke-${crypto.randomUUID()}` },
  139 |     });
  140 |     expect(response.status()).toBe(200);
  141 |     revoked = true;
  142 |   };
  143 |   const cleanup = async () => {
  144 |     let revokeFailed = false;
  145 |     try { await revoke(); } catch { revokeFailed = true; }
  146 |     // The browser-held credential never leaves this context or enters an artifact.
  147 |     await display.evaluate(async () => {
  148 |       const bearer = localStorage.getItem('oto.display.credential');
  149 |       if (bearer) await fetch('/api/display/pairing/expire', {
  150 |         method: 'POST', credentials: 'omit',
  151 |         headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}',
  152 |       });
  153 |     }).catch(() => undefined);
  154 |     await display.goto('about:blank').catch(() => undefined);
  155 |     await context.close();
  156 |     staff.off('response', observeLease);
  157 |     await admin.post('/api/auth/sign-out').catch(() => undefined);
  158 |     await admin.dispose();
  159 |     if (revokeFailed) throw new Error('The dedicated display credential could not be revoked');
  160 |   };
  161 |   try {
  162 |     const signedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } })
  163 |       .catch(() => { throw new Error('The local setup account could not sign in'); });
  164 |     expect(signedIn.status()).toBe(200);
  165 |     const meResponse = await staff.request.get('/api/me');
  166 |     expect(meResponse.status()).toBe(200);
  167 |     const me = await meResponse.json();
  168 |     expect(typeof me.branch?.id === 'string').toBe(true);
  169 |     const linkResponse = await staff.request.get('/api/me/station/link');
  170 |     expect(linkResponse.status()).toBe(200);
  171 |     const link = await linkResponse.json();
  172 |     expect(typeof link.stationId === 'string' && typeof link.boxId === 'string' && link.offline === false).toBe(true);
  173 |     stationId = link.stationId;
  174 |     const stationResponse = await admin.get(`/api/stations/${link.stationId}`);
  175 |     expect(stationResponse.status()).toBe(200);
  176 |     const { station } = await stationResponse.json();
  177 |     expect(station.name === STATION_NAME && station.branchId === me.branch.id && station.boxId === link.boxId).toBe(true);
  178 |     const selected = await admin.put('/api/me/session/station', {
  179 |       data: { stationId: link.stationId }, headers: { 'Idempotency-Key': `display-smoke-station-${crypto.randomUUID()}` },
  180 |     });
  181 |     expect(selected.status()).toBe(200);
  182 | 
  183 |     await display.goto('/display');
  184 |     await expect(display.getByRole('heading', { name: 'Set up this display' })).toBeVisible();
  185 |     const code = await display.getByTestId('display-pairing-code').textContent();
  186 |     expect(typeof code === 'string' && /^\d{6}$/.test(code)).toBe(true);
  187 |     const publication = staff.waitForResponse(response => response.url().endsWith(`/api/stations/${link.stationId}/intents`)
  188 |       && response.request().method() === 'POST' && response.status() === 200
  189 |       && response.request().postDataJSON()?.type === 'session.publish_display').catch(() => null);
  190 |     const claimed = await admin.post(`/api/stations/${link.stationId}/displays/claim`, {
  191 |       data: { pairingCode: code, name: `Local smoke display ${crypto.randomUUID().slice(0, 8)}` },
  192 |       headers: { 'Idempotency-Key': `display-smoke-claim-${crypto.randomUUID()}` },
  193 |     }).catch(() => { throw new Error('The dedicated display pairing request failed'); });
  194 |     expect(claimed.status()).toBe(200);
  195 |     const paired = await claimed.json();
  196 |     expect(typeof paired.device?.id === 'string').toBe(true);
  197 |     credentialId = paired.device.id;
  198 |     expect(paired.station?.id === link.stationId).toBe(true);
  199 |     const published = await publication;
> 200 |     expect(published !== null).toBe(true);
      |                                ^ Error: expect(received).toBe(expected) // Object.is equality
  201 |     if (!published) throw new Error('The staff till did not publish its new display prompt');
  202 |     const payload = published.request().postDataJSON()?.payload;
  203 |     expect(payload?.stage === 'identify' && typeof payload.prompt?.requestId === 'string').toBe(true);
  204 |     await displayPrompt(display, payload.prompt.requestId);
  205 |     await expect(display.getByTestId('display-station')).toContainText(STATION_NAME, { timeout: 20_000 });
  206 |     await expect(display.getByRole('button', { name: 'Find my membership', exact: true })).toBeVisible({ timeout: 20_000 });
  207 |     await expect(staff.getByRole('button', { name: 'Find my membership', exact: true })).toHaveCount(0);
  208 |     expect((await display.request.get('/api/me')).status()).toBe(401);
  209 |     return { display, admin, revoke, releaseLease, cleanup };
  210 |   } catch (error) {
  211 |     try {
  212 |       await releaseLease();
  213 |     } finally {
  214 |       try { await cleanup(); } finally {
  215 |         await clearStaffPage(staff);
  216 |       }
  217 |     }
  218 |     throw error;
  219 |   }
  220 | }
  221 | 
  222 | // Seeded member Mali and the two saved children must survive the independent staff lock.
  223 | test('lock → sign in → membership lookup → child confirm → sign out', async ({ page, browser, baseURL }) => {
  224 |   requireLocalFixture(baseURL);
  225 |   await page.goto('/');
  226 |   await signIn(page);
  227 |   await expect(page.getByText(/Weekday pricing|Weekend pricing/).first()).toBeVisible();
  228 |   const fixture = await pairedDisplay(browser, page, baseURL);
  229 |   try {
  230 |     const originalResponse = await page.request.get('/api/members/lookup', { params: { phone: MEMBER_PHONE } });
  231 |     expect(originalResponse.status()).toBe(200);
  232 |     const original = (await originalResponse.json()).member;
  233 |     expect(original.nickname === 'Mali' && original.children?.length === 2).toBe(true);
  234 |     const originalChildIds = original.children.map((child: { id: string }) => child.id).sort();
  235 |     const promptId = await displayPrompt(fixture.display);
  236 |     await typePhone(fixture.display, MEMBER_PHONE);
  237 |     await page.getByLabel('Lock screen').click();
  238 |     await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  239 |     expect((await displayPrompt(fixture.display)) === promptId).toBe(true);
  240 |     const answered = fixture.display.waitForResponse((response) => response.url().endsWith('/api/display/intents')
  241 |       && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'display.identify');
  242 |     await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
  243 |     expect((await answered).status()).toBe(200);
  244 |     await expect(page.getByText("Who's visiting today?", { exact: true })).toHaveCount(0);
  245 |     const lookup = page.waitForResponse((response) => response.url().includes('/api/members/lookup?') && response.status() === 200);
  246 |     await unlock(page);
  247 |     const found = (await (await lookup).json()).member;
  248 |     expect(found.id === original.id && JSON.stringify(found.children.map((child: { id: string }) => child.id).sort())
  249 |       === JSON.stringify(originalChildIds)).toBe(true);
  250 |     await expect(page.getByText("Who's visiting today?", { exact: true })).toBeVisible({ timeout: 20_000 });
  251 |     const childrenDialog = page.getByRole('dialog');
  252 |     await expect(childrenDialog.getByText('Nong Ploy', { exact: true })).toBeVisible();
  253 |     await expect(childrenDialog.getByText('Nong Tan', { exact: true })).toBeVisible();
  254 |     await expect(fixture.display.getByText('Nong Ploy', { exact: true })).toHaveCount(0);
  255 |     await expect(fixture.display.getByText('Nong Tan', { exact: true })).toHaveCount(0);
  256 |     const details = childrenDialog.getByRole('button', { name: /^Details/ });
  257 |     await expect(details).toHaveCount(2);
  258 |     for (const button of await details.all()) {
  259 |       if (await button.getAttribute('aria-expanded') === 'true') await button.click();
  260 |     }
  261 |     await expect(childrenDialog.getByText('Nong Ploy', { exact: true })).toBeInViewport();
  262 |     await expect(childrenDialog.getByText('Nong Tan', { exact: true })).toBeInViewport();
  263 |     await expect(childrenDialog.getByRole('button', { name: /Confirm 2 children/ })).toBeInViewport();
  264 |     await captureLocalCheck(page, 'ticket-children-local.png');
  265 |     await page.getByRole('button', { name: /Confirm 2 children/ }).click();
  266 |     await expect(page.getByText('Visit confirmed', { exact: true })).toBeVisible({ timeout: 20_000 });
  267 |     await expect(page.getByText('Thai · verified')).toBeVisible();
  268 |     await expect(fixture.display.getByRole('heading', { name: 'Welcome back, Mali!', exact: true })).toBeVisible({ timeout: 20_000 });
  269 |     await captureLocalCheck(fixture.display, 'ticket-display-welcome-local.png');
  270 |     await page.getByLabel('Lock screen').click();
  271 |     await unlock(page);
  272 |     await expect(page.getByRole('heading', { name: 'Select Customer Type', exact: true })).toBeVisible();
  273 |     await expect(page.getByText('Mali', { exact: true }).first()).toBeVisible();
  274 |     await expect(page.getByText('Thai · verified')).toBeVisible();
  275 |     await signOut(page);
  276 |     await fixture.display.reload();
  277 |     await expect(fixture.display.getByTestId('display-station')).toContainText(STATION_NAME, { timeout: 20_000 });
  278 |     await signIn(page);
  279 |     const rejected = fixture.display.waitForResponse((response) => response.url().endsWith('/api/display/session') && response.status() === 401);
  280 |     await fixture.revoke();
  281 |     expect((await rejected).status()).toBe(401);
  282 |     await expect(fixture.display.getByRole('heading', { name: 'Set up this display' })).toBeVisible({ timeout: 20_000 });
  283 |     await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
  284 |     await signOut(page);
  285 |   } finally {
  286 |     try {
  287 |       if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
  288 |       if (await page.getByLabel('Lock screen').isVisible()) {
  289 |         await fixture.releaseLease();
  290 |         await signOut(page);
  291 |       }
  292 |     } finally {
  293 |       try { await fixture.cleanup(); } finally {
  294 |         await clearStaffPage(page);
  295 |       }
  296 |     }
  297 |   }
  298 | });
  299 | 
  300 | test('unknown phone offers the create-member path (SCRUM-31)', async ({ page, browser, baseURL }) => {
```