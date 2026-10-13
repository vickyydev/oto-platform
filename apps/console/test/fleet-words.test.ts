import { describe, expect, it } from 'vitest';
import { boxRetirementOffer, commandLabel, isDrawerPulse } from '@/lib/fleetWords';

/**
 * THE DEVICES DRAWER'S PRINTING WORDS — `src/lib/fleetWords.ts` (SCRUM-208,
 * staging proof).
 *
 * Two labels the proof round found lying: a sale's receipt listed in the
 * command history as "Test print", because it rides the box's one print
 * command; and the cash-drawer pulse shown in the Printing panel as a broken
 * picture "cut off mid-job".
 */
describe('commandLabel', () => {
  it('names a platform document by what it printed, and a bare test print by its kind', () => {
    expect(
      commandLabel({ kind: 'test_print', payload: { document: 'platform', kind: 'receipt' } }),
    ).toBe('Print receipt');
    expect(
      commandLabel({
        kind: 'test_print',
        payload: { document: 'platform', kind: 'kids_wristband', reprintOf: 'root-job' },
      }),
    ).toBe("Reprint kids' wristband");
    expect(
      commandLabel({ kind: 'test_print', payload: { kind: 'test_page', deviceId: 'd' } }),
    ).toBe('Test print');
    expect(commandLabel({ kind: 'restart', payload: null })).toBe('Restart agent');
  });
});

describe('isDrawerPulse', () => {
  it('reads the simulator event first, and the five-byte shape once the event has scrolled out', () => {
    const pulse = { seq: 3, heightDots: 0, jobBytes: 5 };
    expect(
      isDrawerPulse(pulse, [{ kind: 'job.printed', detail: { seq: 3, drawerKicks: 1, bands: 0 } }]),
    ).toBe(true);
    expect(isDrawerPulse(pulse, [])).toBe(true);
    // Nothing drawn but no kick either: not the drawer.
    expect(
      isDrawerPulse({ seq: 4, heightDots: 0, jobBytes: 5 }, [
        { kind: 'job.printed', detail: { seq: 4, drawerKicks: 0, bands: 0 } },
      ]),
    ).toBe(false);
    // A receipt that also kicked the drawer is paper.
    expect(
      isDrawerPulse({ seq: 5, heightDots: 812, jobBytes: 9_000 }, [
        { kind: 'job.printed', detail: { seq: 5, drawerKicks: 1, bands: 4 } },
      ]),
    ).toBe(false);
  });
});

/**
 * SCRUM-378 — what the box drawer offers for retiring a box: out of service
 * first (reversible), removal from the list only after, and the removal's
 * refusal named before it is asked for.
 */
describe('boxRetirementOffer', () => {
  const both = { update: true, archive: true };

  it('offers only "out of service" to a box that is still in service, whatever its state', () => {
    for (const status of ['online', 'offline', 'unclaimed']) {
      expect(boxRetirementOffer({ status }, [], both)).toEqual({
        disable: true,
        restore: false,
        archive: false,
        archiveBlockedBy: null,
      });
    }
  });

  it('offers putting back and removing to a box that is out of service', () => {
    expect(boxRetirementOffer({ status: 'disabled' }, [], both)).toEqual({
      disable: false,
      restore: true,
      archive: true,
      archiveBlockedBy: null,
    });
  });

  it('names the live stations that would make the API refuse the removal', () => {
    expect(
      boxRetirementOffer({ status: 'disabled' }, [{ name: 'Till 1' }], both).archiveBlockedBy,
    ).toBe('Move or archive this box’s stations first — Till 1 still sits on it.');
    expect(
      boxRetirementOffer({ status: 'disabled' }, [{ name: 'Till 1' }, { name: 'Gate' }], both)
        .archiveBlockedBy,
    ).toBe('Move or archive this box’s stations first — Till 1, Gate still sit on it.');
  });

  it('follows each door’s own permission, and offers nothing on an archived box', () => {
    expect(
      boxRetirementOffer({ status: 'online' }, [], { update: false, archive: true }).disable,
    ).toBe(false);
    const outNoArchive = boxRetirementOffer({ status: 'disabled' }, [], {
      update: true,
      archive: false,
    });
    expect([outNoArchive.restore, outNoArchive.archive]).toEqual([true, false]);
    const outNoUpdate = boxRetirementOffer({ status: 'disabled' }, [], {
      update: false,
      archive: true,
    });
    expect([outNoUpdate.restore, outNoUpdate.archive]).toEqual([false, true]);
    expect(boxRetirementOffer({ status: 'disabled', archived: true }, [], both)).toEqual({
      disable: false,
      restore: false,
      archive: false,
      archiveBlockedBy: null,
    });
  });
});
