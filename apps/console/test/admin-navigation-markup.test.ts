import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { describe, expect, it } from 'vitest';
import { AreaLandingContent } from '@/pages/AreaLanding';
import { findArea, visibleNavigation } from '@/components/consoleSections';

describe('Admin area markup', () => {
  it('groups existing payment doors by staff task without adding a navigation area', () => {
    const available = visibleNavigation(() => true, true);
    const area = available.find(entry => entry.id === 'catalogue')!;
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: '/catalogue',
      children: createElement(AreaLandingContent, { area, available }) }));
    expect(html).toContain('Payments');
    for (const label of ['Set up', 'Operate in POS', 'Reconcile', 'Investigate']) expect(html).toContain(label);
    for (const path of ['/catalogue/tenders', '/catalogue/tax', '/devices', '/watch/integrations', '/reports/money', '/watch/support']) {
      expect(html, path).toContain(`href="${path}"`);
    }
    expect(html).toContain('Deployment-only');
    expect(html).toContain('Not integrated');
    expect(available).toHaveLength(10);
  });

  it('payment discovery never invents a destination absent from the existing available navigation', () => {
    const available = visibleNavigation(permission => permission === 'catalog:menu:read' || permission === 'catalog:menu:manage', false);
    const area = available.find(entry => entry.id === 'catalogue')!;
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: '/catalogue',
      children: createElement(AreaLandingContent, { area, available }) }));
    expect(html).not.toContain('href="/catalogue/tax"');
    expect(html).not.toContain('href="/reports/money"');
    expect(html).not.toContain('href="/watch/support"');
  });

  it('offers only available areas on Overview, with working area links and no invented figures', () => {
    const available = visibleNavigation((permission) => permission === 'admin:audit:read', false);
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: '/overview',
      children: createElement(AreaLandingContent, { area: findArea('overview')!, available }) }));
    expect(html).toContain('href="/watch"');
    expect(html).not.toContain('href="/people"');
    expect(html).not.toContain('href="/platform"');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/Revenue|Guests today|In park now/);
  });

  it('puts the existing Watch pages on the area landing at their canonical addresses', () => {
    const available = visibleNavigation(() => true, true);
    const area = available.find((entry) => entry.id === 'watch')!;
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: '/watch',
      children: createElement(AreaLandingContent, { area, available }) }));
    expect(html).toContain('href="/watch/health"');
    expect(html).toContain('href="/watch/failures"');
    expect(html).toContain('href="/watch/integrations"');
    expect(html).toContain('href="/watch/activity"');
  });
});
