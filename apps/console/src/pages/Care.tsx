import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { AdminNotifications } from '@oto/admin-screens';
import { DropOffPricingPanelWithPorts, pricingFromConfig } from '@oto/admin-screens/lifted/admin/dropoff-pricing/DropOffPricingPanel';
import { SupervisionPanelWithPorts } from '@oto/admin-screens/lifted/admin/supervision/SupervisionPanel';
import { TemplatesPanelWithPorts } from '@oto/admin-screens/lifted/admin/templates/TemplatesPanel';
import { fromApi } from '@oto/admin-screens/lifted/admin-helpers/templates/templateDraft';
import type { ApiSupervisionConfig } from '@oto/admin-screens/lifted/api/checkin';
import type { PrintTemplate } from '@oto/admin-screens/lifted/model/types';
import { createConsoleCare } from '@/api/care';
import { fleetApi, type StationRow } from '@/api/fleet';
import { organisationApi } from '@/api/organisation';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';

type Page = 'care' | 'print-templates';
type Park = { id: string; name: string; code: string };
type Snapshot = { version: number; api: ReturnType<typeof createConsoleCare>; config: ApiSupervisionConfig | null; templates: PrintTemplate[] };
const messageOf = (failure: unknown) => failure instanceof Error ? failure.message : 'These settings could not be read.';

/** The approved native forms receive one current account and park snapshot. */
export function Care({ page }: { page: Page }) {
  const { me, permissions, has } = useSession();
  const permission: Permission = page === 'care' ? 'pos:checkin:read' : 'pos:print:read';
  const allowed = has(permission), operatorId = me?.account.operatorId;
  const authority = permissions.map(row => [row.permission, row.scopeType, row.scopeId].join(':')).sort().join('|');
  const [parks, setParks] = useState<Park[] | null>(null), [parkId, setParkId] = useState('');
  const [stored, setStored] = useState<Snapshot | null>(null), [error, setError] = useState<string | null>(null);
  const [parksError, setParksError] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const [stationList, setStationList] = useState<{ version: number; rows: StationRow[] } | null>(null);
  const [stationChoice, setStationChoice] = useState<{ version: number; id: string } | null>(null);
  const [stationFailure, setStationFailure] = useState<{ version: number; message: string } | null>(null);
  const [stationRefresh, setStationRefresh] = useState(0);
  const mounted = useRef(false), requests = useRef(0), stationRequests = useRef(0);
  const contextKey = [me?.account.id, operatorId, authority, page, parkId].join('|');
  const active = useRef({ key: contextKey, version: 0 });
  if (active.current.key !== contextKey) active.current = { key: contextKey, version: active.current.version + 1 };
  const version = active.current.version, snapshot = stored?.version === version ? stored : null;
  const contextApi = useMemo(() => ({ version, api: createConsoleCare() }), [version]).api;
  const current = useCallback(() => mounted.current && active.current.version === version, [version]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requests.current++; }; }, []);
  const can = useCallback((held: Permission, branchId: string) => permissions.some(row => row.permission === held && (
    row.scopeType === 'operator' && (row.scopeId === null || row.scopeId === operatorId) ||
    row.scopeType === 'branch' && row.scopeId === branchId
  )), [permissions, operatorId]);
  const canReadStations = page === 'print-templates' && allowed && !!parkId && can('admin:station:read', parkId);
  const stations = stationList?.version === version ? stationList.rows : null;
  const stationId = stationChoice?.version === version && stations?.some(row => row.id === stationChoice.id) ? stationChoice.id : null;
  const stationError = stationFailure?.version === version ? stationFailure.message : null;

  useEffect(() => {
    if (!canReadStations) return;
    const request = ++stationRequests.current;
    const live = () => current() && request === stationRequests.current;
    setStationFailure(null);
    void fleetApi.stations(parkId).then(answer => {
      if (!live()) return;
      setStationList({ version, rows: answer.stations.filter(row => row.branchId === parkId && !row.archived) });
    }).catch(failure => {
      if (live()) {
        setStationList(null);
        setStationFailure({ version, message: 'Stations could not be read. ' + messageOf(failure) });
      }
    });
    return () => { stationRequests.current++; };
  }, [canReadStations, parkId, current, version, stationRefresh]);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    setParks(null); setParksError(null);
    const own = me?.branch;
    const read = has('admin:branch:read') ? organisationApi.branchesApi.list().then(answer => answer.branches.filter(row => !row.archived)) : Promise.resolve(own ? [own] : []);
    void read.then(rows => {
      if (!live) return;
      const reachable = rows.filter(row => can(permission, row.id));
      setParks(reachable);
      setParkId(previous => reachable.some(row => row.id === previous) ? previous : reachable.find(row => row.id === own?.id)?.id ?? reachable[0]?.id ?? '');
    }).catch(failure => { if (live) setParksError(messageOf(failure)); });
    return () => { live = false; };
  }, [allowed, me?.account.id, me?.branch, has, permission, can, refresh]);

  const reload = useCallback(async (saved = false) => {
    if (!allowed || !parkId) return;
    const request = ++requests.current, live = () => current() && request === requests.current;
    const api = contextApi; setError(null);
    try {
      const config = page === 'care' ? await api.checkinApi.config(parkId) : null;
      const templates = page === 'print-templates' ? (await api.printApi.templates(parkId)).templates.map(fromApi) : [];
      if (live()) setStored({ version, api, config, templates });
    } catch (failure) {
      if (live()) { setStored(null); setError((saved ? 'Saved, but the settings could not be refreshed. ' : '') + messageOf(failure)); }
    }
  }, [allowed, parkId, page, current, version, contextApi]);
  useEffect(() => { setStored(null); void reload(); return () => { requests.current++; }; }, [reload]);

  if (!allowed) return <PermissionRequired permission={permission} />;
  return <>
    <CommandBar sectionId={page} actions={parks?.length ? <><SelectChip label="Park" value={parkId}
      onChange={id => { if (id !== parkId) { requests.current++; setStored(null); setParkId(id); } }}
      options={parks.map(park => ({ value: park.id, label: park.name }))} />
      {canReadStations && <SelectChip label="Station" value={stationId ?? ''} anyLabel="Pick a station"
        disabled={!stations?.length} options={(stations ?? []).map(station => ({ value: station.id, label: station.name }))}
        onChange={id => setStationChoice({ version, id: stations?.some(row => row.id === id) ? id : '' })} />}
    </> : undefined} />
    {parksError && <ErrorNote message={parksError} onRetry={() => setRefresh(value => value + 1)} />}
    {error && <ErrorNote message={error} onRetry={() => void reload()} />}
    {stationError && <ErrorNote message={stationError} onRetry={() => setStationRefresh(value => value + 1)} />}
    {page === 'print-templates' && parkId && !canReadStations && <EmptyNote title="Station selection needs permission"
      detail="You can view print templates. Reading this park's stations is required to choose a test-print destination." />}
    {parks?.length === 0 ? <EmptyNote title="No parks here" detail="There is no reachable park to show these settings for." /> : snapshot ?
      <div key={contextKey} className="flex flex-col gap-6">
        {page === 'care' && snapshot.config && <>
          <DropOffPricingPanelWithPorts ports={{ connected: true, contextKey, pricing: pricingFromConfig(snapshot.config.pricing),
            canManage: can('catalog:package:update', parkId), savePricing: async body => {
              const pricing = await snapshot.api.savePricing(parkId, body, current);
              if (current()) setStored(previous => previous?.version === version && previous.config ? { ...previous, config: { ...previous.config, pricing } } : previous);
              return pricing;
            } }} />
          <SupervisionPanelWithPorts ports={{ connected: true, contextKey, policy: snapshot.config.policy,
            canManage: can('catalog:package:update', parkId), savePolicy: async (next, editorCurrent) => {
              const policy = await snapshot.api.savePolicy(parkId, next, () => current() && (editorCurrent?.() ?? true));
              if (current()) setStored(previous => previous?.version === version && previous.config ? { ...previous, config: { ...previous.config, policy } } : previous);
              return policy;
            } }} />
        </>}
        {page === 'print-templates' && <TemplatesPanelWithPorts ports={{ templates: snapshot.templates, live: true, stationId,
          canEdit: can('admin:branch:update', parkId), canTestPrint: !!stationId && can('admin:box:command', parkId), api: snapshot.api.printApi,
          onSaved: () => reload(true),
        }} />}
      </div> : !error && !parksError ? <Loading what="Care settings" /> : null}
    <AdminNotifications />
  </>;
}
