import { useEffect, useState } from 'react';
import {
  KeyRound,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserX,
  UserCheck,
  Loader2,
  LayoutGrid,
  Lock,
  LogOut,
  MonitorSmartphone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { toast } from '@/hooks/use-toast';
import { adminApi } from '@/api/platform';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { AccountAppsDialog } from './AccountAppsDialog';

/**
 * SCRUM-21 / SCRUM-22 / SCRUM-28 — manage login users: search, invite with a
 * scoped role, activate/deactivate, temporary passwords, and the effective
 * permissions each account resolves to. New screen, prototype admin design
 * language (UI addition — CLAUDE.md §7.2).
 *
 * S2-01a adds the session side of the same job: which devices an account is
 * signed in on, "Sign out everywhere" to evict a forgotten till, and the
 * refusals the API has recorded — the first place to look when someone is
 * being told "no" or is probing what they can reach.
 *
 * S2-17a adds the app side: the suite's other apps hold users of their own, and
 * an account needs both the permission and an identity in the app before a tile
 * opens onto anything. AccountAppsDialog is where those are linked.
 */
type AccountRow = {
  id: string;
  phone: string;
  status: string;
  mustChangePassword: boolean;
  employee: { id: string; name: string } | null;
};

type SessionRow = {
  id: string;
  branchId: string | null;
  stationId: string | null;
  lockedAt: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
};

type DenialRow = {
  id: string;
  actorAccountId: string | null;
  requestId: string | null;
  after: { code: string; message: string; method: string; url: string } | null;
  createdAt: string;
};

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

const ROLES = ['reception', 'staff', 'branch_manager', 'operator_admin'] as const;

export function LoginUsersPanel() {
  const { branches } = useCatalogStore();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newRole, setNewRole] = useState<(typeof ROLES)[number]>('reception');
  const [newBranch, setNewBranch] = useState<string>('');

  /** Confirm-first for destructive/sensitive actions. */
  const [pendingAction, setPendingAction] = useState<
    | { kind: 'deactivate'; account: AccountRow }
    | { kind: 'temp-password'; account: AccountRow }
    | { kind: 'revoke-sessions'; account: AccountRow }
    | null
  >(null);

  const [appsFor, setAppsFor] = useState<AccountRow | null>(null);
  const [sessionsFor, setSessionsFor] = useState<AccountRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [denials, setDenials] = useState<DenialRow[]>([]);

  const [permsFor, setPermsFor] = useState<AccountRow | null>(null);
  const [perms, setPerms] = useState<{
    assignments: Array<{ id: string; roleName: string; scopeType: string; scopeId: string | null }>;
    effective: Array<{ permission: string; scopeType: string; scopeId: string | null; roleName: string }>;
  } | null>(null);

  const apiFail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });

  const refresh = (q = query) =>
    adminApi
      .accounts(q || undefined)
      .then((r) => setAccounts(r.accounts))
      .catch(apiFail("Couldn't load accounts"));

  /** Refusals the API recorded — quiet when there are none, which is normal. */
  const refreshDenials = () =>
    adminApi
      .recentDenials(10)
      .then((r) => setDenials(r.entries))
      .catch(() => setDenials([]));

  useEffect(() => {
    void refresh('');
    void refreshDenials();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const serverBranches = branches.filter((b) => b.apiId);

  const create = async () => {
    if (busy || !newPhone.trim() || !newName.trim()) return;
    setBusy(true);
    try {
      const branch = serverBranches.find((b) => b.id === newBranch) ?? serverBranches[0];
      const scope =
        newRole === 'operator_admin'
          ? { scopeType: 'operator', scopeId: null }
          : { scopeType: 'branch', scopeId: branch?.apiId ?? null };
      const res = await adminApi.createAccount({
        phone: newPhone,
        employeeName: newName.trim(),
        roles: [{ roleName: newRole, ...scope }],
      });
      // The code goes to the phone on every deployment — no log to fall back
      // on — so the toast tells reception what to tell the person in front of
      // them. Ten minutes is CODE_TTL_MS in apps/api/src/services/auth.ts.
      // The account exists either way; only the text may have failed, and
      // saying it went when it did not leaves someone waiting for nothing.
      toast({
        title: 'Account invited',
        description: res.codeSent
          ? 'A six-digit setup code has been texted to that number. It lasts 10 minutes and works once — they enter it on the lock screen to set their password.'
          : (res.warning ??
            'The account was created, but the setup code could not be texted. Send it again from the lock screen.'),
        variant: res.codeSent ? undefined : 'destructive',
      });
      setCreateOpen(false);
      setNewName('');
      setNewPhone('');
      await refresh();
    } catch (err) {
      apiFail("Couldn't create the account")(err);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (a: AccountRow, status: 'active' | 'inactive') =>
    adminApi
      .updateAccount(a.id, { status })
      .then(() => refresh())
      .catch(apiFail("Couldn't update the account"));

  const tempPassword = (a: AccountRow) =>
    adminApi
      .tempPassword(a.id)
      .then((r) =>
        toast({
          title: `Temporary password for ${a.employee?.name ?? a.phone}`,
          description: `${r.temporaryPassword} — works until they set their own; a change is forced at next sign-in.`,
          duration: 20000,
        }),
      )
      .catch(apiFail("Couldn't issue a temporary password"));

  const showPerms = (a: AccountRow) => {
    setPermsFor(a);
    setPerms(null);
    void adminApi
      .accountPermissions(a.id)
      .then(setPerms)
      .catch(apiFail("Couldn't load permissions"));
  };

  const showSessions = (a: AccountRow) => {
    setSessionsFor(a);
    setSessions(null);
    void adminApi
      .accountSessions(a.id)
      .then((r) => setSessions(r.sessions))
      .catch(apiFail("Couldn't load sessions"));
  };

  /** Force sign-out: every device this account holds returns to sign-in. */
  const revokeSessions = (a: AccountRow) =>
    adminApi
      .revokeSessions(a.id)
      .then((r) => {
        toast({
          title: `Signed out everywhere`,
          description: `${r.sessionsEnded} session${r.sessionsEnded === 1 ? '' : 's'} ended for ${
            a.employee?.name ?? a.phone
          }. They must sign in again.`,
        });
        if (sessionsFor?.id === a.id) showSessions(a);
      })
      .catch(apiFail("Couldn't sign them out"));

  const scopeLabel = (scopeType: string, scopeId: string | null) => {
    if (scopeType === 'operator') return scopeId ? 'operator-wide' : 'platform-wide';
    if (scopeType === 'branch') {
      const b = serverBranches.find((x) => x.apiId === scopeId);
      return b ? `branch: ${b.name}` : 'branch';
    }
    return `${scopeType}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              void refresh(e.target.value);
            }}
            placeholder="Search name or phone…"
            className="w-full h-10 rounded-lg border border-input bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4" />
          Invite staff account
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-foreground/10">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead className="w-44">Phone</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.employee?.name ?? '—'}</TableCell>
                <TableCell className="tabular-nums text-foreground/70">{a.phone}</TableCell>
                <TableCell>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                      a.status === 'active'
                        ? 'bg-emerald-500/15 text-emerald-600'
                        : a.status === 'invited'
                          ? 'bg-amber-500/15 text-amber-600'
                          : 'bg-foreground/10 text-foreground/50'
                    }`}
                  >
                    {a.status}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    <Button variant="ghost" size="sm" title="Effective permissions" onClick={() => showPerms(a)}>
                      <ShieldCheck className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Apps" onClick={() => setAppsFor(a)}>
                      <LayoutGrid className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Sessions" onClick={() => showSessions(a)}>
                      <MonitorSmartphone className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Sign out everywhere"
                      onClick={() => setPendingAction({ kind: 'revoke-sessions', account: a })}
                    >
                      <LogOut className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Temporary password"
                      onClick={() => setPendingAction({ kind: 'temp-password', account: a })}
                    >
                      <KeyRound className="w-4 h-4" />
                    </Button>
                    {a.status === 'inactive' ? (
                      <Button variant="ghost" size="sm" title="Activate" onClick={() => void setStatus(a, 'active')}>
                        <UserCheck className="w-4 h-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Deactivate"
                        className="text-destructive"
                        onClick={() => setPendingAction({ kind: 'deactivate', account: a })}
                      >
                        <UserX className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Recent denials (S2-01a) — what the API refused, newest first. */}
      <div className="rounded-2xl border border-foreground/10">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-foreground/10">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <ShieldAlert className="w-4 h-4 text-amber-500" />
            Recent denials
          </h3>
          <Button variant="ghost" size="sm" onClick={() => void refreshDenials()}>
            Refresh
          </Button>
        </div>
        {denials.length === 0 ? (
          <p className="px-4 py-4 text-sm text-foreground/50">
            Nothing refused recently. Blocked role assignments, temp passwords and locked-session
            attempts appear here.
          </p>
        ) : (
          <ul className="divide-y divide-foreground/10">
            {denials.map((d) => {
              const actor = accounts.find((a) => a.id === d.actorAccountId);
              return (
                <li key={d.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600 shrink-0">
                    {d.after?.code ?? 'DENIED'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-medium">{actor?.employee?.name ?? actor?.phone ?? 'Unknown'}</span>
                      <span className="text-foreground/50">
                        {' '}
                        — {d.after?.method} {d.after?.url}
                      </span>
                    </div>
                    <div className="text-xs text-foreground/50">{d.after?.message}</div>
                  </div>
                  <span className="text-xs text-foreground/40 tabular-nums shrink-0">
                    {when(d.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Invite dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => !busy && setCreateOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite a staff account</DialogTitle>
            <DialogDescription>
              They'll finish setup on the lock screen with the SMS code, then sign in with their own
              password.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="text-sm font-semibold text-foreground/60">Full name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Som (Reception)"
              className="w-full h-11 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <label className="text-sm font-semibold text-foreground/60">Phone</label>
            <PhoneInput value={newPhone} onChange={setNewPhone} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-semibold text-foreground/60">Role</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as (typeof ROLES)[number])}
                  className="mt-1 w-full h-11 rounded-lg border border-input bg-background px-2 text-sm"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-semibold text-foreground/60">Branch scope</label>
                <select
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  disabled={newRole === 'operator_admin'}
                  className="mt-1 w-full h-11 rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-50"
                >
                  {serverBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Button className="mt-2" onClick={() => void create()} disabled={busy || !newName.trim() || !newPhone.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create & send invite
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmations for sensitive account actions */}
      <AlertDialog open={pendingAction !== null} onOpenChange={(o) => !o && setPendingAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.kind === 'deactivate'
                ? `Deactivate ${pendingAction.account.employee?.name ?? pendingAction.account.phone}?`
                : pendingAction?.kind === 'revoke-sessions'
                  ? `Sign ${pendingAction.account.employee?.name ?? pendingAction.account.phone} out everywhere?`
                  : `Issue a temporary password for ${pendingAction?.account.employee?.name ?? pendingAction?.account.phone}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === 'deactivate'
                ? 'They are signed out everywhere immediately and cannot sign in until reactivated.'
                : pendingAction?.kind === 'revoke-sessions'
                  ? 'Every device they are signed in on returns to the sign-in screen. The account itself stays active, so they can sign straight back in.'
                  : 'Their current password stops working, every session is signed out, and they must set a new password at next sign-in.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                pendingAction?.kind === 'deactivate'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
              onClick={() => {
                if (pendingAction?.kind === 'deactivate') void setStatus(pendingAction.account, 'inactive');
                if (pendingAction?.kind === 'temp-password') void tempPassword(pendingAction.account);
                if (pendingAction?.kind === 'revoke-sessions') void revokeSessions(pendingAction.account);
                setPendingAction(null);
                void refreshDenials();
              }}
            >
              {pendingAction?.kind === 'deactivate'
                ? 'Deactivate'
                : pendingAction?.kind === 'revoke-sessions'
                  ? 'Sign out everywhere'
                  : 'Issue temporary password'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Apps this account is linked to (S2-17a) */}
      <AccountAppsDialog
        account={appsFor}
        onClose={() => setAppsFor(null)}
        scopeLabel={scopeLabel}
      />

      {/* Sessions this account holds (S2-01a) */}
      <Dialog open={sessionsFor !== null} onOpenChange={(o) => !o && setSessionsFor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sessions — {sessionsFor?.employee?.name ?? sessionsFor?.phone}</DialogTitle>
            <DialogDescription>
              Devices this account is signed in on. A locked session is still signed in — it unlocks
              with the password.
            </DialogDescription>
          </DialogHeader>
          {!sessions ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-foreground/40" />
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-h-[55vh] overflow-y-auto">
              {sessions.length === 0 && (
                <p className="text-sm text-foreground/50">No sessions on record.</p>
              )}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      <MonitorSmartphone className="w-4 h-4 text-foreground/40" />
                      {s.stationId ? 'Station' : 'Till / browser'}
                      {s.lockedAt && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600">
                          <Lock className="w-3 h-3" />
                          locked
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-foreground/50 tabular-nums">
                      last seen {when(s.lastSeenAt)} · expires {when(s.expiresAt)}
                    </div>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                className="mt-1 text-destructive"
                onClick={() =>
                  setPendingAction({ kind: 'revoke-sessions', account: sessionsFor! })
                }
              >
                <LogOut className="w-4 h-4" />
                Sign out everywhere
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Effective permissions dialog (SCRUM-22) */}
      <Dialog open={permsFor !== null} onOpenChange={(o) => !o && setPermsFor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Permissions — {permsFor?.employee?.name ?? permsFor?.phone}
            </DialogTitle>
            <DialogDescription>
              Assigned roles and the effective permissions they resolve to, with scopes.
            </DialogDescription>
          </DialogHeader>
          {!perms ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-foreground/40" />
            </div>
          ) : (
            <div className="flex flex-col gap-4 max-h-[55vh] overflow-y-auto">
              <div>
                <h3 className="text-sm font-bold mb-2">Role assignments</h3>
                <div className="flex flex-col gap-2">
                  {perms.assignments.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between rounded-lg border border-foreground/10 px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{a.roleName}</span>
                      <span className="text-foreground/50">{scopeLabel(a.scopeType, a.scopeId)}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive h-7"
                        onClick={() =>
                          void adminApi
                            .removeAssignment(permsFor!.id, a.id)
                            .then(() => showPerms(permsFor!))
                            .catch(apiFail("Couldn't remove the assignment"))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  {perms.assignments.length === 0 && (
                    <p className="text-sm text-foreground/50">No roles assigned.</p>
                  )}
                </div>
              </div>
              <div>
                <h3 className="text-sm font-bold mb-2">
                  Effective permissions ({perms.effective.length})
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {perms.effective.map((p, i) => (
                    <span
                      key={i}
                      title={`${p.roleName} · ${scopeLabel(p.scopeType, p.scopeId)}`}
                      className="rounded-full bg-foreground/5 px-2 py-1 text-xs font-mono"
                    >
                      {p.permission}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
