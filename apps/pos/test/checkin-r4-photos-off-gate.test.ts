import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOX_CHECKIN_REFUSALS, BRIDGE_CHECKIN_INTENTS } from '@oto/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseApi } from '@/api/release';
import { setLaneStation } from '@/lib/lane';

/**
 * S2-13 ROUND 4 — FOCUSED GATE REPRODUCTION: CHILD_PHOTOS_ENABLED OFF ON THE BOX LANE.
 *
 * With the flag off the box refuses every capture and tells the counter, in
 * `BOX_CHECKIN_REFUSALS.photosOff`, to "carry on without a photo" — and its own
 * `release.create` accepts a release with no pickup photo. The till must be
 * able to do what those words say: the release modal reads the box's
 * `photosEnabled` (answered on `release.context` and `checkin.config`) and,
 * while it is false, releases without a photo and adds an on-the-spot
 * collector without one. The platform never answers `photosEnabled`, so
 * online a photo stays required (R-92).
 *
 * The api half is driven through a stubbed `fetch`; the modal and the gate's
 * toast are checked at source, because the till's unit runner has no DOM.
 */

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const REG = '018f0000-0000-7000-8000-00000000a001';
const STAY = '018f0000-0000-7000-8000-00000000c001';
const RELEASE = '018f0000-0000-7000-8000-00000000e001';
const GUARDIAN = '018f0000-0000-7000-8000-00000000d001';
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

const boxContext = (photosEnabled: boolean) => ({
  checkinId: STAY,
  registrationId: REG,
  branchId: '018f0000-0000-7000-8000-0000000000b2',
  childName: 'Mint',
  childAgeYears: 6,
  guardianName: 'Ploy',
  status: 'in_park',
  signUpPhotoFileId: null,
  pickups: [],
  reconciliation: null,
  prepaidPolicy: 'forfeit',
  release: null,
  photosEnabled,
  source: 'box',
});

const releaseView = (pickupPhotoFileId: string | null) => ({
  id: RELEASE,
  checkinId: STAY,
  registrationId: REG,
  childName: 'Mint',
  collectorName: 'Ploy',
  collectorSource: 'dropper_off',
  guardianId: null,
  verifiedByAccountId: 'acct',
  verifiedByName: 'Nok',
  pickupPhotoFileId,
  stationId: STATION,
  checkedOutAt: '2026-10-01T06:00:00.000Z',
  settlement: null,
});

const root = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

beforeEach(() => {
  setLaneStation(null);
  setLaneStation(STATION);
});

afterEach(() => {
  setLaneStation(null);
  vi.unstubAllGlobals();
});

describe('photos switched off on the box lane (S2-13 r4 gate)', () => {
  it('the box tells the counter to carry on without a photo', () => {
    expect(BOX_CHECKIN_REFUSALS.photosOff.message).toContain('carry on without a photo');
  });

  it('the box lane’s context carries photosEnabled, and the platform’s does not', async () => {
    stubFetch((intent) =>
      intent.type === BRIDGE_CHECKIN_INTENTS.context ? reply({ document: {}, result: boxContext(false) }) : reply({}, 500),
    );
    const ctx = await releaseApi.context(STAY);
    expect(ctx.photosEnabled).toBe(false);
    // The platform's shape never names it: absent means a photo is required.
    const platform = read('../../api/src/services/release.ts');
    expect(platform.slice(platform.indexOf('export interface ReleaseContext'))).not.toMatch(/photosEnabled/);
  });

  it('with photos off, a release goes to the box with no pickup photo and comes back as the box recorded it', async () => {
    const seen = stubFetch((intent) =>
      intent.type === BRIDGE_CHECKIN_INTENTS.release
        ? reply({ document: {}, result: { replay: false, release: releaseView(null) } })
        : reply({}, 500),
    );
    const { release } = await releaseApi.release(STAY, {
      id: RELEASE,
      collector: { kind: 'dropper_off' },
      pickupPhotoFileId: null,
    });
    expect(release.pickupPhotoFileId).toBeNull();
    expect(seen[0]).toMatchObject({
      type: BRIDGE_CHECKIN_INTENTS.release,
      payload: { releaseId: RELEASE, checkinId: STAY, collector: { kind: 'dropper_off' }, pickupPhotoId: null },
    });
  });

  it('with photos off, an on-the-spot collector is added to the box’s list with no photo', async () => {
    const seen = stubFetch((intent) =>
      intent.type === BRIDGE_CHECKIN_INTENTS.guardian
        ? reply({
            document: {},
            result: {
              id: GUARDIAN,
              registrationId: REG,
              name: 'Khun Somchai',
              phone: null,
              relationship: 'grandfather',
              photoFileId: null,
              isDropperOff: false,
              source: 'on_the_spot',
              addedByName: null,
              addedAt: '2026-10-01T06:00:00.000Z',
            },
          })
        : reply({}, 500),
    );
    const added = await releaseApi.addGuardian(REG, {
      id: GUARDIAN,
      name: 'Khun Somchai',
      relationship: 'grandfather',
      phone: null,
      photoFileId: null,
      source: 'on_the_spot',
    });
    expect(added.photoFileId).toBeNull();
    expect(seen[0]!.payload).toMatchObject({ guardianId: GUARDIAN, source: 'on_the_spot', photoId: null });
  });

  it('the release modal branches on the box’s photosEnabled: no camera, no wait for a photo, the box’s own words', () => {
    const modal = read('components/dropoff/CheckOutModal.tsx');
    const api = read('api/release.ts');
    expect(api, 'ReleaseContext carries the box’s photosEnabled').toMatch(/photosEnabled\?: boolean/);
    expect(modal, 'the modal reads photosEnabled').toMatch(/context\?\.photosEnabled !== false/);
    // The confirm press no longer returns early without a photo when photos are off.
    expect(modal).toMatch(/if \(photosEnabled && \(!pickupPhotoUrl \|\| !photo\)\) return;/);
    expect(modal).toMatch(/pickupPhotoFileId: photo,/);
    // The on-the-spot collector may be added without a photo when photos are off.
    expect(modal).toMatch(/const withPhoto = photosEnabled \? onSpotFileId : null;/);
    // The note is the box's own refusal, not words of the till's own.
    expect(modal).toMatch(/BOX_CHECKIN_REFUSALS\.photosOff\.message/);
  });

  it('the gate’s consent-photo toast does not say "take the photo again" when the box said photos are off', () => {
    const till = read('pages/Till.tsx');
    const branch = till.slice(till.indexOf("err.code === 'CHILD_PHOTOS_DISABLED'"));
    const offBranch = branch.slice(0, branch.indexOf('continue;'));
    expect(offBranch).not.toMatch(/take the photo again/);
    expect(offBranch).toMatch(/The registration is saved\./);
  });
});
