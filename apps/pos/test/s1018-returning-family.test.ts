import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LastPhotoChoice, SupervisionGate, type SupervisedSlot } from '@/components/till/SupervisionGate';
import {
  agreementsOnlyForm,
  photoReuseFor,
  prefillGate,
  profileGuardianName,
  slotPhotoState,
  ticketKidsDefault,
  visitingChildren,
  waiverCovers,
  withCoveringSiblingsPlain,
  type LastPhotoState,
} from '@/lib/returningFamily';
import { slotPatchFromSavedChild } from '@/lib/savedChildren';
import type { SavedChild, SupervisionPolicy } from '@/types';
import { renderHook } from './support/hooks';

/**
 * SCRUM-1018 — A RETURNING FAMILY IN THREE STEPS (the owner's answers of 19
 * November, docs/progress/plans/dropoff-beo-20261119/ANSWERS.md §2): the
 * phone number, the saved children with ticks, the three agreements, pay.
 *
 * - The children staff tick as visiting are the form's children and the
 *   ticket's kids count (they took the saved list in its order before).
 * - The parent's name comes from the family's profile.
 * - The last visit's photo is shown to staff with "Still matches" or "Take a
 *   new one"; a child with no earlier photo has one taken as before.
 * - After a waiver the covering sibling plays on a normal ticket: no free
 *   drop-off form, straight to payment.
 */

vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
beforeEach(() => { vi.stubGlobal('React', React); });

const policy: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'confirm-15min', text: 'ZZ TEST within 15 minutes', required: true, order: 0 }],
};
const slot = (id: string, extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id, sourceLineId: 'zz-1018-line', ticketType: {} as SupervisedSlot['ticketType'],
  name: '', age: '', waived: false, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, optIn: true, ...extra,
});
const saved = (id: string, childName: string, childAge: number, extra: Partial<SavedChild> = {}): SavedChild =>
  ({ id, childName, childAge, ...extra }) as SavedChild;

// ZZ TEST children of one demo family, in the order the profile holds them.
const MAI = saved('zz-child-mai', 'ZZ TEST Mai', 6, { allergiesMedical: 'ZZ TEST peanuts' });
const TOM = saved('zz-child-tom', 'ZZ TEST Tom', 10);
const BEN = saved('zz-child-ben', 'ZZ TEST Ben', 3);
const SAVED = [MAI, TOM, BEN];

describe('the ticked children decide', () => {
  it('are the ticked ones, in the saved list’s order; null when the check was skipped', () => {
    expect(visitingChildren(SAVED, [BEN.id, TOM.id])?.map((c) => c.id)).toEqual([TOM.id, BEN.id]);
    expect(visitingChildren(SAVED, [])).toEqual([]);
    expect(visitingChildren(SAVED, null)).toBeNull();
  });

  it('fill the form’s places, already confirmed: no review when they fill every place', () => {
    // Tom and Ben ticked; Mai (first on the profile) stays home.
    const out = prefillGate([slot('p1'), slot('p2')], SAVED, [TOM.id, BEN.id]);
    expect(out.slots.map((s) => s.savedChildId)).toEqual([TOM.id, BEN.id]);
    expect(out.slots.map((s) => s.name)).toEqual(['ZZ TEST Tom', 'ZZ TEST Ben']);
    expect(out.confirmedIds).toEqual(['p1', 'p2']);
    expect(out.review).toBe(false);
  });

  it('a place left for a new child still opens the review, the ticked ones confirmed', () => {
    const out = prefillGate([slot('p1'), slot('p2')], SAVED, [MAI.id]);
    expect(out.slots.map((s) => s.savedChildId)).toEqual([MAI.id, undefined]);
    expect(out.confirmedIds).toEqual(['p1']);
    expect(out.review).toBe(true);
  });

  it('with the check skipped the gate fills from the saved list and reviews, as before', () => {
    const out = prefillGate([slot('p1'), slot('p2')], SAVED, null);
    expect(out.slots.map((s) => s.savedChildId)).toEqual([MAI.id, TOM.id]);
    expect(out.confirmedIds).toEqual([]);
    expect(out.review).toBe(true);
  });

  it('a first visit has nothing to review', () => {
    const out = prefillGate([slot('p1')], [], [MAI.id]);
    expect(out.slots[0]!.savedChildId).toBeUndefined();
    expect(out.review).toBe(false);
  });

  it('never carries a photo, and a care note goes with its own child only', () => {
    const out = prefillGate([slot('p1', { childPhotoUrl: 'data:image/png;base64,AAAA' })], SAVED, [MAI.id]);
    expect(out.slots[0]!.childPhotoUrl).toBeUndefined();
    expect(out.slots[0]!.allergiesMedical).toBe('ZZ TEST peanuts');
    const tom = prefillGate([slot('p1')], SAVED, [TOM.id]);
    expect(tom.slots[0]!.allergiesMedical).toBe('');
  });

  it('are the ticket’s kids count, on the first line with children only', () => {
    expect(ticketKidsDefault([], [MAI.id, TOM.id])).toBe(2);
    expect(ticketKidsDefault([{ kids: 2 }], [MAI.id, TOM.id])).toBe(1);
    expect(ticketKidsDefault([{ kids: 0 }], [MAI.id, TOM.id])).toBe(2);
    expect(ticketKidsDefault([], [])).toBe(1);
    expect(ticketKidsDefault([], null)).toBe(1);
  });
});

describe('the parent’s name from the profile', () => {
  it('is the found member’s name; a first visit or an unnamed profile is asked, as before', () => {
    expect(profileGuardianName({ id: 'zz-m1', nickname: ' ZZ TEST Ploy ' }, null)).toBe('ZZ TEST Ploy');
    expect(profileGuardianName({ id: 'zz-m1', nickname: 'ZZ TEST Ploy' }, 'zz-m1')).toBeNull();
    expect(profileGuardianName({ id: 'zz-m1', nickname: '  ' }, null)).toBeNull();
    expect(profileGuardianName(null, null)).toBeNull();
  });

  it('a returning family whose children are all saved is asked the agreements alone', () => {
    expect(agreementsOnlyForm({ guardianFromProfile: true, slots: [{ savedChildId: 'a' }, { savedChildId: 'b' }] })).toBe(true);
    expect(agreementsOnlyForm({ guardianFromProfile: true, slots: [{ savedChildId: 'a' }, {}] })).toBe(false);
    expect(agreementsOnlyForm({ guardianFromProfile: false, slots: [{ savedChildId: 'a' }] })).toBe(false);
    expect(agreementsOnlyForm({ guardianFromProfile: true, slots: [] })).toBe(false);
  });
});

describe('after a waiver', () => {
  const mai = slot('mai', { name: 'ZZ TEST Mai', age: '6' });
  const tom = slot('tom', { name: 'ZZ TEST Tom', age: '10' });

  it('the waiver rule is unchanged: the oldest other child old enough covers a child waived down', () => {
    expect([...waiverCovers([{ ...mai, waived: true }, tom], policy).entries()].map(([k, v]) => [k, v.id])).toEqual([['mai', 'tom']]);
    expect(waiverCovers([mai, tom], policy).size).toBe(0);
  });

  it('the covering sibling plays on a normal ticket, and is registered again once the waiver is undone', () => {
    const waived = withCoveringSiblingsPlain([{ ...mai, waived: true }, tom], policy);
    expect(waived.map((s) => s.optIn)).toEqual([true, false]);
    const undone = withCoveringSiblingsPlain(waived.map((s) => ({ ...s, waived: false })), policy);
    expect(undone.map((s) => s.optIn)).toEqual([true, true]);
  });

  it('the gate then needs no form: Continue goes on to payment with no confirmation asked', () => {
    const slots = withCoveringSiblingsPlain([{ ...mai, waived: true }, tom], policy);
    const view = renderHook(() => SupervisionGate({ slots, parentName: '', consentAck: false, policy,
      acknowledgedConfirmationIds: [], onUpdateSlot: () => undefined, onToggleWaiver: () => undefined,
      onBack: () => undefined, onContinue: () => undefined, contactPhoneProblem: null }));
    const all = nodes(view.result.current);
    const proceed = all.find((node) => typeof node.props.onClick === 'function' && text(node.props.children).includes('Continue to payment'))!;
    expect(proceed.props.disabled).toBe(false);
    expect(text(view.result.current)).not.toContain('Registered for drop-off — no fee');
    expect(text(view.result.current)).not.toContain('confirmation');
    view.unmount();
  });

  it('without the waiver the older child is still registered free, with the confirmations, as before', () => {
    const view = renderHook(() => SupervisionGate({ slots: [mai, tom], parentName: '', consentAck: false, policy,
      acknowledgedConfirmationIds: [], onUpdateSlot: () => undefined, onToggleWaiver: () => undefined,
      onBack: () => undefined, onContinue: () => undefined, contactPhoneProblem: null }));
    const all = nodes(view.result.current);
    const proceed = all.find((node) => typeof node.props.onClick === 'function' && text(node.props.children).includes('Continue to payment'))!;
    expect(proceed.props.disabled).toBe(true);
    expect(text(view.result.current)).toContain('Registered for drop-off — no fee');
    view.unmount();
  });
});

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(tree: unknown): Node[] {
  return Array.isArray(tree) ? tree.flatMap(nodes)
    : React.isValidElement<Record<string, unknown>>(tree) ? [tree, ...nodes(tree.props.children)] : [];
}
function text(tree: unknown): string {
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree)
    : Array.isArray(tree) ? tree.map(text).join('') : React.isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children) : '';
}

describe('the last visit’s photo', () => {
  const found: LastPhotoState = { status: 'found', checkinId: 'zz-stay-1', fileId: 'zz-file-1', takenAt: '2026-11-10T03:00:00.000Z',
    url: 'https://files.example.invalid/zz-file-1' };
  const child = slot('p1', { name: 'ZZ TEST Mai', age: '6', savedChildId: MAI.id });

  it('is staff’s to decide: the family is not asked while staff compare it', () => {
    expect(slotPhotoState(child, { [MAI.id]: found })).toBe('awaits');
    expect(slotPhotoState(child, { [MAI.id]: { status: 'loading' } })).toBe('awaits');
    expect(slotPhotoState(child, { [MAI.id]: { status: 'none' } })).toBe('today');
    expect(slotPhotoState(child, {})).toBe('today');
    expect(slotPhotoState(slot('p2', { name: 'ZZ TEST new' }), { [MAI.id]: found })).toBe('today');
  });

  it('"Still matches" reuses it; "Take a new one" goes back to today’s photo', () => {
    const reused = { ...child, childPhotoUrl: found.url, lastPhotoChoice: { childId: MAI.id, fromCheckinId: 'zz-stay-1', choice: 'matches' as const } };
    expect(slotPhotoState(reused, { [MAI.id]: found })).toBe('reused');
    expect(photoReuseFor(reused, MAI.id)).toBe('zz-stay-1');
    const fresh = { ...child, lastPhotoChoice: { childId: MAI.id, fromCheckinId: 'zz-stay-1', choice: 'new' as const } };
    expect(slotPhotoState(fresh, { [MAI.id]: found })).toBe('today');
    expect(photoReuseFor(fresh, MAI.id)).toBeNull();
    // A photo taken today always wins over the reused one.
    const taken = { ...reused, childPhotoUrl: 'data:image/png;base64,AAAA' };
    expect(slotPhotoState(taken, { [MAI.id]: found })).toBe('today');
    expect(photoReuseFor(taken, MAI.id)).toBeNull();
  });

  it('never goes to another child: the answer is kept with the child it was given for', () => {
    const reused = { ...child, childPhotoUrl: found.url, lastPhotoChoice: { childId: MAI.id, fromCheckinId: 'zz-stay-1', choice: 'matches' as const } };
    expect(photoReuseFor(reused, TOM.id)).toBeNull();
    expect(photoReuseFor(reused, undefined)).toBeNull();
    // Swapping another saved child into the place drops the photo and the answer.
    const swapped = { ...reused, ...slotPatchFromSavedChild(TOM) };
    expect(swapped.childPhotoUrl).toBeUndefined();
    expect(swapped.lastPhotoChoice).toBeUndefined();
  });

  it('staff see it with the two answers, then what they chose', () => {
    const choices: string[] = [];
    const asked = LastPhotoChoice({ slot: child, last: found, onChoice: (c) => { choices.push(c); } });
    expect(text(asked)).toContain('Does it still match the child and the guardian here?');
    const buttons = nodes(asked).filter((node) => typeof node.props.onClick === 'function');
    expect(buttons.map((node) => text(node.props.children).trim())).toEqual(['Still matches', 'Take a new one']);
    expect(nodes(asked).some((node) => node.type === 'img' && node.props.src === found.url)).toBe(true);
    buttons.forEach((node) => (node.props.onClick as () => void)());
    expect(choices).toEqual(['matches', 'new']);
    const reused = LastPhotoChoice({ slot: { ...child, childPhotoUrl: found.url,
      lastPhotoChoice: { childId: MAI.id, fromCheckinId: 'zz-stay-1', choice: 'matches' } }, last: found, onChoice: () => undefined });
    expect(text(reused)).toContain('Using the photo from the last visit');
    const fresh = LastPhotoChoice({ slot: { ...child, lastPhotoChoice: { childId: MAI.id, fromCheckinId: 'zz-stay-1', choice: 'new' } },
      last: found, onChoice: () => undefined });
    expect(text(fresh)).toContain('A new photo is taken today.');
    expect(LastPhotoChoice({ slot: child, last: { status: 'none' }, onChoice: () => undefined })).toBeNull();
  });
});

describe('the till wires it', () => {
  const src = (file: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', file), 'utf8');
  const till = src('pages/Till.tsx');

  it('the ticks leave the membership check and follow the visitor', () => {
    expect(src('components/till/VisitChildrenModal.tsx')).toContain('onConfirmed(updated, visitId, selectedIds);');
    expect(till).toMatch(/onConfirmed=\{\(children, visitId, visitingIds\) => \{[\s\S]{0,400}?setVisitingChildIds\(visitingIds\);/);
    // A new lookup and a new sale start without them.
    expect(till).toMatch(/setVisitingChildIds\(null\);\s*\/\/ A new lookup is a new \(or no\) visit/);
    expect(till).toMatch(/setSuperGuardianFromProfile\(false\);\s*setVisitingChildIds\(null\);\s*setLastPhotos\(\{\}\);/);
  });

  it('the ticket and the gate take them; the gate reads each saved child’s last photo', () => {
    expect(till).toContain('kids: ticketKidsDefault(lines, visitingChildIds)');
    const open = till.slice(till.indexOf('const openSupervisionGate = '), till.indexOf('const handleUpdateSlot = '));
    expect(open).toContain('const profileName = profileGuardianName(member, createdMemberId);');
    expect(open).toMatch(/const prefill = prefillGate\(slots, saved, visitingChildIds\);\s*setSuperSlots\(prefill\.slots\);\s*setConfirmedSavedIds\(prefill\.confirmedIds\);\s*setStep\(prefill\.review \? 8 : 7\);/);
    expect(open).toContain('readLastPhotos(saved.map((child) => child.id));');
    // Online only, and a read that lands after the sale moved on is dropped.
    expect(open).toMatch(/if \(!platformBranchId \|\| childIds\.length === 0 \|\| tillOffline\(\)\)/);
    expect(open).toContain('if (epoch !== saleEpochRef.current) return;');
  });

  it('the waiver keeps the covering sibling plain, everywhere the gate is read', () => {
    expect(till).toMatch(/const handleToggleWaiver = \(id: string\) =>\s*setSuperSlots\(\(prev\) => withCoveringSiblingsPlain\(/);
    const resolve = till.slice(till.indexOf('const resolveSupervisionGate = async'), till.indexOf('const gateRunningRef'));
    expect(resolve).toContain('const covers = waiverCovers(superSlots, policy);');
    expect(resolve).toContain('resolveSupervisionOutcome(base, slot.waived, slot.optIn && !coveringIds.has(slot.id))');
  });

  it('the registration reuses a photo only on staff’s word, for the same child, and says when it could not', () => {
    const resolve = till.slice(till.indexOf('const resolveSupervisionGate = async'), till.indexOf('const gateRunningRef'));
    expect(resolve).toContain('const from = photoReuseFor(slot, childIdBySlot.get(slot.id));');
    expect(resolve).toContain('await checkinApi.reusePhoto(reg.id,');
    expect(resolve).toContain('take a new photo before pickup.');
    // The display is not asked for a photo staff compare or reuse.
    expect(till).toContain("needsConsent: outcome.needsConsent && photoStateOf(slot) === 'today'");
    expect(till).toContain('photoAtTillFor={staffPhotoSlotIds}');
    expect(till).toContain('onPhotoChoice={handlePhotoChoice}');
  });

  it('the form tells the family’s screens what is shown, not asked', () => {
    expect(till).toContain('...(superParentPhone.trim() ? { phoneFixed: true } : {}),');
    expect(till).toContain('...(superGuardianFromProfile && superParentName.trim() ? { guardianFixed: true } : {}),');
    expect(till).toContain('...(consentAgreementsOnly ? { agreementsOnly: true } : {}),');
    expect(till).toContain('parentNameFixed={superGuardianFromProfile && !!superParentName.trim()}');
    expect(till).toContain('agreementsOnly={consentAgreementsOnly}');
  });
});
