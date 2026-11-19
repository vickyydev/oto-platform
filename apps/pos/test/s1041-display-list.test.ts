import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SCRUM-1041 — THE TILL LISTS ITS DISPLAYS, EACH WITH ITS OWN REMOVE.
 *
 * A till may have up to three customer displays (the owner's answer of 19
 * November: "build it now"). The till names each so staff can tell them
 * apart — the name it was paired under, numbered only where two share one,
 * so a till with one display reads as before — says whether it is connected
 * or when it was last seen, and offers a Remove for each, which revokes that
 * display's pairing alone. Removing is a manager's, as in the Console.
 */

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
const operator = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ can: (permission: string) =>
  operator.allowed && permission === 'admin:device:revoke' }) }));
const client = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/client', async () => ({ ...await vi.importActual('@/api/client'), api: { post: client.post } }));

import { ApiError } from '@/api/client';
import { PairedDisplaysDialog, displaySeenLine } from '@/components/till/PairedDisplays';
import { labelDisplays, type PairedDisplay } from '@/lib/displaySession';
import { renderHook } from './support/hooks';

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

beforeEach(() => { vi.stubGlobal('React', React); vi.clearAllMocks(); operator.allowed = true; });
afterEach(() => { vi.unstubAllGlobals(); });

// Display ids sort in the order the displays were paired (UUIDv7).
const left: PairedDisplay = { id: '0190a000-0000-7000-8000-000000000001', name: 'ZZ TEST counter left', connected: true, lastSeenAt: '2026-11-19T07:59:58Z' };
const right: PairedDisplay = { id: '0190a000-0000-7000-8000-000000000002', name: 'ZZ TEST counter right', connected: false, lastSeenAt: '2026-11-19T06:05:00Z' };
const tablet: PairedDisplay = { id: '0190a000-0000-7000-8000-000000000003', name: 'ZZ TEST tablet', connected: false, lastSeenAt: null };

describe('naming each display so staff can tell them apart', () => {
  it('keeps a name used once exactly as it was, so a till with one display reads as before', () => {
    expect(labelDisplays([left])).toEqual([left]);
    expect(labelDisplays([left, right, tablet]).map((display) => display.name))
      .toEqual(['ZZ TEST counter left', 'ZZ TEST counter right', 'ZZ TEST tablet']);
  });

  it('numbers displays that share a name, in the order they were paired, wherever the list puts them', () => {
    const first = { ...right, id: '0190a000-0000-7000-8000-000000000001', name: 'Customer display' };
    const second = { ...right, id: '0190a000-0000-7000-8000-000000000002', name: 'Customer display' };
    expect(labelDisplays([second, tablet, first]).map((display) => display.name))
      .toEqual(['Customer display 2', 'ZZ TEST tablet', 'Customer display 1']);
  });

  it('says connected, or when it was last seen in the park\'s time, or that it is not connected', () => {
    const now = new Date('2026-11-19T08:00:00Z');
    expect(displaySeenLine(left, 'Asia/Bangkok', now)).toBe('Connected');
    expect(displaySeenLine(right, 'Asia/Bangkok', now)).toBe('Last seen 13:05');
    expect(displaySeenLine({ connected: false, lastSeenAt: '2026-11-18T10:30:00Z' }, 'Asia/Bangkok', now)).toBe('Last seen 18 Nov, 17:30');
    expect(displaySeenLine(tablet, 'Asia/Bangkok', now)).toBe('Not connected');
  });
});

function open(displays: PairedDisplay[] | null) {
  const changes: boolean[] = [];
  const view = renderHook(() => PairedDisplaysDialog({ open: true, onOpenChange: (next) => { changes.push(next); },
    displays, timeZone: 'Asia/Bangkok' }));
  const all = () => elements(view.result.current);
  const byTestId = (id: string) => all().filter((node) => node.props['data-testid'] === id);
  const row = (name: string) => byTestId('paired-display').find((node) => words(node).includes(name));
  const press = (node: Element | undefined) => (node!.props.onClick as () => void)();
  const within = (node: Element | undefined, id: string) => elements(node).find((item) => item.props['data-testid'] === id);
  const button = (node: Element | undefined, label: string) => elements(node).find((item) =>
    words(item.props.children).trim() === label && typeof item.props.onClick === 'function');
  return { view, all, byTestId, row, press, within, button, text: () => words(view.result.current), changes };
}

describe('the till\'s list of its displays', () => {
  it('lists each paired display by name with whether it is connected, and a Remove for each', () => {
    const list = open([left, right, tablet]);
    expect(list.byTestId('paired-display')).toHaveLength(3);
    expect(list.byTestId('paired-display-name').map((node) => words(node))).toEqual(
      ['ZZ TEST counter left', 'ZZ TEST counter right', 'ZZ TEST tablet']);
    expect(words(list.byTestId('paired-display-seen')[0])).toBe('Connected');
    expect(words(list.byTestId('paired-display-seen')[2])).toBe('Not connected');
    expect(list.byTestId('paired-display-remove')).toHaveLength(3);
    expect(list.text()).toContain('A till can have up to three');
    list.view.unmount();
  });

  it('removes one display after staff confirm it, and leaves the others listed', async () => {
    client.post.mockResolvedValue({ ok: true });
    const list = open([left, right, tablet]);
    list.press(list.within(list.row('ZZ TEST counter right'), 'paired-display-remove'));
    // Asked first, in the row itself; nothing is sent yet.
    expect(list.row('ZZ TEST counter right') && words(list.row('ZZ TEST counter right'))).toContain('It stops showing this till');
    expect(client.post).not.toHaveBeenCalled();
    list.press(list.button(list.row('ZZ TEST counter right'), 'Keep'));
    expect(list.within(list.row('ZZ TEST counter right'), 'paired-display-remove-confirm')).toBeUndefined();
    list.press(list.within(list.row('ZZ TEST counter right'), 'paired-display-remove'));
    list.press(list.within(list.row('ZZ TEST counter right'), 'paired-display-remove-confirm'));
    await vi.waitFor(() => expect(list.byTestId('paired-display')).toHaveLength(2));
    expect(client.post).toHaveBeenCalledTimes(1);
    const [path, body, options] = client.post.mock.calls[0]!;
    expect(path).toBe(`/credentials/${right.id}/revoke`);
    expect(body).toEqual({ reason: 'Removed at the till' });
    expect(typeof (options as { idempotencyKey?: string }).idempotencyKey).toBe('string');
    expect(list.byTestId('paired-display-name').map((node) => words(node))).toEqual(['ZZ TEST counter left', 'ZZ TEST tablet']);
    list.view.unmount();
  });

  it('takes a display removed already elsewhere off the list, and says plainly when staff may not remove one', async () => {
    client.post.mockRejectedValueOnce(new ApiError(409, 'CREDENTIAL_ALREADY_REVOKED', 'That credential is already revoked'));
    const list = open([left, right]);
    list.press(list.within(list.row('ZZ TEST counter left'), 'paired-display-remove'));
    list.press(list.within(list.row('ZZ TEST counter left'), 'paired-display-remove-confirm'));
    await vi.waitFor(() => expect(list.byTestId('paired-display')).toHaveLength(1));
    client.post.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Missing permission: admin:device:revoke'));
    list.press(list.within(list.row('ZZ TEST counter right'), 'paired-display-remove'));
    list.press(list.within(list.row('ZZ TEST counter right'), 'paired-display-remove-confirm'));
    await vi.waitFor(() => expect(words(list.byTestId('paired-displays-error')[0])).toBe('Only a manager can remove a display.'));
    expect(list.byTestId('paired-display')).toHaveLength(1);
    list.view.unmount();
  });

  it('offers no Remove to staff who may not remove a display, and says who can', () => {
    operator.allowed = false;
    const list = open([left, right]);
    expect(list.byTestId('paired-display-remove')).toHaveLength(0);
    expect(words(list.byTestId('paired-displays-manager')[0])).toBe('A manager can remove a display.');
    list.view.unmount();
  });

  it('says so when no display is paired, or when the list cannot be read', () => {
    const none = open([]);
    expect(none.text()).toContain('No display is paired to this till.');
    none.view.unmount();
    const unknown = open(null);
    expect(unknown.text()).toContain('The list of displays cannot be read right now.');
    unknown.view.unmount();
  });
});
