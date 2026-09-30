import { describe, expect, it } from 'vitest';
import type {
  BoothArchivedPrize,
  BoothDraft,
  BoothPrizeDraft,
  BoothStaffRow,
  BoothStatus,
  VoucherDefinitionRow,
} from '@/components/booth/boothApi';
import { boothSetupSteps, restoreRefusal, wheelStanding } from '@/components/booth/boothState';

/**
 * THE BOOTH PAGE'S HEAD AND ITS ARCHIVED PRIZES — `src/components/booth/boothState.ts`
 * (SCRUM-468).
 *
 * What the setup checklist ticks, what the header chips say about the wheel,
 * and whether an archived prize is offered a Restore. The ticks were moved out
 * of the checklist component unchanged; these pin them so the move stays a
 * move.
 */

let nextId = 0;
function prize(over: Partial<BoothPrizeDraft> = {}): BoothPrizeDraft {
  nextId += 1;
  return {
    id: `prize-${nextId}`,
    nameEn: `Prize ${nextId}`,
    nameTh: null,
    wheelLabel: null,
    weightBp: 0,
    active: true,
    expiryDays: null,
    dailyCap: null,
    costSatang: 0,
    sliceColor: null,
    textColor: null,
    sortOrder: nextId,
    voucherDefinitionId: null,
    voucherDefinitionCode: null,
    effectiveExpiryDays: null,
    ...over,
  };
}

function draft(over: Partial<BoothDraft> = {}): BoothDraft {
  return {
    booth: { id: 'booth-1', name: 'Booth 1', branchId: 'branch-1', codePrefix: 'B1' },
    settings: {
      layoutId: 'layout-1',
      layoutName: 'Classic',
      buttonKey: ' ',
      eligibility: 'none',
      dailySpinCap: null,
      staffSessionMinutes: null,
    },
    prizes: [prize({ weightBp: 6_000 }), prize({ weightBp: 4_000 })],
    bundle: {},
    bundleHash: 'hash-1',
    published: {
      id: 'v1',
      version: 1,
      publishedAt: '2026-09-29T10:00:00.000Z',
      bundleHash: 'hash-1',
      note: null,
      publishedByAccountId: null,
    },
    changed: false,
    lastEditedAt: null,
    blockers: [],
    ...over,
  };
}

function status(printer: boolean): BoothStatus {
  return {
    booth: { id: 'booth-1', name: 'Booth 1', operatorId: 'op-1', branchId: 'branch-1' },
    box: { id: 'box-1', slot: 'b1', status: 'online', lastHeartbeatAt: null, online: true, inProcess: true },
    config: { publishedVersion: 1, publishedAt: null, runningVersion: 1 },
    printer: printer
      ? {
          deviceId: 'printer-1',
          label: 'Booth printer',
          reachability: 'reachable',
          paperStatus: 'ok',
          lastError: null,
          lastSeenAt: null,
        }
      : null,
    today: { businessDate: '2026-09-30', spins: 0, unattributed: 0, dailyCapsReached: [], spinCap: null },
    lastSpinAt: null,
  };
}

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const withPin = (over: Partial<BoothStaffRow> = {}): BoothStaffRow => ({
  accountId: 'acc-1',
  addedAt: '2026-09-01T00:00:00.000Z',
  addedBy: 'acc-0',
  hasPin: true,
  pinExpiresAt: null,
  ...over,
});

const doneOf = (steps: ReturnType<typeof boothSetupSteps>) =>
  Object.fromEntries(steps.map((s) => [s.id, s.done]));

describe('boothSetupSteps — the checklist at the head of the page', () => {
  it('ticks all six for a booth that is set up and published, in the order a booth is set up', () => {
    const steps = boothSetupSteps(draft(), status(true), [withPin()], NOW);
    expect(steps.map((s) => s.id)).toEqual([
      'booth-printer',
      'booth-station',
      'booth-settings',
      'booth-staff',
      'booth-prizes',
      'booth-publish',
    ]);
    expect(steps.every((s) => s.done)).toBe(true);
  });

  it('ticks nothing from a reading that is not in hand', () => {
    const steps = boothSetupSteps(null, null, null, NOW);
    expect(steps.some((s) => s.done)).toBe(false);
  });

  it('wants a printer, a two-character prefix and a layout', () => {
    const d = draft({
      booth: { id: 'booth-1', name: 'Booth 1', branchId: 'branch-1', codePrefix: 'b1' },
      settings: { ...draft().settings, layoutId: null },
    });
    const done = doneOf(boothSetupSteps(d, status(false), [withPin()], NOW));
    expect(done['booth-printer']).toBe(false);
    expect(done['booth-station']).toBe(false);
    expect(done['booth-settings']).toBe(false);
  });

  it('wants everybody on the booth to hold a PIN that has not expired, and at least one person', () => {
    const d = draft();
    expect(doneOf(boothSetupSteps(d, status(true), [], NOW))['booth-staff']).toBe(false);
    expect(
      doneOf(boothSetupSteps(d, status(true), [withPin(), withPin({ hasPin: false })], NOW))[
        'booth-staff'
      ],
    ).toBe(false);
    expect(
      doneOf(
        boothSetupSteps(d, status(true), [withPin({ pinExpiresAt: '2026-09-30T11:59:00.000Z' })], NOW),
      )['booth-staff'],
    ).toBe(false);
    expect(
      doneOf(
        boothSetupSteps(d, status(true), [withPin({ pinExpiresAt: '2026-10-30T00:00:00.000Z' })], NOW),
      )['booth-staff'],
    ).toBe(true);
  });

  it('counts only the prizes switched on toward 100%, and wants the draft published as it stands', () => {
    const off = draft({
      prizes: [prize({ weightBp: 6_000 }), prize({ weightBp: 4_000, active: false })],
    });
    expect(doneOf(boothSetupSteps(off, status(true), [withPin()], NOW))['booth-prizes']).toBe(false);
    const changed = draft({ changed: true });
    expect(doneOf(boothSetupSteps(changed, status(true), [withPin()], NOW))['booth-publish']).toBe(
      false,
    );
    const never = draft({ published: null });
    expect(doneOf(boothSetupSteps(never, status(true), [withPin()], NOW))['booth-publish']).toBe(false);
  });
});

describe('wheelStanding — the header chips', () => {
  it('says a booth was never published, once', () => {
    const standing = wheelStanding(draft({ published: null, changed: true }));
    expect(standing.published).toEqual({ tone: 'warn', label: 'never published' });
    expect(standing.draft).toBeNull();
  });

  it('names the published version, and whether the draft has moved since', () => {
    expect(wheelStanding(draft())).toEqual({
      published: { tone: 'ok', label: 'version 1 published' },
      draft: { tone: 'ok', label: 'draft matches the published version' },
    });
    expect(wheelStanding(draft({ changed: true })).draft).toEqual({
      tone: 'warn',
      label: 'draft has unpublished changes',
    });
  });
});

describe('restoreRefusal — whether an archived prize is offered a Restore', () => {
  const type = (over: Partial<VoucherDefinitionRow>): VoucherDefinitionRow => ({
    id: 'vt-1',
    code: 'kids-pizza',
    nameEn: 'Kids Pizza',
    nameTh: null,
    kind: 'free_item',
    valueType: 'free',
    valueSatang: null,
    valueBp: null,
    expiryDays: 30,
    costSatang: 0,
    active: true,
    archivedAt: null,
    ...over,
  });
  const archived = (over: Partial<BoothArchivedPrize> = {}): BoothArchivedPrize => ({
    ...prize({ voucherDefinitionId: 'vt-1', voucherDefinitionCode: 'kids-pizza' }),
    archivedAt: '2026-09-29T09:00:00.000Z',
    ...over,
  });

  it('offers it when its voucher type is live, switched off, unknown or absent', () => {
    expect(restoreRefusal(archived(), [type({})])).toBeNull();
    expect(restoreRefusal(archived(), [type({ active: false })])).toBeNull();
    expect(restoreRefusal(archived(), [])).toBeNull();
    expect(restoreRefusal(archived({ voucherDefinitionId: null }), [type({})])).toBeNull();
  });

  it('refuses it while its voucher type is archived, naming the type and where it comes back', () => {
    const refusal = restoreRefusal(archived(), [type({ archivedAt: '2026-09-28T00:00:00.000Z' })]);
    expect(refusal).toContain('Kids Pizza');
    expect(refusal).toContain('Voucher types');
  });
});
