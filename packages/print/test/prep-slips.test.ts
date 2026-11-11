import { describe, expect, it } from 'vitest';
import { renderJob, type PrepTicketData } from '../src/index';
import { PROFILES, SLIP_FIXTURES, TEMPLATES } from './fixtures';

const escpos576 = PROFILES.escpos576!;

/** Every string a printout put on the page, in order. */
function textOf(data: PrepTicketData, kind: 'kitchen_ticket' | 'bar_ticket' = 'kitchen_ticket'): string {
  const job = renderJob({ kind, data }, { device: escpos576, templates: [] });
  return job.layout.items
    .filter((i) => i.k === 'text')
    .map((i) => (i as { text: string }).text)
    .join('\n');
}

/** The inverted bands a printout drew: the VOID or UPDATED banner is one the width of the paper. */
function bandsOf(data: PrepTicketData, kind: 'kitchen_ticket' | 'bar_ticket' = 'kitchen_ticket') {
  const job = renderJob({ kind, data }, { device: escpos576, templates: [] });
  return job.layout.items.filter((i) => i.k === 'invert') as { x: number; y: number; w: number; h: number }[];
}

/**
 * SCRUM-861 — a void slip and an updated-items slip are the prep ticket with
 * the word banded under the header, the order line forced on, and the "voided
 * by" lines; a plain ticket carries none of them and prints exactly as it did.
 */
describe('a void or updated slip on the prep ticket', () => {
  const voided: PrepTicketData = {
    title: 'VOID — Kitchen',
    variant: 'void',
    orderRef: '42',
    time: '14:52',
    holderName: 'Mali',
    details: ['Voided by Nok', 'Refund T1-R-000003'],
    lines: [{ qty: 1, name: 'Hot dog', note: 'no onions' }],
    orderNote: 'Birthday table',
  };

  it('bands the word the width of the paper, before the order line and the dishes', () => {
    const bands = bandsOf(voided);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.w).toBe(escpos576.widthDots - 2 * 8);
    const text = textOf(voided);
    expect(text).toContain('VOID');
    expect(text.indexOf('VOID')).toBeLessThan(text.indexOf('#42'));
    expect(text.indexOf('#42')).toBeLessThan(text.indexOf('Hot dog'));
    for (const part of ['VOID — KITCHEN', '#42', '14:52', 'Voided by Nok', 'Refund T1-R-000003', 'Mali', 'Hot dog', 'no onions', 'Birthday table']) {
      expect(text).toContain(part);
    }
  });

  it('names the order even where the branch switched the order line off its kitchen template', () => {
    const template = { ...TEMPLATES.find((t) => t.type === 'kitchen_ticket')!, fields: { itemizedLines: true, orderRefTime: false } };
    const job = renderJob({ kind: 'kitchen_ticket', data: voided }, { device: escpos576, templates: [template] });
    const text = job.layout.items.filter((i) => i.k === 'text').map((i) => (i as { text: string }).text).join('\n');
    expect(text).toContain('#42');
  });

  it("an updated party slip keeps the party's heading and name, its details and READY BY, under the UPDATED band", () => {
    const updated: PrepTicketData = {
      title: 'UPDATED — Bar',
      variant: 'updated',
      heading: 'Birthday party',
      orderRef: "Mali's 6th",
      time: '11:32',
      details: ['Plan changed in the OTO App', 'Room: Party room 1'],
      readyBy: '13:40',
      lines: [{ qty: 1, name: 'Juice pitcher' }],
    };
    const text = textOf(updated, 'bar_ticket');
    expect(bandsOf(updated, 'bar_ticket')).toHaveLength(1);
    expect(text.indexOf('UPDATED')).toBeLessThan(text.indexOf('BIRTHDAY PARTY'));
    expect(text).toContain("Mali's 6th");
    expect(text).not.toContain("#Mali's 6th");
    expect(text.indexOf('Plan changed in the OTO App')).toBeLessThan(text.indexOf('READY BY 13:40'));
    expect(text.indexOf('READY BY 13:40')).toBeLessThan(text.indexOf('Juice pitcher'));
  });

  it('a plain ticket draws no band: nothing printed before this change moved', () => {
    const plain: PrepTicketData = { title: 'Kitchen', orderRef: '42', time: '14:41', lines: [{ qty: 1, name: 'Hot dog' }] };
    expect(bandsOf(plain)).toHaveLength(0);
    expect(textOf(plain)).not.toMatch(/VOID|UPDATED/);
  });

  it('the committed fixtures are a void kitchen slip and an updated bar slip', () => {
    expect(SLIP_FIXTURES.map((f) => [f.name, f.job.kind, (f.job.data as PrepTicketData).variant])).toEqual([
      ['void-kitchen', 'kitchen_ticket', 'void'],
      ['updated-bar', 'bar_ticket', 'updated'],
    ]);
  });
});
