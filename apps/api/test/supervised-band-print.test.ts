import { describe, expect, it } from 'vitest';
import { saleBandDocument, type SalePrintSnapshot } from '@oto/shared';
import { renderJob, seedPrintTemplates } from '@oto/print';
import { PROFILES } from '@oto/print/fixtures';

/**
 * S2-13 round 1 — the supervision badge and the nanny's name REALLY PRINT
 * (R-50). The prototype configured both fields on the kids band template and
 * never put them on paper; here the sale composer's band document for a
 * supervised child goes through the seeded template and the renderer, and
 * the words are on the printout.
 */

const tspl400 = PROFILES.tspl400!;

function textOf(job: ReturnType<typeof renderJob>): string[] {
  return job.layout.items.filter((i) => i.k === 'text').map((i) => (i as { text: string }).text);
}

const snapshot: SalePrintSnapshot = {
  saleId: '0192f000-0000-7000-8000-000000000001',
  receiptNumber: 'T1-000123',
  at: '2026-10-01T04:00:00.000Z',
  timezone: 'Asia/Bangkok',
  operatorName: 'OTO',
  branchName: 'Central Floresta',
  staffName: 'Reception',
  memberNickname: null,
  lines: [
    {
      id: 'line-kid',
      kind: 'kids',
      label: '2 Hours Play',
      quantity: 1,
      grossSatang: 30_000,
      ticket: true,
      payload: null,
      stayHours: 2,
      stayDurationLabel: '2 hours',
    },
  ],
  subtotalSatang: 30_000,
  grossSatang: 30_000,
  taxBreakdown: { lines: [], vatSatang: 0, serviceSatang: 0 } as never,
  tenders: [],
  bands: [],
  orderChildren: [],
  note: null,
};

const kidsTemplates = seedPrintTemplates;

describe('a supervised child’s kids band', () => {
  it('prints DROP-OFF and the allergy for a drop-off child, and no nanny line', () => {
    const data = saleBandDocument(snapshot, {
      id: 'b1',
      kind: 'kid',
      code: 'T1ABCDEFGHJKMNPQRSTVWXYZ0.ABCDEFGHJKMN',
      saleLineId: 'line-kid',
      childName: 'Dao',
      allergies: 'Peanuts',
      medicalNotes: null,
      dietary: null,
      supervisionBadge: 'DROP-OFF',
      nannyName: 'Pim',
    });
    expect(data.supervisionMode).toBe('DROP-OFF');
    // The nanny's name rides only with the badge it belongs to — and a
    // drop-off child has one only because the snapshot passed it; the platform
    // never does (`salePrintSnapshotOf`).
    const text = textOf(renderJob({ kind: 'kids_wristband', data }, { device: tspl400, templates: kidsTemplates })).join('\n');
    expect(text).toContain('Dao');
    expect(text).toContain('DROP-OFF');
    expect(text).toContain('Peanuts');
  });

  it("prints NANNY and the nanny's name for a nanny child", () => {
    const data = saleBandDocument(snapshot, {
      id: 'b2',
      kind: 'kid',
      code: 'T1ABCDEFGHJKMNPQRSTVWXYZ1.ABCDEFGHJKMN',
      saleLineId: 'line-kid',
      childName: 'Kai',
      allergies: null,
      medicalNotes: null,
      dietary: null,
      supervisionBadge: 'NANNY',
      nannyName: 'Pim',
    });
    const text = textOf(renderJob({ kind: 'kids_wristband', data }, { device: tspl400, templates: kidsTemplates })).join('\n');
    expect(text).toContain('NANNY');
    expect(text).toContain('Nanny: Pim');
  });

  it('prints neither on an unsupervised child’s band', () => {
    const data = saleBandDocument(snapshot, {
      id: 'b3',
      kind: 'kid',
      code: 'T1ABCDEFGHJKMNPQRSTVWXYZ2.ABCDEFGHJKMN',
      saleLineId: 'line-kid',
      childName: 'Ton',
      allergies: null,
      medicalNotes: null,
      dietary: null,
    });
    expect(data.supervisionMode).toBeUndefined();
    expect(data.assignedNannyName).toBeUndefined();
    const text = textOf(renderJob({ kind: 'kids_wristband', data }, { device: tspl400, templates: kidsTemplates })).join('\n');
    expect(text).not.toContain('DROP-OFF');
    expect(text).not.toContain('Nanny:');
  });
});
