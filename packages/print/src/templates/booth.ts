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
import { SIZE, body, divider, logoBlock, small, smallBold, space, text } from './common';

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
  if (data.design?.layout === 'showcase') return buildShowcaseVoucher(data, device);
  /**
   * The booth's own choices (SCRUM-471), each absent on a job stored before
   * they existed and each defaulting to the slip every booth printed before —
   * so a booth nobody has customised lays down the same dots it always did.
   */
  const showLogo = data.showLogo ?? true;
  const showStaff = data.showStaff ?? true;
  const showTerms = data.showTerms ?? true;
  const headerLine = data.headerLine?.trim() ?? '';

  const blocks: Block[] = [];
  // The park's mark. Still not a print template's to switch off —
  // `TEMPLATE_FOR_KIND.booth_voucher` is undefined (`templates/model.ts`) — but
  // the booth's own settings may (SCRUM-471): a booth whose paper comes
  // pre-printed with the park's mark has no use for a second one.
  if (showLogo) blocks.push(logoBlock(), space(4));
  blocks.push(text(data.venueLine, { sizeDots: SIZE.body, weight: 'bold' }, 'center'));

  // The booth's header line sits UNDER the venue line and never in its place:
  // the venue line is how reception in another building knows whose slip it is.
  if (headerLine !== '') {
    blocks.push(text(headerLine, body, 'center'));
  }

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
    value: data.legacyQrPayload ?? data.voucherCode,
    moduleDots: QR_MODULE_DOTS,
    ecc: 'M',
    align: 'center',
  });
  blocks.push(text(data.voucherCode, { sizeDots: SIZE.header, weight: 'bold' }, 'center'));

  blocks.push(divider());
  blocks.push(fact('Issued', data.issuedAt));
  blocks.push(fact('Booth', data.booth));
  // An absent row and a row reading "nobody" are the same slip to whoever is
  // holding it, so the Staff row prints "unattributed" rather than going
  // missing — unless the booth has chosen to leave the row off altogether
  // (SCRUM-471), which is then the same on every slip it prints.
  if (showStaff) blocks.push(fact('Staff', data.staff ?? 'unattributed'));
  blocks.push(fact('Expires', data.expiresAt ?? 'No expiry'));

  blocks.push(divider());
  // A shared fixed code can be redeemed more than once under its type's
  // campaign limit. Calling each printed copy single-use would be false.
  if (data.codeMode !== 'fixed' && !data.legacyQrPayload) {
    blocks.push(text('Single use · ใช้ได้ 1 ครั้ง', smallBold, 'center'));
  }
  /**
   * The foot of the slip is the voucher definition's terms (SCRUM-223), a
   * line each, English then Thai — "Cannot be combined with other offers." —
   * so what the park promised about this prize is the last thing printed.
   * They used to sit under the redemption sentence while the footer line
   * stayed blank on every booth, because no template could set it.
   *
   * The booth may leave them off (SCRUM-471). "Single use" above is not a
   * term of the prize but how the code works at reception, so it stays.
   */
  if (showTerms) {
    for (const line of data.terms) {
      blocks.push(text(line, small, 'center'));
    }
  }
  // The booth's own footer (SCRUM-471); nothing prints for an empty one.
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

/** The owner's bilingual, prize-first voucher on 80 mm paper. */
function buildShowcaseVoucher(data: BoothVoucherData, device: DeviceProfile): PrintDocument {
  const design = data.design!;
  const blocks: Block[] = [];
  if (data.showLogo !== false) blocks.push(logoBlock(), space(4));
  blocks.push(text(design.venueLine?.trim() || data.venueLine, { sizeDots: SIZE.body, weight: 'bold' }, 'center'));
  if (data.headerLine?.trim()) blocks.push(text(data.headerLine.trim(), small, 'center'));
  if (data.reprintNote) blocks.push(text(data.reprintNote, smallBold, 'center'));
  blocks.push(space(8));
  if (design.winnerLine.trim()) blocks.push(text(design.winnerLine, { sizeDots: 36, weight: 'bold' }, 'center'));
  if (design.winnerLineThai.trim()) blocks.push(text(design.winnerLineThai, { sizeDots: SIZE.body, weight: 'bold' }, 'center'));
  blocks.push(space(5), text(data.prizeLine, { sizeDots: 42, weight: 'bold' }, 'center'));
  if (data.prizeLineThai) blocks.push(text(data.prizeLineThai, { sizeDots: 34, weight: 'bold' }, 'center'));
  blocks.push(space(9), divider(), space(6));
  for (const line of data.redemptionLine.split('\n').map((line) => line.trim()).filter(Boolean)) {
    blocks.push(text(line, { sizeDots: SIZE.body, weight: 'bold' }, 'center'));
  }
  blocks.push(space(8), {
    k: 'qr', value: data.legacyQrPayload ?? data.voucherCode, moduleDots: 10, ecc: 'M', align: 'center',
  });
  if (design.codeLabel.trim()) blocks.push(text(design.codeLabel, smallBold, 'center'));
  blocks.push(text(data.voucherCode, { sizeDots: SIZE.header, weight: 'bold' }, 'center'));
  blocks.push(space(7), divider(), space(5));
  blocks.push({
    k: 'columns', gapDots: 12,
    cells: [
      { runs: [{ text: `${design.issuedLabel}\n${data.issuedDate ?? data.issuedAt}` }], align: 'center', style: smallBold, flex: 1 },
      { runs: [{ text: `${design.expiresLabel}\n${data.expiresAt ?? 'No expiry'}` }], align: 'center', style: smallBold, flex: 1 },
    ],
  });
  blocks.push(space(6), divider(), space(5));
  if (data.showTerms !== false) {
    if (design.termsLabel.trim()) blocks.push(text(design.termsLabel, smallBold, 'center'));
    let n = 1;
    if (data.codeMode !== 'fixed' && !data.legacyQrPayload && design.singleUseLabel.trim()) {
      blocks.push(text(`${n++}. ${design.singleUseLabel}`, small, 'left'));
    }
    const en = data.termsEn ?? data.terms;
    const th = data.termsTh ?? [];
    for (let i = 0; i < Math.max(en.length, th.length); i += 1) {
      if (en[i]) blocks.push(text(`${n++}. ${en[i]}`, small, 'left'));
      else if (th[i]) blocks.push(text(`${n++}. ${th[i]}`, small, 'left'));
      if (th[i] && en[i]) blocks.push(text(th[i]!, small, 'left'));
    }
  }
  if (data.showStaff !== false && data.staff) blocks.push(text(`Staff: ${data.staff}`, small, 'left'));
  if (data.footerLine.trim()) blocks.push(space(5), text(data.footerLine, small, 'center'));
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
