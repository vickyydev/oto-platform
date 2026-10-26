import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { consoleConfigurationApi, type ConfigurationIndex } from '@/api/consoleConfiguration';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { CardShell, PageGrid } from '@/components/redesign/layout';
import { EmptyNote, UnreadNote } from '@/components/redesign/StatTile';
import { formatExact } from '@/lib/time';
import { useWorkingAuthority } from '@/lib/workingAuthority';

const owners: Record<string, string> = { platform: 'Platform', pos: 'POS', oto_app: 'OTO App', radar: 'Radar', inbox: 'Inbox', booth: 'Booth' };

export function Configuration() {
  const { has } = useSession();
  if (!has('console:config:read')) return <PermissionRequired permission="console:config:read" />;
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
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const scope = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; scope.current++; }; }, []);
  const invalidate = () => {
    scope.current++; pendingRef.current = null; setPending(null); setOpenError(null);
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
  const open = (entry: ConfigurationIndex['entries'][number]) => {
    if (!entry.openInApp || pendingRef.current || !working.isCurrent()) return;
    const held = scope.current;
    pendingRef.current = entry.id; setPending(entry.id); setOpenError(null);
    void working.run(() => consoleConfigurationApi.openInApp(entry.openInApp!,
      () => mounted.current && scope.current === held && working.isCurrent())).catch((failure: unknown) => {
      if (mounted.current && scope.current === held && working.isCurrent()) {
        setOpenError(failure instanceof Error ? failure.message : 'The settings page could not be opened.');
      }
    }).finally(() => {
      if (mounted.current && scope.current === held && working.isCurrent()) { pendingRef.current = null; setPending(null); }
    });
  };
  return <>
    <CommandBar sectionId="config" actions={<Button variant="outline" onClick={retry}>Refresh</Button>} />
    <p className="text-sm text-muted-foreground">Each setting belongs to its named owner. Opening a settings page keeps that page’s access rules.</p>
    {error && <ErrorNote message={error} onRetry={retry} />}
    {openError && <ErrorNote message={openError} />}
    {!data && !error && <Loading what="configuration index" />}
    {!data && error && <UnreadNote what="Configuration index" />}
    {data && <>
      <SelectChip label="Park" showLabel value={branchId} anyLabel="Operator-wide settings"
        options={data.branches.map(park => ({ value: park.id, label: park.name }))}
        onChange={next => { invalidate(); setBranchId(next); }} />
      <p className="text-sm text-muted-foreground">Read at {formatExact(data.generatedAt, 'UTC')}.</p>
      {data.entries.length === 0 ? <EmptyNote title="No settings in this reading" detail="No settings were included for this access and park selection." /> : <PageGrid>
        {data.entries.map(entry => <CardShell key={entry.id} span={6} title={entry.label}>
          <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Owned by</dt><dd className="font-semibold break-words">{owners[entry.appOwner] ?? entry.appOwner}</dd></div>
            <div><dt className="text-muted-foreground">Settings location</dt><dd>{entry.editableHere ? 'Admin' : owners[entry.appOwner] ?? entry.appOwner}</dd></div>
            <div><dt className="text-muted-foreground">Scope</dt><dd>{entry.scope === 'operator' ? 'Operator-wide' : entry.branchIds.map(id => data.branches.find(park => park.id === id)?.name ?? 'Park name not recorded').join(', ') || 'Park not recorded'}</dd></div>
            <div><dt className="text-muted-foreground">Last changed</dt><dd>{entry.lastChangedAt ? formatExact(entry.lastChangedAt, 'UTC') : entry.lastChangedAvailability === 'unsupported' ? 'Not available' : 'Not recorded'}</dd></div>
          </dl>
          {entry.supported && entry.url && /^\/(?!\/)[^\\\s]*$/.test(entry.url) && <Link href={entry.url} className="text-sm font-semibold text-primary underline underline-offset-4">Open settings</Link>}
          {entry.supported && entry.openInApp && has(`app:${entry.openInApp.app}:access`) && <Button variant="outline" className="self-start" disabled={pending !== null} onClick={() => open(entry)}>
            {pending === entry.id ? 'Opening…' : `Open in ${owners[entry.openInApp.app] ?? entry.openInApp.app}`}
          </Button>}
        </CardShell>)}
      </PageGrid>}
    </>}
  </>;
}
