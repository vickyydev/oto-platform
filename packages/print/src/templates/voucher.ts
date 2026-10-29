/**
 * Credit vouchers and item vouchers, both on the station's receipt printer.
 *
 * The credit voucher follows `PrintTemplatePreview.tsx:101-149`: logo, header,
 * the constant sub-title "Credit Voucher", the credit figure, the line telling
 * the guest they can spend with the QR instead of the band, then the QR and its
 * key as text, then the footer. One voucher per `fnb_credit` grant
 * (`printRouting.tsx:86-119`), and the QR resolves the same wallet the band
 * does — exactly one wallet per grant, for adults and kids alike.
 *
 * A sale no longer prints them as slips of their own: the receipt carries one
 * `creditVoucherSection` per wallet above its footer, so the guest is handed
 * one slip with one cut. The voucher on its own remains for a wallet's credit
 * printed by itself.
 *
 * The item voucher has **no template type of its own**. It borrows
 * `credit_voucher` and honours only its `creditVoucherQr` toggle
 * (`printRouting.tsx:127-133`), which means today it cannot have its own header
 * text, footer or fields. Giving it a real type is a recommendation for S2-06;
 * until then this mirrors the prototype exactly so nothing changes behind the
 * park's back.
 */

import type { Block, DeviceProfile, PrintDocument } from '../document';
import type { CreditVoucherData, ItemVoucherData } from './data';
import type { PrintTemplate } from './model';
import { fieldOn } from './model';
import {
  RECEIPT_TYPE,
  SIZE,
  divider,
  footerBlocks,
  headerBlocks,
  small,
  space,
  text,
  type TypeScale,
} from './common';

/** "฿150" for whole baht, "฿150.50" otherwise — `formatTHB` in `@oto/shared`, which this package does not import. */
function bahtText(baht: number | undefined): string {
  if (baht === undefined || !Number.isFinite(baht)) return '';
  const whole = Number.isInteger(baht);
  return `฿${baht.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export interface CreditVoucherInput {
  template?: PrintTemplate;
  data: CreditVoucherData;
  device: DeviceProfile;
}

/**
 * What one credit voucher says, below its header: the credit and how to spend
 * it, the holder, the band it is also on, and the QR with its key as text.
 *
 * Drawn by the credit voucher itself and — once per wallet — at the foot of
 * the sale's receipt (`templates/receipt.ts`), so the paper a guest gets with
 * one cut says exactly what the separate slip said. `template` is the
 * branch's `credit_voucher` template either way: its two toggles govern this
 * section wherever it prints.
 */
export function creditVoucherSection(
  template: PrintTemplate | undefined,
  data: CreditVoucherData,
  type: TypeScale = RECEIPT_TYPE,
): Block[] {
  const blocks: Block[] = [];
  if (fieldOn(template, 'credit_voucher', 'creditVoucherBalance')) {
    blocks.push(divider(type.ruleDots));
    // The figure on a line of its own, in the total's size: beside its label
    // in a money row, "Credit loaded" at that size wraps on an 80 mm head.
    blocks.push(text('Credit loaded', type.body, 'center'));
    blocks.push(text(data.balance ?? bahtText(data.balanceTHB), type.total, 'center'));
    blocks.push(text('Scan wristband or QR at the F&B counter to spend.', type.small, 'center'));
  }

  if (data.holderName) {
    blocks.push(space(2));
    blocks.push(text(`For ${data.holderName}`, type.body, 'center'));
  }
  if (data.bandCode) blocks.push(text(`Band ${data.bandCode}`, type.body, 'center'));

  if (fieldOn(template, 'credit_voucher', 'creditVoucherQr') && data.qrCode) {
    blocks.push(divider(type.ruleDots));
    blocks.push({
      k: 'qr',
      value: data.qrCode,
      moduleDots: 6,
      ecc: 'M',
      align: 'center',
      caption: [{ text: data.qrCode }],
      captionStyle: type.small,
    });
  }
  return blocks;
}

/**
 * A credit voucher on its own slip — what printing one wallet's credit asks
 * for (`printVoucherCredit` in the api). A sale's credit prints on its
 * receipt instead. Drawn in the receipt's type, because it comes out of the
 * same printer and is read by the same guest.
 */
export function buildCreditVoucher({
  template,
  data,
  device,
}: CreditVoucherInput): PrintDocument {
  const blocks: Block[] = [
    ...headerBlocks(template, 'Credit Voucher', RECEIPT_TYPE),
    ...creditVoucherSection(template, data, RECEIPT_TYPE),
    ...footerBlocks(template, RECEIPT_TYPE),
  ];

  return {
    media: { kind: 'receipt', widthDots: device.widthDots, dpi: 203 },
    paddingDots: 8,
    blocks,
    finish: { feedDots: 96, cut: 'partial' },
  };
}

export interface ItemVoucherInput {
  /** The `credit_voucher` template, which is what the prototype reads. */
  template?: PrintTemplate;
  data: ItemVoucherData;
  device: DeviceProfile;
}

export function buildItemVoucher({ template, data, device }: ItemVoucherInput): PrintDocument {
  const blocks: Block[] = [...headerBlocks(template, 'Item Voucher')];

  blocks.push(divider());
  blocks.push(
    text(`${data.label} ×${data.quantity}`, { sizeDots: SIZE.total, weight: 'bold' }, 'center'),
  );
  blocks.push(text('Collect at the F&B or merch counter.', small, 'center'));

  // Only `creditVoucherQr` is honoured — `printRouting.tsx:127-133`.
  if (fieldOn(template, 'credit_voucher', 'creditVoucherQr') && data.qrCode) {
    blocks.push(divider());
    blocks.push({
      k: 'qr',
      value: data.qrCode,
      moduleDots: 6,
      ecc: 'M',
      align: 'center',
      caption: [{ text: data.qrCode }],
    });
  }

  blocks.push(...footerBlocks(template));

  return {
    media: { kind: 'receipt', widthDots: device.widthDots, dpi: 203 },
    paddingDots: 8,
    blocks,
    finish: { feedDots: 96, cut: 'partial' },
  };
}
