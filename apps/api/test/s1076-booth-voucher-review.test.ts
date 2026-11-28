import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  box,
  branch,
  boothConfigVersion,
  boothPrize,
  sale,
  spin,
  voucher,
  voucherRedemption,
} from '@oto/db';
import { newId } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { payrollBoothVouchers } from '../src/services/payroll-booth-vouchers';
import {
  createTestContext,
  teardownAll,
  SECOND_OPERATOR_BRANCH_CODE,
  type TestContext,
} from './helpers';

let ctx: TestContext;
const month = '2026-11';
const key = randomUUID();
let operatorId: string;
let branchId: string;
let otherBranchId: string;
const saleId = newId(),
  printed = newId(),
  hidden = newId(),
  failedPrint = newId();
const issuedAt = new Date('2026-11-28T16:59:00Z');
const usedAt = new Date('2026-11-28T17:00:00Z');
const route = () => '/otoapp/payroll/booth-vouchers?branchId=' + branchId + '&month=' + month;

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ env });
  const [prize] = await ctx.db
    .select()
    .from(boothPrize)
    .innerJoin(
      boothConfigVersion,
      and(
        eq(boothConfigVersion.stationId, boothPrize.stationId),
        eq(boothConfigVersion.operatorId, boothPrize.operatorId),
      ),
    )
    .where(isNotNull(boothPrize.voucherDefinitionId))
    .limit(1);
  if (!prize) throw Error('Bootstrap needs one published booth prize');
  const source = prize.booth_prize;
  operatorId = source.operatorId;
  branchId = source.branchId;
  const stationId = source.stationId,
    version = prize.booth_config_version;
  const [foreign] = await ctx.db
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.code, SECOND_OPERATOR_BRANCH_CODE));
  otherBranchId = foreign!.id;
  const [actor] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.operatorId, operatorId))
    .limit(1);
  env.OTOAPP_PROVISION_KEYS = operatorId + ':' + otoAppProvisionKeyDigest(key);
  await ctx.restart();
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId,
    branchId,
    name: 'ZZ TEST payroll review',
    slot: 'payroll-review',
    role: 'booth',
    status: 'unclaimed',
  });
  const hiddenVersion = newId();
  const originalBundle = version.bundle as { settings: Record<string, unknown> };
  const hiddenBundle = {
    ...originalBundle,
    settings: { ...originalBundle.settings, voucherShowStaff: false },
  };
  await ctx.db
    .insert(boothConfigVersion)
    .values({
      ...version,
      id: hiddenVersion,
      version: version.version + 1000,
      bundle: hiddenBundle,
      bundleHash: createHash('sha256').update(JSON.stringify(hiddenBundle)).digest('hex'),
    });
  for (const id of [printed, failedPrint, hidden]) {
    await ctx.db.insert(voucher).values({
      id,
      operatorId,
      branchId,
      voucherDefinitionId: source.voucherDefinitionId!,
      source: 'booth',
      code: randomUUID().replaceAll('-', '').toUpperCase(),
      printCount: id === failedPrint ? 0 : 2,
      issuedAt,
    });
    await ctx.db.insert(spin).values({
      id: newId(),
      operatorId,
      branchId,
      stationId,
      boxId,
      boothConfigVersionId: id === hidden ? hiddenVersion : version.id,
      staffAccountId: actor!.id,
      prizeId: source.id,
      voucherId: id,
      occurredAt: issuedAt,
      businessDate: '2026-11-28',
    });
  }
  await ctx.db.insert(sale).values({
    id: saleId,
    operatorId,
    branchId,
    stationId,
    businessDate: '2026-11-29',
    businessDayStart: '05:00',
    timezone: 'Asia/Bangkok',
    occurredAt: usedAt,
    createdByAccountId: actor!.id,
    pricingMode: 'weekday',
    pricingModeReason: 'ZZ TEST',
    customerTier: 'tourist',
    engineVersion: 'test',
    taxConfig: {},
    taxBreakdown: {},
    status: 'paid',
  });
  await ctx.db.insert(voucherRedemption).values({
    id: newId(),
    operatorId,
    voucherId: printed,
    kind: 'consumed',
    saleId,
    branchId,
    stationId,
    occurredAt: usedAt,
  });
}, 120000);
afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-1076 — published booth and till records for payroll', () => {
  it('requires the provisioner and confines it to its own park group', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: route() })).statusCode).toBe(401);
    const foreign = route().replace(branchId, otherBranchId);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: foreign,
          headers: { authorization: 'Bearer ' + key },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('joins the paid till sale to the original paper voucher once, including zero spend and a park midnight', async () => {
    const reply = await ctx.app.inject({
      method: 'GET',
      url: route(),
      headers: { authorization: 'Bearer ' + key },
    });
    expect(reply.statusCode).toBe(200);
    const { records } = reply.json();
    expect(records.filter((v: { voucherId: string }) => v.voucherId === printed)).toHaveLength(1);
    const fact = records.find((v: { voucherId: string }) => v.voucherId === printed);
    expect(fact).toMatchObject({
      saleId,
      saleState: 'paid',
      issuedDay: '2026-11-28',
      usedDay: '2026-11-29',
      spendSatang: 0,
      reversedAt: null,
    });
    expect(fact.accountIds).toHaveLength(1);
    const concealed = records.find((v: { voucherId: string }) => v.voucherId === hidden);
    expect(concealed).toMatchObject({ accountIds: [], employeeIds: [], staffLabel: null });
    expect(fact).not.toHaveProperty('code');
    expect(fact).not.toHaveProperty('customerPhone');
    expect(records.some((v: { voucherId: string }) => v.voucherId === failedPrint)).toBe(false);
  });
  it('retains the sale link and its reversal date after a sale is voided', async () => {
    const when = new Date('2026-12-02T12:00:00Z');
    await ctx.db
      .update(sale)
      .set({ status: 'voided', voidedAt: when, voidReason: 'ZZ TEST review' })
      .where(eq(sale.id, saleId));
    const reversals = await payrollBoothVouchers(ctx.db, operatorId, {
      branchId,
      month: '2026-12',
    });
    expect(reversals.records.find((v) => v.voucherId === printed)).toMatchObject({
      saleId,
      reversedAt: when.toISOString(),
    });
    const [original] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const liveId = newId(),
      nextUse = new Date(when.getTime() + 60000);
    await ctx.db.insert(sale).values({
      ...original!,
      id: liveId,
      status: 'paid',
      occurredAt: nextUse,
      businessDate: '2026-12-02',
      voidedAt: null,
      voidReason: null,
    });
    const [usage] = await ctx.db
      .select()
      .from(voucherRedemption)
      .where(eq(voucherRedemption.saleId, saleId));
    await ctx.db
      .insert(voucherRedemption)
      .values({ ...usage!, id: newId(), kind: 'consumed', saleId: liveId, occurredAt: nextUse });
    const reused = await payrollBoothVouchers(ctx.db, operatorId, { branchId, month: '2026-12' });
    const fact = reused.records.find((row) => row.voucherId === printed);
    expect(fact).toMatchObject({
      saleId: liveId,
      saleState: 'paid',
      reversedAt: null,
      usedAt: nextUse.toISOString(),
    });
    expect(fact!.reversals.map((r) => r.saleId)).toEqual([saleId]);
  });
});
