import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { testControlsApi, type TestControl } from '@/api/observability';
import { ErrorNote, Loading } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CardShell } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { usePlatformAuthority } from '@/lib/platformAuthority';

/** The original Health controls, with server availability and current-session gates. */
export function TestControls({ canManage, onRan, standalone = false }: {
  canManage: boolean; onRan?: () => void; standalone?: boolean;
}) {
  const authority = usePlatformAuthority('admin:ops:manage');
  const [state, setState] = useState<{ key: string; controls: TestControl[]; error: string | null } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const busy = useRef(false);
  const list = canManage && authority.allowed && state?.key === authority.key ? state.controls : null;
  useEffect(() => {
    if (!canManage || !authority.allowed) return;
    let active = true;
    setState(null); setNote(null); setBusyKey(null); busy.current = false;
    void testControlsApi.list().then(({ available, controls }) => {
      if (active && authority.isCurrent()) setState({ key: authority.key, controls: available ? controls : [], error: null });
    }).catch((failure: unknown) => {
      if (active && authority.isCurrent()) setState({ key: authority.key, controls: [], error: failure instanceof Error ? failure.message : 'Test controls could not be read.' });
    });
    return () => { active = false; };
  }, [canManage, authority.allowed, authority.key, authority.isCurrent, retry]);

  if (!canManage || !authority.allowed) return null;
  if (!standalone && (!list || list.length === 0)) return null;
  const error = state?.key === authority.key ? state.error : null;
  const run = async (control: TestControl) => {
    if (busy.current || !authority.isCurrent() || !list?.some((entry) => entry.key === control.key)) return;
    busy.current = true; setBusyKey(control.key); setNote(null);
    try {
      const result = await testControlsApi.run(control.key);
      if (!authority.isCurrent()) return;
      setNote(result.message ?? `${control.label} ran.`);
      onRan?.();
    } catch (failure) {
      if (authority.isCurrent()) setNote(failure instanceof Error ? failure.message : 'That control failed');
    } finally {
      if (authority.isCurrent()) { busy.current = false; setBusyKey(null); }
    }
  };
  return <CardShell span={12} icon={FlaskConical} title={standalone ? 'Available controls' : 'Test controls'}
    note="Staging-only controls add demo scenarios or simulate failures. The demo day is added at Demo Branch 2, never at a live park, and existing records are kept.">
    {error ? <ErrorNote message={error} onRetry={() => { if (authority.isCurrent()) setRetry((value) => value + 1); }} />
      : !list ? <Loading what="test controls" />
        : list.length === 0 ? <EmptyNote title="Test controls are not available on this deployment for this account." />
          : <div className="flex flex-wrap gap-2">{list.map((control) => <Button key={control.key} variant="outline" size="sm"
            className="rounded-full" title={control.description ?? undefined} disabled={busyKey !== null} onClick={() => void run(control)}>
            {busyKey === control.key && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{control.label}
          </Button>)}</div>}
    {note && <p className="text-sm text-muted-foreground mt-3">{note}</p>}
  </CardShell>;
}
