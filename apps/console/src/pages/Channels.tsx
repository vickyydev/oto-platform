import { useEffect, useRef, useState } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { openInboxSettings, type InboxSetting } from '@/api/inbox-routing';
import { useSession } from '@/auth/SessionContext';
import { canSeeArea, findArea } from '@/components/consoleSections';
import { ErrorNote, Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { AreaLanding } from '@/pages/AreaLanding';

const SETTINGS: { kind: InboxSetting; title: string; description: string; permission: Permission }[] = [
  { kind: 'numbers', title: 'Numbers', description: 'Assistant modes for the connected numbers.', permission: 'inbox:ai:manage' },
  { kind: 'templates', title: 'Templates', description: 'Message templates and their approval state.', permission: 'inbox:template:manage' },
  { kind: 'knowledge', title: 'Knowledge base', description: 'Knowledge entries and their approval state.', permission: 'inbox:kb:manage' },
  { kind: 'examples', title: 'Examples', description: 'Review examples and proposed corrections.', permission: 'inbox:kb:manage' },
];

export function ChannelsLanding() {
  const { me, permissions, has, locked } = useSession();
  const owner = JSON.stringify([me?.account.id, me?.account.operatorId, me?.branch?.id, locked,
    permissions.map(row => [row.permission, row.scopeType, row.scopeId]).sort()]);
  const authority = useRef(owner);
  authority.current = owner;
  const area = findArea('channels')!;
  if (!me || locked || !canSeeArea(area, has, me.isPlatformAdmin)) return <AreaLanding id="channels" />;
  const operatorKb = permissions.some(grant => grant.permission === 'inbox:kb:manage' && grant.scopeType === 'operator'
    && (grant.scopeId === null || grant.scopeId === me.account.operatorId));
  const settings = has('app:inbox:access') ? SETTINGS.filter(setting => has(setting.permission)
    && (setting.kind !== 'examples' || operatorKb)) : [];
  return <>
    <AreaLanding id="channels" />
    {settings.length ? <div className="grid min-w-0 gap-4 @xl:grid-cols-2">
      {settings.map(setting => <InboxSettingTile key={`${owner}:${setting.kind}`} setting={setting}
        isCurrent={() => authority.current === owner} />)}
    </div> : <Panel title="Inbox settings"><p className="text-sm text-muted-foreground">Inbox settings are not on your access.</p></Panel>}
  </>;
}

function InboxSettingTile({ setting, isCurrent }: { setting: typeof SETTINGS[number]; isCurrent: () => boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && isCurrent();
  return <Panel title={setting.title} description={setting.description}>
    <Button disabled={pending} onClick={() => {
      if (inFlight.current || !current()) return;
      inFlight.current = true;
      setPending(true); setError(null);
      void openInboxSettings(setting.kind, current).catch((failure: unknown) => {
        if (!current()) return;
        inFlight.current = false; setPending(false);
        setError(failure instanceof Error ? failure.message : 'Inbox settings could not be opened.');
      });
    }}>{pending ? 'Opening Inbox…' : `Open ${setting.title}`}</Button>
    {error && <div className="mt-3"><ErrorNote message={error} /></div>}
  </Panel>;
}
