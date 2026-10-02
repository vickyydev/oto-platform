import type {
  CashDrawerView,
  CashManualMovementKind,
  CashMovementResult,
  CashSecondPerson,
  CashSessionView,
} from '@oto/shared';
import { api, idemKey } from './client';

/**
 * S2-15a round 1 — the drawer, on the platform (`apps/api/src/routes/cash.ts`).
 *
 * Every figure is satang; the screens show baht. Each press carries one
 * `x-oto-action-id`, minted where the person tapped, so a retry answers the
 * row already written rather than writing a second.
 *
 * A paid-out or a safe drop carries the second person's phone and password, so
 * it is sent WITHOUT an Idempotency-Key: the store keeps a hash of the request
 * body for a day, and a body with a password in it is not something to keep a
 * hash of. Its action id is its replay net (unique on the platform).
 */

/** Tells every screen showing the drawer — the header's Cash action, the End of Day card — to read it again. */
export const CASH_DRAWER_CHANGED = 'oto:cash-drawer-changed';
export const announceDrawerChanged = (): void => {
  window.dispatchEvent(new CustomEvent(CASH_DRAWER_CHANGED));
};

export function getDrawer(stationId: string, date?: string): Promise<CashDrawerView> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return api.get<CashDrawerView>(`/stations/${encodeURIComponent(stationId)}/cash${q}`);
}

export async function openDrawer(stationId: string): Promise<CashSessionView> {
  const actionId = crypto.randomUUID();
  const res = await api.post<{ replayed: boolean; session: CashSessionView }>(
    `/stations/${encodeURIComponent(stationId)}/cash/sessions`,
    { id: crypto.randomUUID(), actionId },
    { idempotencyKey: idemKey(), headers: { 'x-oto-action-id': actionId } },
  );
  announceDrawerChanged();
  return res.session;
}

export interface MovementInput {
  kind: CashManualMovementKind;
  amountSatang: number;
  reason: string;
  /** A paid-out's approver, a safe drop's witness. */
  secondPerson?: CashSecondPerson;
}

export async function recordDrawerMovement(sessionId: string, input: MovementInput): Promise<CashMovementResult> {
  const actionId = crypto.randomUUID();
  const body = {
    kind: input.kind,
    amountSatang: input.amountSatang,
    reason: input.reason,
    actionId,
    ...(input.kind === 'paid_out' && input.secondPerson ? { approver: input.secondPerson } : {}),
    ...(input.kind === 'safe_drop' && input.secondPerson ? { witness: input.secondPerson } : {}),
  };
  const withSecondPerson = input.kind === 'paid_out' || input.kind === 'safe_drop';
  const res = await api.post<CashMovementResult>(`/cash/sessions/${encodeURIComponent(sessionId)}/movements`, body, {
    ...(withSecondPerson ? {} : { idempotencyKey: idemKey() }),
    headers: { 'x-oto-action-id': actionId },
  });
  announceDrawerChanged();
  return res;
}

export interface CloseInput {
  countedSatang: number;
  floatLeftSatang?: number;
  note?: string;
}

export async function closeDrawer(sessionId: string, input: CloseInput): Promise<CashSessionView> {
  const actionId = crypto.randomUUID();
  const res = await api.post<{ replayed: boolean; session: CashSessionView }>(
    `/cash/sessions/${encodeURIComponent(sessionId)}/close`,
    { ...input, ...(input.note?.trim() ? { note: input.note.trim() } : { note: undefined }), actionId },
    { idempotencyKey: idemKey(), headers: { 'x-oto-action-id': actionId } },
  );
  announceDrawerChanged();
  return res.session;
}
