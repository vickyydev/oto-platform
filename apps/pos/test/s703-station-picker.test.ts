import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StationTile } from '@/components/station/StationPicker';

vi.mock('@/auth/OperatorContext', () => ({ useOperator: vi.fn() }));
vi.mock('@/station/StationContext', () => ({ useStation: vi.fn() }));

beforeEach(() => { vi.stubGlobal('React', React); });
describe('station setup in the till picker', () => {
  const markup = (ready: boolean) => renderToStaticMarkup(React.createElement(StationTile, {
    station: { id: 'till', name: 'ZZ TEST draft', kind: 'till', boxId: 'box', ready,
      reasons: ready ? [] : ['No receipt prefix', 'Another setup reason'] },
    active: false, busy: false, onSelect: vi.fn(),
  }));
  it('disables the draft, greys it and displays its first readiness reason', () => {
    const html = markup(false);
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toContain('opacity-50');
    expect(html).toContain('No receipt prefix');
    expect(html).not.toContain('Another setup reason');
  });
  it('offers the completed station again', () => {
    const html = markup(true);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toContain('No receipt prefix');
    expect(html).not.toContain('opacity-50');
  });
});
