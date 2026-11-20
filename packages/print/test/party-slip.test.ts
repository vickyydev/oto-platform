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

/**
 * SCRUM-1051 — a dish's or group's serving time on the slip: lines sharing a
 * group and time print together under a small heading of the group's name and
 * time; a dish with a time and no group prints the time beside it; a line with
 * no time prints exactly as before.
 */
describe('serving times on a party slip', () => {
  const timed: PrepTicketData = {
    title: 'Kitchen',
    heading: 'Birthday party',
    orderRef: "Mali's 6th",
    time: '11:00',
    details: ['Room: Party room 1', 'Children: 10'],
    readyBy: '13:40',
    lines: [
      { qty: 3, name: 'Margherita' },
      { qty: 10, name: 'Chicken nuggets', time: '12:30' },
      { qty: 2, name: 'Fruit skewers', time: '13:00', group: 'ZZ Dessert' },
      { qty: 10, name: 'Mini waffles', time: '13:00', group: 'ZZ Dessert' },
      { qty: 1, name: 'Our Cake', note: 'Cake time 15:00', time: '15:00', group: 'ของหวาน' },
    ],
  };
  type Placed = Extract<ReturnType<typeof renderJob>['layout']['items'][number], { k: 'text' }>;
  const items = (data: PrepTicketData) =>
    renderJob({ kind: 'kitchen_ticket', data }, { device: escpos576, templates: [] }).layout.items.filter(
      (i): i is Placed => i.k === 'text',
    );

  it('a group prints one small heading of its name and time, before its lines, and a second group gets its own', () => {
    const text = textOf(timed);
    expect(text.match(/ZZ Dessert/g)).toHaveLength(1);
    expect(text.indexOf('ZZ Dessert')).toBeLessThan(text.indexOf('Fruit skewers'));
    expect(text.indexOf('Fruit skewers')).toBeLessThan(text.indexOf('Mini waffles'));
    expect(text.indexOf('Mini waffles')).toBeLessThan(text.indexOf('ของหวาน'));
    expect(text.indexOf('ของหวาน')).toBeLessThan(text.indexOf('Our Cake'));
    const heading = items(timed).find((i) => i.text === 'ZZ Dessert')!;
    const dish = items(timed).find((i) => i.text.startsWith('Fruit skewers'))!;
    expect(heading.style.sizeDots).toBeLessThan(dish.style.sizeDots);
    // The group's time sits on the heading's own row, at the right (each cell
    // measures its own ink, so the two baselines may differ by a dot).
    const headingTime = items(timed).find((i) => i.text === '13:00' && Math.abs(i.baselineY - heading.baselineY) <= 1)!;
    expect(headingTime).toBeDefined();
    expect(headingTime.x).toBeGreaterThan(heading.x);
  });

  it('a dish with its own time and no group prints the time beside it, on the same row', () => {
    const all = items(timed);
    const dish = all.find((i) => i.text.startsWith('Chicken nuggets'))!;
    const beside = all.find((i) => i.text === '12:30')!;
    expect(Math.abs(beside.baselineY - dish.baselineY)).toBeLessThanOrEqual(1);
    expect(beside.x).toBeGreaterThan(dish.x);
    expect(beside.style.sizeDots).toBe(dish.style.sizeDots);
  });

  it('a line with no time prints exactly as before, and a note under a timed line prints as any note', () => {
    const without: PrepTicketData = { ...timed, lines: timed.lines.map(({ time: _t, group: _g, ...rest }) => rest) };
    const before = textOf(without);
    expect(before).not.toContain('12:30');
    expect(before).not.toContain('ZZ Dessert');
    expect(textOf({ ...timed, lines: [timed.lines[0]!] })).toBe(textOf({ ...without, lines: [without.lines[0]!] }));
    expect(textOf(timed)).toContain('Cake time 15:00');
  });

  it('on 80 mm paper a long dish name wraps inside its own column, never under the time', () => {
    const long: PrepTicketData = {
      ...timed,
      lines: [{ qty: 10, name: 'Mini waffles with whipped cream and strawberries and chocolate sauce', time: '13:00' }],
    };
    const all = items(long);
    const time = all.find((i) => i.text === '13:00')!;
    const name = long.lines[0]!.name;
    const nameRows = all.filter((i) => i.text.trim().length > 0 && i.text !== '13:00' && name.includes(i.text.trim()));
    expect(nameRows.length).toBeGreaterThan(1);
    for (const row of nameRows) expect(row.x + row.widthDots).toBeLessThanOrEqual(time.x);
    const job = renderJob({ kind: 'kitchen_ticket', data: long }, { device: escpos576, templates: [] });
    expect(job.overflow).toEqual([]);
  });
});
