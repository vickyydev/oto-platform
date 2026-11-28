import assert from 'node:assert/strict';
import {
  windowLabel,
  withinWindow,
  isBoothFlyer,
  type BoothRecord,
} from '../../../shared/booth-bonus';
import { namesOnSlip, type RosterPerson } from '../../../server/payroll/booth-roster';
import test, { describeSuite } from '../harness';

describeSuite('Booth voucher bonuses');
const issue: BoothRecord = {
  voucherId: 'v',
  stationId: 's',
  booth: 'ZZ TEST Booth',
  timezone: 'Asia/Bangkok',
  issuedAt: '2026-11-28T16:58:00.000Z',
  issuedDay: '2026-11-28',
  issuedMonth: '2026-11',
  usedAt: '2026-11-28T17:01:00.000Z',
  usedDay: '2026-11-29',
  saleId: 'sale',
  saleState: 'finalised',
  spendSatang: 0,
  reversedAt: null,
  sharedCode: false,
  accountIds: ['a'],
  employeeIds: null,
  staffLabel: 'A and B',
};
const people: RosterPerson[] = ['A', 'B'].map((name) => ({
  id: name,
  name,
  nickname: name,
  accountId: name.toLowerCase(),
  start: null,
  end: null,
}));
test("the branch's midnight and an elapsed day use different deadlines", () => {
  assert.equal(withinWindow(issue, 'same-day'), false);
  assert.equal(withinWindow(issue, '24-hours'), true);
  const last = { ...issue, usedAt: '2026-11-29T16:58:00.000Z', usedDay: '2026-11-29' };
  assert.equal(withinWindow(last, '24-hours'), true);
  assert.equal(withinWindow({ ...last, usedAt: '2026-11-29T16:58:00.001Z' }, '24-hours'), false);
  const early = { ...issue, usedAt: '2026-11-28T16:57:59.999Z', usedDay: '2026-11-28' };
  for (const window of Object.keys(windowLabel) as (keyof typeof windowLabel)[])
    assert.equal(withinWindow(early, window), false);
});
test('seven or thirty park days include the issue day, across a month boundary', () => {
  const used = (n: number) => ({
    ...issue,
    usedDay: new Date(Date.UTC(2026, 10, 28 + n)).toISOString().slice(0, 10),
    usedAt: new Date(Date.UTC(2026, 10, 28 + n, 16)).toISOString(),
  });
  assert.equal(withinWindow(used(6), '7-days'), true);
  assert.equal(withinWindow(used(7), '7-days'), false);
  assert.equal(withinWindow(used(29), '30-days'), true);
  assert.equal(withinWindow(used(30), '30-days'), false);
  assert.equal(withinWindow(used(100), 'any-time'), true);
});
test('an issue snapshot pays only linked employees and keeps unmatched typed names for review', () => {
  assert.deepEqual(
    namesOnSlip({ ...issue, employeeIds: ['A', 'A'], staffLabel: 'A and B' }, people),
    { ids: ['A'], unmatched: 1 },
  );
  assert.deepEqual(
    namesOnSlip({ ...issue, employeeIds: [], staffLabel: 'B', accountIds: [] }, people),
    { ids: [], unmatched: 1 },
  );
  assert.deepEqual(
    namesOnSlip({ ...issue, employeeIds: ['A', 'B'], accountIds: ['a', 'b'] }, people),
    { ids: ['A', 'B'], unmatched: 0 },
  );
});
test('an old slip resolves across the issue date only when each name is unambiguous', () => {
  assert.deepEqual(namesOnSlip(issue, people), { ids: ['A', 'B'], unmatched: 0 });
  const duplicate = { ...people[1], id: 'other-b', accountId: null };
  assert.deepEqual(namesOnSlip(issue, [...people, duplicate]), { ids: ['A'], unmatched: 1 });
  assert.deepEqual(
    namesOnSlip(issue, [...people, { ...duplicate, start: new Date('2026-11-29T00:00Z') }]),
    { ids: ['A', 'B'], unmatched: 0 },
  );
});
test('a birthday count stays individual and only a returned flyer uses the records', () => {
  const bonus = { basis: 'baht-per-unit', bahtPerUnit: 10 } as const;
  assert.equal(
    isBoothFlyer({ type: 'bonus', quote: 'Per returned flyer', bonus } as Parameters<
      typeof isBoothFlyer
    >[0]),
    true,
  );
  assert.equal(
    isBoothFlyer({ type: 'bonus', quote: 'Per birthday party hosted', bonus } as Parameters<
      typeof isBoothFlyer
    >[0]),
    false,
  );
});
