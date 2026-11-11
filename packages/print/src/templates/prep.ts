/**
 * Kitchen and bar tickets.
 *
 * One builder for both, because the prototype has one shape for both: the
 * kitchen and bar templates carry identical field sets
 * (`catalogStore.ts:762-776`), the preview has one prep branch, and
 * `buildPrepTickets` (`lib/fnb.ts:213-235`) produces the same ticket with a
 * different title — `Kitchen` or `Bar` (`:204`). Splitting them here would mean
 * two copies of the same layout to keep in step.
 *
 * Routing is the caller's job and follows the effective prep station per line:
 * a per-item override, else the menu category's default; lines whose station is
 * `'none'` print nowhere and are dropped, and only stations with lines get a
 * ticket. The whole-order note prints on **both** tickets; item notes ride with
 * their own lines and so reach only the station that gets that item.
 *
 * Prices never appear on a prep ticket.
 */

import type { Block, DeviceProfile, PrintDocument } from '../document';
import type { PrepTicketData } from './data';
import type { PrintTemplate, PrintTemplateType } from './model';
import { fieldOn } from './model';
import {
  SIZE,
  allergyBlock,
  allergyText,
  body,
  bodyBold,
  divider,
  footerBlocks,
  headerBlocks,
  small,
  space,
  text,
} from './common';

export interface PrepInput {
  template?: PrintTemplate;
  type: Extract<PrintTemplateType, 'kitchen_ticket' | 'bar_ticket'>;
  data: PrepTicketData;
  device: DeviceProfile;
}

/** SCRUM-861 — the word a void or updated slip is banded with. */
const SLIP_WORD: Record<NonNullable<PrepTicketData['variant']>, string> = {
  void: 'VOID',
  updated: 'UPDATED',
};

export function buildPrepTicket({ template, type, data, device }: PrepInput): PrintDocument {
  const blocks: Block[] = [...headerBlocks(template, data.title)];

  // SCRUM-861 — a void or updated slip wears its word as a white-on-black
  // band the width of the paper, before anything else: a cook reading the
  // ticket from the rail must see it is not an order before the dishes.
  if (data.variant) {
    blocks.push(space(4));
    blocks.push({
      k: 'invert',
      padDots: 8,
      children: [text(SLIP_WORD[data.variant], { sizeDots: 40, weight: 'bold', tracking: 4 }, 'center')],
    });
    blocks.push(space(4));
  }

  // SCRUM-805 — a party's slip says so first.
  if (data.heading) {
    blocks.push(text(data.heading.toUpperCase(), { sizeDots: SIZE.header, weight: 'bold' }));
  }

  // On a party's slip this row is the party's name and when it printed — the
  // slip's own header — so it prints whatever the order-ref toggle says; a
  // void or updated slip must name the order it corrects, so it prints too.
  if (data.heading || data.variant || fieldOn(template, type, 'orderRefTime')) {
    blocks.push(divider());
    blocks.push({
      k: 'columns',
      gapDots: 8,
      cells: [
        {
          // A party's slip names the party here, not an order number.
          runs: [{ text: data.heading ? data.orderRef : `#${data.orderRef}` }],
          align: 'left',
          style: { sizeDots: SIZE.header, weight: 'bold' },
          flex: 1,
        },
        {
          runs: [{ text: data.time }],
          align: 'right',
          style: { sizeDots: SIZE.header, weight: 'bold' },
          flex: 1,
        },
      ],
    });
  }

  // SCRUM-805 — the party's room and children, then READY BY (or, when the
  // kitchen plan has no kids' food time, the note in its place), before the
  // lines, so the kitchen reads when it is due before what it is.
  for (const line of data.details ?? []) blocks.push(text(line, body));
  if (data.readyBy) {
    blocks.push(space(2));
    blocks.push(text(`READY BY ${data.readyBy}`, { sizeDots: SIZE.header, weight: 'bold' }));
  } else if (data.readyByNote) {
    blocks.push(space(2));
    blocks.push(text(data.readyByNote, small));
  }

  if (fieldOn(template, type, 'holderName') && data.holderName) {
    blocks.push({
      k: 'text',
      align: 'left',
      style: body,
      runs: [
        { text: 'For ' },
        { text: data.holderName, style: { weight: 'bold' } },
      ],
    });
  }

  // "Each prep ticket carries the band's allergy alert so prep staff see it
  // too. The real local print agent always includes the allergy line."
  // (`printRouting.tsx:171-172`)
  if (fieldOn(template, type, 'allergyLine') && data.allergiesMedical) {
    blocks.push(space(2));
    blocks.push(allergyBlock(allergyText(data.allergiesMedical, data.holderName)));
  }

  if (fieldOn(template, type, 'itemizedLines') && data.lines.length > 0) {
    blocks.push(divider());
    const showNotes = fieldOn(template, type, 'orderNotes');
    for (const line of data.lines) {
      blocks.push({
        k: 'text',
        align: 'left',
        style: bodyBold,
        runs:
          line.qty === undefined
            ? [{ text: line.name, style: { weight: 'regular' } }]
            : [{ text: `${line.qty}× ` }, { text: line.name, style: { weight: 'regular' } }],
      });
      if (line.note && showNotes) blocks.push(text(`  ${line.note}`, small));
    }
  }

  if (fieldOn(template, type, 'orderNotes') && data.orderNote) {
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
