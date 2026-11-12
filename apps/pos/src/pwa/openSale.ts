import { useSyncExternalStore } from 'react';

/**
 * Whether this till is holding a sale somebody is in the middle of.
 *
 * ONE READER, TODAY. The service-worker update gate
 * (`src/pwa/ServiceWorkerUpdater.tsx`), which must not swap the code under a
 * cart. It is a registry rather than a boolean because more than one surface
 * sells — the till, the order station, the merch station — and each has to be
 * able to say so without knowing about the others.
 *
 * WHAT IT IS NOT. Not persistence: nothing here survives a reload, and nothing
 * here is written to disk. A cart lives in the component that owns it, and the
 * ticket till retains that component during a same-session lock. This flag
 * only prevents a shell update from discarding it; it cannot restore a cart.
 */

const openSurfaces = new Set<string>();
const listeners = new Set<() => void>();
let snapshot = false;
/**
 * SCRUM-878 — WHAT A STAFF SESSION'S END WOULD LOSE, AND SINCE WHEN.
 *
 * Narrower than "open" above. A shell update must not swap away a finished
 * sale's result still on screen or a phone number only typed, so those count
 * as open; but neither is a sale in progress. A session that ends keeps the
 * screen for the next sign-in on this till, and offers it to a different
 * person, only when there is something to lose: a cart line, a member or a
 * tier chosen, a sale rung up and not yet paid. Each selling surface says so
 * beside its "open" (`setSaleAtStake`); a customer display never does.
 *
 * The moment is when the surface first had something at stake: the next
 * person to sign in at that till is told who started the sale and when.
 * Memory only, like the rest of this file.
 */
const atStakeSince = new Map<string, number>();

function publish(): void {
  const next = openSurfaces.size > 0;
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Say whether `surface` is holding an unfinished sale. Idempotent, so it can be
 * driven straight from a render effect.
 */
export function setSaleOpen(surface: string, isOpen: boolean): void {
  if (isOpen) openSurfaces.add(surface);
  else openSurfaces.delete(surface);
  publish();
}

export function getSaleOpen(): boolean {
  return snapshot;
}

/**
 * SCRUM-878 — say whether `surface` holds a sale with something to lose (see
 * `atStakeSince`). Idempotent, so it can be driven straight from an effect.
 */
export function setSaleAtStake(surface: string, atStake: boolean): void {
  if (!atStake) atStakeSince.delete(surface);
  else if (!atStakeSince.has(surface)) atStakeSince.set(surface, Date.now());
}

/**
 * SCRUM-878 — when the oldest sale a selling surface has at stake was
 * started, or null when none has one.
 */
export function saleOpenSince(): number | null {
  let since: number | null = null;
  for (const at of atStakeSince.values()) {
    if (since === null || at < since) since = at;
  }
  return since;
}

export function subscribeSaleOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSaleOpen(): boolean {
  return useSyncExternalStore(subscribeSaleOpen, getSaleOpen, getSaleOpen);
}

/** Keep shared mobile navigation on the payment's park, station and staff. */
const paymentSurfaces = new Set<string>();
const paymentListeners = new Set<() => void>();

export function setPaymentContextLocked(surface: string, locked: boolean): void {
  const before = paymentSurfaces.size > 0;
  if (locked) paymentSurfaces.add(surface);
  else paymentSurfaces.delete(surface);
  if (before !== (paymentSurfaces.size > 0)) {
    for (const listener of paymentListeners) listener();
  }
}

export function getPaymentContextLocked(): boolean {
  return paymentSurfaces.size > 0;
}

export function subscribePaymentContextLocked(listener: () => void): () => void {
  paymentListeners.add(listener);
  return () => { paymentListeners.delete(listener); };
}

export function usePaymentContextLocked(): boolean {
  return useSyncExternalStore(subscribePaymentContextLocked, getPaymentContextLocked, getPaymentContextLocked);
}
