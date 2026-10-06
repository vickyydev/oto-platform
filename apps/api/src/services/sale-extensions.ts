import { and, asc, eq, sql } from 'drizzle-orm';
import { account, band, employee, sale, saleExtension, saleExtensionBand, saleLine, station, type ExtensionSelection } from '@oto/db';
import { bandShortCode, computeTaxBreakdown, newId, PRICING_ENGINE_VERSION } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { planBands } from './bands';
import { resolvePricingScope, resolveSalesChannel, saleViewOf, type ActorContext } from './sale';
import type { Exec, Tx } from './tx';

// Approved prototype mockApi.getExtensionOptions: per bracelet, before the
// branch's existing ticket tax calculation. No catalogue or invented expiry.
export const EXTENSION_OPTIONS = [
  { id: 'ext-30', label: '+30 minutes', minutes: 30, unitSatang: 6000 },
  { id: 'ext-60', label: '+1 hour', minutes: 60, unitSatang: 10000 },
  { id: 'ext-120', label: '+2 hours', minutes: 120, unitSatang: 18000 },
] as const;

type ExtensionRow = typeof saleExtension.$inferSelect;
export function extensionView(row: ExtensionRow) {
  return { id: row.id, chargeSaleId: row.chargeSaleId, optionId: row.optionId, label: row.label,
    minutesAdded: row.minutesAdded, braceletCount: row.braceletCount, amountSatang: row.amountSatang,
    selection: row.selection, status: row.status, createdAt: row.createdAt.toISOString(),
    createdByName: row.createdByName, appliedAt: row.appliedAt?.toISOString() ?? null };
}

async function sourceOf(db: Exec, actor: ActorContext, id: string) {
  const [source] = await db.select().from(sale).where(and(eq(sale.id, id), eq(sale.operatorId, actor.operatorId))).limit(1);
  if (!source) throw errors.notFound('Sale not found');
  await actor.assertBranchAllowed?.(source.branchId);
  return source;
}

export async function readSaleExtensions(db: Exec, actor: ActorContext, sourceSaleId: string) {
  const source = await sourceOf(db, actor, sourceSaleId);
  const rows = await db.select().from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id)).orderBy(asc(saleExtension.createdAt));
  const bands = await db.select().from(band).where(and(eq(band.saleId, source.id), eq(band.status, 'active'))).orderBy(asc(band.createdAt));
  const lines = await db.select().from(saleLine).where(eq(saleLine.saleId, source.id));
  const eligible = source.status === 'finalised' && source.refundedSatang === 0 && planBands(lines).length > 0;
  return { options: eligible ? [...EXTENSION_OPTIONS] : [],
    eligibleBands: eligible ? bands.map((row) => ({ id: row.id, shortCode: bandShortCode(row.code), kind: row.kind })) : [],
    extensions: rows.map(extensionView) };
}

export interface CreateSaleExtensionInput {
  actionId: string;
  stationId: string;
  optionId: string;
  selection: ExtensionSelection;
}

function normalSelection(selection: ExtensionSelection): ExtensionSelection {
  return selection.mode === 'bands' ? { mode: 'bands', bandIds: [...selection.bandIds].sort() } : { mode: 'count', braceletCount: selection.braceletCount };
}

export async function createSaleExtension(tx: Tx, actor: ActorContext, sourceSaleId: string, input: CreateSaleExtensionInput, now = new Date()) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.operatorId}:extension:${input.actionId}`}, 0))`);
  // Serialise two presses on the admission; a second pending charge would
  // otherwise give staff two balances to collect after a lost response.
  const [source] = await tx.select().from(sale).where(and(eq(sale.id, sourceSaleId), eq(sale.operatorId, actor.operatorId))).for('update').limit(1);
  if (!source) throw errors.notFound('Sale not found');
  await actor.assertBranchAllowed?.(source.branchId);
  const selection = normalSelection(input.selection);
  const [already] = await tx.select().from(saleExtension).where(and(eq(saleExtension.operatorId, actor.operatorId), eq(saleExtension.actionId, input.actionId))).limit(1);
  if (already) {
    const [charge] = await tx.select().from(sale).where(eq(sale.id, already.chargeSaleId)).limit(1);
    if (!charge || already.sourceSaleId !== source.id || already.optionId !== input.optionId || charge.stationId !== input.stationId || JSON.stringify(already.selection) !== JSON.stringify(selection)) {
      throw errors.conflict('ACTION_ID_REUSED', 'That action already recorded a different time extension.');
    }
    return { extension: extensionView(already), sale: await saleViewOf(tx, charge), replay: true };
  }
  if (source.status !== 'finalised' || source.refundedSatang > 0) throw errors.conflict('EXTENSION_SOURCE_UNAVAILABLE', 'Extra time needs a finalised admission that has not been refunded.');
  const [pending] = await tx.select({ chargeSaleId: saleExtension.chargeSaleId }).from(saleExtension)
    .where(and(eq(saleExtension.sourceSaleId, source.id), eq(saleExtension.status, 'pending'))).limit(1);
  if (pending) throw errors.conflict('EXTENSION_PENDING', 'Finish or void this admission’s pending time extension first.', pending);
  const option = EXTENSION_OPTIONS.find((row) => row.id === input.optionId);
  if (!option) throw errors.badRequest('Choose an available time extension.');
  const originalLines = await tx.select().from(saleLine).where(eq(saleLine.saleId, source.id));
  const originalCount = planBands(originalLines).length;
  if (originalCount === 0) throw errors.conflict('EXTENSION_NO_BRACELETS', 'This sale has no admission bracelets to extend.');
  const allBands = await tx.select().from(band).where(eq(band.saleId, source.id)).for('update');
  const active = allBands.filter((row) => row.status === 'active');
  const count = selection.mode === 'bands' ? selection.bandIds.length : selection.braceletCount;
  if (!Number.isInteger(count) || count < 1 || count > originalCount) throw errors.badRequest('Choose between one and the original number of bracelets.');
  if (selection.mode === 'bands') {
    if (new Set(selection.bandIds).size !== count || selection.bandIds.some((id) => !active.some((row) => row.id === id))) {
      throw errors.conflict('EXTENSION_BAND_UNAVAILABLE', 'Select distinct active bands belonging to this admission.');
    }
  } else if (allBands.some((row) => row.status !== 'active')) {
    throw errors.conflict('EXTENSION_BAND_UNAVAILABLE', 'This admission has inactive bands. Select the active bands to extend.');
  }
  const [counter] = await tx.select().from(station).where(eq(station.id, input.stationId)).limit(1);
  if (!counter || counter.operatorId !== actor.operatorId || counter.branchId !== source.branchId || counter.archivedAt) throw errors.notFound('Active counter not found at this park');
  if (counter.kind !== 'till' || !counter.codePrefix) throw errors.badRequest('Extra time must be charged at a ticket till with a receipt prefix.');
  resolveSalesChannel(counter, 'till');
  const scope = await resolvePricingScope(tx, source.branchId, actor.operatorId, now);
  const base = option.unitSatang * count;
  const tax = computeTaxBreakdown([{ category: 'tickets', base }], 0, scope.taxConfig);
  const category = tax.categories[0]!;
  const net = tax.grandTotal - tax.serviceChargeTotal - tax.inclusiveTaxTotal - tax.exclusiveTaxTotal;
  const chargeId = newId();
  const extensionId = newId();
  const [charge] = await tx.insert(sale).values({
    id: chargeId, operatorId: actor.operatorId, branchId: source.branchId,
    stationId: counter.id, boxId: counter.boxId, businessDate: scope.businessDate,
    businessDayStart: scope.businessDayStart, timezone: scope.timezone, occurredAt: now,
    origin: 'cloud', clockTrust: 'trusted', salesChannel: 'till', actionId: `time-extension:${input.actionId}`,
    createdByAccountId: actor.accountId, memberId: source.memberId, customerTier: source.customerTier,
    pricingMode: scope.pricingMode, pricingModeReason: scope.pricingModeReason,
    holidayId: scope.holidayId, holidayName: scope.holidayName, engineVersion: PRICING_ENGINE_VERSION,
    taxConfig: scope.taxConfig, taxBreakdown: tax, subtotalSatang: base, netSatang: net,
    serviceChargeSatang: tax.serviceChargeTotal, taxInclusiveSatang: tax.inclusiveTaxTotal,
    taxExclusiveSatang: tax.exclusiveTaxTotal, grossSatang: tax.grandTotal, status: 'tendering',
    note: `Extra play for ${source.receiptNumber ?? source.id}`,
  }).returning();
  if (!charge) throw new Error('Time extension charge was not recorded');
  // An addon is a priced line without new admission participants. Its ticket
  // tax/revenue classification is explicit; product/package IDs stay empty,
  // so it grants no new bands, stock, food or stored value.
  await tx.insert(saleLine).values({ id: newId(), saleId: charge.id, operatorId: actor.operatorId,
    branchId: source.branchId, businessDate: scope.businessDate, lineNo: 1, cartLineId: newId(), kind: 'addon',
    componentKey: 'time_extension', label: `Extra play ${option.label}`, revenueCategory: 'tickets', taxableCategory: 'tickets',
    quantity: count, unitSatang: option.unitSatang, baseSatang: base, netSatang: net,
    serviceChargeSatang: tax.serviceChargeTotal, taxSatang: tax.inclusiveTaxTotal + tax.exclusiveTaxTotal,
    taxMode: category.taxMode, taxRateBp: Math.round(category.taxPercent * 100), taxRateId: category.taxRateId ?? null,
    taxName: category.taxName ?? null, grossSatang: tax.grandTotal, customerTier: source.customerTier,
    payload: { extensionId, sourceSaleId: source.id, minutesAdded: option.minutes } });
  const [person] = await tx.select({ name: employee.name }).from(account).leftJoin(employee, eq(employee.id, account.employeeId)).where(eq(account.id, actor.accountId)).limit(1);
  const [extension] = await tx.insert(saleExtension).values({ id: extensionId, operatorId: actor.operatorId,
    branchId: source.branchId, sourceSaleId: source.id, chargeSaleId: charge.id, actionId: input.actionId,
    optionId: option.id, label: option.label, minutesAdded: option.minutes, braceletCount: count,
    amountSatang: tax.grandTotal, selection, createdAt: now, createdByAccountId: actor.accountId,
    createdByName: person?.name ?? null }).returning();
  if (!extension) throw new Error('Time extension was not recorded');
  if (selection.mode === 'bands') await tx.insert(saleExtensionBand).values(selection.bandIds.map((bandId) => ({ id: newId(), extensionId, bandId, minutesAdded: option.minutes })));
  await audit.record(tx, { actorAccountId: actor.accountId, operatorId: actor.operatorId, branchId: source.branchId,
    requestId: actor.requestId, actionId: input.actionId, action: 'sale.extension.create', entityType: 'sale_extension', entityId: extensionId,
    after: { sourceSaleId: source.id, chargeSaleId: charge.id, optionId: option.id, braceletCount: count, amountSatang: tax.grandTotal, selection } });
  return { extension: extensionView(extension), sale: await saleViewOf(tx, charge), replay: false };
}
