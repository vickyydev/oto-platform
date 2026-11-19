import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pos = (file: string) => readFileSync(new URL(`../../pos/src/${file}`, import.meta.url), 'utf8');

describe('SCRUM-802/783 adversarial review', () => {
  it('LOW FINDING fixed: staff mirrors use the shared display formatter instead of the raw prefix', () => {
    for (const file of ['components/till/StepAwaitCustomer.tsx', 'components/till/StepIdentify.tsx'])
      expect(pos(file)).toContain('formatStoredPhone(phone)');
  });

  it('MEDIUM FINDING fixed: both History layouts reuse the F&B field rule', () => {
    for (const file of ['pages/History.tsx', 'components/mobile/history/MobileHistory.tsx', 'components/fnb/ScanWristband.tsx']) {
      const source = pos(file);
      expect(source).toContain('useScanField(');
      expect(source).not.toContain('nextPacedRun(');
      expect(source).toContain('data-reads-scans=""');
    }
  });

  it('MEDIUM FINDING fixed: leaving the field cancels an unanswered paste timer', () => {
    const field = pos('lib/useScanField.ts');
    expect(field).toContain('if (!active) reset();');
    expect(field).toContain('return reset;');
    expect(field).toContain('void latest.current(typed)');
    expect(field).toContain('event.nativeEvent.isComposing');
  });

  it('MEDIUM FINDING fixed: a paid time charge refreshes the containing list on both layouts', () => {
    for (const file of ['pages/History.tsx', 'components/mobile/history/MobileHistory.tsx'])
      expect(pos(file)).toContain('onExtensionPaid={() => setReread((value) => value + 1)}');
    for (const file of ['components/history/SaleDetail.tsx', 'components/mobile/history/MobileTransactionDetail.tsx'])
      expect(pos(file)).toContain('onPaid: props.onExtensionPaid');
    expect(pos('components/history/SaleExtensions.tsx')).toMatch(/setFlash\(`Added[^\n]+\n\s*onPaid\?\.\(\);/);
  });

  it('LOW FINDING fixed: every reported label, including the paired agreements, formats the stored number', () => {
    // SCRUM-1018 (the owner's answer of 19 November, replacing SCRUM-863's
    // field) — the till's own drop-off and nanny form (ConsentCapture.tsx)
    // shows the number again, read-only, with no tick: that line is a
    // reported label too, so it must show the stored number formatted.
    for (const file of ['pages/Till.tsx', 'components/till/CustomerDisplay.tsx', 'components/till/PublicConsentCapture.tsx', 'components/till/ConsentCapture.tsx'])
      expect(pos(file)).toContain('formatStoredPhone(');
    expect(pos('components/till/ConsentCapture.tsx')).toMatch(/data-testid="consent-kept-phone">\s*<div[^>]*>\{formatStoredPhone\(parentPhone\)\}<\/div>/);
    expect(pos('components/shared/PhoneInput.tsx')).toContain('{storedPhoneHint(value)}');
    expect(pos('lib/phoneUtils.ts')).toContain('return formatSharedPhone(storedPhoneHint(value));');
    // Display only: composition keeps the edited digits; normalization stays on the existing write path.
    expect(pos('lib/phoneUtils.ts')).toContain('return `+${country.dialCode}${digits}`;');
  });
});
