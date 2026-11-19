import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiChild } from '@/api/platform';
import { childDetailsDraft } from '@/components/shared/ChildDetailsFields';
import { gateWriteKey, heldWriteKey, type HeldWriteKey } from '@/lib/gateChildren';
import { saveVisitChildren } from '@/lib/visitChildren';
import type { SavedChild } from '@/types';

/**
 * SCRUM-1059 (1) — "WHO'S VISITING TODAY?" WRITES A CHILD'S CHANGE ONCE.
 *
 * The membership check's window (`VisitChildrenModal`) saved each child staff
 * changed as a PATCH with no key: a reply lost on the way back and Confirm
 * pressed again changed, audited and published the child a second time. The
 * window now holds a key per child and change while it is open for the family
 * (`saveVisitChildren`, the held-key rule of the drop-off gate, SCRUM-1053):
 * the same change retried keeps its key, a new change takes a new one.
 */

const PEANUTS = 'ZZ TEST peanuts';

const apiChild = (id: string, fields: Record<string, unknown> = {}): ApiChild => ({ id, name: `ZZ TEST ${id.slice(-1)}`,
  dateOfBirth: null, ageYears: 6, allergies: PEANUTS, medicalNotes: null, medicalAlert: true, dietary: null,
  foodRestrictions: null, notes: null, lastConfirmedAt: null, ...fields } as ApiChild);

const saved = (id: string): SavedChild => ({ id, childName: `ZZ TEST ${id.slice(-1)}`, childAge: 6, allergiesMedical: PEANUTS } as SavedChild);

/** The platform as the shared idempotency middleware answers it; `lose` loses the next write's reply after it lands. */
class FakePlatform {
  writes: { childId: string; body: Record<string, unknown>; key: string }[] = [];
  sent: { childId: string; key: string }[] = [];
  private answers = new Map<string, { body: string; child: ApiChild }>();
  lose = 0;
  update = async (childId: string, body: Record<string, unknown>, key: string): Promise<{ child: ApiChild }> => {
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
      throw new Error('The reply was lost');
    }
    return { child };
  };
}

/** The window open for one family with two children, both read in full; `allergies` is what staff typed for child a. */
function openWindow(allergiesOfA: string) {
  const records = new Map([['zz-child-a', apiChild('zz-child-a')], ['zz-child-b', apiChild('zz-child-b')]]);
  const drafts = Object.fromEntries([...records.values()].map((c) => [c.id, childDetailsDraft(c)]));
  drafts['zz-child-a'] = { ...drafts['zz-child-a']!, allergies: allergiesOfA };
  return { children: [saved('zz-child-a'), saved('zz-child-b')], records, drafts, allergyDrafts: {} };
}

/** One press of Confirm, on a window whose keys are `keys`. */
const confirm = (platform: FakePlatform, keys: Map<string, HeldWriteKey>, shown: ReturnType<typeof openWindow>) =>
  saveVisitChildren({ ...shown, writeKeys: keys, updateChild: platform.update });

describe('SCRUM-1059 (1): the visit window holds the key a change goes under', () => {
  it('a Confirm retried after a lost reply sends the same key and body, and the child is written once', async () => {
    const platform = new FakePlatform();
    const keys = new Map<string, HeldWriteKey>();
    platform.lose = 1;
    await expect(confirm(platform, keys, openWindow('ZZ TEST peanuts, sesame'))).rejects.toThrow('lost');
    const children = await confirm(platform, keys, openWindow('ZZ TEST peanuts, sesame'));
    expect(platform.sent).toHaveLength(2);
    expect(platform.sent[1]!.key).toBe(platform.sent[0]!.key);
    expect(platform.sent[0]!.key).toMatch(/^visit-child:[0-9a-f-]{36}$/);
    expect(platform.writes).toHaveLength(1);
    expect(platform.writes[0]!.body).toEqual({ allergies: 'ZZ TEST peanuts, sesame', medicalAlert: true });
    // The unchanged child is not sent at all; the changed one comes back as the platform holds it.
    expect(children.map((c) => [c.id, c.allergiesMedical])).toEqual([['zz-child-a', 'ZZ TEST peanuts, sesame'], ['zz-child-b', PEANUTS]]);
  });

  it('a change made between the presses is a new write under a new key', async () => {
    const platform = new FakePlatform();
    const keys = new Map<string, HeldWriteKey>();
    platform.lose = 1;
    await expect(confirm(platform, keys, openWindow('ZZ TEST eggs'))).rejects.toThrow('lost');
    await confirm(platform, keys, openWindow('ZZ TEST eggs and milk'));
    expect(platform.writes.map((w) => w.body.allergies)).toEqual(['ZZ TEST eggs', 'ZZ TEST eggs and milk']);
    expect(new Set(platform.writes.map((w) => w.key)).size).toBe(2);
  });

  it('the allergy line alone (no detail read) is held the same way', async () => {
    const platform = new FakePlatform();
    const keys = new Map<string, HeldWriteKey>();
    const shown = { children: [saved('zz-child-a')], records: new Map<string, ApiChild>(), drafts: {},
      allergyDrafts: { 'zz-child-a': 'ZZ TEST kiwi' } };
    platform.lose = 1;
    await expect(saveVisitChildren({ ...shown, writeKeys: keys, updateChild: platform.update })).rejects.toThrow('lost');
    await saveVisitChildren({ ...shown, writeKeys: keys, updateChild: platform.update });
    expect(platform.sent.map((s) => s.key)).toEqual([platform.sent[0]!.key, platform.sent[0]!.key]);
    expect(platform.writes).toEqual([{ childId: 'zz-child-a', key: platform.sent[0]!.key, body: { allergies: 'ZZ TEST kiwi' } }]);
  });

  it("the window opened again (the next family, or this one later) holds its own keys", async () => {
    const first = new Map<string, HeldWriteKey>();
    const again = new Map<string, HeldWriteKey>();
    const platform = new FakePlatform();
    await confirm(platform, first, openWindow('ZZ TEST eggs'));
    await confirm(platform, again, openWindow('ZZ TEST eggs'));
    expect(platform.sent[1]!.key).not.toBe(platform.sent[0]!.key);
  });

  it("the gate's keys keep their own name and rule", () => {
    const held = new Map<string, HeldWriteKey>();
    const gate = gateWriteKey(held, 'update:zz-child-a', { allergies: 'ZZ TEST eggs' });
    expect(gate).toMatch(/^gate-child:/);
    expect(heldWriteKey(held, 'update:zz-child-a', { allergies: 'ZZ TEST eggs' }, 'gate-child')).toBe(gate);
  });

  it('the window resets its keys when it opens and sends each change under one', () => {
    const modal = readFileSync(new URL('../src/components/till/VisitChildrenModal.tsx', import.meta.url), 'utf8');
    expect(modal).toContain('writeKeys.current = new Map();');
    expect(modal).toMatch(/saveVisitChildren\(\{\s*children, records: recordById, drafts, allergyDrafts, writeKeys: writeKeys.current,/);
    expect(modal).toContain('updateChild: (childId, patch, key) => membersApi.updateChild(childId, patch, key)');
    // No unkeyed write is left in the window.
    expect(modal).not.toMatch(/membersApi\.updateChild\(c\.id/);
  });
});
