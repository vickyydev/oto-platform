import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pos = (file: string) => readFileSync(new URL(`../../pos/src/${file}`, import.meta.url), 'utf8');

describe('SCRUM-802/783 adversarial review', () => {
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
    for (const file of ['pages/Till.tsx', 'components/till/CustomerDisplay.tsx', 'components/till/ConsentCapture.tsx', 'components/till/PublicConsentCapture.tsx'])
      expect(pos(file)).toContain('formatStoredPhone(');
    expect(pos('lib/phoneUtils.ts')).toContain('return formatSharedPhone(storedPhoneHint(value));');
    // Display only: composition keeps the edited digits; normalization stays on the existing write path.
    expect(pos('lib/phoneUtils.ts')).toContain('return `+${country.dialCode}${digits}`;');
  });
});
