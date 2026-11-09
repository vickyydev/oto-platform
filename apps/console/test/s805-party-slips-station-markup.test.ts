import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PARTY_SLIPS_STATION_SENTENCE, PartySlipsStationField } from '@/components/PartySlipsStationField';

/**
 * SCRUM-805 — the branch editor names the station whose kitchen and bar
 * printers receive the party slips, and says the park tags it later.
 */

const stations = [
  { id: 'station-1', name: 'Reception Till 1' },
  { id: 'station-2', name: 'Counter 2' },
];
const markup = (props: Partial<Parameters<typeof PartySlipsStationField>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PartySlipsStationField, {
      value: '',
      stations,
      error: null,
      fieldClass: 'field',
      onChange: () => undefined,
      ...props,
    }),
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe('Party slips printer station', () => {
  it('offers the park’s stations and none, and says the park tags it later', () => {
    const html = markup();
    expect(html).toContain('Party slips printer station');
    expect(html).toContain('<option value="" selected="">Not named yet</option>');
    expect(html).toContain('<option value="station-1">Reception Till 1</option>');
    expect(html).toContain('<option value="station-2">Counter 2</option>');
    expect(html).toContain(PARTY_SLIPS_STATION_SENTENCE);
    expect(PARTY_SLIPS_STATION_SENTENCE).toMatch(/tags this later/);
    expect(PARTY_SLIPS_STATION_SENTENCE).toMatch(/no printer/);
  });

  it('shows the station named now, and holds the choice while the stations are read', () => {
    expect(markup({ value: 'station-1' })).toContain('<option value="station-1" selected="">Reception Till 1</option>');
    const reading = markup({ value: 'station-9', stations: null });
    expect(reading).toMatch(/<select[^>]*disabled/);
    expect(reading).toContain('The station named now');
  });

  it('says when the stations could not be read', () => {
    expect(markup({ stations: null, error: 'The park’s stations could not be read.' })).toContain(
      'The park’s stations could not be read.',
    );
  });

  it('the branch editor sends it only when it changed, and null for none', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/pages/Branches.tsx', import.meta.url)), 'utf8');
    expect(source).toContain(
      "if (slipsStation !== (branch.partySlipsStationId ?? '')) body.partySlipsStationId = slipsStation || null;",
    );
    expect(source).toContain('<PartySlipsStationField');
  });
});
