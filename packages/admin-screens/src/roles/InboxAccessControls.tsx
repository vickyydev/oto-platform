import { useEffect, useMemo, useRef, useState } from 'react';
import { INBOX_CATEGORY_KEYS } from '@oto/shared';
import type { AdminApi } from '../api/admin-api';
import { createRolesApi, type AccountInboxAccess, type InboxAccessChange, type InboxAccessPreview } from '../api/roles';
import { Button } from '../ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { toast } from '../hooks/use-toast';

type Selection = Pick<InboxAccessChange, 'categories' | 'channelAccountIds'>;
const categoryNames = { birthdays: 'Birthdays & Events', general: 'General', marketing: 'Marketing', gm: 'GM' };
const normalized = (value: Selection) => JSON.stringify({ categories: value.categories?.slice().sort() ?? null,
  channelAccountIds: value.channelAccountIds?.slice().sort() ?? null });
const message = (error: unknown) => error instanceof Error ? error.message : 'Inbox access could not be read.';

/** The existing permissions drawer owns this control; no grant is created by a limit. */
export function InboxAccessControls({ api, accountId, canAssign, onSaved }: {
  api: AdminApi; accountId: string; canAssign: boolean; onSaved?: () => void;
}) {
  const roles = useMemo(() => createRolesApi(api), [api]);
  const selected = useRef<string | null>(accountId);
  selected.current = accountId;
  const readRequest = useRef<object>({}), previewRequest = useRef<object>({}), saveRequest = useRef<object | null>(null), saving = useRef(false);
  const [data, setData] = useState<AccountInboxAccess | null>(null);
  const [edit, setEdit] = useState<Selection>({ categories: null, channelAccountIds: null });
  const [preview, setPreview] = useState<InboxAccessPreview | null>(null);
  const [reviewing, setReviewing] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [previewError, setPreviewError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const currentView = useRef({ data, edit, preview });
  currentView.current = { data, edit, preview };
  useEffect(() => {
    selected.current = accountId;
    const request = {}; readRequest.current = request; previewRequest.current = {};
    setData(null); setPreview(null); setReviewing(false); setError(null); setPreviewError(null); setBusy(saving.current);
    void roles.inboxAccess(accountId).then(answer => {
      if (readRequest.current !== request || selected.current !== accountId) return;
      if (answer.accountId !== accountId) { setError('The Inbox limits did not match this account. Refresh and try again.'); return; }
      setData(answer); setEdit({ categories: answer.categories, channelAccountIds: answer.channelAccountIds });
    }).catch(failure => { if (readRequest.current === request && selected.current === accountId) setError(message(failure)); });
    return () => { readRequest.current = {}; previewRequest.current = {}; selected.current = null; };
  }, [accountId, reload, roles]);
  const editable = canAssign && Boolean(data?.canManage) && data?.accountId === accountId;
  const change = (next: Selection) => {
    if (!editable || saving.current) return;
    previewRequest.current = {}; setPreview(null); setPreviewError(null); setEdit(next);
  };
  const startPreview = () => {
    if (!editable || !data || saving.current) return;
    const request = {}; previewRequest.current = request;
    const snapshot = { ...edit, expectedVersion: data.version };
    setReviewing(true); setPreview(null); setPreviewError(null);
    void roles.previewInboxAccess(accountId, snapshot).then(answer => {
      if (previewRequest.current !== request || selected.current !== accountId) return;
      if (answer.accountId !== accountId || answer.version !== snapshot.expectedVersion || normalized(answer.after) !== normalized(snapshot)) {
        setPreviewError('The preview did not match these limits. Refresh and review again.'); return;
      }
      setPreview(answer);
    }).catch(failure => { if (previewRequest.current === request && selected.current === accountId) setPreviewError(message(failure)); });
  };
  const save = async () => {
    if (!editable || !data || !preview || previewError || saving.current || selected.current !== accountId
      || currentView.current.data !== data || currentView.current.edit !== edit || currentView.current.preview !== preview
      || preview.accountId !== accountId || preview.version !== data.version || normalized(preview.after) !== normalized(edit)) return;
    const captured = accountId, view = readRequest.current, request = {};
    saveRequest.current = request;
    const isCurrent = () => selected.current === captured && readRequest.current === view && saveRequest.current === request;
    saving.current = true; setBusy(true);
    try {
      const answer = await roles.saveInboxAccess(captured, { ...preview.after, expectedVersion: preview.version });
      if (!isCurrent()) return;
      if (answer.accountId !== captured) throw new Error('The saved limits did not match this account. Refresh before another change.');
      setData(answer); setEdit({ categories: answer.categories, channelAccountIds: answer.channelAccountIds });
      setReviewing(false); setPreview(null); onSaved?.();
      toast({ title: 'Inbox access updated', description: 'The account keeps its existing roles, within these category and channel limits.' });
    } catch (failure) {
      if (isCurrent()) { setPreview(null); setPreviewError(message(failure)); }
    } finally {
      // One save may be in flight across account changes. Release its shared
      // busy state without letting its result replace a newer view/read.
      if (saveRequest.current === request) { saveRequest.current = null; saving.current = false; if (selected.current !== null) setBusy(false); }
    }
  };
  const channelName = (id: string) => data?.channels.find(channel => channel.id === id)?.displayName
    ?? (data?.channels.some(channel => channel.id === id) ? 'Unnamed channel' : 'Channel outside your readable branches');
  const describe = (selection: Selection) => <>
    <p>Categories: {selection.categories === null ? 'All existing categories' : selection.categories.length === 0 ? 'None' : selection.categories.map(key => categoryNames[key]).join(', ')}</p>
    <p>Channels: {selection.channelAccountIds === null ? 'All existing channels' : selection.channelAccountIds.length === 0 ? 'None' : selection.channelAccountIds.map(channelName).join(', ')}</p>
  </>;
  return <section className="border-t border-foreground/10 pt-4" aria-label="Inbox access limits">
    <h3 className="text-sm font-bold mb-2">Inbox access</h3>
    <p className="mb-3 text-sm text-foreground/70">Category and channel limits narrow the Inbox permissions already assigned above. They do not add access.</p>
    {error ? <div role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" onClick={() => setReload(value => value + 1)}>Refresh Inbox limits</Button></div>
      : !data || data.accountId !== accountId ? <p role="status" className="text-sm">Reading Inbox access…</p>
        : !editable ? <div className="space-y-2 text-sm">{describe(data)}<p className="text-foreground/70">{data.administrator
          ? 'Operator administrators retain their existing Inbox access.' : 'An operator-wide role administrator must review and change these limits.'}</p></div>
          : <div className="space-y-3 text-sm">
            <fieldset disabled={busy} className="space-y-2">
              <legend className="font-semibold">Categories</legend>
              <label className="flex items-center gap-2"><input type="checkbox" checked={edit.categories === null}
                onChange={event => change({ ...edit, categories: event.target.checked ? null : [...INBOX_CATEGORY_KEYS] })} />All categories</label>
              {edit.categories !== null && INBOX_CATEGORY_KEYS.map(key => <label key={key} className="flex items-center gap-2 pl-5"><input type="checkbox"
                checked={edit.categories!.includes(key)} onChange={event => change({ ...edit, categories: event.target.checked
                  ? [...edit.categories!, key] : edit.categories!.filter(value => value !== key) })} />{categoryNames[key]}</label>)}
            </fieldset>
            <fieldset disabled={busy} className="space-y-2">
              <legend className="font-semibold">Channels</legend>
              <label className="flex items-center gap-2"><input type="checkbox" checked={edit.channelAccountIds === null}
                onChange={event => change({ ...edit, channelAccountIds: event.target.checked ? null : data.channels.map(channel => channel.id) })} />All channels</label>
              {edit.channelAccountIds !== null && data.channels.map(channel => <label key={channel.id} className="flex items-center gap-2 pl-5"><input type="checkbox"
                checked={edit.channelAccountIds!.includes(channel.id)} onChange={event => change({ ...edit, channelAccountIds: event.target.checked
                  ? [...edit.channelAccountIds!, channel.id] : edit.channelAccountIds!.filter(id => id !== channel.id) })} />{channel.displayName ?? channel.channel}</label>)}
              {edit.channelAccountIds?.some(id => !data.channels.some(channel => channel.id === id)) && <div className="text-foreground/70">
                Some saved channels are unavailable. Review their removal before saving.
                <Button size="sm" variant="ghost" onClick={() => change({ ...edit, channelAccountIds: edit.channelAccountIds!.filter(id => data.channels.some(channel => channel.id === id)) })}>Remove unavailable channels</Button>
              </div>}
            </fieldset>
            <Button size="sm" variant="outline" disabled={busy || normalized(data) === normalized(edit)} onClick={startPreview}>Review Inbox limits</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReload(value => value + 1)}>Refresh limits</Button>
          </div>}
    <AlertDialog open={reviewing && data?.accountId === accountId} onOpenChange={open => { if (!saving.current && !open) { previewRequest.current = {}; setReviewing(false); setPreview(null); } }}>
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader><AlertDialogTitle>Review Inbox access</AlertDialogTitle>
          <AlertDialogDescription>The existing operator, branch, team and action permissions still apply. Empty selections allow none. Review before saving.</AlertDialogDescription></AlertDialogHeader>
        {previewError ? <div role="alert" className="text-sm text-destructive">{previewError}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setReviewing(false); setReload(value => value + 1); }}>Refresh current limits</Button></div>
          : !preview ? <p role="status" className="text-sm">Reading the current limits and proposed change…</p>
            : <div className="space-y-3 text-sm"><div><h4 className="font-semibold">Current</h4>{describe(preview.before)}</div>
              <div><h4 className="font-semibold">After saving</h4>{describe(preview.after)}</div></div>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy || !preview || Boolean(previewError)} onClick={event => { event.preventDefault(); void save(); }}>Save Inbox limits</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
