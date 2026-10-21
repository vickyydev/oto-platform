import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Permission } from '@oto/shared/permissions';
import type { AdminApi } from '../api/admin-api';
import { createAccountsApi, type AccountRow, type SessionRow, type StaffTokenRow, type StaffTokenSettings, type DenialRow } from '../api/accounts';
import {
  KeyRound,
  Pencil,
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
  Tablet,
} from 'lucide-react';
import { Button } from '../ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { PhoneInput } from './PhoneInput';
import { toast } from '../hooks/use-toast';
import { staffTokenEndedWhy, staffTokenRowState, staffTokenSettingsWords } from './staff-token-words';

/** An identifier short enough to match by eye; never a signed token. */
const shortId = (id: string): string => id.slice(0, 8);

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

const ROLES = ['reception', 'staff', 'branch_manager', 'operator_admin'] as const;

/**
 * Where a role applies, as one value a `<select>` can hold.
 *
 * `operator` is this operator and everything under it. `platform` is the
 * operator scope with a NULL id, which the API reads as every operator there
 * is — a different and much larger thing, offered only to somebody who
 * already holds it. The two were conflated here: an operator_admin invited
 * from this panel was sent `scopeId: null` and became an administrator of the
 * whole platform, and a caller who was not platform-wide had the invitation
 * refused outright (SCOPE_NOT_OWNED).
 */
type ScopeKey = 'operator' | 'platform' | `branch:${string}`;

export interface AdminBranch { id: string; apiId?: string; name: string }
export interface AccountsOperator { operatorId: string; isPlatformAdmin: boolean }

interface LoginUsersPanelProps {
  api: AdminApi;
  branches: AdminBranch[];
  me: AccountsOperator;
  can: (permission: Permission) => boolean;
  onPermissions?: (account: AccountRow) => void;
  onApps?: (account: AccountRow) => void;
  afterAccounts?: ReactNode;
}

/** The POS Login Users account surface, with its host transport and directory supplied. */
export function LoginUsersPanel({ api, branches, me, can, onPermissions, onApps, afterAccounts }: LoginUsersPanelProps) {
  const adminApi = useMemo(() => createAccountsApi(api), [api]);
  const accountsRequest = useRef(0);
  const sessionsRequest = useRef(0);
  const tokensRequest = useRef(0);
  const sessionsAccount = useRef<string | null>(null);
  const currentQuery = useRef('');
  const issuingPassword = useRef(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [denialsLoading, setDenialsLoading] = useState(true);
  const [denialsError, setDenialsError] = useState<string | null>(null);
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

  /**
   * A temporary password that has just been issued, and whether the manager
   * has asked to see it. Held here rather than rendered on arrival, so the
   * credential is on screen only while somebody is deliberately reading it.
   */
  const [issued, setIssued] = useState<{ account: AccountRow; password: string } | null>(null);
  const [issuedVisible, setIssuedVisible] = useState(false);

  const [sessionsFor, setSessionsFor] = useState<AccountRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [denials, setDenials] = useState<DenialRow[]>([]);

  /** Shift tokens for the account in the Sessions dialog (SCRUM-512); null while loading. */
  const [staffTokens, setStaffTokens] = useState<StaffTokenRow[] | null>(null);
  const [staffTokensFailed, setStaffTokensFailed] = useState<string | null>(null);
  const [tokenSettings, setTokenSettings] = useState<StaffTokenSettings | null>(null);
  const [endingToken, setEndingToken] = useState<StaffTokenRow | null>(null);

  /** Correcting a mistyped phone (SCRUM-239). */
  const [phoneFor, setPhoneFor] = useState<AccountRow | null>(null);
  const [newPhoneValue, setNewPhoneValue] = useState('');

  const apiFail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });

  const refresh = (q = currentQuery.current) => {
    const request = ++accountsRequest.current;
    setAccountsLoading(true);
    setAccountsError(null);
    setAccounts([]);
    return adminApi.accounts(q || undefined).then((answer) => {
      if (request === accountsRequest.current) setAccounts(answer.accounts);
    }).catch((err: unknown) => {
      if (request === accountsRequest.current) setAccountsError(err instanceof Error ? err.message : 'Unknown error');
    }).finally(() => {
      if (request === accountsRequest.current) setAccountsLoading(false);
    });
  };

  const refreshDenials = () => {
    if (!can('admin:audit:read')) { setDenialsLoading(false); return Promise.resolve(); }
    setDenialsLoading(true);
    setDenialsError(null);
    return adminApi.recentDenials(10).then((answer) => setDenials(answer.entries))
      .catch((err: unknown) => setDenialsError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setDenialsLoading(false));
  };

  useEffect(() => {
    void refresh('');
    void refreshDenials();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first load, once on mount: refresh closes over the search query and is a new function every render, so listing it would re-fetch on every render
  }, []);

  const serverBranches = branches.filter((b) => b.apiId);

  /**
   * The API's `{ scopeType, scopeId }` for a picked scope, or null while this
   * session's own operator is still loading.
   *
   * Null rather than a fallback on purpose: the only fallback available for
   * an operator-wide grant is a null scopeId, and that is the platform-wide
   * scope. A missing id must stop the request, never widen it.
   */
  const scopeFromKey = (key: ScopeKey): { scopeType: 'operator' | 'branch'; scopeId: string | null } | null => {
    if (key === 'platform') return { scopeType: 'operator', scopeId: null };
    if (key === 'operator') return me ? { scopeType: 'operator', scopeId: me.operatorId } : null;
    const id = key.slice('branch:'.length);
    return id ? { scopeType: 'branch', scopeId: id } : null;
  };

  const create = async () => {
    if (busy || !newPhone.trim() || !newName.trim()) return;
    setBusy(true);
    try {
      const branch = serverBranches.find((b) => b.id === newBranch) ?? serverBranches[0];
      // An operator administrator administers THIS operator. It was being
      // invited with a null scopeId, which is the platform-wide scope — every
      // operator on the deployment (SCRUM-239).
      const scope = newRole === 'operator_admin' ? scopeFromKey('operator') : scopeFromKey(`branch:${branch?.apiId ?? ''}`);
      if (!scope) {
        apiFail("Couldn't create the account")(
          new Error('Still reading which operator this session belongs to. Try again in a moment.'),
        );
        return;
      }
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
        description: res.codeSent === true
          ? 'A six-digit setup code has been texted to that number. It lasts 10 minutes and works once — they enter it on the lock screen to set their password.'
          : res.codeSent === false ? (res.warning?.message ??
            'The account was created, but the setup code could not be texted. Send it again from the lock screen.')
            : 'The account already exists. This response did not repeat the invitation delivery status.',
        variant: res.codeSent === false ? 'destructive' : undefined,
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

  /**
   * Issue a temporary password and hold it for a deliberate reveal (SCRUM-235).
   *
   * It used to be the description of a toast: a working credential for
   * somebody else's account, rendered into the DOM of a shared counter screen
   * for twenty seconds, whether or not the manager was alone. Nobody chose to
   * show it — it just appeared, and stayed for anyone walking past.
   *
   * Now it is kept in state, the dialog shows dots until the manager presses
   * Show, and closing the dialog drops it. The account it belongs to is named
   * so two issued in a row cannot be confused.
   */
  const tempPassword = (a: AccountRow) => {
    if (issuingPassword.current) return;
    issuingPassword.current = true;
    setPasswordBusy(true);
    return adminApi
      .tempPassword(a.id)
      .then((r) => { setIssuedVisible(false); setIssued({ account: a, password: r.temporaryPassword }); })
      .catch(apiFail("Couldn't issue a temporary password"))
      .finally(() => { issuingPassword.current = false; setPasswordBusy(false); });
  };

  /**
   * Correct a phone (SCRUM-239). It is the account's only sign-in credential
   * and the address the setup code goes to, so a mistyped one on an invite
   * used to be permanent.
   */
  const savePhone = async () => {
    if (!phoneFor || !newPhoneValue.trim() || busy) return;
    setBusy(true);
    try {
      await adminApi.updateAccount(phoneFor.id, { phone: newPhoneValue.trim() });
      toast({
        title: 'Phone updated',
        description: 'They sign in with the new number from now on. A setup code already sent to the old one is dead.',
      });
      setPhoneFor(null);
      await refresh();
    } catch (err) {
      apiFail("Couldn't change the phone")(err);
    } finally {
      setBusy(false);
    }
  };

  const loadStaffTokens = (a: AccountRow) => {
    const request = ++tokensRequest.current;
    setStaffTokens(null);
    setStaffTokensFailed(null);
    void adminApi
      .accountStaffTokens(a.id)
      .then((r) => { if (request === tokensRequest.current) setStaffTokens(r.tokens); })
      .catch((err: unknown) => {
        if (request !== tokensRequest.current) return;
        setStaffTokens([]);
        setStaffTokensFailed(err instanceof Error ? err.message : 'Unknown error');
      });
  };

  const showSessions = (a: AccountRow) => {
    const request = ++sessionsRequest.current;
    sessionsAccount.current = a.id;
    setSessionsFor(a);
    setSessions(null);
    setSessionsError(null);
    void adminApi
      .accountSessions(a.id)
      .then((r) => { if (request === sessionsRequest.current) setSessions(r.sessions); })
      .catch((err: unknown) => { if (request === sessionsRequest.current) setSessionsError(err instanceof Error ? err.message : 'Unknown error'); });
    loadStaffTokens(a);
    // The deployment's terms do not change between accounts: read once.
    if (!tokenSettings) {
      void adminApi
        .staffTokenSettings()
        .then(setTokenSettings)
        .catch(() => setTokenSettings(null));
    }
  };

  /**
   * End one shift token (SCRUM-512). The api asks `admin:account:update` at
   * the branch the token was minted at, so its refusal is the authority and
   * its message is what the toast shows.
   */
  const endStaffToken = (t: StaffTokenRow, a: AccountRow) =>
    adminApi
      .endStaffToken(t.jti)
      .then((r) => {
        toast({
          title: r.revoked > 0 ? 'Shift token ended' : 'Already ended',
          description:
            r.revoked > 0
              ? `${a.employee?.name ?? a.phone} can no longer unlock station ${shortId(
                  t.stationId,
                )} offline with it. A box that is offline right now honours this from its next pull.`
              : 'That token had already ended or run out, so nothing changed.',
        });
        if (sessionsAccount.current === a.id) loadStaffTokens(a);
      })
      .catch((err: unknown) => {
        apiFail("Couldn't end the shift token")(err);
        void refreshDenials();
      });

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
        if (sessionsAccount.current === a.id) showSessions(a);
      })
      .catch(apiFail("Couldn't sign them out"));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
          <input
            aria-label="Search name or phone"
            value={query}
            onChange={(e) => {
              currentQuery.current = e.target.value;
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

      <AccountsTable accounts={accounts} loading={accountsLoading} error={accountsError} temporaryPasswordBusy={passwordBusy}
        onRetry={() => void refresh()} onPermissions={onPermissions} onApps={onApps}
        onPhone={(account) => { setPhoneFor(account); setNewPhoneValue(account.phone); }}
        onSessions={showSessions} onRevoke={(account) => setPendingAction({ kind: 'revoke-sessions', account })}
        onTemporaryPassword={(account) => setPendingAction({ kind: 'temp-password', account })}
        onStatus={(account, status) => status === 'inactive' ? setPendingAction({ kind: 'deactivate', account }) : void setStatus(account, status)} />

      {afterAccounts}

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
        {!can('admin:audit:read') ? <p className="px-4 py-4 text-sm text-foreground/50">Recent denials are not on your access.</p>
          : denialsLoading ? <p className="px-4 py-4 text-sm text-foreground/50" role="status">Loading recent denials…</p>
          : denialsError ? <p className="px-4 py-4 text-sm text-destructive" role="alert">Recent denials could not be read. {denialsError}</p>
          : denials.length === 0 ? (
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
              aria-label="Full name"
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
                  aria-label="Role"
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
                  aria-label="Branch scope"
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
            <Button
              className="mt-2"
              onClick={() => void create()}
              disabled={busy || !me || !newName.trim() || !newPhone.trim() || (newRole !== 'operator_admin' && serverBranches.length === 0)}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create & send invite
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Change phone (SCRUM-239) */}
      <Dialog open={phoneFor !== null} onOpenChange={(o) => !busy && !o && setPhoneFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change phone — {phoneFor?.employee?.name ?? phoneFor?.phone}</DialogTitle>
            <DialogDescription>
              This is the number they sign in with and the number setup and reset codes are sent
              to. Changing it does not sign them out.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="text-sm font-semibold text-foreground/60">Phone</label>
            <PhoneInput value={newPhoneValue} onChange={setNewPhoneValue} />
            <Button
              className="mt-2"
              onClick={() => void savePhone()}
              disabled={busy || !newPhoneValue.trim() || newPhoneValue.trim() === phoneFor?.phone}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pencil className="w-4 h-4" />}
              Save phone
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
              disabled={pendingAction?.kind === 'temp-password' && passwordBusy}
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

      {/* The temporary password, shown only when asked for (SCRUM-235) */}
      <Dialog
        open={issued !== null}
        onOpenChange={(open) => {
          if (open) return;
          setIssued(null);
          setIssuedVisible(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Temporary password for {issued?.account.employee?.name ?? issued?.account.phone}
            </DialogTitle>
            <DialogDescription>
              It works once, and the till asks them to choose their own before it opens. Read it to
              them rather than leaving this on screen.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <code className="flex-1 rounded-xl bg-foreground/5 px-4 py-3 font-mono text-lg tracking-widest">
              {issuedVisible ? issued?.password : '••••••••'}
            </code>
            <Button variant="secondary" onClick={() => setIssuedVisible((v) => !v)}>
              {issuedVisible ? 'Hide' : 'Show'}
            </Button>
          </div>
          <Button
            className="mt-2"
            onClick={() => {
              setIssued(null);
              setIssuedVisible(false);
            }}
          >
            Done
          </Button>
        </DialogContent>
      </Dialog>

      {/* Sessions this account holds (S2-01a) */}
      <Dialog open={sessionsFor !== null} onOpenChange={(o) => { if (!o) { sessionsAccount.current = null; sessionsRequest.current++; tokensRequest.current++; setSessionsFor(null); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sessions — {sessionsFor?.employee?.name ?? sessionsFor?.phone}</DialogTitle>
            <DialogDescription>
              Devices this account is signed in on. A locked session is still signed in — it unlocks
              with the password.
            </DialogDescription>
          </DialogHeader>
          {sessionsError ? <p className="text-sm text-destructive" role="alert">Sessions could not be read. {sessionsError}</p> : !sessions ? (
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
              {/* Shift tokens (SCRUM-512) */}
              <div className="mt-1 flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-sm font-bold">
                  <Tablet className="w-4 h-4 text-foreground/40" />
                  Shift tokens
                </h3>
                <p className="text-xs text-foreground/50">
                  Issued when they pick a station. With the password, a token unlocks that till from
                  the box's own copy when the internet is down, so end it when a device goes missing.
                  {tokenSettings && ` ${staffTokenSettingsWords(tokenSettings)}`}
                </p>
                {staffTokens === null ? (
                  <div className="flex justify-center py-3">
                    <Loader2 className="w-5 h-5 animate-spin text-foreground/40" />
                  </div>
                ) : staffTokensFailed ? (
                  <p className="text-sm text-destructive">
                    Couldn't load shift tokens: {staffTokensFailed}
                  </p>
                ) : staffTokens.length === 0 ? (
                  <p className="text-sm text-foreground/50">No shift tokens on record.</p>
                ) : (
                  staffTokens.map((t) => {
                    const state = staffTokenRowState(t);
                    return (
                      <div
                        key={t.jti}
                        className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 font-medium">
                            <span title={t.stationId}>
                              Station <span className="font-mono text-xs">{shortId(t.stationId)}</span>
                            </span>
                            <span className="text-xs text-foreground/40" title={t.boxId}>
                              box <span className="font-mono">{shortId(t.boxId)}</span>
                            </span>
                            {state === 'live' ? (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600">
                                live
                              </span>
                            ) : (
                              <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-semibold text-foreground/50">
                                {state === 'ended' ? staffTokenEndedWhy(t.revokedReason) : 'expired'}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-foreground/50 tabular-nums">
                            issued {when(t.issuedAt)} ·{' '}
                            {t.revokedAt ? `ended ${when(t.revokedAt)}` : `expires ${when(t.expiresAt)}`}
                          </div>
                        </div>
                        {state === 'live' && can('admin:account:update') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive h-7 shrink-0"
                            onClick={() => setEndingToken(t)}
                          >
                            End
                          </Button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
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

      {/* Ending one shift token (SCRUM-512) */}
      <AlertDialog open={endingToken !== null} onOpenChange={(o) => !o && setEndingToken(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              End {sessionsFor?.employee?.name ?? sessionsFor?.phone}'s shift token at station{' '}
              {endingToken ? shortId(endingToken.stationId) : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              That till can no longer be unlocked from the box's offline copy with this token. A box
              that is offline right now honours it from its next pull; until then the token's own
              expiry is the limit. Their sessions stay signed in — Sign out everywhere ends those.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (endingToken && sessionsFor) void endStaffToken(endingToken, sessionsFor);
                setEndingToken(null);
              }}
            >
              End shift token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

interface AccountsTableProps {
  accounts: AccountRow[]; loading: boolean; error: string | null; onRetry: () => void;
  temporaryPasswordBusy?: boolean;
  onPhone: (account: AccountRow) => void; onSessions: (account: AccountRow) => void;
  onRevoke: (account: AccountRow) => void; onTemporaryPassword: (account: AccountRow) => void;
  onStatus: (account: AccountRow, status: 'active' | 'inactive') => void;
  onPermissions?: (account: AccountRow) => void; onApps?: (account: AccountRow) => void;
}

export function AccountsTable({ accounts, loading, error, onRetry, onPhone, onSessions, onRevoke, onTemporaryPassword, onStatus, onPermissions, onApps, temporaryPasswordBusy = false }: AccountsTableProps) {
  return (
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
            {loading ? <TableRow><TableCell colSpan={4}><p role="status">Loading accounts…</p></TableCell></TableRow>
              : error ? <TableRow><TableCell colSpan={4}><p role="alert">Accounts could not be read. {error}</p><Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button></TableCell></TableRow>
                : accounts.length === 0 ? <TableRow><TableCell colSpan={4}>No accounts match this search.</TableCell></TableRow>
                  : accounts.map((a) => (
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
                    {onPermissions && <Button variant="ghost" size="sm" title="Effective permissions" onClick={() => onPermissions(a)}>
                      <ShieldCheck className="w-4 h-4" />
                    </Button>}
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Change phone"
                      onClick={() => onPhone(a)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    {onApps && <Button variant="ghost" size="sm" title="Apps" onClick={() => onApps(a)}>
                      <LayoutGrid className="w-4 h-4" />
                    </Button>}
                    <Button variant="ghost" size="sm" title="Sessions" onClick={() => onSessions(a)}>
                      <MonitorSmartphone className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Sign out everywhere"
                      onClick={() => onRevoke(a)}
                    >
                      <LogOut className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Temporary password"
                      disabled={temporaryPasswordBusy}
                      onClick={() => onTemporaryPassword(a)}
                    >
                      <KeyRound className="w-4 h-4" />
                    </Button>
                    {a.status === 'inactive' ? (
                      <Button variant="ghost" size="sm" title="Activate" onClick={() => onStatus(a, 'active')}>
                        <UserCheck className="w-4 h-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Deactivate"
                        className="text-destructive"
                        onClick={() => onStatus(a, 'inactive')}
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

  );
}
