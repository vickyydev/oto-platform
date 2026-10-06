# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> separate display guest shop uses captured sizes, lock retention, disconnect fallback and settled cash split
- Location: e2e\smoke.spec.ts:801:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
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
  153 |       if (bearer) await fetch('/api/display/pairing/expire', {
  154 |         method: 'POST', credentials: 'omit',
  155 |         headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}',
  156 |       });
  157 |     }).catch(() => undefined);
  158 |     await display.goto('about:blank').catch(() => undefined);
  159 |     await context.close();
  160 |     staff.off('response', observeLease);
  161 |     await admin.post('/api/auth/sign-out').catch(() => undefined);
  162 |     await admin.dispose();
  163 |     if (revokeFailed) throw new Error('The dedicated display credential could not be revoked');
  164 |   };
  165 |   try {
  166 |     const signedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } })
  167 |       .catch(() => { throw new Error('The local setup account could not sign in'); });
  168 |     expect(signedIn.status()).toBe(200);
  169 |     const meResponse = await staff.request.get('/api/me');
  170 |     expect(meResponse.status()).toBe(200);
  171 |     const me = await meResponse.json();
  172 |     expect(typeof me.branch?.id === 'string').toBe(true);
  173 |     const linkResponse = await staff.request.get('/api/me/station/link');
  174 |     expect(linkResponse.status()).toBe(200);
  175 |     const link = await linkResponse.json();
  176 |     expect(typeof link.stationId === 'string' && typeof link.boxId === 'string' && link.offline === false).toBe(true);
  177 |     stationId = link.stationId;
  178 |     const stationResponse = await admin.get(`/api/stations/${link.stationId}`);
  179 |     expect(stationResponse.status()).toBe(200);
  180 |     const { station } = await stationResponse.json();
  181 |     expect(station.name === STATION_NAME && station.branchId === me.branch.id && station.boxId === link.boxId).toBe(true);
  182 |     const selected = await admin.put('/api/me/session/station', {
  183 |       data: { stationId: link.stationId }, headers: { 'Idempotency-Key': `display-smoke-station-${crypto.randomUUID()}` },
  184 |     });
  185 |     expect(selected.status()).toBe(200);
  186 | 
  187 |     await display.goto('/display');
  188 |     await expect(display.getByRole('heading', { name: 'Set up this display' })).toBeVisible();
  189 |     const code = await display.getByTestId('display-pairing-code').textContent();
  190 |     expect(typeof code === 'string' && /^\d{6}$/.test(code)).toBe(true);
  191 |     const publication = staff.waitForResponse(response => response.url().endsWith(`/api/stations/${link.stationId}/intents`)
  192 |       && response.request().method() === 'POST' && response.status() === 200
  193 |       && response.request().postDataJSON()?.type === 'session.publish_display').catch(() => null);
  194 |     const claimed = await admin.post(`/api/stations/${link.stationId}/displays/claim`, {
  195 |       data: { pairingCode: code, name: `Local smoke display ${crypto.randomUUID().slice(0, 8)}` },
  196 |       headers: { 'Idempotency-Key': `display-smoke-claim-${crypto.randomUUID()}` },
  197 |     }).catch(() => { throw new Error('The dedicated display pairing request failed'); });
  198 |     expect(claimed.status()).toBe(200);
  199 |     const paired = await claimed.json();
  200 |     expect(typeof paired.device?.id === 'string').toBe(true);
  201 |     credentialId = paired.device.id;
  202 |     expect(paired.station?.id === link.stationId).toBe(true);
  203 |     const published = await publication;
> 204 |     expect(published !== null).toBe(true);
      |                                ^ Error: expect(received).toBe(expected) // Object.is equality
  205 |     if (!published) throw new Error('The staff till did not publish its new display prompt');
  206 |     const payload = published.request().postDataJSON()?.payload;
  207 |     expect(payload?.stage === 'identify' && typeof payload.prompt?.requestId === 'string').toBe(true);
  208 |     await displayPrompt(display, payload.prompt.requestId);
  209 |     await expect(display.getByTestId('display-station')).toContainText(STATION_NAME, { timeout: 20_000 });
  210 |     await expect(display.getByRole('button', { name: 'Find my membership', exact: true })).toBeVisible({ timeout: 20_000 });
  211 |     await expect(staff.getByRole('button', { name: 'Find my membership', exact: true })).toHaveCount(0);
  212 |     expect((await display.request.get('/api/me')).status()).toBe(401);
  213 |     return { display, admin, revoke, releaseLease, cleanup };
  214 |   } catch (error) {
  215 |     try {
  216 |       await releaseLease();
  217 |     } finally {
  218 |       try { await cleanup(); } finally {
  219 |         await clearStaffPage(staff);
  220 |       }
  221 |     }
  222 |     throw error;
  223 |   }
  224 | }
  225 | 
  226 | // Seeded member Mali and the two saved children must survive the independent staff lock.
  227 | test('lock → sign in → membership lookup → child confirm → sign out', async ({ page, browser, baseURL }) => {
  228 |   requireLocalFixture(baseURL);
  229 |   await page.goto('/');
  230 |   await signIn(page);
  231 |   await expect(page.getByText(/Weekday pricing|Weekend pricing/).first()).toBeVisible();
  232 |   const fixture = await pairedDisplay(browser, page, baseURL);
  233 |   try {
  234 |     const originalResponse = await page.request.get('/api/members/lookup', { params: { phone: MEMBER_PHONE } });
  235 |     expect(originalResponse.status()).toBe(200);
  236 |     const original = (await originalResponse.json()).member;
  237 |     expect(original.nickname === 'Mali' && original.children?.length === 2).toBe(true);
  238 |     const originalChildIds = original.children.map((child: { id: string }) => child.id).sort();
  239 |     const promptId = await displayPrompt(fixture.display);
  240 |     await typePhone(fixture.display, MEMBER_PHONE);
  241 |     await page.getByLabel('Lock screen').click();
  242 |     await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  243 |     expect((await displayPrompt(fixture.display)) === promptId).toBe(true);
  244 |     const answered = fixture.display.waitForResponse((response) => response.url().endsWith('/api/display/intents')
  245 |       && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'display.identify');
  246 |     await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
  247 |     expect((await answered).status()).toBe(200);
  248 |     await expect(page.getByText("Who's visiting today?", { exact: true })).toHaveCount(0);
  249 |     const lookup = page.waitForResponse((response) => response.url().includes('/api/members/lookup?') && response.status() === 200);
  250 |     await unlock(page);
  251 |     const found = (await (await lookup).json()).member;
  252 |     expect(found.id === original.id && JSON.stringify(found.children.map((child: { id: string }) => child.id).sort())
  253 |       === JSON.stringify(originalChildIds)).toBe(true);
  254 |     await expect(page.getByText("Who's visiting today?", { exact: true })).toBeVisible({ timeout: 20_000 });
  255 |     const childrenDialog = page.getByRole('dialog');
  256 |     await expect(childrenDialog.getByText('Nong Ploy', { exact: true })).toBeVisible();
  257 |     await expect(childrenDialog.getByText('Nong Tan', { exact: true })).toBeVisible();
  258 |     await expect(fixture.display.getByText('Nong Ploy', { exact: true })).toHaveCount(0);
  259 |     await expect(fixture.display.getByText('Nong Tan', { exact: true })).toHaveCount(0);
  260 |     const details = childrenDialog.getByRole('button', { name: /^Details/ });
  261 |     await expect(details).toHaveCount(2);
  262 |     for (const button of await details.all()) {
  263 |       if (await button.getAttribute('aria-expanded') === 'true') await button.click();
  264 |     }
  265 |     await expect(childrenDialog.getByText('Nong Ploy', { exact: true })).toBeInViewport();
  266 |     await expect(childrenDialog.getByText('Nong Tan', { exact: true })).toBeInViewport();
  267 |     await expect(childrenDialog.getByRole('button', { name: /Confirm 2 children/ })).toBeInViewport();
  268 |     await captureLocalCheck(page, 'ticket-children-local.png');
  269 |     await page.getByRole('button', { name: /Confirm 2 children/ }).click();
  270 |     await expect(page.getByText('Visit confirmed', { exact: true })).toBeVisible({ timeout: 20_000 });
  271 |     await expect(page.getByText('Thai · verified')).toBeVisible();
  272 |     await expect(fixture.display.getByRole('heading', { name: 'Welcome back, Mali!', exact: true })).toBeVisible({ timeout: 20_000 });
  273 |     await captureLocalCheck(fixture.display, 'ticket-display-welcome-local.png');
  274 |     await page.getByLabel('Lock screen').click();
  275 |     await unlock(page);
  276 |     await expect(page.getByRole('heading', { name: 'Select Customer Type', exact: true })).toBeVisible();
  277 |     await expect(page.getByText('Mali', { exact: true }).first()).toBeVisible();
  278 |     await expect(page.getByText('Thai · verified')).toBeVisible();
  279 |     await signOut(page);
  280 |     await fixture.display.reload();
  281 |     await expect(fixture.display.getByTestId('display-station')).toContainText(STATION_NAME, { timeout: 20_000 });
  282 |     await signIn(page);
  283 |     const rejected = fixture.display.waitForResponse((response) => response.url().endsWith('/api/display/session') && response.status() === 401);
  284 |     await fixture.revoke();
  285 |     expect((await rejected).status()).toBe(401);
  286 |     await expect(fixture.display.getByRole('heading', { name: 'Set up this display' })).toBeVisible({ timeout: 20_000 });
  287 |     await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
  288 |     await signOut(page);
  289 |   } finally {
  290 |     try {
  291 |       if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
  292 |       if (await page.getByLabel('Lock screen').isVisible()) {
  293 |         await fixture.releaseLease();
  294 |         await signOut(page);
  295 |       }
  296 |     } finally {
  297 |       try { await fixture.cleanup(); } finally {
  298 |         await clearStaffPage(page);
  299 |       }
  300 |     }
  301 |   }
  302 | });
  303 | 
  304 | test('unknown phone offers the create-member path (SCRUM-31)', async ({ page, browser, baseURL }) => {
```