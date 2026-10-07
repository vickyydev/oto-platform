import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { benefitsApi } from '@/api/benefits';
import { buildItemCartPayload, type ItemCartIdentity } from '@/api/sales';
import { readBenefitScan, type StationScanEvent } from '@/lib/scanChannel';
import type { FnbOrderLine, ManualDiscount } from '@/types';

/**
 * S2-21 (SCRUM-218) round 3 — the F&B order station's staff benefit on the
 * platform (plan docs/progress/plans/benefits/PLAN.md §8 round 3).
 *
 *   - the acceptance's grep: no benefit function is imported from `mockApi`
 *     anywhere in apps/pos (H16's till half);
 *   - the scan dialog keeps the prototype's words and asks the platform;
 *   - the order carries the QR and the scan's id to the platform, never a
 *     "Staff benefit" row of its own (the platform refuses one);
 *   - a box-checked QR read at the counter's scanner reaches the order.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every name a file imports from the mock API, with where. */
function mockApiImports(): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](?:@\/mockApi|(?:\.\.?\/)+mockApi)['"]/g;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      for (const raw of match[2]!.split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
        if (name) found.push({ file: relative(SRC, file), name });
      }
    }
  }
  return found;
}

describe('the grep: no benefit function from mockApi in apps/pos', () => {
  it('finds the imports it is looking for, and none of them is a benefit', () => {
    const imports = mockApiImports();
    // The walk has to be finding imports, or the assertion under it is empty.
    expect(imports.length).toBeGreaterThan(10);
    expect(imports.filter((i) => /benefit/i.test(i.name))).toEqual([]);
  });

  it('names every benefit function the mock still defines, so a rename cannot slip past', () => {
    const mock = readFileSync(join(SRC, 'mockApi.ts'), 'utf8');
    const defined = [...mock.matchAll(/export (?:const|function) (\w*[Bb]enefit\w*)/g)].map((m) => m[1]!);
    expect(defined).toEqual(
      expect.arrayContaining(['previewStaffBenefit', 'commitStaffBenefit', 'attachBenefitAuditOrderId']),
    );
    const imported = new Set(mockApiImports().map((i) => i.name));
    expect(defined.filter((name) => imported.has(name))).toEqual([]);
  });

  it('the order station and the scan dialog work nothing out themselves', () => {
    // The code, not the prose: a comment may name the prototype's function it replaced.
    const code = (file: string) =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const station = code(join(SRC, 'pages', 'OrderStation.tsx'));
    const dialog = code(join(SRC, 'components', 'fnb', 'BenefitScanModal.tsx'));
    for (const text of [station, dialog]) {
      expect(text).not.toMatch(/previewStaffBenefit|commitStaffBenefit|attachBenefitAuditOrderId/);
      expect(text).not.toMatch(/findOperatorByBenefitQrCode|getEffectiveBenefitProfile/);
      expect(text).not.toContain("from '@/lib/benefits'");
    }
  });
});

describe('the scan dialog keeps the prototype’s words and asks the platform', () => {
  const dialog = readFileSync(join(SRC, 'components', 'fnb', 'BenefitScanModal.tsx'), 'utf8');

  it('is the prototype’s dialog', () => {
    expect(dialog).toContain('<DialogTitle>Scan staff benefit</DialogTitle>');
    expect(dialog).toContain(
      "Scan or type the staff member's benefit QR code to apply their comp,\n            free items, credit, or discount to this order.",
    );
    expect(dialog).toContain('placeholder="Benefit QR code"');
    expect(dialog).toContain("Look up the staff member's QR in Admin → Staff Benefits.");
  });

  it('resolves the QR on the platform and shows the platform’s words, which are the prototype’s', () => {
    expect(dialog).toContain('benefitsApi.resolve(value)');
    expect(dialog).toContain('setError(err.message)');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the calls', () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  function stubFetch(answer: unknown) {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          method: String(init.method),
          headers: init.headers as Record<string, string>,
          body: typeof init.body === 'string' ? init.body : undefined,
        });
        return new Response(JSON.stringify(answer), { status: 200 });
      }),
    );
  }

  it('resolve carries the QR and no key; taking it off a sale carries one; the log is a read', async () => {
    stubFetch({});
    await benefitsApi.resolve('OTO-BEN:v1:abc');
    await benefitsApi.removeFromSale('0199a7b0-0000-7000-8000-0000000005a1', 'press-1');
    await benefitsApi.applications();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/benefits/resolve',
      'DELETE /api/sales/0199a7b0-0000-7000-8000-0000000005a1/benefit',
      'GET /api/benefits/applications',
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ code: 'OTO-BEN:v1:abc' });
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined();
    expect(calls[1]!.headers['idempotency-key']).toBe('press-1');
  });
});

describe('the order carries the QR, never a "Staff benefit" row of its own', () => {
  const identity: ItemCartIdentity = {
    branchId: '0199a7b0-0000-7000-8000-0000000000b1',
    stationId: '0199a7b0-0000-7000-8000-0000000000c1',
    tier: 'tourist',
    channel: 'fnb',
    pickupCode: '12',
    memberId: null,
    customerPhone: null,
    customerNickname: null,
    accountId: '0199a7b0-0000-7000-8000-0000000000a1',
    accountName: 'Reception',
    bandHolder: null,
  };
  const line: FnbOrderLine = {
    id: '0199a7b0-0000-7000-8000-0000000001e1',
    menuItem: {
      id: '0199a7b0-0000-7000-8000-0000000002e1',
      name: 'Iced Latte',
      category: 'drinks-coffee',
      price: { weekday: 95, weekend: 95 },
    },
    qty: 1,
    selectedModifiers: [],
    lineTotal: 95,
  };

  it('sends the QR and the scan’s id, with the relief the guest was shown', () => {
    const payload = buildItemCartPayload([line], [], identity, 0, {
      benefit: {
        applicationId: '0199a7b0-0000-7000-8000-0000000003a1',
        code: 'OTO-BEN:v1:abc',
        expectedReliefSatang: 9_500,
      },
    });
    expect(payload.benefit).toEqual({
      applicationId: '0199a7b0-0000-7000-8000-0000000003a1',
      code: 'OTO-BEN:v1:abc',
      expectedReliefSatang: 9_500,
    });
    expect(payload.manualDiscounts).toEqual([]);
    expect(payload.channel).toBe('fnb');
  });

  it('the order station builds its payload from its own discounts, the benefit row drawn only for the screen', () => {
    const station = readFileSync(join(SRC, 'pages', 'OrderStation.tsx'), 'utf8');
    expect(station).toContain('buildItemCartPayload(displayLines, manualDiscounts, orderIdentity, total, {');
    expect(station).toMatch(/benefit: \{\s*applicationId: benefit\.applicationId,\s*code: benefit\.code,/);
    // The quote hook is asked with the till's own discounts and the benefit beside them.
    expect(station).toMatch(/useItemCartQuoteWithPromos\(\{[\s\S]*?manualDiscounts,[\s\S]*?benefit: benefitPayload,/);
    const display: ManualDiscount = {
      id: 'staff-benefit',
      scope: 'order',
      type: 'fixed',
      value: 95,
      reason: 'Staff benefit',
      amountTHB: 95,
      appliedBy: 'Reception',
      appliedById: identity.accountId,
      appliedAt: '2026-10-07T10:00:00.000Z',
    };
    // Were the display row ever sent, it would go as a till row the platform refuses.
    const leaked = buildItemCartPayload([line], [display], identity, 0);
    expect(leaked.manualDiscounts.map((d) => d.reason)).toEqual(['Staff benefit']);
  });
});

describe('a QR read at this counter’s scanner', () => {
  const event = (over: Partial<StationScanEvent>): StationScanEvent => ({
    kind: 'scan',
    source: 'camera',
    codeKind: 'benefit',
    codeFingerprint: 'f',
    outcome: 'handled',
    handler: 'benefit',
    errorCode: null,
    detail: null,
    actionId: null,
    scannedAt: '2026-10-07T10:00:00.000Z',
    ...over,
  });

  it('reaches the order with whose it is, or says the box’s refusal', () => {
    expect(
      readBenefitScan(
        event({
          detail: {
            action: 'apply_benefit',
            benefitCode: 'OTO-BEN:v1:abc',
            benefit: { name: 'Khun Lek (Manager)', benefitRole: 'manager' },
          },
        }),
      ),
    ).toEqual({ ok: true, code: 'OTO-BEN:v1:abc', name: 'Khun Lek (Manager)', benefitRole: 'manager' });
    expect(
      readBenefitScan(
        event({ outcome: 'refused', handler: 'benefit', detail: { message: 'Benefit revoked: Nok’s QR no longer applies a staff benefit.' } }),
      ),
    ).toEqual({ ok: false, message: 'Benefit revoked: Nok’s QR no longer applies a staff benefit.' });
    expect(readBenefitScan(event({ codeKind: 'voucher' }))).toBeNull();
    // A handled scan the staff screen was not handed the QR for is nothing to apply.
    expect(readBenefitScan(event({ detail: { benefit: { name: 'X' } } }))).toBeNull();
  });
});
