import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  OptionRowFields,
  onePriceFieldValue,
  optionPricesDiffer,
  priceFromOneField,
  twoPricesNote,
} from '../src/lifted/components/admin/modifiers/OptionPriceFields';
import { formatWWPrice } from '../src/lifted/lib/pricingMode';

/**
 * SCRUM-1039 — the option editor: a wide name and one price. Saving one price
 * writes the same value to the stored weekday and weekend price; an option that
 * holds two different prices keeps them until a price is typed.
 */

const noop = () => undefined;
const row = (price: { weekday: number; weekend: number }, cost = '') =>
  renderToStaticMarkup(
    createElement(OptionRowFields, {
      name: 'Extra long option name that must stay readable',
      price,
      cost,
      onName: noop,
      onPrice: noop,
      onCost: noop,
      onRemove: noop,
    }),
  );

describe('option row', () => {
  it('gives the name the full row and shows one price field and the cost', () => {
    const html = row({ weekday: 20, weekend: 20 }, '8');
    const nameInput = html.match(/<input[^>]*aria-label="Option name"[^>]*>/)?.[0] ?? '';
    expect(nameInput.includes(" w-full ")).toBe(true);
    expect(html).toContain('aria-label="Option price delta"');
    expect(html).not.toContain('weekday price delta');
    expect(html).not.toContain('weekend price delta');
    expect(html).toContain('aria-label="Option cost"');
    expect(html).toContain('value="8"');
    expect(html.indexOf('Option name')).toBeLessThan(html.indexOf('Option price delta'));
    expect(html.indexOf('Option price delta')).toBeLessThan(html.indexOf('Option cost'));
  });

  it('keeps the price and cost fields at the width they had beside the old price pair', () => {
    const html = row({ weekday: 20, weekend: 20 }, '8');
    for (const label of ['Option price delta', 'Option cost']) {
      const input = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
      expect(input, label).toMatch(/class="(?:[^"]* )?w-16(?: [^"]*)?"/);
      expect(input, label).not.toMatch(/(?:^|[" ])w-24[" ]/);
    }
  });

  it('shows the single stored price when weekday and weekend agree', () => {
    expect(onePriceFieldValue({ weekday: 20, weekend: 20 })).toBe(20);
    expect(row({ weekday: 20, weekend: 20 })).not.toContain('wknd');
  });

  it('writes one typed price to both stored fields', () => {
    expect(priceFromOneField('35')).toEqual({ weekday: 35, weekend: 35 });
    expect(priceFromOneField('')).toEqual({ weekday: 0, weekend: 0 });
  });

  it('leaves two different stored prices visible, with the field empty', () => {
    const price = { weekday: 10, weekend: 25 };
    expect(optionPricesDiffer(price)).toBe(true);
    expect(onePriceFieldValue(price)).toBe('');
    expect(twoPricesNote(price)).toBe('฿10 / ฿25 wknd');
    expect(row(price)).toContain('฿10 / ฿25 wknd. Type a price to set both.');
  });

  it('writes the two prices as the admin lists write a price pair, thousands grouped', () => {
    const price = { weekday: 1500, weekend: 2000 };
    expect(twoPricesNote(price)).toBe(formatWWPrice(price));
    expect(twoPricesNote(price)).toBe(`฿${(1500).toLocaleString()} / ฿${(2000).toLocaleString()} wknd`);
  });
});
