import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S2-21 (SCRUM-218) round 4 — THE CLOSING AUDIT'S POS HALF: no benefit screen
 * is left on a mock path (docs/progress/plans/benefits/PLAN.md §8 round 4,
 * H16). The api half — every hazard and check named to a live test, every
 * benefits route guarded — is apps/api/test/s221-r4-closing-audit.test.ts.
 *
 * Round 3's grep holds the whole app to no benefit function from `mockApi`.
 * This one holds the benefit SCREENS to more: none reads the mock catalogue's
 * benefit templates, none works a benefit out with the prototype's engine,
 * and each reads and writes through the platform's client (`@/api/benefits`)
 * or, for the reports, the analytics client.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

/** The code, not the prose: a comment may name the prototype function it replaced. */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every screen a staff benefit is shown, edited, scanned or reported on. */
const SCREENS = [
  ...readdirSync(join(SRC, 'components', 'admin', 'staff-benefits')).map((f) =>
    join('components', 'admin', 'staff-benefits', f),
  ),
  join('components', 'fnb', 'BenefitScanModal.tsx'),
  join('components', 'fnb', 'StaffBenefitBreakdown.tsx'),
  join('components', 'fnb', 'FnbConfirmation.tsx'),
  join('components', 'fnb', 'FnbCart.tsx'),
  join('pages', 'OrderStation.tsx'),
  join('components', 'admin', 'reports', 'DiscountCompReportPanel.tsx'),
];

/** The mock's benefit state, and the mock catalogue's benefit templates, by name. */
const MOCK_BENEFIT_NAMES = [
  'getBenefitAuditLog',
  'getBenefitUsage',
  'commitBenefitUsageDeltas',
  'updateOperatorBenefits',
  'findOperatorByBenefitQrCode',
  'getEffectiveBenefitProfile',
  'previewStaffBenefit',
  'commitStaffBenefit',
  'attachBenefitAuditOrderId',
  'getRoleBenefitTemplates',
  'getRoleBenefitTemplate',
  'setRoleBenefitTemplate',
  'roleBenefitTemplates',
];

/** The prototype engine's arithmetic: the platform's to do, never a screen's. */
const ENGINE_NAMES = ['applyStaffBenefits', 'resolveEffectiveBenefitProfile', 'benefitPeriodKey', 'emptyBenefitUsage'];

describe('no benefit screen is left on a mock path', () => {
  it('finds every screen it names', () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(11);
    for (const screen of SCREENS) expect(statSync(join(SRC, screen)).isFile(), screen).toBe(true);
  });

  it('no benefit screen imports a benefit function from the mock API or the mock catalogue', () => {
    for (const screen of SCREENS) {
      const text = code(join(SRC, screen));
      for (const name of MOCK_BENEFIT_NAMES) {
        expect(new RegExp(`\\b${name}\\b`).test(text), `${screen} names ${name}`).toBe(false);
      }
      // Whatever a screen still takes from the mock API is not a benefit.
      for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@\/mockApi['"]/g)) {
        expect(match[1]!, screen).not.toMatch(/benefit/i);
      }
    }
  });

  it('no benefit screen works a benefit out: the prototype engine is called nowhere on them', () => {
    for (const screen of SCREENS) {
      const text = code(join(SRC, screen));
      for (const name of ENGINE_NAMES) {
        expect(new RegExp(`\\b${name}\\b`).test(text), `${screen} calls ${name}`).toBe(false);
      }
    }
  });

  it('outside the mock itself, nothing in the app reaches the mock’s benefit state', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel === 'mockApi.ts' || rel === 'store/catalogStore.ts') continue;
      const text = code(file);
      for (const name of MOCK_BENEFIT_NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the screens that read or change a benefit do it through the platform’s client', () => {
    const viaPlatform: Record<string, RegExp> = {
      [join('components', 'admin', 'staff-benefits', 'StaffBenefitsPanel.tsx')]:
        /benefitsApi\.(templates|staff|applications|saveTemplate|templateHistory)\(/,
      [join('components', 'admin', 'staff-benefits', 'OperatorOverrideDialog.tsx')]: /benefitsApi\.saveStaff\(/,
      [join('components', 'admin', 'staff-benefits', 'BenefitQrDialog.tsx')]:
        /benefitsApi\.(credentials|credentialQr|issueCredential|revokeCredential)\(/,
      [join('components', 'fnb', 'BenefitScanModal.tsx')]: /benefitsApi\.resolve\(/,
      [join('pages', 'OrderStation.tsx')]: /benefitsApi\.removeFromSale\(|benefit:\s*\{\s*applicationId/,
      [join('components', 'admin', 'reports', 'DiscountCompReportPanel.tsx')]: /analyticsReportsApi\.discount/,
    };
    for (const [screen, pattern] of Object.entries(viaPlatform)) {
      expect(pattern.test(code(join(SRC, screen))), screen).toBe(true);
    }
  });

  it('the Audit log shows the refund the platform reports, and keeps the entry (plan Q4’s default)', () => {
    const panel = code(join(SRC, 'components', 'admin', 'staff-benefits', 'StaffBenefitsPanel.tsx'));
    expect(panel).toContain('benefitsApi.applications()');
    expect(panel).toContain('refundedTHB: row.refundedSatang / 100');
    expect(panel).toContain('{entry.refundedTHB > 0 && <> · refunded ฿{entry.refundedTHB}</>}');
  });
});
