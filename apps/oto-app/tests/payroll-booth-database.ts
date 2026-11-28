import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { BoothRecord } from '../shared/booth-bonus';
import { database, makeGroup, makeEmployee } from './payroll-harness';

/** Inside the payroll HTTP suite's disposable database. Only the till transport is local to this test. */
export async function checkBoothDatabase(q: ReturnType<typeof database>['q']) {
  const { loadBoothReport, saveBoothRule } = await import('../server/payroll/booth-bonus');
  const park = await makeGroup(q, 'voucher', ['ZZ TEST voucher park']),
    branch = park.branches[0];
  const core = randomUUID(),
    voucherId = randomUUID(),
    saleId = randomUUID(),
    stationId = randomUUID();
  await q('update branches set core_branch_id=$1 where id=$2 and tenant_id=$3', [
    core,
    branch,
    park.tenant,
  ]);
  const ids = await Promise.all(
    ['A', 'B'].map((s) => makeEmployee(q, park, branch, 'ZZ TEST voucher ' + s, '2026-01-01')),
  );
  const actor = { userId: park.accounts.admin.id, name: 'ZZ TEST admin' };
  const used = '2026-10-02';
  const original: BoothRecord = {
    voucherId,
    saleId,
    stationId,
    booth: 'ZZ TEST voucher booth',
    timezone: 'Asia/Bangkok',
    issuedAt: '2026-10-01T05:00:00.000Z',
    issuedMonth: '2026-10',
    issuedDay: '2026-10-01',
    usedAt: used + 'T05:00:00.000Z',
    usedDay: used,
    saleState: 'paid',
    spendSatang: 0,
    reversedAt: null,
    reversals: [],
    sharedCode: false,
    accountIds: [],
    employeeIds: ids,
    staffLabel: 'A and B',
  };
  let facts = [original];
  const oldUrl = process.env.PLATFORM_API_URL,
    oldKey = process.env.OTOAPP_PROVISION_KEY;
  const key = randomUUID();
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost');
    if (
      req.headers.authorization !== 'Bearer ' + key ||
      path.pathname !== '/otoapp/payroll/booth-vouchers' ||
      path.searchParams.get('branchId') !== core
    ) {
      res.writeHead(403).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ records: facts, next: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    process.env.PLATFORM_API_URL = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    process.env.OTOAPP_PROVISION_KEY = key;
    await saveBoothRule(park.tenant, actor, {
      from: '2026-10-01',
      window: 'any-time',
      rateSatang: 1000,
      overrides: [{ employeeId: ids[1], rateSatang: 1500 }],
      reason: 'ZZ TEST original rate',
    });
    const early = await loadBoothReport(park.tenant, '2026-10');
    assert.deepEqual(early.awards.map((a) => a.rateSatang).sort(), [1000, 1500]);
    assert.equal(early.people.length, 2);
    assert.equal(early.booths[0].sales, 1);
    assert.ok(
      early.awards.every((a) => a.noClockIn),
      'missing attendance is a warning and both people still count',
    );
    await saveBoothRule(park.tenant, actor, {
      from: '2026-10-03',
      window: 'same-day',
      rateSatang: 1800,
      reason: 'ZZ TEST dated change',
    });
    const reversal = { saleId, usedDay: used, at: '2026-10-03T04:00:00.000Z' };
    facts = [
      { ...original, reversedAt: reversal.at, reversals: [reversal], saleState: 'refunded' },
    ];
    assert.equal((await loadBoothReport(park.tenant, '2026-10')).awards.length, 0);
    facts = [
      {
        ...original,
        saleId: randomUUID(),
        usedAt: '2026-11-01T04:00:00.000Z',
        usedDay: '2026-11-01',
        reversals: [reversal],
      },
    ];
    const later = await loadBoothReport(park.tenant, '2026-11');
    assert.deepEqual(later.awards.map((a) => a.rateSatang).sort(), [1000, 1500]);
    assert.ok(later.awards.every((a) => a.saleId === facts[0].saleId && a.window === 'any-time'));
    const receipts = await q(
      'select sale_id,rate_satang,redemption_month from payroll_booth_bonuses where tenant_id=$1 and voucher_id=$2 order by rate_satang',
      [park.tenant, voucherId],
    );
    assert.deepEqual(
      receipts.map((x) => [x.sale_id, x.rate_satang, x.redemption_month]),
      [
        [saleId, 1000, '2026-10'],
        [saleId, 1500, '2026-10'],
      ],
    );
  } finally {
    if (oldUrl === undefined) delete process.env.PLATFORM_API_URL;
    else process.env.PLATFORM_API_URL = oldUrl;
    if (oldKey === undefined) delete process.env.OTOAPP_PROVISION_KEY;
    else process.env.OTOAPP_PROVISION_KEY = oldKey;
    server.closeAllConnections();
    server.close();
  }
}
