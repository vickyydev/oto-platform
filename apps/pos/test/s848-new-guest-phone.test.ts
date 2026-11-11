import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COUNTRY } from '@/data/countries';
import { composePhone, formatStoredPhone } from '@/lib/phoneUtils';

/**
 * SCRUM-848 — THE "NEW GUEST — ENTER NAME" DIALOG SHOWS THE NUMBER AS THE OTHER
 * TILL SCREENS DO.
 *
 * SCRUM-783 gave the till one way to show a number that has been entered —
 * `formatStoredPhone`, the stored form in international grouping — and used it
 * on the staff mirror of the customer's details, the "New member?" offer and
 * the agreement forms. The dialog that asks for a new guest's name still
 * printed the number as it was composed: "+660898020001", with the local
 * trunk 0 the platform does not store.
 *
 * The dialog is written inline in `pages/Till.tsx`, so its line is read as
 * text here, the way s783-number-display reads the "New member?" offer.
 */

const till = readFileSync(new URL('../src/pages/Till.tsx', import.meta.url), 'utf8');
const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

/** One dialog of the till's markup, from its title to the end of its description. */
const dialogDescription = (title: string): string => {
  const from = till.indexOf(title);
  expect(from, title).toBeGreaterThan(0);
  return till.slice(from, till.indexOf('</DialogDescription>', from));
};

describe('SCRUM-848: the New guest dialog shows the phone number in the till’s one format', () => {
  const local = '0898020001'; // ZZ TEST number used only by this fixture.
  const raw = '+660898020001';

  it('what the dialog now prints for the number as the customer screen composes it', () => {
    expect(composePhone(DEFAULT_COUNTRY, local)).toBe(raw);
    expect(formatStoredPhone(raw)).toBe('+66 89 802 0001');
    expect(formatStoredPhone(raw)).not.toContain('+660');
  });

  it('the dialog passes the number through the formatter, and nowhere prints it raw', () => {
    const dialog = dialogDescription('New guest — enter name');
    expect(dialog).toContain('Phone <span className="font-medium text-foreground">{formatStoredPhone(customerPhone)}</span> is not');
    expect(dialog).toContain("recognised. Enter the guest's name to register them so they're remembered next time.");
    expect(dialog).not.toContain('{customerPhone}');
    // No screen of the till prints the composed number as text any more.
    expect(till).not.toMatch(/>\s*\{customerPhone(\.trim\(\))?\}\s*</);
  });

  it('it is the same call the "New member?" offer makes', () => {
    expect(dialogDescription('New member?')).toContain('{formatStoredPhone(customerPhone)}</span>. Create one');
  });

  it('display only: the number the till holds, looks up and saves is not rewritten', () => {
    // The formatter is applied where the number is printed, never where it is kept or sent.
    expect(till).not.toMatch(/setCustomerPhone\(\s*formatStoredPhone\(/);
    expect(till).not.toMatch(/phone:\s*formatStoredPhone\(/);
  });

  it('the two staff mirror cards and the "Stored as" hint are as they were', () => {
    expect(src('components/till/StepAwaitCustomer.tsx')).toContain("{formatStoredPhone(phone) || <span className=\"text-muted-foreground/50\">—</span>}");
    expect(src('components/till/StepIdentify.tsx')).toContain("{formatStoredPhone(phone) || <span className=\"text-muted-foreground/50\">—</span>}");
    const input = src('components/shared/PhoneInput.tsx');
    expect(input).toContain("const storedAsLabel = translate ? t('phoneInput.storedAs') : 'Stored as:';");
    expect(input).toContain('storedPhoneHint(');
    expect(input).not.toContain('formatStoredPhone(');
  });
});
