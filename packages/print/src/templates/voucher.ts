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
  SIZE,
  body,
  divider,
  footerBlocks,
  headerBlocks,
  moneyRow,
  small,
  space,
  text,
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

export function buildCreditVoucher({
  template,
  data,
  device,
}: CreditVoucherInput): PrintDocument {
  const blocks: Block[] = [...headerBlocks(template, 'Credit Voucher')];

  if (fieldOn(template, 'credit_voucher', 'creditVoucherBalance')) {
    blocks.push(divider());
    blocks.push(moneyRow('Credit loaded', data.balance ?? bahtText(data.balanceTHB), true));
    blocks.push(text('Scan wristband or QR at the F&B counter to spend.', small));
  }

  if (data.holderName) {
    blocks.push(space(2));
    blocks.push(text(`For ${data.holderName}`, body));
  }

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
