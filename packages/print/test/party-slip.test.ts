import { describe, expect, it } from 'vitest';
import { renderJob, type PrepTicketData } from '../src/index';
import { PROFILES } from './fixtures';

const escpos576 = PROFILES.escpos576!;

/** Every string a printout put on the page, in order. */
function textOf(data: PrepTicketData, kind: 'kitchen_ticket' | 'bar_ticket' = 'kitchen_ticket'): string {
  const job = renderJob({ kind, data }, { device: escpos576, templates: [] });
  return job.layout.items
    .filter((i) => i.k === 'text')
    .map((i) => (i as { text: string }).text)
    .join('\n');
}

/**
 * SCRUM-805 — a party's kitchen and bar slips are the prep ticket with the
 * party's heading, its room, children and start, and READY BY; a sale's ticket
 * carries none of them and prints exactly as it did.
 */
describe('a party slip on the prep ticket', () => {
  const slip: PrepTicketData = {
    title: 'Kitchen',
    heading: 'Birthday party',
    orderRef: "Mali's 6th",
    time: '11:00',
    details: ['Room: Party room 1', 'Children: 10', 'Party starts 13:00'],
    readyBy: '13:40',
    lines: [
      { qty: 3, name: 'Margherita' },
      { qty: 2, name: 'French fries' },
      { name: 'Hawaiian' },
    ],
  };

  it('prints the heading, the party by name, its details and READY BY before the dishes', () => {
    const text = textOf(slip);
    for (const part of ['BIRTHDAY PARTY', "Mali's 6th", 'Room: Party room 1', 'Children: 10', 'Party starts 13:00', 'READY BY 13:40']) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("#Mali's 6th");
    expect(text.indexOf('READY BY 13:40')).toBeLessThan(text.indexOf('Margherita'));
    expect(text).toMatch(/3×\s*\n?Margherita/);
  });

  it('a dish the plan gives no count prints by name alone', () => {
    const text = textOf(slip);
    expect(text).toContain('Hawaiian');
    expect(text).not.toMatch(/undefined/);
  });

  it('says why READY BY is the party’s start when the plan has no food time', () => {
    const text = textOf({ ...slip, readyBy: '13:00', readyByNote: "the party's start: the kitchen plan has no food time" }, 'bar_ticket');
    expect(text).toContain('READY BY 13:00');
    expect(text).toContain("(the party's start: the kitchen plan has no food time)");
  });

  it('names the party even where the branch switched the order line off its kitchen template', () => {
    const job = renderJob(
      { kind: 'kitchen_ticket', data: slip },
      {
        device: escpos576,
        templates: [
          {
            id: 'tpl-kitchen-805',
            type: 'kitchen_ticket',
            name: 'Kitchen ticket',
            showLogo: false,
            fields: { holderName: true, allergyLine: true, itemizedLines: true, orderNotes: true },
          },
        ],
      },
    );
    const text = job.layout.items
      .filter((i) => i.k === 'text')
      .map((i) => (i as { text: string }).text)
      .join('\n');
    expect(text).toContain("Mali's 6th");
    expect(text).toContain('READY BY 13:40');
  });

  it('a sale’s ticket keeps its order number and prints no party lines', () => {
    const text = textOf({ title: 'Kitchen', orderRef: 'A12', time: '14:05', lines: [{ qty: 1, name: 'Pad Thai' }] });
    expect(text).toContain('#A12');
    expect(text).not.toContain('READY BY');
    expect(text).not.toContain('BIRTHDAY PARTY');
  });
});
