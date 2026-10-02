import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { branch, device, endOfDay, paymentMethod } from '@oto/db';
import { endOfDayReceiptDocument, type EodReceiptDocument } from '@oto/shared';
import { accountNames } from './refund-slices';
import type { Exec } from './tx';

/**
 * S2-15a round 2 — what the End of Day receipt says, built from the closed
 * day's saved row when the box asks for it (`buildPrintDocument`), so the
 * original and every reprint carry the figures exactly as they were locked.
 * The receipt template's label/value rows carry it, so every agent prints it.
 */

/** The till's word for a channel (`channelLabel` in the POS). */
export function eodChannelLabel(
  channel: string,
  terminals: ReadonlyMap<string, string>,
  methods: ReadonlyMap<string, string>,
): string {
  if (channel.startsWith('card:')) {
    const tid = channel.slice('card:'.length);
    const label = terminals.get(tid);
    return label ? `Card · ${label} (${tid})` : `Card · ${tid}`;
  }
  if (channel.startsWith('method:')) {
    const token = channel.slice('method:'.length);
    return methods.get(token) ?? token;
  }
  switch (channel) {
    case 'cash':
      return 'Cash';
    case 'promptpay':
      return 'PromptPay / QR';
    case 'ewallet':
      return 'E-wallet';
    case 'bank_transfer':
      return 'Bank transfer';
    case 'party_prepay':
      return 'Party prepayments';
    case 'credit':
      return 'Credit';
    default:
      return channel;
  }
}

/** The receipt for one closed day; null when there is no such day. */
export async function endOfDayReceiptDocumentOf(
  db: Exec,
  endOfDayId: string,
  copy: boolean,
): Promise<EodReceiptDocument | null> {
  const [row] = await db.select().from(endOfDay).where(eq(endOfDay.id, endOfDayId)).limit(1);
  if (!row) return null;
  const [place] = await db
    .select({ name: branch.name, timezone: branch.timezone })
    .from(branch)
    .where(eq(branch.id, row.branchId))
    .limit(1);
  const terminals = new Map(
    (
      await db
        .select({ tid: device.terminalId, label: device.label })
        .from(device)
        .where(and(eq(device.branchId, row.branchId), eq(device.kind, 'terminal'), isNotNull(device.terminalId)))
    ).map((t) => [t.tid?.trim() ?? '', t.label]),
  );
  const tokens = row.lines.filter((l) => l.channel.startsWith('method:')).map((l) => l.channel.slice('method:'.length));
  const methods = new Map(
    tokens.length
      ? (
          await db
            .select({ code: paymentMethod.code, label: paymentMethod.label })
            .from(paymentMethod)
            .where(and(eq(paymentMethod.operatorId, row.operatorId), inArray(paymentMethod.code, tokens)))
        ).map((m) => [m.code, m.label])
      : [],
  );
  const nameOf = await accountNames(db, [row.closedByAccountId, row.overrideByAccountId].filter((id): id is string => !!id));
  return endOfDayReceiptDocument({
    receiptNumber: row.receiptNumber,
    branchName: place?.name ?? null,
    date: row.businessDate,
    closedAt: row.closedAt,
    timezone: place?.timezone ?? 'Asia/Bangkok',
    closedByName: nameOf(row.closedByAccountId),
    lines: row.lines,
    labelOf: (channel) => eodChannelLabel(channel, terminals, methods),
    countedSatang: row.countedSatang,
    floatSatang: row.floatSatang,
    floatLeftSatang: row.floatLeftSatang,
    totalExpectedSatang: row.totalExpectedSatang,
    totalActualSatang: row.totalActualSatang,
    totalDifferenceSatang: row.totalDifferenceSatang,
    override:
      row.overrideByAccountId && row.overrideReason
        ? { reason: row.overrideReason, byName: nameOf(row.overrideByAccountId) }
        : null,
    copy,
  });
}
