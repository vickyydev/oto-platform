import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * SCRUM-889 — AN OPEN PARTY SETTLEMENT IS NEVER REOPENED ON THE TICKETS TAB.
 *
 * Found in SCRUM-876's staging proof: a party settled at the till and left at
 * its balance came back on the Tickets tab as an ordinary ticket order, with
 * editable steppers and a Pay button naming the gross. The till now reads the
 * platform's list row (`partySettlement`) and offers such a sale as "Party
 * settlement open — Resume on the party page", with the way there; an
 * ordinary ticket sale left at the same till still comes straight back.
 *
 * The isolated harness has no OTO App tables, so no party can be planned and
 * settled through the app here. The settlement is the platform's own record
 * (`pos.party_settlement`) written against a sale this till rang up — exactly
 * what the list reads — and everything after that is the real till in a real
 * browser: `pnpm --filter @oto/pos e2e e2e/party-settlement-left-open.spec.ts`.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const DATABASE_URL = process.env.POS_E2E_DATABASE_URL ?? '';
const root = resolve(import.meta.dirname, '../../..');

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

const requireDb = createRequire(resolve(root, 'packages/db/package.json'));
const { Pool } = requireDb('pg') as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }>;
    end: () => Promise<void>;
  };
};

async function fromDatabase<T>(run: (pool: InstanceType<typeof Pool>) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect
    .poll(async () => (await picker.isVisible()) || (await page.getByText('Membership Check', { exact: true }).isVisible()), {
      timeout: 30_000,
    })
    .toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** One write the way the till sends it, in the signed-in page's session. */
async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api${url}`, {
    headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    data,
  });
  expect(res.status(), `${url}: ${await res.text()}`).toBe(200);
  return (await res.json()) as T;
}

/** The till's station and a package it sells. */
async function theCounter(): Promise<{ stationId: string; packageId: string }> {
  return fromDatabase(async (pool) => {
    const { rows } = await pool.query(
      `select s.id, s.branch_id from core.station s where s.code_prefix = 'T1' and s.name = 'Reception Till 1' limit 1`,
    );
    const packages = await pool.query(
      `select id from pos.ticket_package where branch_id = $1 and archived_at is null and name = '2 Hours Play' limit 1`,
      [rows[0]!.branch_id],
    );
    return { stationId: rows[0]!.id!, packageId: packages.rows[0]!.id! };
  });
}

/** A child-and-adult ticket sale rung up at the till by the signed-in account and left unpaid. */
async function ringUp(page: Page, at: { stationId: string; packageId: string }): Promise<string> {
  const saleId = randomUUID();
  await post(page, '/sales', {
    id: saleId,
    stationId: at.stationId,
    lines: [{ id: randomUUID(), packageId: at.packageId, kids: 1, adults: 1 }],
  });
  return saleId;
}

test('an open party settlement is offered to the party page and never resumed on the Tickets tab', async ({ page }) => {
  test.skip(!PHONE || !PASSWORD || !DATABASE_URL, 'Runs on the isolated harness (e2e/run.mjs)');
  await signIn(page);
  const at = await theCounter();

  // The settlement: a sale this till rang up, recorded as a party's settlement and left at its balance.
  const settlementSaleId = await ringUp(page, at);
  const eventId = randomUUID();
  await fromDatabase((pool) =>
    pool.query(
      `insert into pos.party_settlement
         (id, operator_id, branch_id, otoapp_event_id, sale_id, kids, adults, socks_given, rate_mode, party_date, plan, station_id)
       select $1, s.operator_id, s.branch_id, $2, s.id, 1, 1, 0, 'weekday', s.business_date, '{}'::jsonb, s.station_id
       from pos.sale s where s.id = $3`,
      [randomUUID(), eventId, settlementSaleId],
    ),
  );

  // The Tickets tab opens again: the settlement is offered to the party page, the till stays idle.
  await page.goto('/');
  const card = page.getByTestId('left-behind-party-settlement');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Party settlement open — Resume on the party page');
  await expect(card.getByTestId('open-party-page')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Resume this sale' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Void/ })).toHaveCount(0);
  await expect(page.getByTestId('resumed-sale-notice')).toHaveCount(0);
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();

  // An ordinary ticket sale left at the same till still comes straight back to its payment screen.
  await ringUp(page, at);
  await page.goto('/');
  await expect(page.getByTestId('resumed-sale-notice')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('left-behind-party-settlement')).toBeVisible();

  // The card's way there opens the party page on that party.
  await page.getByTestId('open-party-page').click();
  await expect(page).toHaveURL(new RegExp(`/parties\\?party=${eventId}$`));
});
