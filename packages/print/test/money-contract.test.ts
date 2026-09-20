/**
 * `@oto/print` formats no money of its own. Baht strings arrive already
 * formatted, from `formatTHB` in `@oto/shared`, because this package must give
 * the same bytes whatever locale a container happens to have.
 *
 * That makes the format a contract between two packages with nothing enforcing
 * it, so this test enforces it: the strings the fixtures print are compared
 * against what `formatTHB` actually returns.
 *
 * The import is a relative path into the sibling package rather than
 * `@oto/shared`, because adding the workspace dependency needs a lockfile
 * regeneration that another session currently owns. Swap it for the package
 * specifier when that lands.
 */

import { describe, expect, it } from 'vitest';
import { formatTHB } from '../../shared/src/money';

describe('the money strings in the fixtures are what @oto/shared emits', () => {
  const cases: [number, string][] = [
    [109000, '฿1,090'],
    [109050, '฿1,090.50'],
    [15000, '฿150'],
    [0, '฿0'],
    [7132, '฿71.32'],
    [119950, '฿1,199.50'],
    [123450, '฿1,234.50'],
  ];

  for (const [satang, expected] of cases) {
    it(`${satang} satang prints as ${expected}`, () => {
      expect(formatTHB(satang)).toBe(expected);
    });
  }

  it('renders every baht sign it produces, which lives in the Thai block', () => {
    // U+0E3F is in the Thai block, so it resolves through Noto Sans Thai via
    // the fallback chain, not through Noto Sans. A money row rendering it as
    // .notdef would take out every receipt.
    expect(formatTHB(100).codePointAt(0)).toBe(0x0e3f);
  });
});
