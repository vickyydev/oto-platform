import {
  BRIDGE_CHECKIN_INTENTS,
  DROPPER_OFF_PICKUP_ID,
  newId as newRecordId,
  type BridgeCheckinFamily,
  type PickupView,
  type PrepaidReconciliation,
  type ReleaseView,
} from '@oto/shared';
import type { AuthorizedPickup } from '@/types';
import type { PrepaidFoodReconciliation } from '@/lib/dropoff';
import { viaLane } from '@/lib/lane';
import { api, idemKey } from './client';
import { bridgeApi } from './bridge';
import { capturePhotoOnBox } from './checkin';

/**
 * S2-13 round 3 — the pickup list and the release, ONLINE (plan
 * docs/progress/plans/checkin/PLAN.md §2.4).
 *
 * Where the prototype's board called `getAuthorizedPickups`,
 * `addGuardianToRegistration`, `editGuardian`, `addPickupFromChatPhoto` and
 * `checkOut`, it calls these. The platform enforces R-92 — a release names a
 * listed, unrevoked person or an on-the-spot collector with name and photo,
 * and always carries the live pickup photo — so a refusal arrives here in the
 * counter's words and is shown as it came.
 *
 * Photos: registered under the REGISTRATION through `POST /files`, PUT
 * straight to storage on the presigned URL, then named by id on the guardian
 * or the release, which takes them over. Reading one back goes through
 * `GET /files/:id/url`, which the platform access-logs (R-94) — so a photo is
 * read when it is shown, and only then. Never a photo of an identity document.
 */

/**
 * ROUND 4 — THE BOX LANE (plan §2.5). The pickup list, the release modal's
 * context, an on-the-spot collector and the release itself answer from the
 * counter's box when the link is down, in the platform's own shapes; the
 * photos are kept on the box and sent when the link is back (the row says
 * `photo_pending_upload` until then). Editing or revoking someone already on
 * the list, and reading a stored photo, wait for the link.
 */
async function onBox<R>(stationId: string, type: string, payload: Record<string, unknown>): Promise<R> {
  const answer = await bridgeApi.intent<R>(stationId, type, payload, { actionId: newRecordId() });
  return answer.result as R;
}

function needsInternet(what: string): Error {
  return new Error(`${what} needs the internet — this counter is offline. Do it when the connection is back.`);
}

/** A family's pickup list as the box knows it: the dropper-off first, then everyone added. */
function pickupsOfFamily(family: BridgeCheckinFamily): PickupView[] {
  return [
    {
      id: DROPPER_OFF_PICKUP_ID,
      registrationId: family.registrationId,
      name: family.guardianName,
      phone: family.guardianPhone,
      relationship: null,
      photoFileId: family.photoFileId,
      isDropperOff: true,
      source: 'dropper_off',
      addedByName: null,
      addedAt: family.createdAt,
    },
    ...family.guardians
      .filter((g) => !g.revoked)
      .map((g) => ({
        id: g.id,
        registrationId: family.registrationId,
        name: g.name,
        phone: g.phone,
        relationship: g.relationship,
        photoFileId: g.photoFileId,
        isDropperOff: false,
        source: g.source,
        addedByName: null,
        addedAt: g.createdAt,
      })),
  ];
}

export interface ReleaseContext {
  checkinId: string;
  registrationId: string;
  branchId: string;
  childName: string;
  childAgeYears: number;
  guardianName: string;
  status: 'registered' | 'in_park' | 'out';
  signUpPhotoFileId: string | null;
  pickups: PickupView[];
  reconciliation: PrepaidReconciliation | null;
  prepaidPolicy: 'refund' | 'forfeit';
  release: ReleaseView | null;
  /**
   * The BOX's answer only (gate r4, finding 2): `false` while
   * `CHILD_PHOTOS_ENABLED` is off on that counter's box, which then refuses
   * every capture and accepts a release — or an on-the-spot collector — with
   * no photo. The platform never answers it (R-92: a photo, always), so absent
   * means required.
   */
  photosEnabled?: boolean;
}

export type ReleaseCollector =
  | { kind: 'dropper_off' }
  | { kind: 'guardian'; guardianId: string }
  | {
      kind: 'on_the_spot';
      guardianId?: string;
      name: string;
      relationship?: string | null;
      phone?: string | null;
      /** Null only where photos are switched off (`photosEnabled: false`). */
      photoFileId: string | null;
    };

/** A data URL — or any URL the browser can fetch — as the bytes an upload sends. */
async function blobOf(url: string): Promise<Blob> {
  if (url.startsWith('data:')) {
    const [head, body = ''] = url.split(',');
    const type = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/jpeg';
    const bytes = atob(body);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
    return new Blob([out], { type });
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('The photo could not be read — take it again.');
  return res.blob();
}

/** The platform's pickup (satang-free, file ids) in the prototype's `AuthorizedPickup` shape. */
export function pickupFromView(p: PickupView, photoUrl?: string): AuthorizedPickup {
  return {
    id: p.id,
    registrationId: p.registrationId,
    name: p.name,
    ...(p.phone ? { phone: p.phone } : {}),
    ...(p.relationship ? { relationship: p.relationship } : {}),
    ...(photoUrl ? { photoUrl } : {}),
    isDropperOff: p.isDropperOff,
    source: p.source,
    ...(p.addedByName ? { addedBy: p.addedByName } : {}),
    addedAt: p.addedAt,
  };
}

/** The platform's reconciliation (satang) as the prototype's summary reads it (baht). */
export function reconciliationFromWire(r: PrepaidReconciliation): PrepaidFoodReconciliation {
  return {
    mode: r.mode,
    paidTHB: r.paidSatang / 100,
    remainingCreditTHB: r.remainingCreditSatang / 100,
    itemBreakdown: r.itemBreakdown.map((i) => ({
      menuItemName: i.menuItemName,
      qty: i.qty,
      redeemedQty: i.redeemedQty,
      unredeemedQty: i.unredeemedQty,
      unitPriceTHB: i.unitSatang / 100,
      unredeemedValueTHB: i.unredeemedSatang / 100,
    })),
    totalRedeemedTHB: r.totalRedeemedSatang / 100,
    totalUnusedTHB: r.totalUnusedSatang / 100,
  };
}

export const releaseApi = {
  /** A fresh client-minted id (OD-12) for a guardian or a release. */
  newId: (): string => newRecordId(),

  /** Everything the release modal shows for one stay. */
  context: (checkinId: string) =>
    viaLane(
      () => api.get<ReleaseContext>(`/checkin/pickups/stays/${encodeURIComponent(checkinId)}`),
      (stationId) => onBox<ReleaseContext>(stationId, BRIDGE_CHECKIN_INTENTS.context, { checkinId }),
    ),

  /** A registration's pickup list: the dropper-off first. */
  pickups: (registrationId: string) =>
    viaLane(
      () =>
        api.get<{ registrationId: string; branchId: string; pickups: PickupView[] }>(
          `/checkin/pickups/registrations/${encodeURIComponent(registrationId)}`,
        ),
      async (stationId) => {
        const board = await onBox<{ families: BridgeCheckinFamily[] }>(stationId, BRIDGE_CHECKIN_INTENTS.board, {});
        const family = board.families.find((f) => f.registrationId === registrationId);
        if (!family) throw new Error('This counter is offline and has no copy of that family’s pickup list.');
        return { registrationId, branchId: family.branchId, pickups: pickupsOfFamily(family) };
      },
    ),

  addGuardian: (
    registrationId: string,
    body: {
      id: string;
      name: string;
      relationship?: string | null;
      phone?: string | null;
      photoFileId?: string | null;
      source: 'in_person' | 'from_chat' | 'on_the_spot';
    },
  ) =>
    viaLane(
      () =>
        api.post<PickupView>(`/checkin/pickups/registrations/${encodeURIComponent(registrationId)}/guardians`, body, {
          idempotencyKey: idemKey(),
        }),
      (stationId) =>
        onBox<PickupView>(stationId, BRIDGE_CHECKIN_INTENTS.guardian, {
          guardianId: body.id,
          registrationId,
          name: body.name,
          relationship: body.relationship ?? null,
          phone: body.phone ?? null,
          source: body.source,
          photoId: body.photoFileId ?? null,
        }),
    ),

  editGuardian: (
    guardianId: string,
    body: { name?: string; relationship?: string | null; phone?: string | null; photoFileId?: string | null },
  ) =>
    viaLane(
      () => api.patch<PickupView>(`/checkin/pickups/guardians/${encodeURIComponent(guardianId)}`, body, { idempotencyKey: idemKey() }),
      async () => {
        throw needsInternet('Editing someone already on the pickup list');
      },
    ),

  revokeGuardian: (guardianId: string) =>
    viaLane(
      () => api.post<PickupView>(`/checkin/pickups/guardians/${encodeURIComponent(guardianId)}/revoke`, {}, { idempotencyKey: idemKey() }),
      async () => {
        throw needsInternet('Taking someone off the pickup list');
      },
    ),

  /**
   * Store a photo the counter just took, under the registration; answers the
   * file id the guardian or the release then names.
   */
  uploadPhoto: async (registrationId: string, dataUrl: string): Promise<string> =>
    viaLane(
      () => uploadToStorage(registrationId, dataUrl),
      // Kept on the box; the release or the collector it is used for names it.
      async (stationId) => (await capturePhotoOnBox(stationId, registrationId, dataUrl, 'pickup')).photoId,
    ),

  /** A short-lived URL for a stored photo. Every call is access-logged by the platform (R-94). */
  photoUrl: async (fileId: string): Promise<string> =>
    (await api.get<{ url: string; contentType: string }>(`/files/${encodeURIComponent(fileId)}/url`)).url,

  /**
   * Promote a chat photo to the pickup list (prototype `addPickupFromChatPhoto`):
   * the image is stored under the registration and the person added `from_chat`.
   */
  promoteFromChat: async (
    registrationId: string,
    input: { name: string; relationship?: string; phone?: string; imageUrl: string },
  ): Promise<PickupView> => {
    const photoFileId = await releaseApi.uploadPhoto(registrationId, input.imageUrl);
    return releaseApi.addGuardian(registrationId, {
      id: newRecordId(),
      name: input.name,
      relationship: input.relationship ?? null,
      phone: input.phone ?? null,
      photoFileId,
      source: 'from_chat',
    });
  },

  /**
   * Release the child. The same `id` again answers with the release it made.
   * `pickupPhotoFileId` is null only where the box said photos are off; the
   * platform lane refuses a null in its own words (`PICKUP_PHOTO_REQUIRED`),
   * so a link that comes back between the modal opening and the press is met
   * with the truth rather than a release without its photo.
   */
  release: (checkinId: string, body: { id: string; collector: ReleaseCollector; pickupPhotoFileId: string | null; stationId?: string | null }) =>
    viaLane(
      () =>
        api.post<{ replay: boolean; release: ReleaseView }>(
          `/checkin/pickups/stays/${encodeURIComponent(checkinId)}/release`,
          body,
          { idempotencyKey: idemKey() },
        ),
      (stationId) =>
        onBox<{ replay: boolean; release: ReleaseView }>(stationId, BRIDGE_CHECKIN_INTENTS.release, {
          releaseId: body.id,
          checkinId,
          collector:
            body.collector.kind === 'on_the_spot'
              ? {
                  kind: 'on_the_spot',
                  guardianId: body.collector.guardianId ?? newRecordId(),
                  // A missing name is the box's refusal to give, in the counter's words.
                  name: body.collector.name ?? '',
                  relationship: body.collector.relationship ?? null,
                  phone: body.collector.phone ?? null,
                  photoId: body.collector.photoFileId,
                }
              : body.collector,
          pickupPhotoId: body.pickupPhotoFileId || null,
        }),
    ),
};

/** The platform lane's photo: registered under the registration, stored through the same-origin API. */
async function uploadToStorage(registrationId: string, dataUrl: string): Promise<string> {
  const blob = await blobOf(dataUrl);
  const file = await api.post<{ id: string; uploadUrl: string }>(
    '/files',
    {
      id: newRecordId(),
      contentType: blob.type || 'image/jpeg',
      ownerEntityType: 'registration',
      ownerEntityId: registrationId,
      filename: `pickup.${(blob.type || 'image/jpeg').split('/')[1] ?? 'jpg'}`,
    },
    { idempotencyKey: idemKey() },
  );
  await api.put<void>(`/files/${encodeURIComponent(file.id)}/content`, blob);
  return file.id;
}
