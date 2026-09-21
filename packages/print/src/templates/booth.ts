/**
 * The Lucky Wheel booth voucher.
 *
 * No prototype to port, because the outgoing booth printed nothing at all: the
 * television showed a QR, the visitor opened it on a phone, and Radar allocated
 * a four-digit code (`docs/features/booth.md`). The paper is new. What it
 * carries is fixed by two documents that agree with each other:
 *
 *   - the specification quoted in `docs/features/booth.md` — "logo, prize in
 *     Thai and English, QR, short code, issue time and booth, expiry per
 *     prize, terms";
 *   - the printed sample in `docs/architecture/DEVICE_INVENTORY.md` §7, shared
 *     on 2026-09-20, which supplies the exact wording of the venue line, the
 *     "★ YOU WON ★" banner, the redemption sentence and the footer.
 *
 * The line `Single use · ใช้ได้ 1 ครั้ง` is the shortest argument for this whole
 * package: it is Thai, on a voucher the park is already handing to visitors,
 * and there is no Thai code page on the hardware to print it with. It goes
 * through the same shaper as every other string here and reaches the head as
 * dots, which is also what lets a prize name be Thai, English or both.
 *
 * ## The width is an assumption: 576 dots, and nothing has measured it
 *
 * The booth printer is **not in `DEVICE_INVENTORY.md` §2**. That table lists
 * six printers and every one of them is at the park on `192.168.88.0/24`; the
 * booth stands in a shopping centre behind a box of its own, and its model, its
 * address and its dots per line are recorded in no repository document. §7 says
 * 80 mm receipt stock, so it is an ESC/POS unit — and that is as far as the
 * evidence goes. **576 is the number this layout is drawn against and the
 * committed fixture is rendered at, and it is an assumption, not a fact.**
 *
 * It is not even the only number an 80 mm unit takes. §9.3's C260 family is
 * 576 dots per line, but §9.4 quotes the XP-80 range's own specification as
 * "576 dots/line **or** 512 dots/line", and §9.4 also records that the Windows
 * driver name identifies nothing because many models install as "XP-80C". So
 * the answer comes off the printer's self-test page and nowhere else, and until
 * somebody holds one, both numbers are live.
 *
 * It is written here rather than left implicit because of how it fails.
 * `GS v 0` discards raster data wider than the print area **and reports
 * nothing** (D6, and the note on `DeviceProfile` in `document.ts`): point a
 * 576-dot profile at a 512-dot head and the right-hand 8 mm of every voucher is
 * simply never laid down. No exception, no `overflow` note, nothing on the
 * print-job row — a voucher in a visitor's hand with its right edge missing and
 * no trace of it anywhere in the system. WHAT is missing depends on what the
 * voucher says, which is why the test below measures it rather than reasoning
 * about it.
 *
 * Two things follow. Neither is a promise this file can keep:
 *
 *   - the profile has to come from the device record once somebody measures the
 *     booth printer and puts it in §2 — never from this comment, and never from
 *     a template, because width is a property of the head (`document.ts`);
 *   - `booth-voucher.escpos512` in `test/fixtures/` is the same voucher laid
 *     out for a 512-dot head, so the two can be put side by side without
 *     hardware. It is not a simulation of the failure above — a *correct* 512
 *     layout is not what a 576 layout looks like truncated — but it does show
 *     that the content survives the narrower head when the profile is right.
 *
 * What the 576-dot layout would actually lose on a 512-dot head is measured
 * rather than guessed, in `templates.test.ts` → "what a wrong width costs":
 * every item of the rendered layout is checked against the narrower head's
 * 512-dot limit, and the test names which ones cross it.
 */

import type { Block, DeviceProfile, PrintDocument } from '../document';
import type { BoothVoucherData } from './data';
import { SIZE, divider, logoBlock, small, smallBold, space, text } from './common';

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

export function buildBoothVoucher({ data, device }: BoothVoucherInput): PrintDocument {
  const blocks: Block[] = [
    // The park's mark. Unconditional, unlike every other printout's logo:
    // `TEMPLATE_FOR_KIND.booth_voucher` is undefined (`templates/model.ts`), so
    // there is no `showLogo` toggle to read and nothing at the booth that could
    // set one. A voucher redeemed at a counter in a different building is the
    // last printout that should be able to come out unbranded.
    logoBlock(),
    space(4),
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
  for (const line of data.terms) {
    blocks.push(text(line, small, 'center'));
  }
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
  blocks.push(fact('Staff', data.staff ?? 'Not signed in'));
  blocks.push(fact('Expires', data.expiresAt ?? 'No expiry'));

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
      { runs: [{ text: label }], align: 'left', style: small, widthDots: FACT_LABEL_DOTS },
      { runs: [{ text: value }], align: 'left', style: smallBold, flex: 1 },
    ],
  };
}
