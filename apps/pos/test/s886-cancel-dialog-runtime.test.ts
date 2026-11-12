import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { CancelBookingDialog, type CancellableBooking } from '@/components/dropoff/CancelBookingDialog';
import { setLaneStation } from '@/lib/lane';
import type { CheckIn } from '@/types';

/**
 * SCRUM-886 — THE ONE CANCEL CONFIRM, RUN.
 *
 * The picker (SCRUM-862) and the Check-in board share `CancelBookingDialog`.
 * Its rule, driven on the hooks harness: no confirm without a reason (spaces
 * are not a reason), the reason trimmed to the platform, the confirm closed
 * and the list re-read only once the platform cancelled; a refusal stays on
 * the confirm with the platform's own words; on the box lane the press is
 * refused in the counter's words and nothing reaches the box.
 */

const seam = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('react', async () => ({ ...(await vi.importActual<typeof import('react')>('react')), ...(await import('./support/hooks')) }));
vi.mock('@/hooks/use-toast', () => ({ toast: seam.toast }));

const STATION = '018f0000-0000-7000-8000-0000000058a2';
const REG = '0190a0a0-0000-7000-8000-00000000a886';

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
  children: [{ id: 'c1', childName: 'ZZ TEST Mint' } as CheckIn],
};

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('React', React);
  seam.toast.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLaneStation(null);
});

function mount() {
  const onClose = vi.fn();
  const onCancelled = vi.fn();
  const view = renderHook(() => CancelBookingDialog({ booking, onClose, onCancelled }));
  return { view, onClose, onCancelled };
}

describe('s886 — the shared cancel confirm', () => {
  it('names the family and its children, and says the signed form stays on record', () => {
    const { view } = mount();
    const text = words(view.result.current);
    expect(text).toContain('Cancel this waiting booking');
    expect(text).toContain("ZZ TEST Ploy's booking: ZZ TEST Mint leave the waiting list");
    expect(text).toContain('The signed form stays on record.');
  });

  it('refuses to confirm without a reason, spaces included', () => {
    const { view } = mount();
    expect(confirmOf(view.result.current).props.disabled).toBe(true);
    expect(words(confirmOf(view.result.current))).toBe('Give a reason to cancel');
    expect(words(view.result.current)).toContain('A reason is required.');
    type(view.result.current, '   ');
    expect(confirmOf(view.result.current).props.disabled).toBe(true);
    type(view.result.current, 'Family did not come');
    expect(confirmOf(view.result.current).props.disabled).toBe(false);
    expect(words(confirmOf(view.result.current))).toBe('Cancel the booking');
    expect(words(view.result.current)).not.toContain('A reason is required.');
  });

  it('posts the trimmed reason once, then closes and re-reads the list', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return reply({ id: REG, children: [{ id: 'c1', status: 'cancelled' }] });
      }),
    );
    const { view, onClose, onCancelled } = mount();
    type(view.result.current, '  Family did not come  ');
    (confirmOf(view.result.current).props.onClick as () => void)();
    await vi.waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(onCancelled).toHaveBeenCalledWith(booking);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ url: `/api/checkin/registrations/${REG}/cancel`, body: { reason: 'Family did not come' } }]);
    expect(seam.toast).not.toHaveBeenCalled();
  });

  it('a refusal stays on the confirm, in the platform’s words, and the list is not re-read', async () => {
    const refusal = 'ZZ TEST Mint is already paid for at the till on receipt T1-000086 — refund or void that sale instead.';
    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: { code: 'CHECKIN_CANCEL_PAID', message: refusal } }, 409)));
    const { view, onClose, onCancelled } = mount();
    type(view.result.current, 'Family did not come');
    (confirmOf(view.result.current).props.onClick as () => void)();
    await vi.waitFor(() => expect(seam.toast).toHaveBeenCalledTimes(1));
    expect(seam.toast.mock.calls[0]![0]).toMatchObject({ title: "Couldn't cancel this booking", description: refusal, variant: 'destructive' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it('on the box lane the press is refused in the counter’s words and never reaches the box', async () => {
    setLaneStation(STATION);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return reply({ error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } }, 503);
      }),
    );
    const { view, onCancelled } = mount();
    type(view.result.current, 'Family did not come');
    (confirmOf(view.result.current).props.onClick as () => void)();
    await vi.waitFor(() => expect(seam.toast).toHaveBeenCalledTimes(1));
    expect(seam.toast.mock.calls[0]![0]).toMatchObject({
      description: 'Cancelling a waiting booking needs the internet — this counter is offline. Do it when the connection is back.',
    });
    expect(urls.some((u) => u.includes('/intents'))).toBe(false);
    expect(onCancelled).not.toHaveBeenCalled();
  });
});
