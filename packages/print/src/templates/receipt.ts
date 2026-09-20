/**
 * The sale receipt.
 *
 * Section order follows the prototype's preview
 * (`PrintTemplatePreview.tsx:151-281`) with the S2-11 additions slotted where
 * they belong: the abbreviated tax-invoice block and the receipt number under
 * the header, tenders and band codes after the totals.
 *
 * One rule that looks like a bug and is not: on a receipt an item's note prints
 * whether or not `orderNotes` is on (`:215`) — `orderNotes` is not even an
 * applicable field for the receipt type. Only prep tickets gate notes.
 */

import type { Block, DeviceProfile, PrintDocument } from '../document';
import type { ReceiptData } from './data';
import type { PrintTemplate } from './model';
import { fieldOn } from './model';
import {
  SIZE,
  body,
  bodyBold,
  divider,
  footerBlocks,
  headerBlocks,
  moneyRow,
  small,
  space,
  text,
  valueColumnDots,
} from './common';

export interface ReceiptInput {
  template?: PrintTemplate;
  data: ReceiptData;
  device: DeviceProfile;
}

export function buildReceipt({ template, data, device }: ReceiptInput): PrintDocument {
  const blocks: Block[] = [...headerBlocks(template, data.title)];

  if (data.taxInvoiceLines?.length) {
    blocks.push(space(4));
    for (const line of data.taxInvoiceLines) blocks.push(text(line, small, 'center'));
  }

  if (data.receiptNumber || data.dateTime) {
    blocks.push(divider());
    blocks.push({
      k: 'columns',
      gapDots: 8,
      cells: [
        { runs: [{ text: data.receiptNumber ?? '' }], align: 'left', style: bodyBold, flex: 1 },
        { runs: [{ text: data.dateTime ?? '' }], align: 'right', style: body, flex: 1 },
      ],
    });
  }
  if (data.staffName) blocks.push(text(`Served by ${data.staffName}`, small));
  if (data.memberNickname) blocks.push(text(`Member: ${data.memberNickname}`, small));

  if (fieldOn(template, 'receipt', 'itemizedLines') && data.lines.length > 0) {
    blocks.push(divider());
    for (const line of data.lines) {
      blocks.push({
        k: 'columns',
        gapDots: 8,
        cells: [
          {
            runs: [
              { text: `${line.qty}× `, style: { weight: 'bold' } },
              { text: line.name },
            ],
            align: 'left',
            style: body,
            flex: 1,
          },
          {
            runs: [{ text: line.price ?? '' }],
            align: 'right',
            style: body,
            widthDots: valueColumnDots(SIZE.body),
          },
        ],
      });
      // Item notes ride with their line and are not gated on a receipt.
      if (line.note) blocks.push(text(`  ${line.note}`, small));
    }
  }

  if (fieldOn(template, 'receipt', 'taxServiceBreakdown')) {
    blocks.push(divider());
    if (data.subtotal) blocks.push(moneyRow('Subtotal', data.subtotal));
    if (data.service) blocks.push(moneyRow('Service', data.service));
    if (data.vat) blocks.push(moneyRow('VAT (incl.)', data.vat));
    blocks.push({ k: 'rule', style: 'solid', thicknessDots: 1 });
    blocks.push(moneyRow('TOTAL', data.total, true));
  }

  if (data.tenders?.length) {
    blocks.push(space(4));
    for (const tender of data.tenders) blocks.push(moneyRow(tender.label, tender.amount));
  }

  if (data.bandCodes?.length) {
    blocks.push(divider());
    blocks.push(text('Bands issued', { sizeDots: SIZE.small, weight: 'bold', tracking: 1 }));
    for (const code of data.bandCodes) blocks.push(text(`• ${code}`, small));
  }

  if (fieldOn(template, 'receipt', 'voucherInfo') && data.creditGrants?.length) {
    blocks.push(divider());
    blocks.push(text('Credit issued', { sizeDots: SIZE.small, weight: 'bold', tracking: 1 }));
    for (const grant of data.creditGrants) blocks.push(text(`• ${grant}`, small));
  }

  if (data.orderNote) {
    blocks.push(divider());
    blocks.push(text(data.orderNote, small));
  }

  blocks.push(...footerBlocks(template));

  return {
    media: { kind: 'receipt', widthDots: device.widthDots, dpi: 203 },
    paddingDots: 8,
    blocks,
    finish: { feedDots: 96, cut: 'partial' },
  };
}
