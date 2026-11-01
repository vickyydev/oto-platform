import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { StationCard } from '@/pages/Devices';
import type { StationRow } from '@/api/fleet';
import { UNREAD_DEVICES } from '@/lib/deviceList';

vi.mock('@/lib/workingAuthority', () => ({ useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }) }));
const noop = () => undefined;
const station: StationRow = { id: 'station', branchId: 'branch', boxId: 'box', name: 'ZZ TEST draft',
  kind: 'till', ready: false, reasons: ['No receipt prefix'], codePrefix: null };

describe('receipt-prefix setup guidance', () => {
  it('shows the API reason on the station card', () => {
    const html = renderToStaticMarkup(createElement(StationCard, { station, branchLabel: 'Park', onOpen: noop }));
    expect(html).toContain('Not ready for selling');
    expect(html).toContain('No receipt prefix');
  });
  it('explains the draft in the drawer while leaving Save available', () => {
    const html = renderToStaticMarkup(createElement(StationDrawer, { station, branchId: 'branch', branchLabel: 'Park',
      boxes: [], deviceList: () => UNREAD_DEVICES, onRetryDevices: noop, canEdit: true, onClose: noop, onSaved: noop }));
    expect(html).toContain('No receipt prefix');
    const button = html.match(/<button[^>]*>Save the station<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });
  it('shows ready when a prefix has been supplied', () => {
    const html = renderToStaticMarkup(createElement(StationCard, { station: { ...station, ready: true, reasons: [], codePrefix: 'T1' },
      branchLabel: 'Park', onOpen: noop }));
    expect(html).toContain('Ready for selling');
    expect(html).not.toContain('No receipt prefix');
  });
});
