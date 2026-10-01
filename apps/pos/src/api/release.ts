import {
  newId as newRecordId,
  type PickupView,
  type PrepaidReconciliation,
  type ReleaseView,
} from '@oto/shared';
import type { AuthorizedPickup } from '@/types';
import type { PrepaidFoodReconciliation } from '@/lib/dropoff';
import { api, idemKey } from './client';

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
      photoFileId: string;
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
  context: (checkinId: string) => api.get<ReleaseContext>(`/checkin/pickups/stays/${encodeURIComponent(checkinId)}`),

  /** A registration's pickup list: the dropper-off first. */
  pickups: (registrationId: string) =>
    api.get<{ registrationId: string; branchId: string; pickups: PickupView[] }>(
      `/checkin/pickups/registrations/${encodeURIComponent(registrationId)}`,
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
    api.post<PickupView>(`/checkin/pickups/registrations/${encodeURIComponent(registrationId)}/guardians`, body, {
      idempotencyKey: idemKey(),
    }),

  editGuardian: (
    guardianId: string,
    body: { name?: string; relationship?: string | null; phone?: string | null; photoFileId?: string | null },
  ) => api.patch<PickupView>(`/checkin/pickups/guardians/${encodeURIComponent(guardianId)}`, body, { idempotencyKey: idemKey() }),

  revokeGuardian: (guardianId: string) =>
    api.post<PickupView>(`/checkin/pickups/guardians/${encodeURIComponent(guardianId)}/revoke`, {}, { idempotencyKey: idemKey() }),

  /**
   * Store a photo the counter just took, under the registration; answers the
   * file id the guardian or the release then names.
   */
  uploadPhoto: async (registrationId: string, dataUrl: string): Promise<string> => {
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
    const put = await fetch(file.uploadUrl, { method: 'PUT', body: blob, headers: { 'content-type': blob.type || 'image/jpeg' } });
    if (!put.ok) throw new Error(`The photo did not save (${put.status}) — take it again.`);
    return file.id;
  },

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

  /** Release the child. The same `id` again answers with the release it made. */
  release: (checkinId: string, body: { id: string; collector: ReleaseCollector; pickupPhotoFileId: string; stationId?: string | null }) =>
    api.post<{ replay: boolean; release: ReleaseView }>(
      `/checkin/pickups/stays/${encodeURIComponent(checkinId)}/release`,
      body,
      { idempotencyKey: idemKey() },
    ),
};
