import { expect, test, type Page } from '@playwright/test';

const OPERATOR = '01968210-0000-7000-8000-000000000001';
const ACTOR = '01968210-0000-7000-8000-000000000002';
const SESSION = '01968210-0000-7000-8000-000000000003';
const REFERENCE = 'zz-test-support-request-682';
const PRIVATE_DETAIL = 'ZZ_TEST_PRIVATE_SUPPORT_DETAIL';
type ReadKind = 'lookup' | 'trace';

/** The built App/session/transport runs unchanged; every API reply is synthetic and local. */
async function fixture(page: Page, kind: ReadKind, status: 429 | 500 | 404) {
  const reads: Array<{ path: string; query: Record<string, string> }> = [];
  const writes: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { Object.assign(window, { __supportReference: value }); },
    } });
  });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.slice(4).replace(/\/$/, '');
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_NO_WRITES', message: 'Read-only fixture.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false },
      employee: { id: ACTOR, name: 'ZZ TEST Support reviewer', nickname: null },
      branch: null, isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
      operatorContext: { sessionId: SESSION, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
        operatorOverride: null, revision: 0, branchId: null, stationId: null },
      impersonation: null, impersonating: [],
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', 'console:support:lookup', 'console:support:trace',
    ].map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/ops/health') return route.fulfill({ json: {
      generatedAt: '2026-10-29T00:00:00.000Z', overallStatus: 'ok', alerts: [], boxes: [], checks: [],
    } });
    if (path === `/console/support/${kind}`) {
      reads.push({ path, query: Object.fromEntries(url.searchParams) });
      return route.fulfill({ status, headers: {
        'x-request-id': REFERENCE, ...(status === 429 ? { 'retry-after': '2' } : {}),
      }, json: { error: {
        code: status === 429 ? 'RATE_LIMITED' : status === 404 ? 'TRACE_NOT_FOUND' : 'INTERNAL',
        message: status === 429 ? 'Too many requests' : status === 404 ? 'No trace with that key' : PRIVATE_DETAIL,
        details: { internal: PRIVATE_DETAIL, received: PRIVATE_DETAIL },
      } } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Outside this read fixture.' } } });
  });
  return { reads, writes };
}

async function read(page: Page, kind: ReadKind) {
  await page.goto('/watch/support');
  const input = page.getByRole('textbox', { name: kind === 'lookup' ? 'Search' : 'Id or number', exact: true });
  await expect(input).toBeVisible();
  await input.fill('ZZ TEST retained support key');
  await page.getByRole('button', { name: kind === 'lookup' ? 'Search' : 'Trace', exact: true }).click();
  return input;
}

async function expectReference(page: Page) {
  await expect(page.getByText(REFERENCE, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy reference', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __supportReference?: string }).__supportReference === 'zz-test-support-request-682')).toBe(true);
  await expect(page.locator('body')).not.toContainText(PRIVATE_DETAIL);
}

for (const kind of ['lookup', 'trace'] as const) {
  test(`${kind} keeps a native rate-limit wait and safe request reference without exposing private details`, async ({ page }) => {
    const state = await fixture(page, kind, 429);
    const input = await read(page, kind);
    await expect(page.getByText('Too many requests. Wait 2 seconds before trying again.', { exact: true })).toBeVisible();
    await expectReference(page);
    await expect(input).toHaveValue('ZZ TEST retained support key');
    expect(state.reads).toEqual([{ path: `/console/support/${kind}`, query: kind === 'lookup'
      ? { q: 'ZZ TEST retained support key' } : { id: 'ZZ TEST retained support key', kind: 'action' } }]);
    expect(state.writes).toEqual([]);
  });

  test(`${kind} keeps a safe reference on an unexpected server error and never renders its raw message`, async ({ page }) => {
    const state = await fixture(page, kind, 500);
    await read(page, kind);
    await expect(page.getByText(/could not be loaded because the service had a problem|service returned an unexpected error/)).toBeVisible();
    await expectReference(page);
    expect(state.reads).toHaveLength(1);
    expect(state.writes).toEqual([]);
  });
}

test('a missing trace retains the established park-group wording and its safe request reference', async ({ page }) => {
  const state = await fixture(page, 'trace', 404);
  await read(page, 'trace');
  await expect(page.getByText(/Nothing in this park group carries that key\./)).toBeVisible();
  await expectReference(page);
  await expect(page.locator('body')).not.toContainText('not available on this deployment');
  expect(state.reads).toHaveLength(1);
  expect(state.writes).toEqual([]);
});
