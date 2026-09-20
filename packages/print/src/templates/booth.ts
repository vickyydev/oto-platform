/**
 * The Lucky Wheel booth voucher.
 *
 * No prototype to port: the booth is a lifted Replit app. The content is fixed
 * by `docs/architecture/DEVICE_INVENTORY.md` §7 from the sample shared on
 * 2026-09-20, and S2-07a adds the prize name in Thai and English, the issue
 * time, an expiry and terms.
 *
 * The line `Single use · ใช้ได้ 1 ครั้ง` is the shortest argument for this whole
 * package: it is Thai, on a voucher the park is already handing to visitors,
 * and there is no Thai code page on the hardware to print it with.
 *
 * The booth's printer is **not in DEVICE_INVENTORY §2** — that section lists six
 * printers, all at the park, and the booth sits at a mall booth with its own
 * box. §7 says 80 mm receipt stock, so it is an ESC/POS unit, but its model,
 * address and dots per line are unknown. Until someone adds it to the device
 * list, a booth fixture is rendered against a nominal 576-dot profile and that
 * is an assumption, not a fact.
 */

import type { Block, DeviceProfile, PrintDocument } from '../document';
import type { BoothVoucherData } from './data';
import { SIZE, divider, small, smallBold, space, text } from './common';

export interface BoothVoucherInput {
  data: BoothVoucherData;
  device: DeviceProfile;
}

export function buildBoothVoucher({ data, device }: BoothVoucherInput): PrintDocument {
  const blocks: Block[] = [
    text(data.venueLine, { sizeDots: SIZE.body, weight: 'bold' }, 'center'),
    space(4),
    text('★ YOU WON ★', { sizeDots: SIZE.header, weight: 'bold', tracking: 2 }, 'center'),
    space(4),
    text(data.prizeLine, { sizeDots: SIZE.total, weight: 'bold' }, 'center'),
  ];

  if (data.prizeLineThai) {
    blocks.push(text(data.prizeLineThai, { sizeDots: SIZE.body, weight: 'bold' }, 'center'));
  }

  blocks.push(divider());
  blocks.push(text(data.redemptionLine, small, 'center'));
  blocks.push(text(data.termsLine, small, 'center'));
  blocks.push(divider());

  blocks.push({
    k: 'qr',
    value: data.voucherCode,
    // A large QR: the booth voucher is scanned at reception across a counter.
    moduleDots: 8,
    ecc: 'M',
    align: 'center',
  });
  blocks.push(text(data.voucherCode, { sizeDots: SIZE.header, weight: 'bold' }, 'center'));

  blocks.push(divider());
  blocks.push(fact('Date', data.date));
  blocks.push(fact('Booth', data.booth));
  blocks.push(fact('Staff', data.staff));
  if (data.issuedAt) blocks.push(fact('Issued', data.issuedAt));
  if (data.expiresAt) blocks.push(fact('Expires', data.expiresAt));

  blocks.push(divider());
  blocks.push(text('Single use · ใช้ได้ 1 ครั้ง', smallBold, 'center'));
  blocks.push(text(data.footerLine, small, 'center'));

  return {
    media: { kind: 'receipt', widthDots: device.widthDots, dpi: 203 },
    paddingDots: 8,
    blocks,
    finish: { feedDots: 96, cut: 'partial' },
  };
}

function fact(label: string, value: string): Block {
  return {
    k: 'columns',
    gapDots: 8,
    cells: [
      { runs: [{ text: label }], align: 'left', style: small, widthDots: 90 },
      { runs: [{ text: value }], align: 'left', style: smallBold, flex: 1 },
    ],
  };
}
