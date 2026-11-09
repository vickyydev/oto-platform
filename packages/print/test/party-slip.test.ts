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
 * party's heading, its room and children, and READY BY; a sale's ticket
 * carries none of them and prints exactly as it did.
 */
describe('a party slip on the prep ticket', () => {
  const slip: PrepTicketData = {
    title: 'Kitchen',
    heading: 'Birthday party',
    orderRef: "Mali's 6th",
    time: '11:00',
    details: ['Room: Party room 1', 'Children: 10'],
    readyBy: '13:40',
    lines: [
      { qty: 3, name: 'Margherita' },
      { qty: 2, name: 'French fries' },
      { name: 'Hawaiian' },
    ],
  };

  it('prints the heading, the party by name, its details and READY BY before the dishes', () => {
    const text = textOf(slip);
    for (const part of ['BIRTHDAY PARTY', "Mali's 6th", 'Room: Party room 1', 'Children: 10', 'READY BY 13:40']) {
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

  it('prints no READY BY time when the kitchen plan has no kids’ food time, only the note in its place', () => {
    const noTime: PrepTicketData = { ...slip, readyBy: undefined, readyByNote: "No kids' food time in the OTO App" };
    const text = textOf(noTime, 'bar_ticket');
    expect(text).not.toContain('READY BY');
    expect(text).toContain("No kids' food time in the OTO App");
    expect(text.indexOf("No kids' food time in the OTO App")).toBeLessThan(text.indexOf('Margherita'));
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
