import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { CancelBookingDialog, type CancellableBooking } from '@/components/dropoff/CancelBookingDialog';
import type { CheckIn } from '@/types';

/**
 * SCRUM-909 — THE CONFIRM, CANCELLING A CHILD ON THEIR OWN, RUN.
 *
 * Handed a booking marked `alone` (`cancelAloneOf`), the shared confirm names
 * the child, says the rest of the booking stays, and posts the reason with
 * only that child's id (`checkinIds`); the whole booking's confirm posts the
 * reason alone, as before (s886-cancel-dialog-runtime pins that).
 */

const seam = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('react', async () => ({ ...(await vi.importActual<typeof import('react')>('react')), ...(await import('./support/hooks')) }));
vi.mock('@/hooks/use-toast', () => ({ toast: seam.toast }));

const REG = '0190a0a0-0000-7000-8000-00000000a909';

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as React.ReactNode)];
}
function words(tree: React.ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(words).join('');
  return React.isValidElement<{ children?: React.ReactNode }>(tree) ? words(tree.props.children) : '';
}
const confirmOf = (tree: React.ReactNode) => nodes(tree).find((n) => n.props.variant === 'destructive')!;
const reasonOf = (tree: React.ReactNode) => nodes(tree).find((n) => n.props.id === 'cancel-booking-reason')!;
const type = (tree: React.ReactNode, value: string) =>
  (reasonOf(tree).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });

const booking: CancellableBooking = {
  registrationId: REG,
  parentName: 'ZZ TEST Ploy',
  children: [{ id: 'c2', childName: 'ZZ TEST Nok' } as CheckIn],
  alone: true,
};

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('React', React);
  seam.toast.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function mount() {
  const onClose = vi.fn();
  const onCancelled = vi.fn();
  const view = renderHook(() => CancelBookingDialog({ booking, onClose, onCancelled }));
  return { view, onClose, onCancelled };
}

describe('s909 — the confirm for a child on their own', () => {
  it('names the child and says the rest of the booking stays', () => {
    const { view } = mount();
    const text = words(view.result.current);
    expect(text).toContain("Cancel ZZ TEST Nok's booking");
    expect(text).not.toContain('Cancel this waiting booking');
    expect(text).toContain(
      "ZZ TEST Ploy's booking: ZZ TEST Nok leave the waiting list and can't be added to a sale; the rest of the booking stays as it is.",
    );
    expect(text).toContain('The signed form stays on record.');
  });

  it("posts the trimmed reason with only that child's id, then closes and re-reads the list", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return reply({ id: REG, children: [{ id: 'c2', status: 'cancelled' }] });
      }),
    );
    const { view, onClose, onCancelled } = mount();
    type(view.result.current, '  Went home  ');
    (confirmOf(view.result.current).props.onClick as () => void)();
    await vi.waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(onCancelled).toHaveBeenCalledWith(booking);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ url: `/api/checkin/registrations/${REG}/cancel`, body: { reason: 'Went home', checkinIds: ['c2'] } }]);
    expect(seam.toast).not.toHaveBeenCalled();
  });
});
