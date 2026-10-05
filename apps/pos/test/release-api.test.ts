import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickupView, PrepaidReconciliation } from '@oto/shared';
import { checkinApi } from '@/api/checkin';
import { pickupFromView, reconciliationFromWire, releaseApi } from '@/api/release';

/**
 * S2-13 round 3 — the till's half of pickups and release (plan
 * docs/progress/plans/checkin/PLAN.md §2.4).
 *
 * The four components the round owns no longer read the prototype's
 * in-memory store; they call `releaseApi`, which this file drives against a
 * stubbed `fetch`: the photo is registered under the registration and stored
 * through the same-origin API, the release names it by id, and the
 * platform's satang come back to the summary as the prototype's baht, exactly.
 */

const REG = '0190a0a0-0000-7000-8000-000000000001';
const STAY = '0190a0a0-0000-7000-8000-000000000c01';

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
let calls: Call[];
let answers: Array<(call: Call) => Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request ${call.method} ${url}`);
    return next(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the four components dropped the prototype store', () => {
  const files = [
    '../src/components/dropoff/CheckOutModal.tsx',
    '../src/components/shared/AuthorizedPickupSheet.tsx',
    '../src/components/shared/CameraCapture.tsx',
    '../src/components/shared/FoodReconciliationSummary.tsx',
  ];
  for (const rel of files) {
    it(`${rel.split('/').pop()} imports nothing from mockApi`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src).not.toMatch(/from ['"]@\/mockApi['"]/);
    });
  }
});

describe('releaseApi', () => {
  it('stores consent photos on the same origin before attaching them', async () => {
    answers.push(
      (c) => json({ id: (c.body as { id: string }).id, uploadUrl: 'https://storage.example/unused' }),
      () => new Response(null, { status: 204 }),
      () => json({ id: REG, children: [] }),
    );
    await checkinApi.uploadPhoto(REG, 'data:image/jpeg;base64,/9j/AA==', [STAY]);
    const id = (calls[0]!.body as { id: string }).id;
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/files', `PUT /api/files/${id}/content`, `POST /api/checkin/registrations/${REG}/photo`,
    ]);
    expect(calls[1]!.body).toBeInstanceOf(Blob);
    expect(calls[1]!.headers['idempotency-key']).toBeUndefined();
    expect(calls[2]!.body).toMatchObject({ fileId: id, checkinIds: [STAY] });
  });

  it('stores a photo under the registration through the signed-in API', async () => {
    answers.push(
      (c) => json({ id: (c.body as { id: string }).id, uploadUrl: 'https://storage.example/put?sig=1' }),
      () => new Response(null, { status: 204 }),
    );
    const id = await releaseApi.uploadPhoto(REG, 'data:image/jpeg;base64,/9j/AA==');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: '/api/files', method: 'POST' });
    expect(calls[0]!.body).toMatchObject({ contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: REG });
    expect(calls[0]!.headers['idempotency-key']).toBeTruthy();
    expect(calls[1]).toMatchObject({ url: `/api/files/${id}/content`, method: 'PUT' });
    expect(calls[1]!.body).toBeInstanceOf(Blob);
    expect(calls[1]!.headers['content-type']).toBe('image/jpeg');
    expect(calls[1]!.headers['idempotency-key']).toBeUndefined();
    expect(id).toBe((calls[0]!.body as { id: string }).id);
  });

  it('passes on the platform refusal when the photo cannot be stored', async () => {
    answers.push(
      () => json({ id: 'f', uploadUrl: 'https://storage.example/put' }),
      () => json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is unavailable — try again in a moment' } }, 503),
    );
    await expect(releaseApi.uploadPhoto(REG, 'data:image/jpeg;base64,AA==')).rejects.toThrow('File storage is unavailable');
  });

  it('releases with the collector and the stored pickup photo, and surfaces a refusal in the counter’s words', async () => {
    answers.push(() =>
      json(
        {
          error: {
            code: 'COLLECTOR_NOT_LISTED',
            message: "That person is not on this child's pickup list. Add them on the spot with their name and photo, or call the parent.",
          },
        },
        409,
      ),
    );
    await expect(
      releaseApi.release(STAY, { id: 'r1', collector: { kind: 'guardian', guardianId: 'g1' }, pickupPhotoFileId: 'p1' }),
    ).rejects.toThrow("not on this child's pickup list");
    expect(calls[0]).toMatchObject({
      url: `/api/checkin/pickups/stays/${STAY}/release`,
      method: 'POST',
      body: { id: 'r1', collector: { kind: 'guardian', guardianId: 'g1' }, pickupPhotoFileId: 'p1' },
    });
  });

  it('promotes a chat photo: the image stored, the person added from_chat with it', async () => {
    answers.push(
      () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { status: 200 }),
      (c) => json({ id: (c.body as { id: string }).id, uploadUrl: 'https://storage.example/put' }),
      () => new Response(null, { status: 204 }),
      (c) =>
        json({
          id: (c.body as { id: string }).id,
          registrationId: REG,
          name: 'Aunt Noi',
          phone: null,
          relationship: 'aunt',
          photoFileId: 'x',
          isDropperOff: false,
          source: 'from_chat',
          addedByName: 'Reception',
          addedAt: '2026-10-01T10:00:00.000Z',
        }),
    );
    const added = await releaseApi.promoteFromChat(REG, { name: 'Aunt Noi', relationship: 'aunt', imageUrl: 'https://chat.example/photo.png' });
    expect(added.source).toBe('from_chat');
    expect(calls[0]!.url).toBe('https://chat.example/photo.png');
    expect(calls[1]!.body).toMatchObject({ contentType: 'image/png', ownerEntityType: 'registration' });
    expect(calls[2]!.url).toBe(`/api/files/${(calls[1]!.body as { id: string }).id}/content`);
    expect(calls[3]).toMatchObject({ url: `/api/checkin/pickups/registrations/${REG}/guardians`, method: 'POST' });
    expect(calls[3]!.body).toMatchObject({ name: 'Aunt Noi', source: 'from_chat', photoFileId: (calls[1]!.body as { id: string }).id });
  });
});

describe('the mapping to the prototype shapes', () => {
  it('a platform pickup is the prototype’s AuthorizedPickup, with the photo URL it was read at', () => {
    const view: PickupView = {
      id: 'dropper_off',
      registrationId: REG,
      name: 'Ploy',
      phone: '+66812345678',
      relationship: null,
      photoFileId: 'file-1',
      isDropperOff: true,
      source: 'dropper_off',
      addedByName: null,
      addedAt: '2026-10-01T09:00:00.000Z',
    };
    expect(pickupFromView(view, 'https://signed/1')).toEqual({
      id: 'dropper_off',
      registrationId: REG,
      name: 'Ploy',
      phone: '+66812345678',
      photoUrl: 'https://signed/1',
      isDropperOff: true,
      source: 'dropper_off',
      addedAt: '2026-10-01T09:00:00.000Z',
    });
  });

  it('the reconciliation comes back in baht to the satang', () => {
    const wire: PrepaidReconciliation = {
      mode: 'prepaid_items',
      paidSatang: 21_625,
      remainingCreditSatang: 0,
      itemBreakdown: [
        { menuItemName: 'Orange juice', qty: 2, redeemedQty: 1, unredeemedQty: 1, unitSatang: 4_550, unredeemedSatang: 4_550 },
        { menuItemName: 'Ham sandwich', qty: 1, redeemedQty: 0, unredeemedQty: 1, unitSatang: 12_525, unredeemedSatang: 12_525 },
      ],
      totalRedeemedSatang: 4_550,
      totalUnusedSatang: 17_075,
    };
    expect(reconciliationFromWire(wire)).toEqual({
      mode: 'prepaid_items',
      paidTHB: 216.25,
      remainingCreditTHB: 0,
      itemBreakdown: [
        { menuItemName: 'Orange juice', qty: 2, redeemedQty: 1, unredeemedQty: 1, unitPriceTHB: 45.5, unredeemedValueTHB: 45.5 },
        { menuItemName: 'Ham sandwich', qty: 1, redeemedQty: 0, unredeemedQty: 1, unitPriceTHB: 125.25, unredeemedValueTHB: 125.25 },
      ],
      totalRedeemedTHB: 45.5,
      totalUnusedTHB: 170.75,
    });
  });
});
