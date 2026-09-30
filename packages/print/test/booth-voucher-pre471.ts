/**
 * The booth voucher template AS IT WAS before SCRUM-471 — a frozen copy of
 * `src/templates/booth.ts` at commit 1807e922, kept as a test oracle and
 * nothing else. Nothing in `src/` imports it.
 *
 * SCRUM-471 gave each booth five choices over its slip, and promised that a
 * booth which makes none prints exactly what every booth printed before.
 * `booth-voucher-slip.test.ts` holds the template to that promise against this
 * copy, document and ESC/POS bytes, across data shapes the committed fixture
 * alone does not cover. Never edit this file to make that test pass: a
 * difference there is a change to every booth's paper.
 */

import type { Block, DeviceProfile, PrintDocument } from '../src/document';
import type { BoothVoucherData } from '../src/templates/data';
import { SIZE, divider, logoBlock, small, smallBold, space, text } from '../src/templates/common';

export interface BoothVoucherInput {
  data: BoothVoucherData;
  device: DeviceProfile;
}

/** The label column of the fact rows, in dots. Fits "Expires" at `SIZE.small`. */
const FACT_LABEL_DOTS = 90;

/**
 * Dots per QR module.
 *
 * A booth voucher is scanned across a reception counter rather than held up to
 * a till, so it gets the largest code of any printout here — 8 dots against the
 * credit voucher's 6. A ten-character code encodes as a 21-module QR, which is
 * 168 dots at this size and leaves room on a 512-dot head as well as a 576-dot
 * one. The layout shrinks a QR that does not fit and records why
 * (`layout.ts`), so a longer payload degrades and is reported rather than
 * overrunning the paper.
 */
const QR_MODULE_DOTS = 8;

export function buildBoothVoucherBefore471({ data, device }: BoothVoucherInput): PrintDocument {
  const blocks: Block[] = [
    // The park's mark. Unconditional, unlike every other printout's logo:
    // `TEMPLATE_FOR_KIND.booth_voucher` is undefined (`templates/model.ts`), so
    // there is no `showLogo` toggle to read and nothing at the booth that could
    // set one. A voucher redeemed at a counter in a different building is the
    // last printout that should be able to come out unbranded.
    logoBlock(),
    space(4),
    text(data.venueLine, { sizeDots: SIZE.body, weight: 'bold' }, 'center'),
  ];

  // A copy staff asked for says so at the top, where reception looks first:
  // two slips with one code is only a puzzle if nothing says which is which.
  if (data.reprintNote) {
    blocks.push(text(data.reprintNote, smallBold, 'center'));
  }

  blocks.push(
    space(4),
    text('★ YOU WON ★', { sizeDots: SIZE.header, weight: 'bold', tracking: 2 }, 'center'),
    space(4),
    text(data.prizeLine, { sizeDots: SIZE.total, weight: 'bold' }, 'center'),
  );

  if (data.prizeLineThai) {
    blocks.push(text(data.prizeLineThai, { sizeDots: SIZE.body, weight: 'bold' }, 'center'));
  }

  blocks.push(divider());
  blocks.push(text(data.redemptionLine, small, 'center'));
  blocks.push(divider());

  // The payload and the readable text are the same string, taken from the same
  // field: a slip whose QR and printed code disagree is a voucher reception
  // cannot honour either way.
  blocks.push({
    k: 'qr',
    value: data.voucherCode,
    moduleDots: QR_MODULE_DOTS,
    ecc: 'M',
    align: 'center',
  });
  blocks.push(text(data.voucherCode, { sizeDots: SIZE.header, weight: 'bold' }, 'center'));

  blocks.push(divider());
  blocks.push(fact('Issued', data.issuedAt));
  blocks.push(fact('Booth', data.booth));
  // Both rows always print. An absent row and a row reading "nobody" are the
  // same slip to whoever is holding it, so the template says which.
  blocks.push(fact('Staff', data.staff ?? 'unattributed'));
  blocks.push(fact('Expires', data.expiresAt ?? 'No expiry'));

  blocks.push(divider());
  blocks.push(text('Single use · ใช้ได้ 1 ครั้ง', smallBold, 'center'));
  /**
   * The foot of the slip is the voucher definition's terms (SCRUM-223), a
   * line each, English then Thai — "Cannot be combined with other offers." —
   * so what the park promised about this prize is the last thing printed.
   * They used to sit under the redemption sentence while the footer line
   * stayed blank on every booth, because no template can set it.
   */
  for (const line of data.terms) {
    blocks.push(text(line, small, 'center'));
  }
  // A footer a branch template may add one day; nothing prints for an empty one.
  if (data.footerLine.trim() !== '') {
    blocks.push(text(data.footerLine, small, 'center'));
  }

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
      { runs: [{ text: label }], align: 'left', style: small, widthDots: FACT_LABEL_DOTS },
      { runs: [{ text: value }], align: 'left', style: smallBold, flex: 1 },
    ],
  };
}
