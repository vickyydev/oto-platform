import { expect, test, type Page } from '@playwright/test';
import { openSection, signInAndWait } from './console';

/**
 * A read that failed is not a finding (SCRUM-474).
 *
 * The redesign gave every empty list an all-clear — a green tick, "Nothing
 * needs you right now" — and a count chip in each command bar. Both are claims
 * about the park, so both may only be drawn from an answer. These cases make
 * ONE read fail (a 500, or a 403 where that is how an account meets it — never
 * a 404, which the pages rightly read as "not on this deployment") and assert
 * the page says the read failed rather than dressing the gap as an empty list
 * or a zero. `Unreadable` in components/Panel.tsx states the rule; the
 * redesign's `UnreadNote` is its card-language twin.
 *
 * The first four are the release gate's reproductions, kept as they failed,
 * with the positive half each one now has.
 */

const boom = {
  status: 500,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code: 'INTERNAL', message: 'induced read failure' } }),
};

/** The page's own ErrorNote: the read has settled, as a failure. */
async function failed(page: Page, message = 'induced read failure') {
  await expect(page.getByText(message).first()).toBeVisible({ timeout: 30_000 });
}

test('Health: a failed /ops/health is not drawn as "Nothing needs you right now"', async ({ page }) => {
  await page.route(/\/api\/ops\/health(\?.*)?$/, (route) => route.fulfill(boom));
  await signInAndWait(page);
  await failed(page);
  await expect(page.getByText('Nothing needs you right now')).toHaveCount(0);
  await expect(page.getByText('The alert list could not be read')).toBeVisible();
});

test('Failures: a failed /ops/failures is not drawn as "Nothing failed in the last 24 hours"', async ({
  page,
}) => {
  await signInAndWait(page);
  await page.route(/\/api\/ops\/failures(\?.*)?$/, (route) => route.fulfill(boom));
  await openSection(page, 'Failures');
  await failed(page);
  await expect(page.getByText(/Nothing failed in the/)).toHaveCount(0);
  await expect(page.getByText('The failure list could not be read')).toBeVisible();
});

test('Failures rail: a failed /ops/quarantine is not drawn as "Nothing is waiting on a decision"', async ({
  page,
}) => {
  await signInAndWait(page);
  await page.route(/\/api\/ops\/quarantine(\?.*)?$/, (route) => route.fulfill(boom));
  await openSection(page, 'Failures');
  // The rail now says the read failed, with the reason and its one button.
  await expect(page.getByText('The quarantine list could not be read')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/induced read failure/).first()).toBeVisible();
  await expect(page.getByText('Nothing is waiting on a decision')).toHaveCount(0);
  await expect(page.getByText('could not be read just now')).toBeVisible();
});

test('Devices: a failed box read is not drawn as "0 boxes · 0 online"', async ({ page }) => {
  await signInAndWait(page);
  await page.route(/\/api\/branches\/[^/]+\/boxes(\?.*)?$/, (route) => route.fulfill(boom));
  await openSection(page, 'Devices');
  await failed(page);
  await expect(page.getByText(/\d+ box(es)? · \d+ online/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The same rule at the fix round's other reads.

test('Health: before /ops/health first answers, Alerts says it is loading, not all-clear', async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/ops\/health(\?.*)?$/, async (route) => {
    await held;
    await route.continue();
  });
  await signInAndWait(page);
  await expect(page.getByText('Loading alerts…')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Nothing needs you right now')).toHaveCount(0);
  release();
  await expect(page.getByText('Loading alerts…')).toHaveCount(0, { timeout: 30_000 });
});

test('Quarantine list: a failed read is not drawn as "Nothing is waiting on a decision"', async ({
  page,
}) => {
  await signInAndWait(page);
  await page.route(/\/api\/ops\/quarantine(\?.*)?$/, (route) => route.fulfill(boom));
  await openSection(page, 'Failures');
  await page.getByRole('button', { name: /^Quarantine/ }).click();
  await failed(page);
  await expect(page.getByText('Nothing is waiting on a decision')).toHaveCount(0);
  // The rail's reading and the list's own: both say the read failed.
  await expect(page.getByText('The quarantine list could not be read')).toHaveCount(2);
});

test('Devices: an account refused the box read (403) sees no box count, and the station count still comes from its own read', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Devices');
  // The positive control first: with every read answering, the chip is there.
  await expect(page.getByText(/^\d+ box(es)? · \d+ online · \d+ stations?$/)).toBeVisible({
    timeout: 30_000,
  });

  await page.route(/\/api\/branches\/[^/]+\/boxes(\?.*)?$/, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'induced box refusal' } }),
    }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await failed(page, 'induced box refusal');
  await expect(page.getByText(/\d+ box(es)? · \d+ online/)).toHaveCount(0);
  await expect(page.getByText(/^\d+ stations?$/)).toBeVisible();
});

test('Failures: the command bar counts the groups as a floor while another page remains', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const group = (n: number) => ({
    fingerprint: `induced-${n}`,
    kind: 'job',
    name: `induced.job.${n}`,
    count: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    lastError: 'induced for the count',
    lastRunId: null,
    retryable: false,
  });
  await signInAndWait(page);
  await page.route(/\/api\/ops\/failures(\?.*)?$/, (route) => {
    const second = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({
      json: second
        ? { groups: [50, 51, 52].map(group), nextCursor: null }
        : { groups: Array.from({ length: 50 }, (_, n) => group(n)), nextCursor: 'page-2' },
    });
  });
  await openSection(page, 'Failures');
  await expect(page.getByText('50+ groups')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByText('53 groups')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('50+ groups')).toHaveCount(0);
});
