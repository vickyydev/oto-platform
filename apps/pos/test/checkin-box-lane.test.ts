import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBridgeStaffName } from '@/api/bridge';
import { boardApi, checkinApi } from '@/api/checkin';
import { releaseApi } from '@/api/release';
import { currentLane, setLaneStation } from '@/lib/lane';

/**
 * S2-13 ROUND 4 — CHECK-IN, THE BOARD AND RELEASE WITH THE LINK DOWN, THE
 * TILL'S HALF (plan §2.5).
 *
 * The gate, the board and the release modal call `checkinApi`, `boardApi` and
 * `releaseApi` exactly as they do online; when the platform refuses the
 * station (or cannot be reached) the same calls ride the station bridge to
 * the counter's box under the same ids. `fetch` is stubbed at the boundary,
 * so every path asserted is one the till would call.
 */

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const BRANCH = '018f0000-0000-7000-8000-0000000000b2';
const REG = '018f0000-0000-7000-8000-00000000a001';
const STAY = '018f0000-0000-7000-8000-00000000c001';
const SALE = '018f0000-0000-7000-8000-00000000b001';
const intentsUrl = `/api/box/v1/station/${STATION}/intents`;

const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;
const forcedOffline = () =>
  reply({ error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } }, 503);

interface Intent {
  type: string;
  payload: Record<string, unknown>;
}

function stubFetch(bridge: (intent: Intent) => Response) {
  const seen: Intent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === intentsUrl) {
        const intent = JSON.parse(String(init?.body)) as Intent;
        seen.push(intent);
        return bridge(intent);
      }
      return forcedOffline();
    }),
  );
  return seen;
}

const stay = (over: Record<string, unknown> = {}) => ({
  id: STAY,
  registrationId: REG,
  childId: null,
  childName: 'Mint',
  childAgeYears: 6,
  dateOfBirth: null,
  allergies: null,
  foodRestrictions: null,
  mayOrderFood: false,
  foodProvision: null,
  service: 'drop_off',
  status: 'registered',
  scheduledFor: null,
  bookedMinutes: 120,
  nannyId: null,
  nannyName: null,
  checkedInAt: null,
  checkedOutAt: null,
  saleId: SALE,
  bandId: null,
  visitId: null,
  photoFileId: null,
  ...over,
});

const family = (over: Record<string, unknown> = {}) => ({
  registrationId: REG,
  branchId: BRANCH,
  memberId: null,
  guardianName: 'Ploy',
  guardianPhone: '+66812345678',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-10-01T03:00:00.000Z',
  source: 'till',
  photoFileId: null,
  createdAt: '2026-10-01T03:00:00.000Z',
  contact: null,
  tab: 'registered',
  children: [stay()],
  guardians: [
    {
      id: '018f0000-0000-7000-8000-00000000d001',
      registrationId: REG,
      name: 'Khun Somchai',
      relationship: 'grandfather',
      phone: null,
      photoFileId: null,
      source: 'in_person',
      revoked: false,
      createdAt: '2026-10-01T03:01:00.000Z',
    },
  ],
  origin: 'cache',
  ...over,
});

beforeEach(() => {
  setLaneStation(null);
  setLaneStation(STATION);
  setBridgeStaffName('Nok');
});

afterEach(() => {
  setLaneStation(null);
  setBridgeStaffName(null);
  vi.unstubAllGlobals();
});

describe('the gate on the box lane', () => {
  it('registers through the box under the gate’s own ids when the platform refuses the station', async () => {
    const seen = stubFetch((intent) =>
      intent.type === 'checkin.create'
        ? reply({ document: {}, result: { registration: { id: REG, children: [stay()] } } })
        : reply({}, 500),
    );
    const reg = await checkinApi.createRegistration({
      id: REG,
      branchId: BRANCH,
      stationId: STATION,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ['confirm-15min'],
      children: [{ checkinId: STAY, name: 'Mint', ageYears: 6, service: 'drop_off' }],
    });
    expect(reg.id).toBe(REG);
    expect(currentLane()).toBe('box');
    expect(seen[0]).toMatchObject({
      type: 'checkin.create',
      payload: {
        registrationId: REG,
        guardianName: 'Ploy',
        consentAcknowledged: true,
        children: [{ checkinId: STAY, name: 'Mint', ageYears: 6, service: 'drop_off' }],
      },
    });
  });

  it('"Check in now" and "Leave as booked" ride the box with the staff name, answered in the platform’s shape', async () => {
    const seen = stubFetch((intent) =>
      intent.payload.event === 'check_in_now'
        ? reply({
            document: {},
            result: {
              saleId: SALE,
              children: [stay({ status: 'in_park', bandId: 'band-1' })],
              bands: [{ id: 'band-1', checkinId: STAY, childName: 'Mint', shortCode: 'T1-7KMQ4X' }],
              printJobs: [{ id: 'job-1', kind: 'kids_wristband', status: 'printed' }],
              notes: [],
            },
          })
        : reply({ document: {}, result: { saleId: SALE, children: [stay({ scheduledFor: '2026-10-01T05:00:00.000Z' })] } }),
    );
    const done = await checkinApi.checkInNow({ saleId: SALE, entries: [{ checkinId: STAY, nannyId: null }] });
    expect(done.bands[0]).toMatchObject({ id: 'band-1', shortCode: 'T1-7KMQ4X' });
    expect(seen[0]).toEqual({
      type: 'checkin.update',
      payload: { event: 'check_in_now', saleId: SALE, entries: [{ checkinId: STAY, nannyId: null }], staffName: 'Nok' },
      lastSeenSequence: 0,
      actionId: expect.any(String),
    });
    const booked = await checkinApi.leaveAsBooked({ saleId: SALE, entries: [{ checkinId: STAY }] });
    expect(booked.children[0]!.scheduledFor).toBe('2026-10-01T05:00:00.000Z');
    expect(seen[1]!.payload).toMatchObject({ event: 'leave_as_booked', saleId: SALE });
  });

  it('what the box lane does not do is refused in the counter’s words, before anything is sent', async () => {
    const seen = stubFetch(() => reply({}, 500));
    await expect(checkinApi.addChildren(REG, [])).rejects.toThrow(/needs the internet — this counter is offline/);
    await expect(boardApi.edit(STAY, { guardianName: 'Fah' })).rejects.toThrow(/guardian's name, phone or channel needs the internet/);
    await expect(releaseApi.revokeGuardian('g-1')).rejects.toThrow(/needs the internet/);
    expect(seen).toEqual([]);
  });
});

describe('the board and the release on the box lane', () => {
  it('reads the board from the box, edits there, and checks a booked child in on the sale they paid on', async () => {
    const seen = stubFetch((intent) => {
      if (intent.type === 'checkin.board') {
        return reply({
          document: {},
          result: { families: [family()], counts: { registered: 1, in_park: 0, out: 0 }, unconfirmedFamilies: 1, nannies: [], nannyRatioSoftMax: 3, prepaidFoodUnused: 'refund' },
        });
      }
      if (intent.payload.event === 'edit') {
        return reply({ document: {}, result: { checkin: stay({ allergies: 'Peanuts' }), changed: 1, warnings: [], contact: null } });
      }
      return reply({
        document: {},
        result: { saleId: SALE, children: [stay({ status: 'in_park' })], bands: [{ id: 'band-2', checkinId: STAY, childName: 'Mint', shortCode: 'T1-AAAA11' }], printJobs: [], notes: [] },
      });
    });
    const board = await boardApi.board(BRANCH);
    expect(board.families[0]!.children[0]!.id).toBe(STAY);
    const today = await boardApi.today(BRANCH);
    expect(today).toEqual({ inPark: 0, upcoming: 1 });
    const edit = await boardApi.edit(STAY, { allergies: 'Peanuts', bookedMinutes: 180 });
    expect(edit.changed).toBe(1);
    expect(seen.find((i) => i.payload.event === 'edit')!.payload).toEqual({
      event: 'edit',
      checkinId: STAY,
      fields: { allergies: 'Peanuts', bookedMinutes: 180 },
    });
    const booked = await boardApi.checkInBooked({ entries: [{ checkinId: STAY }] });
    expect(booked.saleIds).toEqual([SALE]);
    expect(seen.at(-1)!.payload).toMatchObject({ event: 'check_in_now', saleId: SALE, entries: [{ checkinId: STAY }] });
  });

  it('the release modal: its context, the pickup list, a photo kept on the box and the release, all through the box', async () => {
    const dataUrl = `data:image/jpeg;base64,${btoa('\xff\xd8\xff\xe0 a face, never a document')}`;
    const seen = stubFetch((intent) => {
      switch (intent.type) {
        case 'release.context':
          return reply({ document: {}, result: { checkinId: STAY, registrationId: REG, pickups: [], status: 'in_park' } });
        case 'checkin.board':
          return reply({ document: {}, result: { families: [family()] } });
        case 'photo.capture':
          return reply({ document: {}, result: { photoId: intent.payload.photoId, fileId: intent.payload.photoId, pendingUpload: true } });
        case 'release.create':
          return reply({ document: {}, result: { replay: false, release: { id: intent.payload.releaseId, collectorName: 'Ploy', settlement: null } } });
        default:
          return reply({}, 500);
      }
    });
    const ctx = await releaseApi.context(STAY);
    expect(ctx.registrationId).toBe(REG);
    const list = await releaseApi.pickups(REG);
    expect(list.pickups.map((p) => p.name)).toEqual(['Ploy', 'Khun Somchai']);
    expect(list.pickups[0]).toMatchObject({ id: 'dropper_off', isDropperOff: true });
    const photoId = await releaseApi.uploadPhoto(REG, dataUrl);
    const capture = seen.find((i) => i.type === 'photo.capture')!;
    expect(capture.payload).toMatchObject({ registrationId: REG, purpose: 'pickup' });
    expect(capture.payload.photoId).toBe(photoId);
    const releaseId = releaseApi.newId();
    const { release } = await releaseApi.release(STAY, { id: releaseId, collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId });
    expect(release.collectorName).toBe('Ploy');
    expect(seen.find((i) => i.type === 'release.create')!.payload).toEqual({
      releaseId,
      checkinId: STAY,
      collector: { kind: 'dropper_off' },
      pickupPhotoId: photoId,
    });
  });
});
