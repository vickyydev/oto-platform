import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AdminScreenProvider, useBranch, useCatalogStore, useLocation, useOperator, useSearch, useStation,
  type AdminScreenRuntime,
} from '../src/lifted/runtime/AdminScreenRuntime';

/** Unused capabilities fail loudly, so this check cannot fall back to an app singleton. */
function fixtureRuntime(label: string, navigations: string[]): AdminScreenRuntime {
  const values = {
    catalog: { ticketTypes: [{ id: `${label}-ticket`, name: `${label} ticket` }] },
    session: { operator: { id: `${label}-actor` }, can: (permission: string) => label === 'A' && permission === 'catalog:package:update' },
    branch: { branch: { id: `${label}-park`, name: `${label} park` }, branches: [], switching: false, setActiveBranchId: () => undefined },
    station: { station: { stationId: `${label}-station` } },
    navigation: { search: `?panel=${label}`, navigate: (path: string) => { navigations.push(path); } },
  };
  return new Proxy(values, {
    get(target, property, receiver) {
      if (!(property in target)) throw new Error(`Unprovided host capability: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as AdminScreenRuntime;
}

describe('the lifted screen runtime is scoped to its provider', () => {
  it('keeps nested host data, permissions, station and navigation independent', () => {
    const aMoves: string[] = [], bMoves: string[] = [];
    const actions: Array<(path: string) => void> = [];
    function Probe() {
      const catalog = useCatalogStore(), session = useOperator(), branch = useBranch(), station = useStation();
      const [, navigate] = useLocation(); actions.push(navigate);
      return createElement('p', null, [
        catalog.ticketTypes[0]!.name, session.operator!.id, branch.branch.name, station.station!.stationId,
        String(session.can('catalog:package:update')), useSearch(),
      ].join('|'));
    }
    const a = fixtureRuntime('A', aMoves), b = fixtureRuntime('B', bMoves);
    const html = renderToStaticMarkup(createElement(AdminScreenProvider, { value: a, children: createElement(Fragment, null,
      createElement(Probe),
      createElement(AdminScreenProvider, { value: b, children: createElement(Probe) }),
      createElement(Probe),
    ) }));
    expect(html).toBe('<p>A ticket|A-actor|A park|A-station|true|?panel=A</p><p>B ticket|B-actor|B park|B-station|false|?panel=B</p><p>A ticket|A-actor|A park|A-station|true|?panel=A</p>');
    actions[0]!('/admin?panel=tickets'); actions[1]!('/admin?panel=tax'); actions[2]!('/admin?panel=menu');
    expect(aMoves).toEqual(['/admin?panel=tickets', '/admin?panel=menu']);
    expect(bMoves).toEqual(['/admin?panel=tax']);
  });

  it('refuses an unbound panel instead of reading an app store or another provider', () => {
    function Unbound() { useCatalogStore(); return null; }
    expect(() => renderToStaticMarkup(createElement(Unbound))).toThrow('Admin screens must be used within an AdminScreenProvider');
  });
});
