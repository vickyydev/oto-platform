import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ApiChild } from '@/api/platform';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import {
  gateChildMergePatch,
  gateChildPatch,
  matchSlotsToSavedChildren,
  saveGateChildren,
  withSavedChild,
  type SaveGateChildrenInput,
} from '@/lib/gateChildren';
import type { Member, SavedChild } from '@/types';

/**
 * SCRUM-871 / SCRUM-872 — THE GATE WRITES EACH CHILD ONCE.
 *
 * The "Children playing alone" gate saves each supervised child to the
 * guardian's profile before it registers them. Two ways that wrote a child
 * twice:
 *
 *   SCRUM-871 — a walk-in family (no member on the sale) whose first Continue
 *   failed part-way: the child the API had just created was never put on the
 *   member in hand, the retry found no saved child for the slot and entered
 *   it again, and the till minted a fresh id on every create so the platform
 *   could not tell the retry from a new child.
 *
 *   SCRUM-872 — a guardian whose number is first learned at the form (SCRUM-863
 *   asks it again) but who already has saved children: nothing matched the
 *   typed children to the saved ones, so each was added as new.
 *
 * These drive `saveGateChildren` — the loop the gate runs — against a fake
 * profile store that behaves as the platform does (a client id sent twice
 * answers with the record that exists), failing it at each stage and pressing
 * again, and pin the match rules: same name (trimmed, case-insensitive) and
 * the same date of birth when both have one, otherwise the same age; never a
 * guess when two could match.
 */

const ASOF = new Date('2026-11-12T03:00:00Z');
const MEMBER = '0190a0a0-0000-7000-8000-0000000000a1';
const idOf = (n: number) => `0190a0a0-0000-7000-8000-0000000000${n.toString(16).padStart(2, '0')}`;

const slot = (id: string, over: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id,
  sourceLineId: 'line-1',
  ticketType: { id: 'play-2h', name: '2 Hours Play' } as unknown as SupervisedSlot['ticketType'],
  name: 'Bua',
  age: '6',
  waived: false,
  allergiesMedical: '',
  foodRestrictions: '',
  mayOrderFood: false,
  ...over,
});

const saved = (id: string, over: Partial<SavedChild> = {}): SavedChild => ({
  id,
  childName: 'Bua',
  childAge: 6,
  savedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const memberWith = (children: SavedChild[] = []): Member => ({
  id: MEMBER,
  phone: '+66812345678',
  nickname: 'Ploy',
  savedChildren: children,
});

/**
 * The profile store as the platform keeps it: `POST /members/:id/children`
 * with an id already written answers with that child; a PATCH sets the named
 * fields. `failAt` names a call that throws — `before` the row is written (the
 * link was down) or `after` it (the answer was lost), as the park's WiFi does.
 */
class FakeProfiles {
  rows = new Map<string, ApiChild>();
  creates = 0;
  updates = 0;
  failAt: { create?: number; when: 'before' | 'after' } | null = null;

  addChild = async (memberId: string, body: Record<string, unknown>, id: string): Promise<{ child: ApiChild }> => {
    this.creates += 1;
    const fail = this.failAt?.create === this.creates ? this.failAt.when : null;
    if (fail === 'before') throw new Error('Failed to fetch');
    expect(memberId).toBe(MEMBER);
    const existing = this.rows.get(id);
    if (!existing) {
      this.rows.set(id, {
        id,
        name: String(body.name),
        dateOfBirth: (body.dateOfBirth as string | null) ?? null,
        ageYears: (body.ageYears as number | null) ?? null,
        allergies: (body.allergies as string | null) ?? null,
        medicalNotes: null,
        medicalAlert: !!body.allergies,
        dietary: null,
        foodRestrictions: (body.foodRestrictions as string | null) ?? null,
        notes: null,
        lastConfirmedAt: null,
      });
    }
    if (fail === 'after') throw new Error('Failed to fetch');
    return { child: this.rows.get(id)! };
  };

  updateChild = async (childId: string, patch: Record<string, unknown>): Promise<{ child: ApiChild }> => {
    this.updates += 1;
    const row = this.rows.get(childId);
    if (!row) throw new Error('Child not found');
    const next = { ...row, ...(patch as Partial<ApiChild>) } as ApiChild;
    this.rows.set(childId, next);
    return { child: next };
  };
}

/** The till's side of the gate: one stable id per slot, the member and the slots in state. */
class FakeTill {
  member: Member | null;
  slots: SupervisedSlot[];
  ids = new Map<string, string>();
  matched = new Map<string, string>();
  minted = 0;

  constructor(member: Member | null, slots: SupervisedSlot[]) {
    this.member = member;
    this.slots = slots;
  }

  childIdFor = (slotId: string): string => {
    const known = this.ids.get(slotId);
    if (known) return known;
    this.minted += 1;
    const id = idOf(0x10 + this.minted);
    this.ids.set(slotId, id);
    return id;
  };

  onSaved = (slotId: string, child: SavedChild, guardianId: string): void => {
    // applySavedChild, with the guardian named: the member in hand takes the child.
    if (this.member && this.member.id === guardianId) this.member = withSavedChild(this.member, child);
    this.slots = this.slots.map((s) => (s.id === slotId ? { ...s, savedChildId: child.id } : s));
  };

  /** One press of Continue: the loop runs on the member in hand (found or created). */
  press(store: FakeProfiles, guardian: Member, ages: Record<string, number> = { 'slot-a': 6, 'slot-b': 9 }) {
    const input: SaveGateChildrenInput = {
      guardian,
      slots: this.slots.map((s) => ({ slot: s, age: ages[s.id] ?? 6 })),
      asOf: ASOF,
      childIdFor: this.childIdFor,
      matchedSlots: this.matched,
      addChild: store.addChild,
      updateChild: store.updateChild,
      onSaved: this.onSaved,
    };
    return saveGateChildren(input);
  }
}

const twoKids = () => [slot('slot-a', { name: 'Bua', age: '6' }), slot('slot-b', { name: 'Nok', age: '9', allergiesMedical: 'Peanuts' })];

describe('SCRUM-871: a walk-in family, Continue pressed again after a failure', () => {
  it('writes both children once when nothing fails', async () => {
    const store = new FakeProfiles();
    const till = new FakeTill(null, twoKids());
    const created = memberWith();
    till.member = created;
    const result = await till.press(store, created);
    expect(store.creates).toBe(2);
    expect(store.updates).toBe(0);
    expect([...store.rows.values()].map((c) => c.name)).toEqual(['Bua', 'Nok']);
    expect(result.confirmedChildIds).toEqual([idOf(0x11), idOf(0x12)]);
    expect(result.guardian.savedChildren?.map((c) => c.childName)).toEqual(['Bua', 'Nok']);
    expect(till.member?.savedChildren?.map((c) => c.id)).toEqual([idOf(0x11), idOf(0x12)]);
    expect(till.slots.map((s) => s.savedChildId)).toEqual([idOf(0x11), idOf(0x12)]);
  });

  it('the second child failed before it was written: the retry corrects the first and writes the second', async () => {
    const store = new FakeProfiles();
    store.failAt = { create: 2, when: 'before' };
    const till = new FakeTill(null, twoKids());
    const created = memberWith();
    till.member = created;
    await expect(till.press(store, created)).rejects.toThrow('Failed to fetch');
    expect(store.rows.size).toBe(1);
    expect(till.member?.savedChildren?.map((c) => c.id)).toEqual([idOf(0x11)]);
    expect(till.slots[0]!.savedChildId).toBe(idOf(0x11));

    store.failAt = null;
    const result = await till.press(store, till.member!);
    expect(store.rows.size).toBe(2);
    expect(store.creates).toBe(3);
    expect(store.updates).toBe(0);
    expect(result.confirmedChildIds).toEqual([idOf(0x11), idOf(0x12)]);
    expect([...store.rows.values()].map((c) => c.name)).toEqual(['Bua', 'Nok']);
  });

  it("the first child's answer was lost after the platform wrote it: the retry replays it under the same id", async () => {
    const store = new FakeProfiles();
    store.failAt = { create: 1, when: 'after' };
    const till = new FakeTill(null, twoKids());
    const created = memberWith();
    till.member = created;
    await expect(till.press(store, created)).rejects.toThrow('Failed to fetch');
    expect(store.rows.size).toBe(1);
    // Nothing reached the till: the slot is not linked, the member has no child.
    expect(till.slots[0]!.savedChildId).toBeUndefined();
    expect(till.member?.savedChildren).toEqual([]);

    store.failAt = null;
    const result = await till.press(store, till.member!);
    expect(store.rows.size).toBe(2);
    expect(result.confirmedChildIds).toEqual([idOf(0x11), idOf(0x12)]);
    expect(till.minted).toBe(2);
  });

  it('the registration failed after both were written: the retry writes nothing new', async () => {
    const store = new FakeProfiles();
    const till = new FakeTill(null, twoKids());
    const created = memberWith();
    till.member = created;
    const first = await till.press(store, created);
    const again = await till.press(store, till.member!);
    expect(store.creates).toBe(2);
    expect(store.updates).toBe(0);
    expect(again.confirmedChildIds).toEqual(first.confirmedChildIds);
    expect(store.rows.size).toBe(2);
  });

  it('a lost answer, then the allergy corrected before the retry: the replayed record is brought up to date', async () => {
    const store = new FakeProfiles();
    store.failAt = { create: 1, when: 'after' };
    const till = new FakeTill(null, [slot('slot-a', { name: 'Bua', age: '6' })]);
    const created = memberWith();
    till.member = created;
    await expect(till.press(store, created)).rejects.toThrow('Failed to fetch');
    till.slots = till.slots.map((s) => ({ ...s, allergiesMedical: 'Shellfish' }));

    store.failAt = null;
    await till.press(store, till.member!);
    expect(store.rows.size).toBe(1);
    expect(store.updates).toBe(1);
    expect(store.rows.get(idOf(0x11))!.allergies).toBe('Shellfish');
    expect(till.member?.savedChildren?.[0]?.allergiesMedical).toBe('Shellfish');
  });

  it('a slot edited after the first press is corrected on the retry, not entered again', async () => {
    const store = new FakeProfiles();
    const till = new FakeTill(null, twoKids());
    const created = memberWith();
    till.member = created;
    await till.press(store, created);
    till.slots = till.slots.map((s) => (s.id === 'slot-b' ? { ...s, name: 'Nok Noi' } : s));
    await till.press(store, till.member!);
    expect(store.creates).toBe(2);
    expect(store.updates).toBe(1);
    expect(store.rows.get(idOf(0x12))!.name).toBe('Nok Noi');
  });

  it('the member in hand gains each child as it is written, under its own id', async () => {
    const store = new FakeProfiles();
    const till = new FakeTill(null, twoKids());
    const created = memberWith();
    // The till's state still holds an OLDER member (as a closure would): the
    // write must name the guardian, not whatever the state has.
    till.member = memberWith([saved(idOf(0x01), { childName: 'Someone Else' })]);
    till.member = { ...till.member, id: '0190a0a0-0000-7000-8000-0000000000a2' };
    const result = await till.press(store, created);
    expect(till.member?.savedChildren?.map((c) => c.childName)).toEqual(['Someone Else']);
    expect(result.guardian.savedChildren?.map((c) => c.childName)).toEqual(['Bua', 'Nok']);
  });
});

describe('SCRUM-872: a guardian found at the form who already has saved children', () => {
  it('matches a typed child to a saved child by name and age and corrects it rather than adding one', async () => {
    const store = new FakeProfiles();
    const bua = saved(idOf(0x01), { childName: 'bua ', childAge: 6 });
    const nok = saved(idOf(0x02), { childName: 'Nok', childAge: 9, allergiesMedical: 'Peanuts' });
    for (const c of [bua, nok]) {
      store.rows.set(c.id, {
        id: c.id, name: c.childName, dateOfBirth: null, ageYears: c.childAge, allergies: c.allergiesMedical ?? null,
        medicalNotes: null, medicalAlert: false, dietary: null, foodRestrictions: null, notes: null, lastConfirmedAt: null,
      });
    }
    const found = memberWith([bua, nok]);
    const till = new FakeTill(found, [slot('slot-a', { name: 'BUA', age: '6', allergiesMedical: 'Milk' }), slot('slot-b', { name: 'Nok', age: '9', allergiesMedical: 'Peanuts' })]);
    const result = await till.press(store, found);
    expect(store.creates).toBe(0);
    expect(store.updates).toBe(1);
    expect(store.rows.get(idOf(0x01))!.allergies).toBe('Milk');
    expect(result.confirmedChildIds).toEqual([idOf(0x01), idOf(0x02)]);
    expect(till.slots.map((s) => s.savedChildId)).toEqual([idOf(0x01), idOf(0x02)]);
    expect(result.unmatched).toEqual([]);

    // Pressed again (the registration failed): the linked slots take the update path, nothing is added.
    await till.press(store, till.member!);
    expect(store.creates).toBe(0);
    expect(store.updates).toBe(1);
  });

  it('a name that matches at a different age is a new child', async () => {
    const store = new FakeProfiles();
    const found = memberWith([saved(idOf(0x01), { childName: 'Bua', childAge: 6 })]);
    const till = new FakeTill(found, [slot('slot-a', { name: 'Bua', age: '9' })]);
    await till.press(store, found, { 'slot-a': 9 });
    expect(store.creates).toBe(1);
    expect(store.updates).toBe(0);
  });

  it('the source holds the loop to the matched child: the till calls saveGateChildren', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/pages/Till.tsx', import.meta.url)), 'utf8');
    const gate = src.slice(src.indexOf('const resolveSupervisionGate'), src.indexOf('const findOrCreateGateMember'));
    expect(gate).toMatch(/saveGateChildren\(/);
    // The old direct create inside the loop is gone; the port hands the id in.
    expect(gate).not.toMatch(/membersApi\.addChild\(guardian\.id/);
    expect(gate).toMatch(/addChild: \(memberId, body, id\) => membersApi\.addChild\(memberId, body, id\)/);
    expect(gate).toMatch(/childIdFor: \(slotId\) => gateIdFor\(gateChildIdsRef\.current, slotId\)/);
    expect(gate).toMatch(/applySavedChild\(child, guardianId\)/);
    // The child ids are minted once per gate, with the stay and waiver ids.
    const open = src.slice(src.indexOf('const openSupervisionGate'), src.indexOf('const handleUpdateSlot'));
    expect(open).toMatch(/gateChildIdsRef\.current = new Map\(\)/);
    // The by-name matches are kept per gate too, so a retry never clears.
    expect(gate).toMatch(/matchedSlots: gateMatchedChildrenRef\.current/);
    expect(open).toMatch(/gateMatchedChildrenRef\.current = new Map\(\)/);
  });
});

describe('SCRUM-872: a matched child typed afresh never loses what the profile holds', () => {
  /** Nok on the profile: an allergy (so the medical alert), a date of birth, a food restriction. */
  const nokOnFile = (store: FakeProfiles) => {
    const nok = saved(idOf(0x02), {
      childName: 'Nok', childAge: 9, dateOfBirth: '2017-03-01', allergiesMedical: 'Peanuts', foodRestrictions: 'No pork',
    });
    store.rows.set(nok.id, {
      id: nok.id, name: 'Nok', dateOfBirth: '2017-03-01', ageYears: 9, allergies: 'Peanuts', medicalNotes: null,
      medicalAlert: true, dietary: null, foodRestrictions: 'No pork', notes: null, lastConfirmedAt: null,
    });
    return memberWith([nok]);
  };
  const patches: Record<string, unknown>[] = [];
  const recording = (store: FakeProfiles) => {
    const update = store.updateChild;
    store.updateChild = async (childId, patch) => {
      patches.push(patch);
      return update(childId, patch);
    };
  };

  it('blank allergies, no date of birth, blank food: nothing is cleared, on the first press or the retry', async () => {
    patches.length = 0;
    const store = new FakeProfiles();
    recording(store);
    const found = nokOnFile(store);
    const till = new FakeTill(found, [slot('slot-b', { name: 'Nok', age: '9' })]);
    const first = await till.press(store, found);
    expect(store.creates).toBe(0);
    expect(store.updates).toBe(0);
    expect(first.confirmedChildIds).toEqual([idOf(0x02)]);
    // Linked now (as onSaved does): the registration failed and Continue is pressed again.
    expect(till.slots[0]!.savedChildId).toBe(idOf(0x02));
    await till.press(store, till.member!);
    expect(store.updates).toBe(0);
    expect(patches).toEqual([]);
    const row = store.rows.get(idOf(0x02))!;
    expect(row.allergies).toBe('Peanuts');
    expect(row.medicalAlert).toBe(true);
    expect(row.dateOfBirth).toBe('2017-03-01');
    expect(row.foodRestrictions).toBe('No pork');
  });

  it('a name that differs only in case sends no name', async () => {
    patches.length = 0;
    const store = new FakeProfiles();
    recording(store);
    const found = nokOnFile(store);
    const till = new FakeTill(found, [slot('slot-b', { name: ' NOK ', age: '9', allergiesMedical: 'Shellfish' })]);
    await till.press(store, found);
    await till.press(store, till.member!);
    expect(patches).toEqual([{ allergies: 'Shellfish' }]);
    expect(store.rows.get(idOf(0x02))!.name).toBe('Nok');
  });

  it('the merge patch sends only what the slot adds', () => {
    const nok = saved(idOf(0x02), { childName: 'Nok', childAge: 9, dateOfBirth: '2017-03-01', allergiesMedical: 'Peanuts', foodRestrictions: 'No pork' });
    expect(gateChildMergePatch(slot('s', { name: 'nok', age: '9' }), 9, nok)).toBeNull();
    expect(gateChildMergePatch(slot('s', { name: 'Nok', age: '9', dateOfBirth: '2017-03-01' }), 9, nok)).toBeNull();
    const noDob = saved(idOf(0x03), { childName: 'Bua', childAge: 6 });
    expect(gateChildMergePatch(slot('s', { name: 'Bua', age: '6', dateOfBirth: '2020-05-01' }), 6, noDob)).toEqual({
      dateOfBirth: '2020-05-01', ageYears: 6,
    });
    expect(gateChildMergePatch(slot('s', { name: 'Bua', age: '6', foodRestrictions: 'Halal' }), 6, noDob)).toEqual({ foodRestrictions: 'Halal' });
    // Never a null, so the API's medical alert is never lowered by a blank box.
    for (const value of Object.values(gateChildMergePatch(slot('s', { name: 'Bua', age: '6', allergiesMedical: 'Milk' }), 6, noDob) ?? {})) {
      expect(value).not.toBeNull();
    }
  });

  it('a matched slot swapped by the review to another saved child takes the ordinary patch again', async () => {
    const store = new FakeProfiles();
    const found = nokOnFile(store);
    const till = new FakeTill(found, [slot('slot-b', { name: 'Nok', age: '9' })]);
    await till.press(store, found);
    expect(till.matched.get('slot-b')).toBe(idOf(0x02));
    // The review links the slot to a different record, pre-filled from it.
    const other = saved(idOf(0x04), { childName: 'Nok', childAge: 9, allergiesMedical: 'Milk' });
    store.rows.set(other.id, { ...store.rows.get(idOf(0x02))!, id: other.id, allergies: 'Milk', dateOfBirth: null });
    till.member = withSavedChild(till.member!, other);
    till.slots = [slot('slot-b', { name: 'Nok', age: '9', savedChildId: other.id, allergiesMedical: '' })];
    await till.press(store, till.member!);
    // Staff cleared the allergy the review showed: that clear is deliberate and is sent.
    expect(store.rows.get(other.id)!.allergies).toBeNull();
  });
});

describe('SCRUM-872: the match rules', () => {
  const match = (slots: SupervisedSlot[], children: SavedChild[]) =>
    matchSlotsToSavedChildren(
      slots.map((s) => ({ slot: s, age: Number(s.age) })),
      children,
      ASOF,
    );

  it('same name (trimmed, case-insensitive) and same age', () => {
    const m = match([slot('s1', { name: '  bua', age: '6' })], [saved(idOf(0x01), { childName: 'Bua ', childAge: 6 })]);
    expect(m.matched.get('s1')?.id).toBe(idOf(0x01));
    expect(m.unmatched).toEqual([]);
  });

  it('both have a date of birth: the dates decide, not the age snapshot', () => {
    const same = match(
      [slot('s1', { name: 'Bua', age: '6', dateOfBirth: '2020-05-01' })],
      [saved(idOf(0x01), { childName: 'Bua', childAge: 5, dateOfBirth: '2020-05-01' })],
    );
    expect(same.matched.get('s1')?.id).toBe(idOf(0x01));
    const other = match(
      [slot('s1', { name: 'Bua', age: '6', dateOfBirth: '2020-05-01' })],
      [saved(idOf(0x01), { childName: 'Bua', childAge: 6, dateOfBirth: '2020-06-01' })],
    );
    expect(other.matched.size).toBe(0);
    expect(other.unmatched).toEqual([]);
  });

  it("only the saved child has a date of birth: the saved child's age today is compared", () => {
    // Born 2020-05-01, 6 on 2026-11-12.
    const m = match([slot('s1', { name: 'Bua', age: '6' })], [saved(idOf(0x01), { childName: 'Bua', childAge: 4, dateOfBirth: '2020-05-01' })]);
    expect(m.matched.get('s1')?.id).toBe(idOf(0x01));
  });

  it('only the slot has a date of birth: its age is compared with the saved age', () => {
    const m = match([slot('s1', { name: 'Bua', age: '6', dateOfBirth: '2020-05-01' })], [saved(idOf(0x01), { childName: 'Bua', childAge: 6 })]);
    expect(m.matched.get('s1')?.id).toBe(idOf(0x01));
  });

  it('a different name or a different age is no match', () => {
    const children = [saved(idOf(0x01), { childName: 'Bua', childAge: 6 })];
    expect(match([slot('s1', { name: 'Buaa', age: '6' })], children).matched.size).toBe(0);
    expect(match([slot('s1', { name: 'Bua', age: '7' })], children).matched.size).toBe(0);
    expect(match([slot('s1', { name: '', age: '6' })], children).matched.size).toBe(0);
  });

  it('two saved children that both match: no guess, the slot is reported', () => {
    const m = match(
      [slot('s1', { name: 'Bua', age: '6' })],
      [saved(idOf(0x01), { childName: 'Bua', childAge: 6 }), saved(idOf(0x02), { childName: 'bua', childAge: 6 })],
    );
    expect(m.matched.size).toBe(0);
    expect(m.unmatched).toEqual([{ slotId: 's1', name: 'Bua', reason: 'several_saved' }]);
  });

  it('two slots that match one saved child: no guess, both are reported', () => {
    const m = match(
      [slot('s1', { name: 'Bua', age: '6' }), slot('s2', { name: 'Bua', age: '6' })],
      [saved(idOf(0x01), { childName: 'Bua', childAge: 6 })],
    );
    expect(m.matched.size).toBe(0);
    expect(m.unmatched.map((u) => [u.slotId, u.reason])).toEqual([['s1', 'several_slots'], ['s2', 'several_slots']]);
  });

  it('a saved child another slot is already linked to is not offered', () => {
    const m = match(
      [slot('s1', { name: 'Bua', age: '6', savedChildId: idOf(0x01) }), slot('s2', { name: 'Bua', age: '6' })],
      [saved(idOf(0x01), { childName: 'Bua', childAge: 6 })],
    );
    expect(m.matched.size).toBe(0);
    expect(m.unmatched).toEqual([]);
  });

  it('a linked slot is never re-matched', () => {
    const m = match(
      [slot('s1', { name: 'Bua', age: '6', savedChildId: idOf(0x09) })],
      [saved(idOf(0x01), { childName: 'Bua', childAge: 6 })],
    );
    expect(m.matched.size).toBe(0);
  });
});

describe('the gate patch', () => {
  it('sends only what changed, and nothing for an untouched child', () => {
    const child = saved(idOf(0x01), { childName: 'Bua', childAge: 6, allergiesMedical: 'Milk', dietary: 'Halal' });
    expect(gateChildPatch(slot('s1', { name: 'Bua', age: '6', allergiesMedical: 'Milk', foodRestrictions: 'Halal' }), 6, child)).toBeNull();
    expect(gateChildPatch(slot('s1', { name: 'Bua', age: '7', allergiesMedical: 'Milk', foodRestrictions: 'Halal' }), 7, child)).toEqual({ ageYears: 7 });
  });

  it('withSavedChild replaces a child it already holds and appends one it does not', () => {
    const m = memberWith([saved(idOf(0x01))]);
    expect(withSavedChild(m, saved(idOf(0x01), { childName: 'Bua Noi' })).savedChildren?.map((c) => c.childName)).toEqual(['Bua Noi']);
    expect(withSavedChild(m, saved(idOf(0x02), { childName: 'Nok' })).savedChildren?.map((c) => c.childName)).toEqual(['Bua', 'Nok']);
  });
});
