import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '@/api/client';
import { setBridgeOrigin } from '@/api/bridge';
import { checkinApi, type CreateRegistrationBody } from '@/api/checkin';
import { confirmVisitChildren, membersApi } from '@/api/platform';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { saveGateChildren } from '@/lib/gateChildren';
import {
  GATE_BOX_NOT_SYNCED,
  GATE_CONNECTION_DROPPED,
  GATE_NOTHING_TAKEN,
  gateFailureDescription,
  gateOnlineHold,
} from '@/lib/gateOnline';
import {
  currentLane,
  holdPlatformLane,
  isBoxLaneTrigger,
  platformLaneHeld,
  setHeldRetryDelays,
  setLaneStation,
  viaLane,
} from '@/lib/lane';
import type { Member } from '@/types';

/**
 * SCRUM-887 — A CONNECTION DROP DURING A DROP-OFF REGISTRATION DOES NOT LEAVE
 * THE FAMILY STUCK ON THE BOX.
 *
 * Found in the SCRUM-871 staging proof: a walk-in family's guardian and
 * children were written on the platform, then the link dropped as the
 * registration was sent. The dropped call moved the till to its box, the box
 * (whose member copy refreshes once a minute) answered "Member not found", and
 * the family stood at the desk.
 *
 * These drive the till's real api wrappers with `fetch` replaced by a fake
 * platform and a fake box that behaves as the real one does (it holds no
 * member the platform wrote since its last pull), and walk the gate's steps
 * in its order with the gate's own hold (`lib/gateOnline`). The source pins at
 * the end tie `pages/Till.tsx` to that hold.
 */

const STATION = '018f0000-0000-7000-8000-0000000887a1';
const BRANCH = '018f0000-0000-7000-8000-0000000887b1';

const json = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

type Drop = 'before' | 'after';

/** The platform and the counter's box, as the till reaches them. */
class World {
  members = new Map<string, { id: string; phone: string; nickname: string }>();
  children = new Map<string, Record<string, unknown> & { id: string; memberId: string }>();
  visits = new Set<string>();
  registrations = new Map<string, { id: string; memberId: string | null; children: { id: string; childId: string | null }[] }>();
  /** The members the box's copy holds (none written since its last pull). */
  boxMembers = new Set<string>();
  platform: { method: string; path: string; body: Record<string, unknown> }[] = [];
  box: { type: string; payload: Record<string, unknown> }[] = [];
  /**
   * Drop the link on the listed calls (1-based) to a path: `before` it reaches
   * the platform, or `after` the platform wrote it (the answer is lost).
   */
  drops: { path: RegExp; at: number[]; when: Drop; seen?: number }[] = [];
  forcedOffline = false;

  fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.startsWith('/api/box/v1/station/')) return this.onBox(url, body);
    const path = url.replace(/^\/api/, '');
    const drop = this.drops.find((d) => {
      if (!d.path.test(`${method} ${path}`)) return false;
      d.seen = (d.seen ?? 0) + 1;
      return d.at.includes(d.seen);
    });
    if (drop?.when === 'before') throw new TypeError('Failed to fetch');
    this.platform.push({ method, path, body });
    if (this.forcedOffline) {
      return json({ error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } }, 503);
    }
    const answer = this.onPlatform(method, path, body);
    if (drop?.when === 'after') throw new TypeError('Failed to fetch');
    return answer;
  });

  private onPlatform(method: string, path: string, body: Record<string, unknown>): Response {
    if (method === 'POST' && path === '/members') {
      const id = String(body.id);
      if (!this.members.has(id)) this.members.set(id, { id, phone: String(body.phone), nickname: String(body.nickname) });
      return json({ member: { ...this.members.get(id), children: [] } });
    }
    const addChild = /^\/members\/([^/]+)\/children$/.exec(path);
    if (method === 'POST' && addChild) {
      const id = String(body.id);
      if (!this.children.has(id)) {
        this.children.set(id, {
          id, memberId: addChild[1]!, name: body.name, dateOfBirth: body.dateOfBirth ?? null, ageYears: body.ageYears ?? null,
          allergies: body.allergies ?? null, medicalNotes: null, medicalAlert: !!body.allergies, dietary: null,
          foodRestrictions: body.foodRestrictions ?? null, notes: null, lastConfirmedAt: null,
        });
      }
      return json({ child: this.children.get(id) });
    }
    if (method === 'POST' && path === '/visits') {
      this.visits.add(String(body.id));
      return json({ id: body.id, visitDate: '2026-11-12', status: 'draft' });
    }
    if (method === 'POST' && path === '/checkin/registrations') {
      const id = String(body.id);
      if (!this.registrations.has(id)) {
        const kids = body.children as { checkinId: string; childId: string | null }[];
        this.registrations.set(id, {
          id, memberId: (body.memberId as string | null) ?? null,
          children: kids.map((c) => ({ id: c.checkinId, childId: c.childId })),
        });
      }
      const reg = this.registrations.get(id)!;
      return json({ ...reg, branchId: BRANCH, guardianName: body.guardianName, children: reg.children.map((c) => ({ id: c.id, childId: c.childId })) });
    }
    return json({ error: { code: 'ROUTE_NOT_FOUND', message: `no ${method} ${path}` } }, 404);
  }

  /** The box's checks, as `checkin-desk.ts` and `station-bridge.ts` make them. */
  private onBox(url: string, body: Record<string, unknown>): Response {
    const payload = (body.payload ?? {}) as Record<string, unknown>;
    this.box.push({ type: String(body.type), payload });
    const memberId = payload.memberId as string | undefined;
    if (memberId && !this.boxMembers.has(memberId)) {
      return json({ error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
    }
    return json({ document: {}, result: { registration: { id: payload.registrationId, children: [] } } });
  }
}

let world: World;

beforeEach(() => {
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  setBridgeOrigin(null);
  setLaneStation(null);
  setLaneStation(STATION);
  setHeldRetryDelays([0, 0, 0]);
  world = new World();
  vi.stubGlobal('fetch', world.fetch);
});

afterEach(() => {
  setHeldRetryDelays(null);
  setLaneStation(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const slot = (id: string, name: string, age: string, allergies = ''): SupervisedSlot => ({
  id,
  sourceLineId: 'line-1',
  ticketType: { id: 'play-1h', name: '1 Hour Play' } as unknown as SupervisedSlot['ticketType'],
  name,
  age,
  waived: false,
  allergiesMedical: allergies,
  foodRestrictions: '',
  mayOrderFood: false,
});

/**
 * One press of the gate's Continue, in `resolveSupervisionGate`'s order with
 * its hold: the walk-in's guardian created from the form, each child saved,
 * the visit, the registration. The ids are the gate's, minted once and sent
 * again on every press, as `pages/Till.tsx` keeps them in refs.
 */
class Gate {
  hold = gateOnlineHold(() => { this.retryingSaid += 1; });
  retryingSaid = 0;
  regId = '018f0000-0000-7000-8000-00000088701a';
  childIds = new Map([['a', '018f0000-0000-7000-8000-00000088702a'], ['b', '018f0000-0000-7000-8000-00000088702b']]);
  stayIds = ['018f0000-0000-7000-8000-00000088703a', '018f0000-0000-7000-8000-00000088703b'];
  guardian: Member | null = null;
  slots = [slot('a', 'ZZ TEST Bua', '6', 'ZZ TEST peanuts'), slot('b', 'ZZ TEST Nok', '9')];
  toasts: string[] = [];

  async press(): Promise<'payment' | 'failed'> {
    this.hold.beginPress();
    try {
      let guardian = this.guardian;
      const childIdBySlot = new Map<string, string>();
      let visitId: string | null = null;
      try {
        if (!guardian) {
          const created = await membersApi.create({ phone: '0898710010', nickname: 'ZZ TEST guardian' });
          this.hold.noteWrite();
          guardian = { id: created.member.id, phone: created.member.phone, nickname: 'ZZ TEST guardian', savedChildren: [] };
          this.guardian = guardian;
        }
        const written = await saveGateChildren({
          guardian,
          slots: this.slots.map((s) => ({ slot: s, age: Number(s.age) })),
          asOf: new Date('2026-11-12T03:00:00Z'),
          childIdFor: (slotId) => this.childIds.get(slotId)!,
          matchedSlots: new Map(),
          addChild: (memberId, body, id) => membersApi.addChild(memberId, body, id),
          updateChild: (childId, patch) => membersApi.updateChild(childId, patch),
          onSaved: (slotId, child) => {
            this.hold.noteWrite();
            this.guardian = { ...this.guardian!, savedChildren: [...(this.guardian!.savedChildren ?? []).filter((c) => c.id !== child.id), child] };
            this.slots = this.slots.map((s) => (s.id === slotId ? { ...s, savedChildId: child.id } : s));
          },
        });
        for (const [k, v] of written.childIdBySlot) childIdBySlot.set(k, v);
        visitId = await confirmVisitChildren(null, { memberId: guardian.id, childIds: written.confirmedChildIds });
        this.hold.noteWrite();
      } catch (err) {
        this.toasts.push(gateFailureDescription(err, this.hold.startedOnline));
        return 'failed';
      }
      try {
        const body: CreateRegistrationBody = {
          id: this.regId,
          branchId: BRANCH,
          stationId: STATION,
          memberId: guardian.id,
          visitId,
          guardianName: 'ZZ TEST guardian',
          guardianPhone: '0898710010',
          contactChannel: 'whatsapp',
          consentAcknowledged: true,
          acknowledgedConfirmationIds: [],
          children: this.slots.map((s, i) => ({
            checkinId: this.stayIds[i]!,
            childId: childIdBySlot.get(s.id) ?? null,
            name: s.name,
            ageYears: Number(s.age),
            service: 'drop_off',
          })) as CreateRegistrationBody['children'],
        };
        const reg = await checkinApi.createRegistration(body);
        this.hold.noteWrite();
        expect(reg.id).toBe(this.regId);
      } catch (err) {
        this.toasts.push(gateFailureDescription(err, this.hold.startedOnline));
        return 'failed';
      }
      return 'payment';
    } finally {
      this.hold.endPress();
    }
  }
}

const registrationPosts = () => world.platform.filter((c) => c.path === '/checkin/registrations');

describe('SCRUM-887: the staging case — the registration drops after the guardian and children were written online', () => {
  it('retries the registration online with the same id, never asks the box, and reaches payment in one press', async () => {
    world.drops.push({ path: /^POST \/checkin\/registrations$/, at: [1], when: 'before' });
    const gate = new Gate();
    expect(await gate.press()).toBe('payment');
    expect(world.box).toEqual([]);
    expect(currentLane()).toBe('platform');
    expect(world.members.size).toBe(1);
    expect(world.children.size).toBe(2);
    expect(world.registrations.size).toBe(1);
    expect(registrationPosts().map((c) => c.body.id)).toEqual([gate.regId]);
    expect([...world.registrations.values()][0]!.children.map((c) => c.childId)).toEqual([...gate.childIds.values()]);
    // Staff were told once that the connection dropped and the till is retrying.
    expect(gate.retryingSaid).toBe(1);
    expect(gate.toasts).toEqual([]);
    expect(platformLaneHeld()).toBe(false);
  });

  it('an answer lost after the platform wrote the registration: the retry answers with it, no second registration', async () => {
    world.drops.push({ path: /^POST \/checkin\/registrations$/, at: [1], when: 'after' });
    const gate = new Gate();
    expect(await gate.press()).toBe('payment');
    expect(registrationPosts()).toHaveLength(2);
    expect(new Set(registrationPosts().map((c) => c.body.id))).toEqual(new Set([gate.regId]));
    expect(world.registrations.size).toBe(1);
    expect(world.box).toEqual([]);
  });

  it('the link stays down: plain words to staff, the lane stays the platform, and the next press finishes online with nothing written twice', async () => {
    world.drops.push({ path: /^POST \/checkin\/registrations$/, at: [1, 2, 3, 4], when: 'before' });
    const gate = new Gate();
    expect(await gate.press()).toBe('failed');
    expect(gate.toasts).toEqual([`${GATE_CONNECTION_DROPPED} ${GATE_NOTHING_TAKEN}`]);
    expect(gate.toasts[0]).not.toMatch(/Member not found/);
    expect(world.box).toEqual([]);
    expect(currentLane()).toBe('platform');
    expect(platformLaneHeld()).toBe(false);
    expect(world.registrations.size).toBe(0);

    // Something else at the till noticed the drop and moved the lane to the box meanwhile.
    setLaneStation(null);
    setLaneStation(STATION);
    await viaLane(async () => { throw new NetworkError(); }, async () => 'box');
    expect(currentLane()).toBe('box');

    // The link is back; Continue again. The gate started online, so it stays there.
    world.platform.length = 0;
    expect(await gate.press()).toBe('payment');
    expect(world.box).toEqual([]);
    expect(world.members.size).toBe(1);
    expect(world.children.size).toBe(2);
    expect(world.registrations.size).toBe(1);
    // No child was posted again: both slots were linked on the first press.
    expect(world.platform.filter((c) => /\/children$/.test(c.path) && c.method === 'POST')).toEqual([]);
    expect(registrationPosts().map((c) => c.body.id)).toEqual([gate.regId]);
  });

  it('SCRUM-871 1b: the second child\'s answer is lost after the guardian was created online — the child is retried online under its id', async () => {
    world.drops.push({ path: /^POST \/members\/[^/]+\/children$/, at: [2], when: 'after' });
    const gate = new Gate();
    expect(await gate.press()).toBe('payment');
    expect(world.box).toEqual([]);
    expect(world.children.size).toBe(2);
    const posted = world.platform.filter((c) => /\/children$/.test(c.path)).map((c) => c.body.id);
    expect(posted).toEqual([gate.childIds.get('a'), gate.childIds.get('b'), gate.childIds.get('b')]);
    expect(world.registrations.size).toBe(1);
  });
});

describe('SCRUM-887: the general rule for a till offline from the start is unchanged', () => {
  it('a dropped link before the gate wrote anything moves the guardian\'s create to the box under the same id, and the rest follows there', async () => {
    world.drops.push({ path: /^POST \/members$/, at: [1], when: 'before' });
    const gate = new Gate();
    // The box answers the create with the id it was handed.
    const inner = world.fetch.getMockImplementation()!;
    world.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { type?: string; payload?: Record<string, unknown> }) : {};
      if (url.endsWith('/intents') && body.type === 'member.create') {
        world.box.push({ type: 'member.create', payload: body.payload ?? {} });
        world.boxMembers.add(String(body.payload?.memberId));
        return json({ document: {}, result: { member: { id: body.payload?.memberId, phone: '+66898710010', children: [] } } });
      }
      if (url.endsWith('/intents') && body.type === 'child.create') {
        world.box.push({ type: 'child.create', payload: body.payload ?? {} });
        return json({ document: {}, result: { child: { id: body.payload?.childId, name: body.payload?.name, dateOfBirth: null, ageYears: body.payload?.ageYears, allergies: body.payload?.allergies ?? null } } });
      }
      if (url.endsWith('/intents') && body.type === 'visit.create') {
        world.box.push({ type: 'visit.create', payload: body.payload ?? {} });
        return json({ document: {}, result: { id: body.payload?.visitId, visitDate: '2026-11-12', status: 'draft' } });
      }
      return inner(url, init);
    });
    expect(await gate.press()).toBe('payment');
    expect(gate.hold.startedOnline).toBe(false);
    expect(currentLane()).toBe('box');
    expect(world.box.map((c) => c.type)).toEqual(['member.create', 'child.create', 'child.create', 'visit.create', 'checkin.create']);
    expect(world.members.size).toBe(0);
    expect(gate.retryingSaid).toBe(0);
  });

  it('without a hold, a dropped call still moves the till to its box', async () => {
    const result = await viaLane(async () => { throw new NetworkError(); }, async (station) => `box:${station}`);
    expect(result).toBe(`box:${STATION}`);
    expect(currentLane()).toBe('box');
    expect(isBoxLaneTrigger(new NetworkError())).toBe(true);
  });
});

describe('SCRUM-887: holdPlatformLane', () => {
  it('goes to the platform even when the lane says box, and retries only a dropped link', async () => {
    await viaLane(async () => { throw new NetworkError(); }, async () => 'box');
    expect(currentLane()).toBe('box');
    const release = holdPlatformLane();
    try {
      let calls = 0;
      const answer = await viaLane(async () => {
        calls += 1;
        if (calls < 3) throw new NetworkError();
        return 'platform';
      }, async () => 'box');
      expect(answer).toBe('platform');
      expect(calls).toBe(3);
      // A refusal is the platform's answer: never retried, never sent to the box.
      let refused = 0;
      await expect(viaLane(async () => {
        refused += 1;
        throw new ApiError(409, 'CONSENT_REQUIRED', 'Consent first');
      }, async () => 'box')).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
      expect(refused).toBe(1);
    } finally { release(); }
    expect(platformLaneHeld()).toBe(false);
    // Released: the lane's own rule again.
    expect(await viaLane(async () => 'platform', async () => 'box')).toBe('box');
  });

  it('gives up after the backoff with the dropped link\'s own error, and hears each retry', async () => {
    const heard: number[] = [];
    const release = holdPlatformLane((attempt) => heard.push(attempt));
    try {
      let calls = 0;
      await expect(viaLane(async () => { calls += 1; throw new NetworkError(); }, async () => 'box')).rejects.toBeInstanceOf(NetworkError);
      expect(calls).toBe(4);
      expect(heard).toEqual([1, 2, 3]);
      expect(currentLane()).toBe('platform');
    } finally { release(); }
  });

  it('the Console\'s forced-offline switch still sends a held call to the box', async () => {
    const release = holdPlatformLane();
    try {
      const answer = await viaLane(
        async () => { throw new ApiError(503, 'STATION_FORCED_OFFLINE', 'forced'); },
        async (station) => `box:${station}`,
      );
      expect(answer).toBe(`box:${STATION}`);
      expect(currentLane()).toBe('box');
    } finally { release(); }
  });

  it('a release is taken once, however many times it is called', () => {
    const one = holdPlatformLane();
    const two = holdPlatformLane();
    one();
    one();
    expect(platformLaneHeld()).toBe(true);
    two();
    expect(platformLaneHeld()).toBe(false);
  });

  it('the gate takes no hold for a write its box answered, and a new gate starts unheld', async () => {
    await viaLane(async () => { throw new NetworkError(); }, async () => 'box');
    const gate = gateOnlineHold(() => undefined);
    gate.beginPress();
    gate.noteWrite();
    expect(gate.startedOnline).toBe(false);
    expect(platformLaneHeld()).toBe(false);
    gate.endPress();

    setLaneStation(null);
    setLaneStation(STATION);
    gate.beginPress();
    gate.noteWrite();
    expect(gate.startedOnline).toBe(true);
    expect(platformLaneHeld()).toBe(true);
    gate.endPress();
    expect(platformLaneHeld()).toBe(false);
    gate.beginPress();
    expect(platformLaneHeld()).toBe(true);
    gate.endPress();
    gate.reset();
    gate.beginPress();
    expect(platformLaneHeld()).toBe(false);
    gate.endPress();
  });
});

describe('SCRUM-887: what staff read', () => {
  it('a dropped link after an online write says the connection dropped and to press Continue again', () => {
    const words = gateFailureDescription(new NetworkError(), true);
    expect(words).toBe(`${GATE_CONNECTION_DROPPED} ${GATE_NOTHING_TAKEN}`);
    expect(words).toMatch(/press Continue again/);
    expect(words).toMatch(/Nobody has been checked in or charged/);
  });

  it('a box that has not pulled the family yet (the forced-offline switch) says to wait a minute', async () => {
    world.forcedOffline = true;
    const release = holdPlatformLane();
    let err: unknown;
    try {
      await checkinApi.createRegistration({
        id: '018f0000-0000-7000-8000-00000088799a', branchId: BRANCH, memberId: '018f0000-0000-7000-8000-00000088799b',
        guardianName: 'ZZ TEST', contactChannel: 'whatsapp', consentAcknowledged: true, acknowledgedConfirmationIds: [], children: [],
      });
    } catch (caught) { err = caught; } finally { release(); }
    expect(err).toBeInstanceOf(ApiError);
    expect(gateFailureDescription(err, true)).toBe(`${GATE_BOX_NOT_SYNCED} ${GATE_NOTHING_TAKEN}`);
    // A gate that did not start online keeps the box's own words, as before.
    expect(gateFailureDescription(err, false)).toBe(`Member not found ${GATE_NOTHING_TAKEN}`);
  });

  it('every other failure keeps the words it always had', () => {
    expect(gateFailureDescription(new ApiError(409, 'CONSENT_REQUIRED', 'Consent first.'), true)).toBe(`Consent first. ${GATE_NOTHING_TAKEN}`);
    expect(gateFailureDescription(new NetworkError(), false)).toBe(`${new NetworkError().message} ${GATE_NOTHING_TAKEN}`);
    expect(gateFailureDescription('odd', false)).toBe(`Unknown error ${GATE_NOTHING_TAKEN}`);
  });
});

describe('SCRUM-887: the till holds its gate', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/pages/Till.tsx', import.meta.url)), 'utf8');
  const gate = src.slice(src.indexOf('const resolveSupervisionGate'), src.indexOf('const handleDoneAdding'));

  it('notes every gate write and holds each press, released when the press ends', () => {
    expect(src).toMatch(/const \[gateOnline\] = useState\(\(\) => gateOnlineHold\(\(words\) => toast\(words\)\)\)/);
    expect(gate.indexOf('gateOnline.beginPress()')).toBeGreaterThan(-1);
    expect(gate.indexOf('gateOnline.beginPress()')).toBeLessThan(gate.indexOf('saveGateChildren('));
    // member create, each child, the visit, the registration
    expect(gate.match(/gateOnline\.noteWrite\(\)/g)).toHaveLength(4);
    // SCRUM-857 — each note asks first whether the run's sale is still on the
    // till: a run whose sale was cancelled while it saved (the family's Done,
    // then staff Back and Cancel) never marks the next sale's gate online.
    expect(gate.match(/(?:if \(!ownSale\(\)\) return;\s*|if \(ownSale\(\)\) |if \(epoch === saleEpochRef\.current\) )gateOnline\.noteWrite\(\)/g)).toHaveLength(4);
    expect(gate).toMatch(/onSaved: \(slotId, child, guardianId\) => \{\s*if \(!ownSale\(\)\) return;\s*gateOnline\.noteWrite\(\);/);
    expect(gate).toMatch(/registrationId = reg\.id;\s*if \(ownSale\(\)\) gateOnline\.noteWrite\(\);/);
    expect(gate).toMatch(/const findOrCreateGateMember = [^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*const epoch = saleEpochRef\.current;/);
    expect(gate).toMatch(/resolveSupervisionGate\(\)\.finally\(\(\) => \{\s*gateOnline\.endPress\(\);/);
    expect(gate.match(/gateFailureDescription\(err, gateOnline\.startedOnline\)/g)).toHaveLength(2);
    const open = src.slice(src.indexOf('const openSupervisionGate'), src.indexOf('const handleUpdateSlot'));
    expect(open).toMatch(/gateOnline\.reset\(\)/);
  });
});
