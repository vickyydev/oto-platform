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
    // SCRUM-863 — the till's own drop-off and nanny form (ConsentCapture.tsx)
    // has no read-only number any more: it asks for the number again, and the
    // field shows the stored form beside what is typed (storedPhoneHint).
    for (const file of ['pages/Till.tsx', 'components/till/CustomerDisplay.tsx', 'components/till/PublicConsentCapture.tsx'])
      expect(pos(file)).toContain('formatStoredPhone(');
    expect(pos('components/till/ConsentCapture.tsx')).not.toContain('consent-kept-phone');
    expect(pos('components/shared/PhoneInput.tsx')).toContain('{storedPhoneHint(value)}');
    expect(pos('lib/phoneUtils.ts')).toContain('return formatSharedPhone(storedPhoneHint(value));');
    // Display only: composition keeps the edited digits; normalization stays on the existing write path.
    expect(pos('lib/phoneUtils.ts')).toContain('return `+${country.dialCode}${digits}`;');
  });
});
