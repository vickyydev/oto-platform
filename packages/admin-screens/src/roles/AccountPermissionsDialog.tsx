import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import type { AdminApi } from '../api/admin-api';
import type { AccountRow } from '../api/accounts';
import { createRolesApi, type AccountPermissions, type GrantRole, type PermissionPreview, type PreviewQuery } from '../api/roles';
import type { AccountsOperator, AdminBranch } from '../accounts/LoginUsersPanel';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../ui/alert-dialog';
import { toast } from '../hooks/use-toast';
import { PermissionDiffView } from './PermissionDiffView';
import { permissionWords, scopeWords } from './presentation';

export type PermissionAccount = Pick<AccountRow, 'id' | 'phone' | 'employee'>;
const ROLES = ['reception', 'staff', 'branch_manager', 'operator_admin'] as const;
type ScopeKey = 'operator' | 'platform' | `branch:${string}`;
type PendingChange = { accountId: string } & (
  { operation: 'grant'; body: GrantRole } | { operation: 'remove'; assignmentId: string }
);

/** The existing POS permissions drawer, with a server preview before either write. */
export function AccountPermissionsDialog({ account, api, branches, me, canAssign, onClose, onSaved }: {
  account: PermissionAccount | null;
  api: AdminApi;
  branches: AdminBranch[];
  me: AccountsOperator;
  canAssign: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const rolesApi = useMemo(() => createRolesApi(api), [api]);
  const selectedAccount = useRef<string | null>(null);
  selectedAccount.current = account?.id ?? null;
  const readRequest = useRef<object>({});
  const previewRequest = useRef<object>({});
  const saving = useRef(false);
  const [permissions, setPermissions] = useState<AccountPermissions | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [addRole, setAddRole] = useState<(typeof ROLES)[number]>('reception');
  const [addScope, setAddScope] = useState<ScopeKey>('operator');
  const [change, setChange] = useState<PendingChange | null>(null);
  const [preview, setPreview] = useState<PermissionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accountId = account?.id;

  useEffect(() => {
    const request = {};
    readRequest.current = request;
    previewRequest.current = {};
    setPermissions(null);
    setReadError(null);
    setChange(null);
    setPreview(null);
    setPreviewError(null);
    if (!accountId) return;
    void rolesApi.accountPermissions(accountId).then((answer) => {
      if (request === readRequest.current) setPermissions(answer);
    }).catch((failure: unknown) => {
      if (request === readRequest.current) setReadError(message(failure, 'Could not load permissions.'));
    });
    return () => { readRequest.current = {}; previewRequest.current = {}; };
  }, [accountId, reload, rolesApi]);

  const serverBranches = branches.filter((branch) => branch.apiId);
  const scopeOptions: Array<{ key: ScopeKey; label: string }> = [
    ...serverBranches.map((branch) => ({ key: `branch:${branch.apiId!}` as ScopeKey, label: `Branch — ${branch.name}` })),
    { key: 'operator', label: 'Operator-wide (all branches)' },
    ...(me.isPlatformAdmin ? [{ key: 'platform' as ScopeKey, label: 'Platform-wide (every operator)' }] : []),
  ];
  const clearPreview = () => {
    if (saving.current) return;
    previewRequest.current = {};
    setChange(null);
    setPreview(null);
    setPreviewError(null);
  };
  const loadPreview = (pending: PendingChange) => {
    if (saving.current || !canAssign || selectedAccount.current !== pending.accountId) return;
    const request = {};
    previewRequest.current = request;
    setChange(pending);
    setPreview(null);
    setPreviewError(null);
    const query: PreviewQuery = pending.operation === 'grant'
      ? { accountId: pending.accountId, operation: 'grant', roleName: pending.body.roleName,
        scopeType: pending.body.scopeType, ...(pending.body.scopeId !== null ? { scopeId: pending.body.scopeId } : {}) }
      : { accountId: pending.accountId, operation: 'remove', assignmentId: pending.assignmentId };
    void rolesApi.preview(query).then((answer) => {
      if (request !== previewRequest.current || selectedAccount.current !== pending.accountId) return;
      if (answer.accountId !== pending.accountId || answer.operation !== pending.operation) {
        setPreviewError('The preview did not match this account change. Try again.');
      } else setPreview(answer);
    }).catch((failure: unknown) => {
      if (request === previewRequest.current && selectedAccount.current === pending.accountId) {
        setPreviewError(message(failure, 'Could not read the permission preview.'));
      }
    });
  };
  const startGrant = () => {
    if (!account || saving.current) return;
    const scope: Pick<GrantRole, 'scopeType' | 'scopeId'> = addScope === 'platform'
      ? { scopeType: 'operator', scopeId: null }
      : addScope === 'operator' ? { scopeType: 'operator', scopeId: me.operatorId }
        : { scopeType: 'branch', scopeId: addScope.slice('branch:'.length) };
    loadPreview({ accountId: account.id, operation: 'grant', body: { roleName: addRole, ...scope } });
  };
  const save = async () => {
    if (!change || !preview || previewError || !canAssign || saving.current || selectedAccount.current !== change.accountId) return;
    saving.current = true;
    setBusy(true);
    try {
      if (change.operation === 'grant') await rolesApi.grant(change.accountId, change.body);
      else await rolesApi.remove(change.accountId, change.assignmentId);
      toast({ title: change.operation === 'grant' ? 'Role assigned' : 'Role removed',
        description: 'The account’s permissions are being read again from the server.' });
      if (selectedAccount.current === change.accountId) {
        previewRequest.current = {};
        setChange(null);
        setPreview(null);
        setReload((held) => held + 1);
        onSaved?.();
      }
    } catch (failure) {
      if (selectedAccount.current === change.accountId) {
        setPreview(null);
        setPreviewError(message(failure, 'The role change could not be saved.'));
      }
    } finally { saving.current = false; setBusy(false); }
  };

  return <>
    <Dialog open={account !== null} onOpenChange={(open) => { if (!open && !saving.current) { clearPreview(); onClose(); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Permissions — {account?.employee?.name ?? account?.phone}</DialogTitle>
          <DialogDescription>Assigned roles and the effective permissions they resolve to, with scopes.</DialogDescription>
        </DialogHeader>
        {readError ? <div role="alert" className="text-sm text-destructive">
          Permissions could not be read. {readError}
          <Button variant="ghost" size="sm" onClick={() => setReload((held) => held + 1)}>Try again</Button>
        </div> : !permissions ? <div className="flex justify-center py-8" role="status" aria-label="Loading permissions">
          <Loader2 className="w-6 h-6 animate-spin text-foreground/40" />
        </div> : <div className="flex flex-col gap-4 max-h-[55vh] overflow-y-auto">
          <div>
            <h3 className="text-sm font-bold mb-2">Role assignments</h3>
            <div className="flex flex-col gap-2">
              {permissions.assignments.map((assignment) => <div key={assignment.id}
                className="flex items-center justify-between rounded-lg border border-foreground/10 px-3 py-2 text-sm">
                <span className="font-medium">{assignment.roleName}</span>
                <span className="text-foreground/50">{scopeWords(assignment.scopeType, assignment.scopeId, branches)}</span>
                <Button variant="ghost" size="sm" className="text-destructive h-7" disabled={busy || !canAssign}
                  onClick={() => account && loadPreview({ accountId: account.id, operation: 'remove', assignmentId: assignment.id })}>Remove</Button>
              </div>)}
              {permissions.assignments.length === 0 && <p className="text-sm text-foreground/50">
                No roles assigned — this account can sign in and reach nothing. Give it one below.
              </p>}
            </div>
            <div className="mt-3 flex items-end gap-2 rounded-lg border border-dashed border-foreground/15 p-3">
              <div className="flex-1 min-w-0">
                <label className="text-xs font-semibold text-foreground/60">Role</label>
                <select aria-label="Role" value={addRole} disabled={busy}
                  onChange={(event) => { clearPreview(); setAddRole(event.target.value as (typeof ROLES)[number]); }}
                  className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-2 text-sm">
                  {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-0">
                <label className="text-xs font-semibold text-foreground/60">Scope</label>
                <select aria-label="Scope" value={addScope} disabled={busy}
                  onChange={(event) => { clearPreview(); setAddScope(event.target.value as ScopeKey); }}
                  className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-2 text-sm">
                  {scopeOptions.map((scope) => <option key={scope.key} value={scope.key}>{scope.label}</option>)}
                </select>
              </div>
              <Button size="sm" className="h-9" disabled={busy || !canAssign || !me.operatorId} onClick={startGrant}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}Add
              </Button>
            </div>
            {!canAssign && <p className="mt-2 text-sm text-foreground/50">Role changes are not on your access.</p>}
          </div>
          <div>
            <h3 className="text-sm font-bold mb-2">Effective permissions ({permissions.effective.length})</h3>
            <div className="flex flex-wrap gap-1.5">
              {permissions.effective.map((permission, index) => <span key={index}
                title={`${permission.roleName} · ${scopeWords(permission.scopeType, permission.scopeId, branches)} · ${permissionWords(permission.permission)}`}
                className="rounded-full bg-foreground/5 px-2 py-1 text-xs font-mono">{permission.permission}</span>)}
            </div>
          </div>
        </div>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={change !== null} onOpenChange={(open) => { if (!open) clearPreview(); }}>
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Review permission change</AlertDialogTitle>
          <AlertDialogDescription>{account?.employee?.name ?? account?.phone} — {change?.operation === 'grant'
            ? `assign ${change.body.roleName} at ${scopeWords(change.body.scopeType, change.body.scopeId, branches)}`
            : 'remove a role'}. Review the server’s permission changes before saving.</AlertDialogDescription>
        </AlertDialogHeader>
        {previewError ? <div role="alert" className="text-sm text-destructive">{previewError}
          <Button variant="ghost" size="sm" onClick={() => change && loadPreview(change)}>Refresh preview</Button>
        </div> : preview ? <PermissionDiffView added={preview.added} removed={preview.removed} branches={branches} />
          : <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Reading permission preview…</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy || !preview || Boolean(previewError)} onClick={(event) => { event.preventDefault(); void save(); }}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Save role change
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function message(failure: unknown, fallback: string): string { return failure instanceof Error ? failure.message : fallback; }
