/**
 * Kids and adult wristbands.
 *
 * One builder for both, because the prototype has one wristband branch
 * (`PrintTemplatePreview.tsx:34-98`) and the two types differ only in their
 * applicable fields: the adult template has no `allergyLine` at all, and its
 * seed has `holderName: false`.
 *
 * No logo and no header, ever: the OTO mark is pre-printed on the band stock
 * (`PrintTemplatePreview.tsx:46-47`), and the editor hides those controls for
 * band types (`TemplateEditor.tsx:29-32`). Footer text *is* editable for a band
 * but the preview never draws it — an inconsistency carried over rather than
 * quietly fixed, because fixing it would change what the park sees printed.
 *
 * The scan mark changes here, and deliberately. The prototype chose a 1D
 * barcode on purpose — "a thin band suits a barcode far better than a square
 * QR" (`components/till/Barcode.tsx:2-6`) — but the signed band code is a
 * station-prefixed ULID plus an HMAC (D4) and does not fit a 1D strip at a
 * scannable module width. So the QR is primary and the short human-readable
 * code goes underneath. On a band wide enough for two dots per module that
 * short code is also printed as Code 128, so the Zebra reads both; on a 25 mm
 * band it is text only, because a one-dot narrow bar is 0.125 mm and will not
 * read reliably. The visible label of the field is still "Barcode", which is a
 * design change the owner has to see — the plan routes it to CP3.
 */

import type { Block, DeviceProfile, PrintDocument } from '../document';
import type { BandData } from './data';
import type { PrintTemplate, PrintTemplateType } from './model';
import { fieldOn } from './model';
import {
  SIZE,
  allergyBlock,
  bodyBold,
  joinDot,
  small,
  smallBold,
  space,
  text,
} from './common';

export type BandType = Extract<PrintTemplateType, 'kids_wristband' | 'adult_wristband'>;

export interface BandInput {
  template?: PrintTemplate;
  type: BandType;
  data: BandData;
  device: DeviceProfile;
}

/** Below this the Code 128 narrow bar would be one dot, which will not scan. */
const MIN_BARCODE_MODULE_DOTS = 2;

export function buildBand({ template, type, data, device }: BandInput): PrintDocument {
  const width = device.widthDots;
  const blocks: Block[] = [];

  if (fieldOn(template, type, 'holderName') && data.holderName) {
    blocks.push(text(data.holderName, { sizeDots: SIZE.bandName, weight: 'bold' }));
  }

  if (fieldOn(template, type, 'supervisionBadge') && data.supervisionMode) {
    blocks.push({
      k: 'invert',
      inline: true,
      padDots: 3,
      children: [
        text(data.supervisionMode, { sizeDots: SIZE.bandBody, weight: 'bold', tracking: 2 }),
      ],
    });
  }

  const timeBits = joinDot([
    fieldOn(template, type, 'startEndTime') && data.startEndTime,
    fieldOn(template, type, 'durationTime') && data.duration,
  ]);
  if (timeBits) blocks.push(text(timeBits, { sizeDots: SIZE.bandBody, weight: 'bold' }));

  const metaBits = joinDot([
    fieldOn(template, type, 'partyName') && data.partyName,
    fieldOn(template, type, 'dietaryRequirement') && data.dietaryRequirement,
  ]);
  if (metaBits) blocks.push(text(metaBits, small));

  if (fieldOn(template, type, 'assignedNannyName') && data.assignedNannyName) {
    blocks.push(text(`Nanny: ${data.assignedNannyName}`, small));
  }

  // Applicable on the kids band only; `fieldOn` returns false for the adult
  // type because the field is not in its APPLICABLE_FIELDS list.
  if (fieldOn(template, type, 'allergyLine') && data.allergy) {
    blocks.push(space(2));
    blocks.push(allergyBlock(`ALLERGY: ${data.allergy}`));
  }

  if (fieldOn(template, type, 'qr') && data.bandCode) {
    blocks.push(space(4));
    blocks.push({
      k: 'qr',
      value: data.bandCode,
      // 4 dots per module is 0.5 mm, comfortably above what a phone camera or
      // the Zebra needs; the layout reduces it if the band is too narrow and
      // says so in `overflow`.
      moduleDots: 4,
      ecc: 'M',
      align: 'center',
    });
    if (data.shortCode) {
      const moduleDots = Math.floor(width / codeWidthModules(data.shortCode));
      if (moduleDots >= MIN_BARCODE_MODULE_DOTS) {
        blocks.push({
          k: 'barcode',
          symbology: 'code128',
          value: data.shortCode,
          heightDots: 48,
          moduleDots: Math.min(3, moduleDots),
          hri: 'none',
          align: 'center',
        });
      }
      blocks.push(text(data.shortCode, smallBold, 'center'));
    }
    blocks.push(text('SCAN', { sizeDots: 14, weight: 'regular', tracking: 3 }, 'center'));
  }

  const media = device.media;
  return {
    media: {
      kind: 'label',
      widthDots: width,
      heightDots: media ? Math.round(media.lengthMm * 8) : undefined,
      dpi: 203,
    },
    paddingDots: 6,
    blocks,
    // No cutter and no drawer on a band printer; `SET TEAR ON` does the rest.
    finish: { copies: 1, cut: 'none' },
  };
}

/** Modules a Code 128 of this content needs, worst case (set B throughout). */
function codeWidthModules(value: string): number {
  return (value.length + 3) * 11 + 2;
}

/** A bold body style, exported so the test page can match the band's look. */
export const bandTextStyle = bodyBold;
