import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childChangeActionId, confirmVisitChildren, membersApi, type ApiChild } from '@/api/platform';
import { setBridgeOrigin } from '@/api/bridge';
import { childDetailsDraft } from '@/components/shared/ChildDetailsFields';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { saveGateChildren, type HeldWriteKey } from '@/lib/gateChildren';
import { currentLane, setLaneStation } from '@/lib/lane';
import { heldVisitWrite, saveVisitChildren } from '@/lib/visitChildren';
import type { Member, SavedChild } from '@/types';

/**
 * SCRUM-1060 — A SAVE RETRIED AFTER A LOST CONNECTION IS WRITTEN ONCE, THE
 * REMAINING PATHS (the till's side).
 *
 *  (1) "Who's visiting today?" opened the family's visit under a fresh id and
 *      key on every Confirm: a press again after the visit's reply was lost
 *      opened a second draft visit. The window now holds the visit's identity
 *      (`heldVisitWrite`) while it is open, kept while the same children are
 *      confirmed; the drop-off gate's own visit is held the same way.
 *  (2) On a counter till a call that reaches nothing at all moves to the
 *      counter box (`viaLane`), which kept a child's change under a fresh
 *      action id of its own: a change the platform had in fact written was
 *      written again when the box's fact arrived. The change now carries one
 *      action id on both lanes (`childChangeActionId`), so the platform counts
 *      it once.
 *
 * The real api wrappers run against a stubbed `fetch`: a platform that
 * answers as the shared idempotency middleware and the routes do (a key seen
 * with the same body is answered from the first write, a visit id seen is
 * replayed, a child's change already written under its action id is not
 * written again), and a counter box that keeps each intent as a fact, synced
 * to that platform afterwards by the same rules. A reply is lost after the
 * write lands, either as a 504 or as no answer at all.
 */

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const MEMBER = '018f0000-0000-7000-8000-00000000d0a1';
const CHILD_A = '018f0000-0000-7000-8000-00000000c0a1';
const CHILD_B = '018f0000-0000-7000-8000-00000000c0b1';
const OPEN_VISIT = '018f0000-0000-7000-8000-00000000e0a1';
const PEANUTS = 'ZZ TEST peanuts';

type Lost = 'gateway' | 'nothing' | null;

const json = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

const apiChild = (id: string, fields: Record<string, unknown> = {}): ApiChild => ({ id, name: `ZZ TEST ${id.slice(-2)}`,
  dateOfBirth: null, ageYears: 6, allergies: PEANUTS, medicalNotes: null, medicalAlert: true, dietary: null,
  foodRestrictions: null, notes: null, lastConfirmedAt: null, ...fields } as ApiChild);

/** The platform and the counter box, behind one `fetch`. */
class World {
  /** Visits the platform holds, by id. */
  visits = new Map<string, string[]>();
  /** Children added to an open visit, by operation id. */
  operations = new Set<string>();
  /** Each change to a child the platform wrote (one audit row and one publication each). */
  childWrites: { childId: string; actionId: string | null; lane: 'online' | 'box' }[] = [];
  /** What the till sent online, in order. */
  online: { method: string; url: string; key: string | null; body: Record<string, unknown> }[] = [];
  /** The counter box's facts, in order. */
  facts: { type: string; actionId: string; payload: Record<string, unknown> }[] = [];
  /** How the next online write's reply is lost, after the write lands. */
  lose: Lost = null;
  /** The platform is out of reach: nothing is written, nothing answers. */
  down = false;
  /** The box's next reply is lost after it keeps the fact. */
  boxLose = false;
  private answers = new Map<string, { body: string; status: number; data: unknown }>();

  fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.startsWith('/api/box/')) {
      const answer = this.box(body);
      if (this.boxLose) {
        this.boxLose = false;
        throw new TypeError('Failed to fetch');
      }
      return answer;
    }
    if (this.down) throw new TypeError('Failed to fetch');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers['idempotency-key'] ?? null;
    this.online.push({ method: init?.method ?? 'GET', url, key, body });
    const seen = key ? this.answers.get(key) : undefined;
    if (seen) {
      if (seen.body !== JSON.stringify(body)) return json({ error: { code: 'IDEMPOTENCY_MISMATCH', message: 'no' } }, 409);
      return json(seen.data, seen.status);
    }
    const data = this.route(url, body);
    if (key) this.answers.set(key, { body: JSON.stringify(body), status: 200, data });
    const lost = this.lose;
    this.lose = null;
    if (lost === 'nothing') throw new TypeError('Failed to fetch');
    if (lost === 'gateway') return json({ error: { code: 'GATEWAY_TIMEOUT', message: 'The reply was lost' } }, 504);
    return json(data);
  });

  private route(url: string, body: Record<string, unknown>): unknown {
    if (url === '/api/visits') {
      const id = body.id as string;
      if (!this.visits.has(id)) this.visits.set(id, body.childIds as string[]);
      return { id, visitDate: '2026-11-20', status: 'draft' };
    }
    const add = /^\/api\/visits\/([^/]+)\/children$/.exec(url);
    if (add) {
      this.operations.add(body.operationId as string);
      return { id: add[1], visitDate: '2026-11-20', status: 'draft' };
    }
    const patch = /^\/api\/members\/children\/([^/]+)$/.exec(url);
    if (patch) {
      const { actionId, source: _source, memberId: _member, confirmedNone: _none, ...fields } = body;
      this.writeChild(patch[1]!, (actionId as string | undefined) ?? null, 'online');
      return { child: apiChild(patch[1]!, fields) };
    }
    throw new Error(`no route for ${url}`);
  }

  /** The platform's rule: a change already written under its action id is not written again. */
  private writeChild(childId: string, actionId: string | null, lane: 'online' | 'box'): void {
    if (actionId && this.childWrites.some((w) => w.childId === childId && w.actionId === actionId)) return;
    this.childWrites.push({ childId, actionId, lane });
  }

  private box(sent: Record<string, unknown>): Response {
    const payload = sent.payload as Record<string, unknown>;
    this.facts.push({ type: sent.type as string, actionId: sent.actionId as string, payload });
    if (sent.type === 'child.update') {
      const { childId, ...fields } = payload;
      return json({ document: {}, result: { child: apiChild(childId as string, fields) } });
    }
    return json({ document: {}, result: { id: payload.visitId, visitDate: '2026-11-20', status: 'draft' } });
  }

  /** The box's facts reach the platform, applied as the sync handlers apply them. */
  sync(): void {
    for (const fact of this.facts.splice(0)) {
      if (fact.type === 'child.update') this.writeChild(fact.payload.childId as string, fact.actionId, 'box');
      if (fact.type === 'visit.create' && !this.visits.has(fact.payload.visitId as string)) {
        this.visits.set(fact.payload.visitId as string, fact.payload.childIds as string[]);
      }
    }
  }
}

let world: World;

beforeEach(() => {
  world = new World();
  vi.stubGlobal('fetch', world.fetch);
  setBridgeOrigin(null);
  setLaneStation(null);
});

afterEach(() => {
  setLaneStation(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The till at a counter with a box (`station`), or one with no box. */
const standAt = (station: string | null) => setLaneStation(station);

/** One press of Confirm's visit step, on a window whose identities are `keys`. */
const confirmVisit = (keys: Map<string, HeldWriteKey>, openVisitId: string | null, childIds: string[]) => {
  const visit = { memberId: MEMBER, childIds };
  return confirmVisitChildren(openVisitId, visit, heldVisitWrite(keys, openVisitId, visit));
};

describe('SCRUM-1060 (1): the visit "Who\'s visiting today?" opens is held while the window is open', () => {
  it('a Confirm again after the visit\'s reply was lost (504) replays that visit: one draft visit', async () => {
    const keys = new Map<string, HeldWriteKey>();
    world.lose = 'gateway';
    await expect(confirmVisit(keys, null, [CHILD_A, CHILD_B])).rejects.toMatchObject({ status: 504 });
    const id = await confirmVisit(keys, null, [CHILD_A, CHILD_B]);
    const sent = world.online.filter((c) => c.url === '/api/visits');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.id).toBe(sent[0]!.body.id);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[0]!.key).toBe(`visit:${sent[0]!.body.id as string}`);
    expect(id).toBe(sent[0]!.body.id);
    expect(world.visits.size).toBe(1);
  });

  it('no answer at all, on a till with no box: the same visit again', async () => {
    standAt(null);
    const keys = new Map<string, HeldWriteKey>();
    world.lose = 'nothing';
    await expect(confirmVisit(keys, null, [CHILD_A])).rejects.toThrow();
    await confirmVisit(keys, null, [CHILD_A]);
    const ids = world.online.filter((c) => c.url === '/api/visits').map((c) => c.body.id);
    expect(new Set(ids).size).toBe(1);
    expect(world.visits.size).toBe(1);
  });

  it('no answer at all on a counter till: the box takes the same visit id, and its fact opens no second visit', async () => {
    standAt(STATION);
    const keys = new Map<string, HeldWriteKey>();
    world.lose = 'nothing';
    const id = await confirmVisit(keys, null, [CHILD_A]);
    expect(currentLane()).toBe('box');
    const online = world.online.find((c) => c.url === '/api/visits')!;
    expect(world.facts).toEqual([{ type: 'visit.create', actionId: expect.any(String),
      payload: { visitId: online.body.id, memberId: MEMBER, childIds: [CHILD_A] } }]);
    expect(id).toBe(online.body.id);
    world.sync();
    expect(world.visits.size).toBe(1);
  });

  it('other children ticked are another confirmation, under a new identity', async () => {
    const keys = new Map<string, HeldWriteKey>();
    world.lose = 'gateway';
    await expect(confirmVisit(keys, null, [CHILD_A, CHILD_B])).rejects.toMatchObject({ status: 504 });
    await confirmVisit(keys, null, [CHILD_A]);
    const sent = world.online.filter((c) => c.url === '/api/visits');
    expect(sent[1]!.body.id).not.toBe(sent[0]!.body.id);
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
  });

  it('children added to the visit the gate opened: a press again is the same operation under the same key', async () => {
    const keys = new Map<string, HeldWriteKey>();
    world.lose = 'gateway';
    await expect(confirmVisit(keys, OPEN_VISIT, [CHILD_A])).rejects.toMatchObject({ status: 504 });
    expect(await confirmVisit(keys, OPEN_VISIT, [CHILD_A])).toBe(OPEN_VISIT);
    const sent = world.online.filter((c) => c.url === `/api/visits/${OPEN_VISIT}/children`);
    expect(sent.map((c) => c.body.operationId)).toEqual([sent[0]!.body.operationId, sent[0]!.body.operationId]);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(world.operations.size).toBe(1);
  });

  it('the window opened again (or the next family) holds a new identity', async () => {
    await confirmVisit(new Map(), null, [CHILD_A]);
    await confirmVisit(new Map(), null, [CHILD_A]);
    expect(world.visits.size).toBe(2);
  });

  it('the window and the gate send their visit under the identity they hold', () => {
    const read = (...parts: string[]) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...parts), 'utf8');
    const modal = read('components', 'till', 'VisitChildrenModal.tsx');
    expect(modal).toContain('const visitId = await confirmVisitChildren(openVisitId, visit, heldVisitWrite(writeKeys.current, openVisitId, visit));');
    expect(modal).toContain('writeKeys.current = new Map();');
    const till = read('pages', 'Till.tsx');
    const gate = till.slice(till.indexOf('const resolveSupervisionGate'), till.indexOf('const runSupervisionGate'));
    expect(gate).toMatch(/gateVisitId = await confirmVisitChildren\(openVisitId, visit,\s+heldVisitWrite\(gateWriteKeysRef\.current, openVisitId, visit\)\);/);
    // No visit is opened anywhere at the counter without one.
    expect(`${modal}${till}`).not.toMatch(/confirmVisitChildren\([^)]*\{\s*memberId/);
  });
});

/** The window open for one family whose child a staff changed to `allergies`. */
function visitWindow(allergies: string) {
  const records = new Map([[CHILD_A, apiChild(CHILD_A)]]);
  const drafts = { [CHILD_A]: { ...childDetailsDraft(apiChild(CHILD_A)), allergies } };
  const children = [{ id: CHILD_A, childName: 'ZZ TEST a1', childAge: 6, allergiesMedical: PEANUTS } as SavedChild];
  return { children, records, drafts, allergyDrafts: {} };
}

/** One press of Confirm's save step, through the till's own wrapper, as the window wires it. */
const saveWindow = (keys: Map<string, HeldWriteKey>, allergies: string) => saveVisitChildren({
  ...visitWindow(allergies), writeKeys: keys,
  updateChild: (childId, patch, key) => membersApi.updateChild(childId, patch, key),
});

const slot = (id: string, savedChildId: string, extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id, sourceLineId: 'line', ticketType: {} as SupervisedSlot['ticketType'], name: 'ZZ TEST a1', age: '6', waived: false,
  allergiesMedical: PEANUTS, foodRestrictions: '', mayOrderFood: false, savedChildId, ...extra,
});

/** One press of the drop-off gate's Continue, through the till's own wrappers, as Till.tsx wires them. */
const pressGate = (keys: Map<string, HeldWriteKey>, slots: SupervisedSlot[]) => saveGateChildren({
  guardian: { id: MEMBER, phone: '', nickname: 'ZZ TEST family',
    savedChildren: [{ id: CHILD_A, childName: 'ZZ TEST a1', childAge: 6, allergiesMedical: PEANUTS }] } as unknown as Member,
  slots: slots.map((s) => ({ slot: s, age: 6 })), childIdFor: () => 'unused', matchedSlots: new Map(), writeKeys: keys,
  addChild: async () => { throw new Error('no new child here'); },
  updateChild: (childId, patch, key) => membersApi.updateChild(childId, patch, key),
  updateChildCareFromDisplay: (childId, care, memberId, key) =>
    membersApi.updateChildCareFromDisplay(childId, { ...care, memberId }, key),
  onSaved: () => undefined,
});

describe('SCRUM-1060 (2): a child\'s change carries one identity on both lanes', () => {
  it('the action id is what was minted for the change: the part of its key after the screen\'s name', () => {
    expect(childChangeActionId('visit-child:0b6f6a8e-3c55-4a39-9e7e-5d3c9f0a1b2c')).toBe('0b6f6a8e-3c55-4a39-9e7e-5d3c9f0a1b2c');
    expect(childChangeActionId('child-review:zz-press-1')).toBe('zz-press-1');
    expect(childChangeActionId(`gate-child:${'x'.repeat(80)}`)).toHaveLength(64);
    expect(childChangeActionId(undefined)).toBeUndefined();
  });

  it('"Who\'s visiting today?": no answer at all on a counter till; the box\'s fact names the change the platform wrote, counted once', async () => {
    standAt(STATION);
    world.lose = 'nothing';
    await saveWindow(new Map(), 'ZZ TEST peanuts, sesame');
    const online = world.online.find((c) => c.url === `/api/members/children/${CHILD_A}`)!;
    expect(online.body.actionId).toBe(childChangeActionId(online.key!));
    expect(world.facts).toEqual([{ type: 'child.update', actionId: online.body.actionId,
      payload: { childId: CHILD_A, allergies: 'ZZ TEST peanuts, sesame', medicalAlert: true } }]);
    world.sync();
    expect(world.childWrites).toEqual([{ childId: CHILD_A, actionId: online.body.actionId, lane: 'online' }]);
  });

  it('"Who\'s visiting today?": a 504 and Confirm again: the same key and action id online, one write, nothing on the box', async () => {
    standAt(STATION);
    const keys = new Map<string, HeldWriteKey>();
    world.lose = 'gateway';
    await expect(saveWindow(keys, 'ZZ TEST kiwi')).rejects.toMatchObject({ status: 504 });
    await saveWindow(keys, 'ZZ TEST kiwi');
    const sent = world.online.filter((c) => c.url === `/api/members/children/${CHILD_A}`);
    expect(sent.map((c) => [c.key, c.body.actionId])).toEqual([[sent[0]!.key, sent[0]!.body.actionId], [sent[0]!.key, sent[0]!.body.actionId]]);
    expect(world.facts).toEqual([]);
    expect(world.childWrites).toHaveLength(1);
  });

  it('the box took the change and its answer was lost; Confirm again once the link is back: counted once', async () => {
    standAt(STATION);
    const keys = new Map<string, HeldWriteKey>();
    world.down = true;
    world.boxLose = true;
    await expect(saveWindow(keys, 'ZZ TEST eggs')).rejects.toThrow();
    expect(currentLane()).toBe('box');
    const taken = world.facts[0]!.actionId;
    world.sync();
    world.down = false;
    // The link is back: the till works through the platform again.
    standAt(null);
    standAt(STATION);
    await saveWindow(keys, 'ZZ TEST eggs');
    const online = world.online.filter((c) => c.url === `/api/members/children/${CHILD_A}`);
    expect(online.at(-1)!.body.actionId).toBe(taken);
    expect(world.childWrites).toEqual([{ childId: CHILD_A, actionId: taken, lane: 'box' }]);
  });

  it('the box\'s answer lost and Confirm pressed again on the box: two facts under one action id, counted once', async () => {
    standAt(STATION);
    const keys = new Map<string, HeldWriteKey>();
    world.down = true;
    world.boxLose = true;
    await expect(saveWindow(keys, 'ZZ TEST milk')).rejects.toThrow();
    await saveWindow(keys, 'ZZ TEST milk');
    expect(world.facts.map((f) => f.actionId)).toEqual([world.facts[0]!.actionId, world.facts[0]!.actionId]);
    world.sync();
    expect(world.childWrites).toHaveLength(1);
  });

  it('the gate\'s care note from the display and staff\'s own change: each its own identity on both lanes, each counted once', async () => {
    standAt(STATION);
    const keys = new Map<string, HeldWriteKey>();
    world.lose = 'nothing';
    // The first write (the family's care note) lands and its answer is lost: from there the box takes both.
    await pressGate(keys, [slot('s1', CHILD_A, { name: 'ZZ TEST a1 renamed', allergiesMedical: 'ZZ TEST eggs', careSource: 'display' })]);
    const care = world.online.find((c) => c.body.source === 'customer_display')!;
    expect(care.body.actionId).toBe(childChangeActionId(care.key!));
    expect(world.facts.map((f) => f.type)).toEqual(['child.update', 'child.update']);
    expect(world.facts[0]!.actionId).toBe(care.body.actionId);
    expect(world.facts[1]!.actionId).not.toBe(care.body.actionId);
    expect(world.facts[1]!.payload).toEqual({ childId: CHILD_A, name: 'ZZ TEST a1 renamed' });
    world.sync();
    expect(world.childWrites.map((w) => w.lane)).toEqual(['online', 'box']);
  });

  it('a change sent with no key keeps a fresh action id per call on the box, as before', async () => {
    standAt(STATION);
    world.lose = 'nothing';
    await membersApi.updateChild(CHILD_A, { allergies: 'ZZ TEST plain' });
    expect(world.online[0]!.body).toEqual({ allergies: 'ZZ TEST plain' });
    expect(world.facts[0]!.actionId).toMatch(/^child\.update:[0-9a-f-]{36}$/);
  });
});
