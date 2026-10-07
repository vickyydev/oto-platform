import { describe, expect, it } from 'vitest';
import { BENEFIT_WORDS, benefitCodeShown, benefitCredentialSigningInput } from '../src';

/**
 * S2-21 round 2 — what a refusal may say back of a benefit QR. The prototype
 * echoes whatever was scanned (`BenefitScanModal.tsx:34`); a platform QR is a
 * credential, and one refused for a reason of the box's own is still live, so
 * the echo stops before its signature wherever the words travel.
 */

const SIGNATURE =
  'Zm9yZ2VkLXNpZ25hdHVyZS1ub3QtYS1yZWFsLW9uZS1idXQtdGhlLXJpZ2h0LWxlbmd0aC0xMjM0NTY3OA';
const INPUT = benefitCredentialSigningInput({
  employeeId: '018f1d2c-0000-7000-8000-000000000a01',
  credentialId: '018f1d2c-0000-7000-8000-000000000b01',
  exp: 1_822_000_000,
  kid: '0123456789abcdef',
});
const QR = `${INPUT}.${SIGNATURE.padEnd(86, 'x')}`;

describe('benefitCodeShown', () => {
  it('echoes a benefit QR up to its signature, in every shape a scanner types it', () => {
    expect(benefitCodeShown(QR)).toBe(INPUT);
    expect(benefitCodeShown(`  ${QR}\r\n`)).toBe(INPUT);
    expect(benefitCodeShown(QR.toLowerCase())).toBe(INPUT.toLowerCase());
    // A newer format, a cut-off one and the header alone: still nothing past a dot.
    expect(benefitCodeShown(QR.replace('OTO-BEN:v1:', 'OTO-BEN:v2:'))).toBe(
      INPUT.replace('v1', 'v2'),
    );
    expect(benefitCodeShown(INPUT)).toBe(INPUT);
    expect(benefitCodeShown('OTO-BEN:OP-4')).toBe('OTO-BEN:OP-4');
  });

  it('a QR whose dot a scanner mangled is cut at the longest signing input, not shown whole', () => {
    const mangled = QR.replace('.', '>');
    const shown = benefitCodeShown(mangled);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(115);
    expect(mangled.includes(shown.slice(0, -1))).toBe(true);
    expect(shown.includes(SIGNATURE.slice(4, 12))).toBe(false);
  });

  it('anything without the header is echoed as typed — the prototype’s own words, word for word', () => {
    expect(benefitCodeShown('OTO-BENEFIT-OP-4')).toBe('OTO-BENEFIT-OP-4');
    expect(benefitCodeShown(' OP.4 ')).toBe('OP.4');
    expect(BENEFIT_WORDS.notFound('OTO-BENEFIT-OP-4')).toBe(
      'No staff benefit found for "OTO-BENEFIT-OP-4".',
    );
  });

  it('a QR with anything in front of its header is cut at its signature too (round 3)', () => {
    // The four shapes the round 2 review probed: a wedge scanner's code id, a
    // zero-width space and quotes from a pasted message, a typed label.
    for (const prefix of [']Q1', '\u200b', '"', 'QR: ', 'ß ']) {
      const shown = benefitCodeShown(`${prefix}${QR}"`);
      expect(shown, JSON.stringify(prefix)).toBe(`${prefix}${INPUT}`.trim());
      expect(shown).not.toContain(SIGNATURE.slice(0, 12));
    }
    // Lower case, mid-string, and read twice in one burst: still nothing past the first dot.
    expect(benefitCodeShown(`]q1${QR.toLowerCase()}`)).toBe(`]q1${INPUT.toLowerCase()}`);
    expect(benefitCodeShown(`]Q1${QR}${QR}`)).toBe(`]Q1${INPUT}`);
    // A mangled dot behind a prefix is cut at the longest signing input after the header.
    const mangled = benefitCodeShown(`]Q1${QR.replace('.', '>')}`);
    expect(mangled.endsWith('…')).toBe(true);
    expect(mangled.includes(SIGNATURE.slice(4, 12))).toBe(false);
    expect(BENEFIT_WORDS.notFound(`]Q1${QR}`)).toBe(`No staff benefit found for "]Q1${INPUT}".`);
  });

  it('the not-found words never carry a signature', () => {
    expect(BENEFIT_WORDS.notFound(QR)).toBe(`No staff benefit found for "${INPUT}".`);
    expect(BENEFIT_WORDS.notFound(QR)).not.toContain(SIGNATURE.slice(0, 20));
  });
});
