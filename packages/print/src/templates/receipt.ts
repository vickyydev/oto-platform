/**
 * The sale receipt.
 *
 * Section order follows the prototype's preview
 * (`PrintTemplatePreview.tsx:151-281`) with the S2-11 additions slotted where
 * they belong: the abbreviated tax-invoice block and the receipt number under
 * the header, tenders and band codes after the totals. SCRUM-527 adds the
 * discount rows between the subtotal and the service charge, where History's
 * money card shows them.
 *
 * The sale's F&B credit closes the receipt: one credit voucher section per
 * wallet the sale granted (`creditVoucherSection`, the same blocks the
 * voucher slip draws), above the footer and before the one cut. A sale is one
 * slip; the credit used to follow it as slips of its own, each with its own
 * cut. The section obeys the branch's `credit_voucher` template, as the slip
 * did, so its two toggles mean the same wherever the credit prints.
 *
 * Drawn in `RECEIPT_TYPE` — every line bold and larger than the other
 * printouts — which is where the receipt's darkness comes from: the text is
 * raster, so there is no printer-side bold to switch on (`common.ts`).
 *
 * One rule that looks like a bug and is not: on a receipt an item's note prints
 * whether or not `orderNotes` is on (`:215`) — `orderNotes` is not even an
 * applicable field for the receipt type. Only prep tickets gate notes.
 */

import type { Block, DeviceProfile, PrintDocument } from '../document';
import { measureText } from '../fonts/shape';
import type { ReceiptData } from './data';
import type { PrintTemplate } from './model';
import { fieldOn } from './model';
import {
  RECEIPT_TYPE as T,
  divider,
  footerBlocks,
  headerBlocks,
  moneyRow,
  space,
  text,
  valueColumnDots,
} from './common';
import { creditVoucherSection } from './voucher';

export interface ReceiptInput {
  template?: PrintTemplate;
  /** The branch's `credit_voucher` template, which governs the credit sections. */
  creditTemplate?: PrintTemplate;
  data: ReceiptData;
  device: DeviceProfile;
}

const PADDING_DOTS = 8;
const COLUMN_GAP_DOTS = 8;

/**
 * The receipt number and the time, on one row when both fit the head and on
 * two lines when they do not — never with the time wrapped under its own date.
 *
 * Measured rather than guessed because the two are text of any length: the
 * platform stamps "2026-09-30 14:05" (258 dots at 32), and a 512-dot head
 * leaves 496 for the pair. The date's cell is exactly as wide as the date, so
 * the number keeps everything else.
 */
function receiptNumberRow(data: ReceiptData, widthDots: number): Block[] {
  const number = data.receiptNumber ?? '';
  const when = data.dateTime ?? '';
  const room = widthDots - PADDING_DOTS * 2;
  const numberDots = Math.ceil(measureText(number, T.body));
  const whenDots = Math.ceil(measureText(when, T.body));
  if (!number || !when || numberDots + COLUMN_GAP_DOTS + whenDots > room) {
    return [number, when].filter((v) => v.length > 0).map((v) => text(v, T.body));
  }
  return [
    {
      k: 'columns',
      gapDots: COLUMN_GAP_DOTS,
      cells: [
        { runs: [{ text: number }], align: 'left', style: T.body, flex: 1 },
        { runs: [{ text: when }], align: 'right', style: T.body, widthDots: whenDots },
      ],
    },
  ];
}

export function buildReceipt({ template, creditTemplate, data, device }: ReceiptInput): PrintDocument {
  const blocks: Block[] = [...headerBlocks(template, data.title, T)];

  if (data.taxInvoiceLines?.length) {
    blocks.push(space(4));
    for (const line of data.taxInvoiceLines) blocks.push(text(line, T.small, 'center'));
  }

  if (data.receiptNumber || data.dateTime) {
    blocks.push(divider(T.ruleDots));
    blocks.push(...receiptNumberRow(data, device.widthDots));
  }
  if (data.staffName) blocks.push(text(`Served by ${data.staffName}`, T.small));
  if (data.memberNickname) blocks.push(text(`Member: ${data.memberNickname}`, T.small));

  if (fieldOn(template, 'receipt', 'itemizedLines') && data.lines.length > 0) {
    blocks.push(divider(T.ruleDots));
    for (const line of data.lines) {
      blocks.push({
        k: 'columns',
        gapDots: 8,
        cells: [
          {
            runs: [{ text: `${line.qty}× ` }, { text: line.name }],
            align: 'left',
            style: T.body,
            flex: 1,
          },
          {
            runs: [{ text: line.price ?? '' }],
            align: 'right',
            style: T.body,
            widthDots: valueColumnDots(T.body.sizeDots),
          },
        ],
      });
      // Item notes ride with their line and are not gated on a receipt.
      if (line.note) blocks.push(text(`  ${line.note}`, T.small));
    }
  }

  if (fieldOn(template, 'receipt', 'taxServiceBreakdown')) {
    blocks.push(divider(T.ruleDots));
    if (data.subtotal) blocks.push(moneyRow('Subtotal', data.subtotal, false, T));
    // SCRUM-527 — each discount under the subtotal it came off, as History's
    // money card lists them, with its reason line in the small size.
    for (const discount of data.discounts ?? []) {
      blocks.push(moneyRow(discount.label, discount.amount, false, T));
      if (discount.detail) blocks.push(text(`  ${discount.detail}`, T.small));
    }
    if (data.service) blocks.push(moneyRow('Service', data.service, false, T));
    if (data.vat) blocks.push(moneyRow('VAT (incl.)', data.vat, false, T));
    blocks.push({ k: 'rule', style: 'solid', thicknessDots: T.ruleDots });
    blocks.push(moneyRow('TOTAL', data.total, true, T));
  }

  if (data.tenders?.length) {
    blocks.push(space(4));
    for (const tender of data.tenders) blocks.push(moneyRow(tender.label, tender.amount, false, T));
  }

  if (data.bandCodes?.length) {
    blocks.push(divider(T.ruleDots));
    blocks.push(text('Bands issued', { ...T.small, tracking: 1 }));
    for (const code of data.bandCodes) blocks.push(text(`• ${code}`, T.small));
  }

  if (fieldOn(template, 'receipt', 'voucherInfo') && data.creditGrants?.length) {
    blocks.push(divider(T.ruleDots));
    blocks.push(text('Credit issued', { ...T.small, tracking: 1 }));
    for (const grant of data.creditGrants) blocks.push(text(`• ${grant}`, T.small));
  }

  if (data.orderNote) {
    blocks.push(divider(T.ruleDots));
    blocks.push(text(data.orderNote, T.small));
  }

  const credits = data.creditVouchers ?? [];
  for (const credit of credits) {
    blocks.push(space(8));
    blocks.push(divider(T.ruleDots));
    blocks.push(text('CREDIT VOUCHER', T.title, 'center'));
    blocks.push(...creditVoucherSection(creditTemplate, credit, T));
  }
  // The voucher's own footer said it once per slip; on one receipt, once.
  if (credits.length > 0 && creditTemplate?.footerText) {
    blocks.push(text(creditTemplate.footerText, T.small, 'center'));
  }

  blocks.push(...footerBlocks(template, T));

  return {
    media: { kind: 'receipt', widthDots: device.widthDots, dpi: 203 },
    paddingDots: PADDING_DOTS,
    blocks,
    finish: { feedDots: 96, cut: 'partial' },
  };
}
