import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Loader2, RefreshCw } from 'lucide-react';
import { Link } from 'wouter';
import type { Permission } from '@oto/shared';
import {
  consoleConfigurationApi, consolePagePath, settingsTarget,
  type ConfigurationEntry, type ConfigurationIndex, type SettingsTarget,
} from '@/api/consoleConfiguration';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip, Tag } from '@/components/redesign/chips';
import { CardShell, PageGrid } from '@/components/redesign/layout';
import { EmptyNote, UnreadNote } from '@/components/redesign/StatTile';
import { formatExact } from '@/lib/time';
import { useWorkingAuthority } from '@/lib/workingAuthority';
import { configurationGroups, configurationOwnerName as ownerName } from '@/lib/paymentViews';
import { visibleNavigation } from '@/components/consoleSections';
import { PaymentsDiscovery } from '@/components/PaymentsDiscovery';


export function Configuration() {
  const { has } = useSession();
  if (!has('console:config:read')) return <><CommandBar sectionId="config" /><PermissionRequired permission="console:config:read" /></>;
  return <ConfigurationBody />;
}

function ConfigurationBody() {
  const working = useWorkingAuthority();
  const { has } = useSession();
  const [branchId, setBranchId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<ConfigurationIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef<string | null>(null);
  const scope = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; scope.current++; }; }, []);
  const invalidate = () => {
    scope.current++; openingRef.current = null; setOpening(null); setOpenError(null);
  };
  useEffect(() => {
    let live = true;
    setError(null); setData(null);
    void working.run(() => consoleConfigurationApi.configuration(branchId)).then(answer => {
      if (live && working.isCurrent()) setData(answer);
    }).catch((failure: unknown) => {
      if (live && working.isCurrent()) setError(failure instanceof Error ? failure.message : 'Configuration could not be read.');
    });
    return () => { live = false; };
  }, [branchId, refresh, working.run, working.isCurrent]);
  const retry = () => { invalidate(); setRefresh(value => value + 1); };
  const selectPark = (next: string) => {
    if (next && !data?.branches.some(park => park.id === next)) return;
    invalidate(); setBranchId(next);
  };
  const open = (entry: ConfigurationEntry, target: SettingsTarget) => {
    if (openingRef.current || !working.isCurrent()) return;
    const held = scope.current;
    const current = () => mounted.current && scope.current === held && working.isCurrent();
    openingRef.current = entry.id; setOpening(entry.id); setOpenError(null);
    void working.run(() => consoleConfigurationApi.openInApp(target, current)).catch((failure: unknown) => {
      if (current()) setOpenError(failure instanceof Error ? failure.message : 'The settings page could not be opened.');
    }).finally(() => {
      if (current()) { openingRef.current = null; setOpening(null); }
    });
  };
  return <>
    <CommandBar sectionId="config" actions={<Button variant="outline" size="sm" onClick={retry}>
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
    </Button>} />
    {openError && <div role="alert"><ErrorNote message={openError} /></div>}
    <ConfigurationContent data={data} error={error} onRetry={retry} onSelectPark={selectPark}
      has={has} opening={opening} onOpenInApp={open} />
  </>;
}

/**
 * The settings index as a read-only directory. Each supported entry offers its
 * one real editor: an Admin page through the router, or a handoff into the app
 * that owns it. Unsupported entries offer nothing. Only a change time the
 * platform really recorded is shown.
 */
export function ConfigurationContent({ data, error, onRetry, onSelectPark, has, opening, onOpenInApp }: {
  data: ConfigurationIndex | null;
  error: string | null;
  onRetry: () => void;
  onSelectPark: (branchId: string) => void;
  has: (permission: Permission) => boolean;
  opening: string | null;
  onOpenInApp: (entry: ConfigurationEntry, target: SettingsTarget) => void;
}) {
  const [search, setSearch] = useState('');
  if (error) return <><div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div><UnreadNote what="Configuration index" /></>;
  if (!data) return <div role="status"><Loading what="configuration index" /></div>;
  const parkName = (id: string) => data.branches.find(park => park.id === id)?.name ?? 'Park not in this reading';
  const groups = configurationGroups(data.entries, search), shown = groups.reduce((count, group) => count + group.entries.length, 0);
  const setupPaths = data.entries.filter(entry => entry.supported).flatMap(entry => { const page = consolePagePath(entry.url); return page ? [page] : []; });
  const availablePaths = visibleNavigation(has, false).flatMap(group => group.sections.map(section => section.path));
  return <>
    <p className="text-sm text-muted-foreground">Each setting belongs to its named owner and is changed only on its own page, which keeps that page’s access rules.</p>
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <SelectChip label="Park" showLabel value={data.selectedBranchId ?? ''} anyLabel="All parks in your reach"
        disabled={data.branches.length === 0} onChange={onSelectPark}
        options={data.branches.map(park => ({ value: park.id, label: park.name }))} />
      <p className="text-sm text-muted-foreground">Read <time dateTime={data.generatedAt}>{formatExact(data.generatedAt, 'UTC')}</time>.</p>
    </div>
    <PaymentsDiscovery availablePaths={availablePaths} setupPaths={setupPaths} />
    <div className="min-w-0 space-y-2">
      <label className="block text-sm font-semibold">Search settings
        <input type="search" value={search} onChange={event => setSearch(event.target.value)}
          className="mt-1 h-10 w-full rounded-xl border bg-card px-3 font-normal" placeholder="Name, setting key or owner app" />
      </label>
      <p className="text-sm text-muted-foreground">{shown} of {data.entries.length} settings in this loaded park selection.</p>
    </div>
    <h2 className="text-xl font-bold">Settings by owner</h2>
    {data.entries.length === 0
      ? <EmptyNote title="No settings in this reading" detail="No setting is on your access for this park selection." />
      : shown === 0 ? <EmptyNote title="No settings match this search" detail="This search only refines the loaded index. Change or clear it to see the other entries." />
        : groups.map(group => <section key={group.owner} className="min-w-0 space-y-3" data-setting-owner-group={group.owner}>
          <h3 className="text-lg font-bold">{ownerName(group.owner)}</h3>
          <PageGrid>{group.entries.map(entry => <ConfigurationCard key={entry.id} entry={entry} parkName={parkName}
            has={has} opening={opening} onOpenInApp={onOpenInApp} />)}</PageGrid>
        </section>)}
  </>;
}

function ConfigurationCard({ entry, parkName, has, opening, onOpenInApp }: {
  entry: ConfigurationEntry;
  parkName: (id: string) => string;
  has: (permission: Permission) => boolean;
  opening: string | null;
  onOpenInApp: (entry: ConfigurationEntry, target: SettingsTarget) => void;
}) {
  const page = entry.supported ? consolePagePath(entry.url) : null;
  const target = entry.supported ? settingsTarget(entry.openInApp) : null;
  const appAccess = target ? has(`app:${target.app}:access` as const) : false;
  const changed = entry.lastChangedAvailability === 'available' ? entry.lastChangedAt : null;
  return <CardShell span={6} title={entry.label} className="min-w-0">
    <div data-setting-key={entry.key} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap gap-2">
        <Tag variant="mint">{ownerName(entry.appOwner)}</Tag>
        {!entry.supported && <Tag>Not supported here</Tag>}
      </div>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Changed in</dt><dd className="font-semibold break-words">{entry.editableHere ? 'Admin' : ownerName(entry.appOwner)}</dd></div>
        <div><dt className="text-muted-foreground">Applies to</dt><dd className="break-words">{entry.scope === 'operator'
          ? 'All parks (operator-wide)'
          : entry.branchIds.map(parkName).join(', ')}</dd></div>
        {changed && <div><dt className="text-muted-foreground">Last changed</dt><dd><time dateTime={changed}>{formatExact(changed, 'UTC')}</time></dd></div>}
      </dl>
      {!entry.supported && <p className="text-sm text-muted-foreground">This setting has no page linked from Admin.</p>}
      {page && <Link href={page} className="self-start text-sm font-semibold text-primary underline underline-offset-4">Open settings</Link>}
      {target && appAccess && <Button variant="outline" size="sm" className="self-start" disabled={opening !== null}
        onClick={() => onOpenInApp(entry, target)}>
        {opening === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
        {opening === entry.id ? `Opening ${ownerName(target.app)}…` : `Open in ${ownerName(target.app)}`}
      </Button>}
      {target && !appAccess && <p className="text-sm text-muted-foreground">Opening it needs access to {ownerName(target.app)}.</p>}
    </div>
  </CardShell>;
}
