import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiChild } from '@/api/platform';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import type { DisplayCare } from '@/lib/displayCareNotes';
import { gateWriteKey, saveGateChildren, type HeldWriteKey } from '@/lib/gateChildren';
import type { Member } from '@/types';

/**
 * SCRUM-1053 — A CHANGE TO A CHILD, RETRIED AFTER A LOST REPLY, IS ONE WRITE.
 *
 * The drop-off gate writes each saved child's changes as a PATCH: the
 * family's care notes from the display (SCRUM-1020) on their own, and the
 * rest (what staff changed on the till) after them. Neither carried a key,
 * so a reply lost on the way back and Done (or Continue) pressed again sent
 * the change as a new write: the platform changed, audited and published the
 * child twice for one edit. Each change now goes under a key the till holds
 * for the life of the gate (`gateWriteKey`), as the display's saved-child
 * review held its write: the same change sent again goes under the same key
 * and the platform answers from the first write; a different change, another
 * child or the next gate takes a new one.
 */

const PEANUTS = 'ZZ TEST peanuts';

const slot = (id: string, savedChildId: string, extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id, sourceLineId: 'line', ticketType: {} as SupervisedSlot['ticketType'], name: `ZZ TEST ${id}`, age: '6', waived: false,
  allergiesMedical: PEANUTS, foodRestrictions: '', mayOrderFood: false, savedChildId, ...extra,
});

const guardian = (): Member => ({
  id: 'zz-family', phone: '', nickname: 'ZZ TEST Ploy',
  savedChildren: [
    { id: 'zz-child-a', childName: 'ZZ TEST a', childAge: 6, allergiesMedical: PEANUTS },
    { id: 'zz-child-b', childName: 'ZZ TEST b', childAge: 6, allergiesMedical: PEANUTS },
  ],
} as unknown as Member);

const apiChild = (id: string, fields: Record<string, unknown>): ApiChild => ({ id, name: `ZZ TEST ${id.slice(-1)}`, dateOfBirth: null,
  ageYears: 6, allergies: PEANUTS, medicalNotes: null, medicalAlert: true, dietary: null, foodRestrictions: null, notes: null,
  lastConfirmedAt: null, ...fields } as ApiChild);

/**
 * The platform's side, as the shared idempotency middleware answers it: a
 * key seen with the same body is answered from the first write, which is
 * counted once; the same key with another body is refused. `lose` loses the
 * reply of the next write after it lands.
 */
class FakePlatform {
  writes: { childId: string; body: Record<string, unknown>; key: string }[] = [];
  sent: { childId: string; key: string }[] = [];
  private answers = new Map<string, { body: string; child: ApiChild }>();
  lose = 0;

  private patch(childId: string, body: Record<string, unknown>, key: string): { child: ApiChild } {
    this.sent.push({ childId, key });
    const seen = this.answers.get(key);
    if (seen) {
      if (seen.body !== JSON.stringify(body)) throw new Error('IDEMPOTENCY_MISMATCH');
      return { child: seen.child };
    }
    this.writes.push({ childId, body, key });
    const child = apiChild(childId, body);
    this.answers.set(key, { body: JSON.stringify(body), child });
    if (this.lose > 0) {
      this.lose -= 1;
      throw new Error('The upstream save reply was lost');
    }
    return { child };
  }

  care = async (childId: string, care: DisplayCare, memberId: string, key: string) =>
    this.patch(childId, { source: 'customer_display', ...care, memberId }, key);
  update = async (childId: string, patch: Record<string, unknown>, key: string) => this.patch(childId, patch, key);
}

/** One press of Done (or Continue) on a gate whose keys the till holds. */
const press = (platform: FakePlatform, keys: Map<string, HeldWriteKey>, slots: SupervisedSlot[]) => saveGateChildren({
  guardian: guardian(), slots: slots.map((s) => ({ slot: s, age: 6 })), childIdFor: () => 'unused', matchedSlots: new Map(),
  writeKeys: keys, addChild: async () => { throw new Error('no new child here'); },
  updateChild: platform.update, updateChildCareFromDisplay: platform.care, onSaved: () => undefined,
});

describe('SCRUM-1053 (1): the key a change goes under', () => {
  it('the same change retried keeps its key; a new change takes a new one', () => {
    const held = new Map<string, HeldWriteKey>();
    const first = gateWriteKey(held, 'care:zz-child-a', { allergies: 'ZZ TEST eggs' });
    expect(gateWriteKey(held, 'care:zz-child-a', { allergies: 'ZZ TEST eggs' })).toBe(first);
    const changed = gateWriteKey(held, 'care:zz-child-a', { allergies: 'ZZ TEST eggs and milk' });
    expect(changed).not.toBe(first);
    // Back to the first wording after another change: a new write, never the old key's answer.
    expect(gateWriteKey(held, 'care:zz-child-a', { allergies: 'ZZ TEST eggs' })).not.toBe(first);
  });

  it('never shares a key between two children, two kinds of write or two gates', () => {
    const held = new Map<string, HeldWriteKey>();
    const change = { allergies: 'ZZ TEST eggs' };
    const a = gateWriteKey(held, 'care:zz-child-a', change);
    const b = gateWriteKey(held, 'care:zz-child-b', change);
    const staff = gateWriteKey(held, 'update:zz-child-a', change);
    expect(new Set([a, b, staff]).size).toBe(3);
    // The next gate holds its own keys (the till starts a new map when the gate opens).
    expect(gateWriteKey(new Map(), 'care:zz-child-a', change)).not.toBe(a);
    expect(a).toMatch(/^gate-child:[0-9a-f-]{36}$/);
  });
});

describe('SCRUM-1053 (2): the gate retried after a lost reply writes once', () => {
  it("the family's care note from the display: the retry is the first write's key and body, written once", async () => {
    const platform = new FakePlatform();
    const keys = new Map<string, HeldWriteKey>();
    const slots = [slot('a', 'zz-child-a', { allergiesMedical: 'ZZ TEST peanuts, sesame', careSource: 'display' })];
    platform.lose = 1;
    await expect(press(platform, keys, slots)).rejects.toThrow('lost');
    // Done again: the member in hand never heard the answer, so the change is sent again — under its key.
    await press(platform, keys, slots);
    expect(platform.sent).toHaveLength(2);
    expect(platform.sent[1]!.key).toBe(platform.sent[0]!.key);
    expect(platform.writes).toEqual([{ childId: 'zz-child-a', key: platform.sent[0]!.key,
      body: { source: 'customer_display', allergies: 'ZZ TEST peanuts, sesame', memberId: 'zz-family' } }]);
  });

  it("staff's own change to a child in the same gate is held the same way", async () => {
    const platform = new FakePlatform();
    const keys = new Map<string, HeldWriteKey>();
    const slots = [slot('a', 'zz-child-a', { allergiesMedical: 'ZZ TEST peanuts, staff note' })];
    platform.lose = 1;
    await expect(press(platform, keys, slots)).rejects.toThrow('lost');
    await press(platform, keys, slots);
    expect(platform.sent.map((s) => s.key)).toEqual([platform.sent[0]!.key, platform.sent[0]!.key]);
    expect(platform.writes).toHaveLength(1);
    expect(platform.writes[0]!.body).toEqual({ allergies: 'ZZ TEST peanuts, staff note' });
  });

  it('a change made between the presses is a new write under a new key; two children never share one', async () => {
    const platform = new FakePlatform();
    const keys = new Map<string, HeldWriteKey>();
    platform.lose = 1;
    await expect(press(platform, keys, [slot('a', 'zz-child-a', { allergiesMedical: 'ZZ TEST eggs', careSource: 'display' })]))
      .rejects.toThrow('lost');
    await press(platform, keys, [
      slot('a', 'zz-child-a', { allergiesMedical: 'ZZ TEST eggs and milk', careSource: 'display' }),
      slot('b', 'zz-child-b', { allergiesMedical: 'ZZ TEST eggs and milk', careSource: 'display' }),
    ]);
    expect(platform.writes.map((w) => [w.childId, w.body.allergies])).toEqual([
      ['zz-child-a', 'ZZ TEST eggs'], ['zz-child-a', 'ZZ TEST eggs and milk'], ['zz-child-b', 'ZZ TEST eggs and milk']]);
    expect(new Set(platform.writes.map((w) => w.key)).size).toBe(3);
  });
});

describe('SCRUM-1053 (3): the till holds the keys for the gate and sends them', () => {
  const read = (...parts: string[]) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...parts), 'utf8');
  const till = read('pages', 'Till.tsx');

  it('one map for the life of the gate, started afresh when the gate opens', () => {
    expect(till).toContain('const gateWriteKeysRef = useRef(new Map<string, HeldWriteKey>());');
    const open = till.slice(till.indexOf('const openSupervisionGate = '), till.indexOf('const readLastPhotos = '));
    expect(open).toContain('gateWriteKeysRef.current = new Map();');
    const gate = till.slice(till.indexOf('const resolveSupervisionGate'), till.indexOf('const runSupervisionGate'));
    expect(gate).toContain('writeKeys: gateWriteKeysRef.current,');
    expect(gate).toContain('updateChild: (childId, patch, key) => membersApi.updateChild(childId, patch, key),');
    expect(gate).toContain('membersApi.updateChildCareFromDisplay(childId, { ...care, memberId }, key),');
  });

  it('the care-note write sends its key to the platform', () => {
    expect(read('api', 'platform.ts'))
      .toContain("() => cloudMembersApi.updateChild(childId, { source: 'customer_display', ...care }, idempotencyKey),");
  });
});
