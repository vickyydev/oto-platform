import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Loader2, PlugZap, Unlink } from 'lucide-react';
import { Button } from '../ui/button';
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
import { toast } from '../hooks/use-toast';
import {
  appAccessPermission,
  createAppIdentitiesApi,
  APP_KEYS,
  OTO_APP_ROLES,
  type AppIdentity,
  type AppKey,
  type OtoAppRole,
  isMissingRoute,
} from '../api/app-identities';
import { createRolesApi } from '../api/roles';
import type { AdminApi } from '../api/admin-api';

/**
 * S2-17a — the Apps surface of an account: which of the suite's apps it can
 * open, and the user each of those apps knows it as.
 *
 * Granting an app is two things at once, and the panel is built to show both.
 * The `app:<key>:access` permission decides whether the tile appears on the
 * launcher; the identity inside the app decides whether the tile opens onto
 * anything. Either half alone is a broken grant — a permission with no identity
 * sends someone to a refusal at the door, an identity with no permission is a
 * user in that app nobody can reach — so every row states both rather than
 * collapsing them into one "enabled" switch.
 *
 * It sits beside the Permissions and Sessions dialogs of LoginUsersPanel, which
 * are the account's other per-account surfaces.
 */
export interface AppsDialogAccount {
  id: string;
  phone: string;
  employee: { id: string; name: string } | null;
}

/** So a row reads "Lucky Wheel" and not "booth". */
const APP_NAMES: Record<AppKey, string> = {
  pos: 'POS',
  console: 'Console',
  oto_app: 'OTO App',
  radar: 'Radar',
  booth: 'Lucky Wheel',
  inbox: 'Inbox',
};

/**
 * The apps that are this platform. The till and the console read the account
 * out of this database, so there is no second user to link — the access half is
 * the whole story, and a link row here is one nothing would ever read. The
 * apps taken in from elsewhere keep their own user tables and do need one.
 */
const NATIVE_APPS = new Set<AppKey>(['pos', 'console']);

/**
 * The apps whose user this console can create rather than only claim. The OTO
 * App keeps its own user table, but that table is a schema of this same
 * database, so provisioning writes it in one transaction with the account —
 * which is why an administrator here does not have to go and make the person a
 * second time before coming back with an id. Every other app is still somewhere
 * else, so its id is something they arrive holding.
 */
const CREATABLE_APPS = new Set<AppKey>(['oto_app']);

/** Matches the id input beside it, so the two rows of the form line up. */
const FIELD =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

type Grant = { roleName: string; scopeType: string; scopeId: string | null };

const readGrants = (effective: Array<Grant & { permission: string }>): Record<string, Grant[]> => {
  const byPermission: Record<string, Grant[]> = {};
  for (const permission of effective) {
    (byPermission[permission.permission] ??= []).push({ roleName: permission.roleName, scopeType: permission.scopeType, scopeId: permission.scopeId });
  }
  return byPermission;
};

/**
 * Any grant of `app:<key>:access` puts the tile on the launcher, whatever its
 * scope: the hand-off route takes the branch from the session, so a
 * branch-scoped grant opens the app for someone while they are working that
 * branch. The scope is printed beside the role instead of being folded into
 * this boolean, because "opens, but only at HKT Central" is the answer an
 * administrator is after. Linking from here grants operator-wide unless the
 * OTO App's branch choice narrows it (SCRUM-469).
 */
const opensTile = (grants: Grant[]): boolean => grants.length > 0;
const opensEverywhere = (grants: Grant[]): boolean =>
  grants.some((g) => g.scopeType === 'operator');

/**
 * The apps whose access can be scoped to chosen branches from here
 * (SCRUM-469). The OTO App's branch access is written by the same provisioning
 * service, so the choice reaches what the person sees inside it as well as
 * where the tile opens.
 */
const BRANCH_SCOPED_APPS = new Set<AppKey>(['oto_app']);

/** A branch the picker offers: the platform's own id and name. */
export interface AppsDialogBranch {
  id: string;
  name: string;
}

/** `null` is all branches; a list is exactly those. */
type BranchChoice = string[] | null;

export function AccountAppsDialog({
  account,
  onClose,
  scopeLabel,
  branches,
  api,
  canAssign,
}: {
  api: AdminApi;
  canAssign: boolean;
  account: AppsDialogAccount | null;
  onClose: () => void;
  /** The Login Users panel's scope wording, so both dialogs read the same. */
  scopeLabel: (scopeType: string, scopeId: string | null) => string;
  /** The operator's open branches, for the OTO App branch choice. */
  branches: AppsDialogBranch[];
}) {
  const appIdentitiesApi = useMemo(() => createAppIdentitiesApi(api), [api]);
  const adminApi = useMemo(() => createRolesApi(api), [api]);
  const [identities, setIdentities] = useState<AppIdentity[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [grants, setGrants] = useState<Record<string, Grant[]>>({});
  const [listMissing, setListMissing] = useState(false);
  /** Per app, because the provisioning routes arrive one app at a time. */
  const [unavailable, setUnavailable] = useState<AppKey[]>([]);
  const [busy, setBusy] = useState(false);

  const [linkFor, setLinkFor] = useState<AppKey | null>(null);
  const [externalUserId, setExternalUserId] = useState('');
  /** Make the person in that app, or claim the user it already has. */
  const [linkMode, setLinkMode] = useState<'create' | 'existing'>('create');
  const [appEmail, setAppEmail] = useState('');
  const [appFullName, setAppFullName] = useState('');
  const [appRole, setAppRole] = useState<OtoAppRole>('staff');
  /** The branch choice in the link form (SCRUM-469). All branches by default. */
  const [linkBranches, setLinkBranches] = useState<BranchChoice>(null);
  /** The app whose branches are being changed on an existing link, and the draft. */
  const [editBranchesFor, setEditBranchesFor] = useState<AppKey | null>(null);
  const [editBranches, setEditBranches] = useState<BranchChoice>(null);
  const [pendingUnlink, setPendingUnlink] = useState<AppIdentity | null>(null);
  const selectedAccount = useRef<string | null>(null);
  const readRequest = useRef<object | null>(null);
  selectedAccount.current = account?.id ?? null;

  const apiFail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });

  const accountName = account?.employee?.name ?? account?.phone ?? '';

  /** Read both halves together; a late result never belongs to the next account. */
  const refresh = useCallback(async (accountId: string) => {
    if (selectedAccount.current !== accountId) return null;
    const request = {};
    readRequest.current = request;
    setIdentities(null); setLoadedFor(null); setReadError(null); setListMissing(false);
    try {
      const [list, permissions] = await Promise.all([
        appIdentitiesApi.list(accountId), adminApi.accountPermissions(accountId),
      ]);
      const nextGrants = readGrants(permissions.effective);
      if (selectedAccount.current === accountId && readRequest.current === request) {
        setIdentities(list.identities); setGrants(nextGrants); setLoadedFor(accountId);
      }
      return { identities: list.identities, grants: nextGrants };
    } catch (error) {
      if (selectedAccount.current === accountId && readRequest.current === request) {
        setIdentities([]); setLoadedFor(accountId);
        if (isMissingRoute(error)) setListMissing(true);
        else setReadError(error instanceof Error ? error.message : 'Unknown error');
      }
      throw error;
    }
  }, [adminApi, appIdentitiesApi]);

  useEffect(() => {
    const accountId = account?.id;
    setUnavailable([]);
    setLinkFor(null);
    setEditBranchesFor(null);
    setPendingUnlink(null);
    if (accountId) void refresh(accountId).catch(() => undefined);
    return () => { readRequest.current = null; };
  }, [account?.id, refresh]);

  const creating = (app: AppKey): boolean => CREATABLE_APPS.has(app) && linkMode === 'create';

  /** A list with nothing ticked is not a choice yet; all branches always is. */
  const choiceReady = (choice: BranchChoice): boolean => choice === null || choice.length > 0;

  /** Everything the chosen mode needs is filled in. */
  const linkReady = (app: AppKey): boolean =>
    (creating(app) ? appEmail.trim().length > 0 : externalUserId.trim().length > 0) &&
    (!BRANCH_SCOPED_APPS.has(app) || choiceReady(linkBranches));

  const branchName = (id: string): string => branches.find((b) => b.id === id)?.name ?? 'a closed branch';

  const openLinkForm = (app: AppKey) => {
    setLinkFor(app);
    setExternalUserId('');
    setAppEmail('');
    setAppFullName('');
    setAppRole('staff');
    setLinkBranches(null);
    // Creating is the common case: most people being provisioned are new to
    // the app. Someone who is already in it switches.
    setLinkMode(CREATABLE_APPS.has(app) ? 'create' : 'existing');
  };

  const link = async (app: AppKey) => {
    if (!account || !canAssign || busy || !linkReady(app)) return;
    const accountId = account.id;
    const id = externalUserId.trim();
    const makeUser = creating(app);
    // Sent only when narrowed: all branches is what the api does without one.
    const scoped = BRANCH_SCOPED_APPS.has(app) && linkBranches ? { branchIds: linkBranches } : {};
    setBusy(true);
    try {
      const result = await appIdentitiesApi.link(
        app,
        makeUser
          ? {
              accountId,
              otoApp: {
                email: appEmail.trim(),
                fullName: appFullName.trim() || undefined,
                role: appRole,
              },
              ...scoped,
            }
          : { accountId, externalUserId: id, ...scoped },
      );
      if (selectedAccount.current !== accountId) return;
      setLinkFor(null); setExternalUserId('');
      toast({
        title: `${APP_NAMES[app]} linked`,
        description: makeUser
          ? `${APP_NAMES[app]} now has a user for ${accountName} (${result.externalUserId}), and they open it from the launcher with no second password.`
          : `${accountName} opens ${APP_NAMES[app]} from the launcher as ${id}, with no second password.`,
      });
    } catch (err) {
      if (selectedAccount.current !== accountId) return;
      if (isMissingRoute(err)) setUnavailable((u) => (u.includes(app) ? u : [...u, app]));
      else apiFail(`Couldn't link ${APP_NAMES[app]}`)(err);
    } finally {
      setBusy(false);
    }
    // Either way the rows on screen are out of date: the link landed, or the
    // refusal ("already linked", "that user is taken") says someone else has
    // moved since this dialog opened.
    void refresh(accountId).catch(() => undefined);
  };

  const openBranchEdit = (identity: AppIdentity) => {
    setEditBranchesFor(identity.app);
    setEditBranches(identity.branches?.accessBranches ?? null);
  };

  /** SCRUM-469 — change the branches an existing OTO App link covers. */
  const saveBranches = async () => {
    if (!account || !canAssign || busy || editBranchesFor !== 'oto_app' || !choiceReady(editBranches)) return;
    const accountId = account.id;
    setBusy(true);
    try {
      await appIdentitiesApi.setOtoAppBranches(accountId, editBranches);
      if (selectedAccount.current !== accountId) return;
      setEditBranchesFor(null);
      toast({
        title: 'OTO App branches changed',
        description:
          editBranches === null
            ? `${accountName} now covers all branches.`
            : `${accountName} now covers ${editBranches.map(branchName).join(', ')}.`,
      });
    } catch (err) {
      if (selectedAccount.current !== accountId) return;
      apiFail("Couldn't change the branches")(err);
    } finally {
      setBusy(false);
    }
    void refresh(accountId).catch(() => undefined);
  };

  const unlink = async (identity: AppIdentity) => {
    if (!account || !canAssign || busy) return;
    const accountId = account.id;
    const name = APP_NAMES[identity.app];
    setBusy(true);
    let removed = false;
    try {
      await appIdentitiesApi.unlink(identity.app, accountId);
      removed = true;
      const current = await refresh(accountId);
      if (!current || selectedAccount.current !== accountId) return;
      const stillGranted = opensTile(current.grants[appAccessPermission(identity.app)] ?? []);
      toast({
        title: `${name} unlinked`,
        description: stillGranted
          ? `${name} no longer knows ${accountName}. Their other roles still grant access — the row shows what they still hold.`
          : `${name} no longer knows ${accountName}, and its tile is off their launcher.`,
      });
    } catch (err) {
      if (selectedAccount.current !== accountId) return;
      if (removed) toast({ title: `${name} unlinked`, description: 'The link was removed, but current access could not be read. Try again to check the remaining roles.', variant: 'destructive' });
      else if (isMissingRoute(err)) setUnavailable((u) => (u.includes(identity.app) ? u : [...u, identity.app]));
      else apiFail(`Couldn't unlink ${name}`)(err);
    } finally {
      setBusy(false);
    }
    if (!removed) void refresh(accountId).catch(() => undefined);
  };

  return (
    <>
      <Dialog open={account !== null} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Apps — {accountName}</DialogTitle>
            <DialogDescription>
              Which apps this account can open, and the user each app knows them as. Both halves are
              needed: the permission puts the tile on their launcher, the identity is who the app
              signs them in as.
            </DialogDescription>
          </DialogHeader>

          {identities === null || loadedFor !== account?.id ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-foreground/40" />
            </div>
          ) : listMissing ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-foreground/15 px-6 py-10 text-center">
              <PlugZap className="w-5 h-5 text-foreground/40" />
              <p className="text-sm font-semibold">App linking is not on this deployment yet</p>
              <p className="max-w-sm text-sm text-foreground/50">
                The panel fills in as soon as the provisioning routes are deployed here. Until then,
                app access is whatever the roles under Permissions grant.
              </p>
            </div>
          ) : readError ? (
            <div className="flex flex-col gap-2 rounded-lg border border-foreground/10 p-3">
              <p role="alert" className="text-sm text-destructive">Apps could not be read. {readError}</p>
              <Button variant="ghost" size="sm" onClick={() => account && void refresh(account.id).catch(() => undefined)}>Try again</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-h-[55vh] overflow-y-auto">
              {APP_KEYS.map((app) => {
                const identity = identities.find((i) => i.app === app) ?? null;
                const appGrants = grants[appAccessPermission(app)] ?? [];
                const granted = opensTile(appGrants);
                const routeMissing = unavailable.includes(app);
                /** No identity to link, and none missing either. */
                const native = NATIVE_APPS.has(app) && identity === null;

                return (
                  <div key={app} role="group" aria-label={`${APP_NAMES[app]} access`} className="rounded-lg border border-foreground/10 px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          {APP_NAMES[app]}
                          <StateMark identity={identity} granted={granted} native={native} />
                        </div>
                        <p className="mt-0.5 text-xs text-foreground/50">
                          {stateLine(APP_NAMES[app], identity !== null, granted, native)}
                        </p>
                      </div>
                      {identity ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive shrink-0"
                          onClick={() => setPendingUnlink(identity)}
                          disabled={busy || !canAssign}
                        >
                          <Unlink className="w-4 h-4" />
                          Unlink
                        </Button>
                      ) : native || linkFor === app ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => openLinkForm(app)}
                          disabled={busy || !canAssign}
                        >
                          <Link2 className="w-4 h-4" />
                          {CREATABLE_APPS.has(app) ? 'Give them access' : 'Link a user'}
                        </Button>
                      )}
                    </div>

                    {/* The two halves, spelled out, because this is the point. */}
                    <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-foreground/40">Access</dt>
                      <dd className="text-foreground/60">
                        {appGrants.length > 0 ? (
                          <>
                            {appGrants
                              .map((g) => `${g.roleName} (${scopeLabel(g.scopeType, g.scopeId)})`)
                              .join(', ')}
                            {!opensEverywhere(appGrants) &&
                              ' — only while they are working that branch'}
                          </>
                        ) : (
                          <>
                            no role carries{' '}
                            <span className="font-mono">{appAccessPermission(app)}</span>
                          </>
                        )}
                      </dd>
                      <dt className="text-foreground/40">Identity</dt>
                      <dd className="text-foreground/60">
                        {identity ? (
                          <>
                            <span className="font-mono">{identity.externalUserId}</span>
                            <span className="text-foreground/40">
                              {' '}
                              · linked {when(identity.createdAt)}
                            </span>
                          </>
                        ) : native ? (
                          'this account — no separate user'
                        ) : (
                          `none in ${APP_NAMES[app]}`
                        )}
                      </dd>
                      {identity && BRANCH_SCOPED_APPS.has(app) && identity.branches && (
                        <>
                          <dt className="text-foreground/40">Branches</dt>
                          <dd className="flex items-start justify-between gap-2 text-foreground/60">
                            <span>
                              {identity.branches.accessBranches === null
                                ? 'all branches'
                                : identity.branches.accessBranches.map(branchName).join(', ')}
                              <span className="text-foreground/40">
                                {' '}
                                · in {APP_NAMES[app]}:{' '}
                                {appBranchesLine(identity.branches.appBranches)}
                              </span>
                            </span>
                            {editBranchesFor !== app && (
                              <button
                                type="button"
                                className="shrink-0 font-semibold text-foreground/70 hover:underline disabled:opacity-50"
                                onClick={() => openBranchEdit(identity)}
                                disabled={busy || !canAssign}
                              >
                                Change
                              </button>
                            )}
                          </dd>
                        </>
                      )}
                    </dl>

                    {identity && editBranchesFor === app && (
                      <div className="mt-3 flex flex-col gap-2 rounded-lg bg-foreground/[0.03] p-3">
                        <BranchPicker
                          appName={APP_NAMES[app]}
                          branches={branches}
                          value={editBranches}
                          onChange={setEditBranches}
                          disabled={busy || !canAssign}
                        />
                        <div className="mt-1 flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => void saveBranches()}
                            disabled={busy || !canAssign || !choiceReady(editBranches)}
                          >
                            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                            Save branches
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditBranchesFor(null)}
                            disabled={busy || !canAssign}
                          >
                            Cancel
                          </Button>
                        </div>
                        <p className="text-xs text-foreground/40">
                          Replaces their branch access in {APP_NAMES[app]}, including any set there
                          since, and moves where the tile opens with it.
                        </p>
                      </div>
                    )}

                    {routeMissing && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-foreground/50">
                        <PlugZap className="w-3.5 h-3.5 shrink-0 translate-y-px text-foreground/40" />
                        Linking {APP_NAMES[app]} users is not on this deployment yet.
                      </p>
                    )}

                    {linkFor === app && (
                      <div className="mt-3 flex flex-col gap-2 rounded-lg bg-foreground/[0.03] p-3">
                        {CREATABLE_APPS.has(app) && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant={linkMode === 'create' ? 'secondary' : 'ghost'}
                              size="sm"
                              onClick={() => setLinkMode('create')}
                              disabled={busy}
                            >
                              New to {APP_NAMES[app]}
                            </Button>
                            <Button
                              variant={linkMode === 'existing' ? 'secondary' : 'ghost'}
                              size="sm"
                              onClick={() => setLinkMode('existing')}
                              disabled={busy}
                            >
                              Already has a user
                            </Button>
                          </div>
                        )}

                        {creating(app) ? (
                          <>
                            <label className="text-xs font-semibold text-foreground/60">
                              Their email in {APP_NAMES[app]}
                            </label>
                            <input
                              type="email"
                              value={appEmail}
                              onChange={(e) => setAppEmail(e.target.value)}
                              placeholder="name@otopark.co.th"
                              className={FIELD}
                            />
                            <label className="mt-1 text-xs font-semibold text-foreground/60">
                              Their name
                            </label>
                            <input
                              value={appFullName}
                              onChange={(e) => setAppFullName(e.target.value)}
                              placeholder={accountName}
                              className={FIELD}
                            />
                            <label className="mt-1 text-xs font-semibold text-foreground/60">
                              Their role in {APP_NAMES[app]}
                            </label>
                            <select
                              value={appRole}
                              onChange={(e) => setAppRole(e.target.value as OtoAppRole)}
                              className={FIELD}
                            >
                              {OTO_APP_ROLES.map((r) => (
                                <option key={r.value} value={r.value}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <>
                            <label className="text-xs font-semibold text-foreground/60">
                              Their user id in {APP_NAMES[app]}
                            </label>
                            <input
                              value={externalUserId}
                              onChange={(e) => setExternalUserId(e.target.value)}
                              placeholder="The id that app already knows them by"
                              className={FIELD}
                            />
                          </>
                        )}

                        {BRANCH_SCOPED_APPS.has(app) && (
                          <BranchPicker
                            appName={APP_NAMES[app]}
                            branches={branches}
                            value={linkBranches}
                            onChange={setLinkBranches}
                            disabled={busy}
                            allHint={
                              creating(app)
                                ? `In ${APP_NAMES[app]} they start at their own branch.`
                                : `Their branches in ${APP_NAMES[app]} stay as they are.`
                            }
                            seesEverything={
                              creating(app) && (appRole === 'admin' || appRole === 'global_admin')
                            }
                          />
                        )}

                        <div className="mt-1 flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => void link(app)}
                            disabled={busy || !canAssign || !linkReady(app)}
                          >
                            {busy ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Link2 className="w-4 h-4" />
                            )}
                            {creating(app) ? `Create in ${APP_NAMES[app]}` : `Link ${APP_NAMES[app]}`}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLinkFor(null)}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                        </div>
                        <p className="text-xs text-foreground/40">
                          {creating(app) ? (
                            <>
                              The user is made in {APP_NAMES[app]} with no password of its own — the
                              launcher is the only way in.
                            </>
                          ) : BRANCH_SCOPED_APPS.has(app) ? (
                            <>
                              Their role in {APP_NAMES[app]} stays as it is there. Their branches stay
                              too, unless you choose some above.
                            </>
                          ) : (
                            <>
                              The role in {APP_NAMES[app]} and the branches they cover are set inside{' '}
                              {APP_NAMES[app]}.
                            </>
                          )}{' '}
                          Linking here grants{' '}
                          <span className="font-mono">{appAccessPermission(app)}</span> as well, so the
                          tile and the user arrive together.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingUnlink !== null} onOpenChange={(o) => !o && setPendingUnlink(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unlink {pendingUnlink ? APP_NAMES[pendingUnlink.app] : ''} from {accountName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The app stops knowing them, and the access this link granted goes with it. Access from
              any other role stays: the tile then sits on their launcher and opens onto a refusal.
              The row will say which happened.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy || !canAssign}
              onClick={() => {
                if (pendingUnlink) void unlink(pendingUnlink);
                setPendingUnlink(null);
              }}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Where the app seats them, in words. */
function appBranchesLine(
  app: NonNullable<AppIdentity['branches']>['appBranches'],
): string {
  if (!app) return 'not on this deployment';
  if (app.allBranches) return 'every branch (set there)';
  if (app.branches.length === 0) return 'no branch yet';
  return app.branches.map((b) => b.name).join(', ');
}

/**
 * SCRUM-469 — which branches the access covers: all of them (the default, as
 * every grant was before), or only the ones ticked.
 */
function BranchPicker({
  appName,
  branches,
  value,
  onChange,
  disabled,
  allHint,
  seesEverything,
}: {
  appName: string;
  branches: AppsDialogBranch[];
  value: BranchChoice;
  onChange: (next: BranchChoice) => void;
  disabled: boolean;
  /** What "all branches" means inside the app on this path. */
  allHint?: string;
  /** The role chosen sees every branch in the app whatever is ticked. */
  seesEverything?: boolean;
}) {
  const toggle = (id: string) => {
    const current = value ?? [];
    onChange(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-foreground/60">Branches</span>
      <div className="flex items-center gap-1">
        <Button
          variant={value === null ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onChange(null)}
          disabled={disabled}
        >
          All branches
        </Button>
        <Button
          variant={value !== null ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onChange(value ?? [])}
          disabled={disabled || branches.length === 0}
        >
          Only some
        </Button>
      </div>
      {value === null ? (
        allHint && <p className="text-xs text-foreground/40">{allHint}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {branches.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value.includes(b.id)}
                onChange={() => toggle(b.id)}
                disabled={disabled}
              />
              {b.name}
            </label>
          ))}
          <p className="text-xs text-foreground/40">
            The tile opens only while they are working one of these, and in {appName} they see
            only these.
          </p>
        </div>
      )}
      {seesEverything && (
        <p className="text-xs text-amber-600">
          An Admin or Global admin in {appName} sees every branch there, whatever is chosen here.
        </p>
      )}
    </div>
  );
}

/** The pill, in the status colours the Login Users table already uses. */
function StateMark({
  identity,
  granted,
  native,
}: {
  identity: AppIdentity | null;
  granted: boolean;
  /** An app with no user of its own: access alone decides the state. */
  native: boolean;
}) {
  const opens = granted && (native || identity !== null);
  const half = !opens && (granted || identity !== null);
  const tone = opens
    ? 'bg-emerald-500/15 text-emerald-600'
    : half
      ? 'bg-amber-500/15 text-amber-600'
      : 'bg-foreground/10 text-foreground/50';
  const label = opens
    ? 'opens'
    : granted
      ? 'refused at the door'
      : identity
        ? 'tile hidden'
        : 'not granted';
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>;
}

/** One sentence saying what happens if they open that tile today. */
function stateLine(name: string, linked: boolean, granted: boolean, native: boolean): string {
  if (native)
    return granted
      ? `Opens from the launcher, signed in as this account.`
      : `Not on their launcher — no role carries its access.`;
  if (linked && granted) return 'Opens from the launcher, signed in, with no second password.';
  if (granted)
    return `The tile is on their launcher, but ${name} has no user for them — it refuses them at the door.`;
  if (linked)
    return `${name} has a user for them, but the tile is not on their launcher, so they cannot reach it from here.`;
  return `Not on their launcher, and unknown to ${name}.`;
}
