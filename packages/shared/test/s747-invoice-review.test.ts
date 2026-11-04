import { describe, expect, it } from 'vitest';
import { buildInvoiceNo, invoiceStationSegment, INVOICE_NO_MAX_SEQ } from '../src/payments';

const parts = { businessDate: '2026-11-04', seq: 147 };

describe('SCRUM-747: preserve invoice identity while supporting saved till codes', () => {
  it.each([
    ['T1', 'T01261104000147'], ['T2', 'T02261104000147'],
    ['PI1', 'PI1261104000147'], ['PI2', 'PI2261104000147'],
  ])('keeps %s byte-identical, with or without a sandbox prefix', (stationCode, expected) => {
    expect(buildInvoiceNo({ ...parts, stationCode })).toBe(expected);
    expect(buildInvoiceNo({ ...parts, stationCode, prefix: 'SBX' })).toBe(`SBX${expected}`);
  });

  // P1 FINDING: a valid saved code cannot open a gateway tender. Fix: compact
  // its segment without changing the date, sequence or shared invoice counter.
  it.each(['ZI7C', 'ZZ747A'])('fits the supported %s code even at both limits', stationCode => {
    const result = buildInvoiceNo({ stationCode, prefix: 'SANDB', businessDate: '2099-12-31', seq: INVOICE_NO_MAX_SEQ });
    expect(result).toMatch(/^[A-Z0-9]{20}$/);
    expect(result.endsWith('991231999999')).toBe(true);
    expect(invoiceStationSegment(stationCode)).toMatch(/^[A-Z0-9]{3}$/);
  });

  it('is stable across case and punctuation normalization and reserves WEB', () => {
    expect(invoiceStationSegment(' zi-7c ')).toBe(invoiceStationSegment('ZI7C'));
    expect(invoiceStationSegment('ZI7C')).toBe('LO7');
    expect(invoiceStationSegment('ZZ747A')).toBe('0AX');
    for (let i = 0; i < 50_000; i += 1) {
      const segment = invoiceStationSegment(`Z${i.toString(36).toUpperCase().padStart(5, '0')}`);
      expect(segment).toMatch(/^[A-Z0-9]{3}$/);
      expect(segment).not.toBe('WEB');
    }
  });

  it('still refuses an unsupported length rather than truncating it', () => {
    expect(() => buildInvoiceNo({ ...parts, stationCode: 'TOOLONG' })).toThrow();
    expect(invoiceStationSegment('TOOLONG')).toBeNull();
  });

  it('never reuses a number by wrapping a full daily sequence', () => {
    expect(() => buildInvoiceNo({ ...parts, stationCode: 'T1', seq: INVOICE_NO_MAX_SEQ + 1 })).toThrow(/outside/);
  });
});
