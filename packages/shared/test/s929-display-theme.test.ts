import { describe, expect, it } from 'vitest';
import { STATION_DISPLAY_THEMES, StationSessionDocumentSchema } from '../src/station-session';

/**
 * SCRUM-929 — the paired display's look rides on the station document's
 * envelope as ONE optional field. Null means no till has told the box one yet;
 * absent means a box from before the field. A reader from before the field
 * drops it and reads the rest of the document as it always did.
 */
describe('the station document carries a paired display look (SCRUM-929)', () => {
  const document = {
    stationId: '018f0000-0000-7000-8000-000000000001', boxId: '018f0000-0000-7000-8000-000000000002',
    schemaVersion: 1, sequence: 7, stage: 'welcome', step: null, cart: null, member: null, totals: null,
    payment: null, prompt: null, language: 'th', lease: null, takeoverCount: 0, updatedAt: '2026-11-12T03:00:00.000Z',
  };

  it('is light or dark, and nothing else', () => {
    expect([...STATION_DISPLAY_THEMES]).toEqual(['light', 'dark']);
    for (const theme of STATION_DISPLAY_THEMES) expect(StationSessionDocumentSchema.parse({ ...document, theme }).theme).toBe(theme);
    for (const theme of ['blue', '', 'Light', 1, {}]) expect(StationSessionDocumentSchema.safeParse({ ...document, theme }).success).toBe(false);
  });

  it('says null for a box never told one, and leaves the field out for a box from before it', () => {
    const told = StationSessionDocumentSchema.parse({ ...document, theme: null });
    expect('theme' in told).toBe(true);
    expect(told.theme).toBeNull();
    const older = StationSessionDocumentSchema.parse(document);
    expect('theme' in older).toBe(false);
    expect(older.language).toBe('th');
  });

  it('is dropped harmlessly by a reader from before the field', () => {
    const OlderDocumentSchema = StationSessionDocumentSchema.omit({ theme: true });
    const read = OlderDocumentSchema.parse({ ...document, theme: 'light' });
    expect('theme' in read).toBe(false);
    expect(read).toEqual(OlderDocumentSchema.parse(document));
  });
});
