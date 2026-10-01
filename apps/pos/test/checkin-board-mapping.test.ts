import { describe, expect, it } from 'vitest';
import {
  boardChildToCheckIn,
  editsToPatch,
  nannyChoicesFor,
  type ApiBoardChild,
  type ApiBoardFamily,
  type ApiNanny,
  type CheckInEdits,
} from '@/api/checkin';
import { dueState, remainingMinutes } from '@/lib/dropoff';
import { deriveWaStatus } from '@/lib/waConnection';

/**
 * S2-13 ROUND 2 — the board's rows in the prototype's shapes.
 *
 * The DropOff page, its cards, the edit and nanny modals and round 3's
 * CheckOutModal all render the prototype's `CheckIn`; the platform answers
 * with registrations and their stays. These pin the mapping the screens rely
 * on: the timer fields (checked-in time + booked minutes, client-ticked with
 * the prototype's 15-minute amber), the contact chip, the nanny's name, the
 * picker's load that does not count the child being edited, and the edit
 * form's PATCH body carrying only what changed.
 */

const NOW = Date.parse('2026-10-01T05:00:00Z');

function child(over: Partial<ApiBoardChild> = {}): ApiBoardChild {
  return {
    id: '0190a0a0-0000-7000-8000-0000000000c1',
    registrationId: '0190a0a0-0000-7000-8000-0000000000r1',
    childId: null,
    childName: 'Mint',
    childAgeYears: 6,
    dateOfBirth: null,
    allergies: 'Peanuts',
    foodRestrictions: null,
    mayOrderFood: false,
    foodProvision: null,
    service: 'drop_off',
    status: 'in_park',
    scheduledFor: null,
    bookedMinutes: 120,
    nannyId: null,
    checkedInAt: new Date(NOW - 110 * 60_000).toISOString(),
    saleId: null,
    bandId: null,
    visitId: null,
    photoFileId: null,
    nannyName: null,
    checkedOutAt: null,
    ...over,
  };
}

function family(over: Partial<ApiBoardFamily> = {}): ApiBoardFamily {
  return {
    registrationId: '0190a0a0-0000-7000-8000-0000000000r1',
    branchId: '0190a0a0-0000-7000-8000-00000000b001',
    memberId: null,
    guardianName: 'Ploy',
    guardianPhone: '+66812345678',
    contactChannel: 'whatsapp',
    consentRecordedAt: '2026-10-01T03:00:00Z',
    source: 'till',
    photoFileId: '0190a0a0-0000-7000-8000-0000000000f1',
    createdAt: '2026-10-01T03:00:00Z',
    contact: null,
    tab: 'in_park',
    children: [],
    ...over,
  };
}

describe('boardChildToCheckIn', () => {
  it('carries the timer: amber inside 15 minutes, red when over', () => {
    const soon = boardChildToCheckIn(child(), family());
    expect(soon).toMatchObject({ status: 'in_park', bookedDurationMinutes: 120, parentName: 'Ploy', phone: '+66812345678' });
    expect(dueState(remainingMinutes(soon, NOW))).toBe('due_soon');
    const over = boardChildToCheckIn(child({ checkedInAt: new Date(NOW - 130 * 60_000).toISOString() }), family());
    expect(dueState(remainingMinutes(over, NOW))).toBe('overdue');
    const fresh = boardChildToCheckIn(child({ checkedInAt: new Date(NOW - 10 * 60_000).toISOString() }), family());
    expect(dueState(remainingMinutes(fresh, NOW))).toBe('ok');
  });

  it('shows the contact chip from the registration: unverified with no check, its status after one', () => {
    expect(deriveWaStatus(boardChildToCheckIn(child(), family()))).toBe('unverified');
    const pending = boardChildToCheckIn(child(), family({ contact: { status: 'pending', sentAt: '2026-10-01T03:01:00Z', confirmedAt: null } }));
    expect(deriveWaStatus(pending)).toBe('pending');
    expect(pending.waConnection?.sentAt).toBe('2026-10-01T03:01:00Z');
    expect(deriveWaStatus(boardChildToCheckIn(child(), family({ guardianPhone: null })))).toBeUndefined();
  });

  it("names the nanny, marks the photo on file and the consent, and keeps the board's ids", () => {
    const c = boardChildToCheckIn(
      child({ service: 'nanny', nannyId: '0190a0a0-0000-7000-8000-0000000000a1', nannyName: 'Pim' }),
      family(),
      'https://files.example/photo',
    );
    expect(c).toMatchObject({
      id: '0190a0a0-0000-7000-8000-0000000000c1',
      registrationId: '0190a0a0-0000-7000-8000-0000000000r1',
      assignedNannyId: '0190a0a0-0000-7000-8000-0000000000a1',
      assignedNannyName: 'Pim',
      serviceType: 'nanny',
      photoOnFile: true,
      childPhotoUrl: 'https://files.example/photo',
      confirmationsAccepted: true,
      allergiesMedical: 'Peanuts',
    });
  });
});

describe('nannyChoicesFor', () => {
  const roster: ApiNanny[] = [
    { id: 'pim', name: 'Pim', onShift: true, load: 2, coveredNames: ['Mint', 'Kai'] },
    { id: 'aor', name: 'Aor', onShift: false, load: 0, coveredNames: [] },
  ];

  it("does not count the child being edited against her own nanny, and an off-shift nanny is not pickable", () => {
    const choices = nannyChoicesFor(roster, { childName: 'Mint', assignedNannyId: 'pim', status: 'in_park' });
    expect(choices.find((n) => n.id === 'pim')).toMatchObject({ load: 1, coveredNames: ['Kai'], available: true });
    expect(choices.find((n) => n.id === 'aor')).toMatchObject({ available: false, onShift: false });
    expect(nannyChoicesFor(roster).find((n) => n.id === 'pim')!.load).toBe(2);
  });
});

describe('editsToPatch', () => {
  const before = boardChildToCheckIn(child(), family());
  const form = (over: Partial<CheckInEdits> = {}): CheckInEdits => ({
    childName: before.childName,
    childAge: before.childAge,
    parentName: before.parentName,
    contactMethod: before.contactMethod,
    phone: before.phone,
    serviceType: before.serviceType,
    mayOrderFood: before.mayOrderFood,
    foodRestrictions: before.foodRestrictions,
    allergiesMedical: before.allergiesMedical,
    bookedDurationMinutes: before.bookedDurationMinutes,
    assignedNannyId: before.assignedNannyId,
    ...over,
  });

  it('sends nothing for an unchanged form', () => {
    expect(editsToPatch(before, form())).toEqual({});
  });

  it('sends only the changed fields, in the platform names', () => {
    expect(
      editsToPatch(
        before,
        form({ bookedDurationMinutes: 180, serviceType: 'nanny', assignedNannyId: 'pim', allergiesMedical: '', phone: '0811110011' }),
      ),
    ).toEqual({ bookedMinutes: 180, service: 'nanny', nannyId: 'pim', allergies: null, guardianPhone: '0811110011' });
  });

  it('a cleared booked time is no booked time', () => {
    expect(editsToPatch(before, form({ bookedDurationMinutes: 0 }))).toEqual({ bookedMinutes: null });
  });
});
