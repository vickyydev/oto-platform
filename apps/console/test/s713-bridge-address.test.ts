import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BridgeAddress } from '@/components/devices/BoxDrawer';
import type { BoxRow } from '@/api/fleet';

vi.mock('@/lib/workingAuthority', () => ({ useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }) }));
const box: BoxRow = { id: 'box', name: 'ZZ TEST bridge', slot: 'zz-test', role: 'counter', status: 'offline', bridgeOrigin: 'https://counter.example.test' };
const draw = (over: Partial<BoxRow> = {}, canUpdate = true) => renderToStaticMarkup(createElement(BridgeAddress, { box: { ...box, ...over }, canUpdate, onChanged: () => {} }));

describe('counter bridge setup', () => {
  it('shows the stored address with save permission', () => {
    expect(draw()).toContain('https://counter.example.test');
    expect(draw()).toContain('Save bridge address');
  });
  it('keeps a read-only view without update permission', () => {
    expect(draw({}, false)).toContain('disabled');
    expect(draw({}, false)).not.toContain('Save bridge address');
  });
  it('shows why a rejected saved address is not in use, including for a read-only administrator', () => {
    const html = draw({ bridgeOrigin: null, bridgeWarning: 'The saved address is not trusted and is not in use.' }, false);
    expect(html).toContain('role="alert"'); expect(html).toContain('not trusted');
    expect(html).toContain('dedicated DNS zone'); expect(html).toContain('never a shared hosting suffix');
  });
  it('offers no external address for a virtual box, including an older record', () => {
    expect(draw({ role: 'virtual', bridgeOrigin: undefined })).toContain('uses the platform address');
    expect(draw({ role: 'virtual' })).not.toContain('<input');
  });
});
