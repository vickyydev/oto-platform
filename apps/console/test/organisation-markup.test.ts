import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Operators } from '@/pages/Operators';
import { Holidays } from '@/pages/Holidays';

const session = vi.hoisted(() => ({ platform: true, allowed: new Set(['admin:operator:read', 'catalog:holiday:manage']) }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({
  me: { isPlatformAdmin: session.platform, branch: null }, has: (permission: string) => session.allowed.has(permission),
}) }));
vi.mock('@/components/redesign/CommandBar', () => ({ CommandBar: ({ sectionId }: { sectionId: string }) => createElement('h1', null, sectionId) }));
beforeEach(() => { session.platform = true; session.allowed = new Set(['admin:operator:read', 'catalog:holiday:manage']); });

describe('Organisation Console host markup', () => {
  it.each(['operator-only', 'missing-read'])('refuses the Operators host before mounting native write controls for %s access', access => {
    if (access === 'operator-only') session.platform = false;
    else session.allowed.delete('admin:operator:read');
    const html = renderToStaticMarkup(createElement(Operators));
    expect(html).toContain('admin:operator:read (platform-wide)');
    expect(html).not.toContain('Create operator');
    expect(html).not.toContain('Invite administrator');
    expect(html).not.toContain('Reset demo data');
  });

  it('hosts the original Operators controls for the permitted platform account', () => {
    const html = renderToStaticMarkup(createElement(Operators));
    expect(html).toContain('Create operator');
    expect(html).toContain('New operator name (e.g. OTO)');
    expect(html).not.toContain('admin:operator:read (platform-wide)');
  });

  it('keeps Holidays permission refusal distinct from a permitted pending park lookup', () => {
    session.allowed.delete('catalog:holiday:manage');
    const denied = renderToStaticMarkup(createElement(Holidays));
    expect(denied).toContain('catalog:holiday:manage');
    expect(denied).not.toContain('Loading parks');
    expect(denied).not.toContain('Add range');
    session.allowed.add('catalog:holiday:manage');
    const pending = renderToStaticMarkup(createElement(Holidays));
    expect(pending).toContain('Loading parks');
    expect(pending).not.toContain('No holiday overrides yet');
    expect(pending).not.toContain('Add range');
  });
});
