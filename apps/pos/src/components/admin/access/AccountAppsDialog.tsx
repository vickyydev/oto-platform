import { useEffect, useState } from 'react';
import { Link2, Loader2, PlugZap, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { toast } from '@/hooks/use-toast';
import {
  adminApi,
  appAccessPermission,
  appIdentitiesApi,
  APP_KEYS,
  OTO_APP_ROLES,
  type AppIdentity,
  type AppKey,
  type OtoAppRole,
} from '@/api/platform';
import { isMissingRoute } from '@/api/client';

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

/**
 * Any grant of `app:<key>:access` puts the tile on the launcher, whatever its
 * scope: the hand-off route takes the branch from the session, so a
 * branch-scoped grant opens the app for someone while they are working that
 * branch. The scope is printed beside the role instead of being folded into
 * this boolean, because "opens, but only at HKT Central" is the answer an
 * administrator is after. Linking from here always grants operator-wide.
 */
const opensTile = (grants: Grant[]): boolean => grants.length > 0;
const opensEverywhere = (grants: Grant[]): boolean =>
  grants.some((g) => g.scopeType === 'operator');

export function AccountAppsDialog({
  account,
  onClose,
  scopeLabel,
}: {
  account: AppsDialogAccount | null;
  onClose: () => void;
  /** The Login Users panel's scope wording, so both dialogs read the same. */
  scopeLabel: (scopeType: string, scopeId: string | null) => string;
}) {
  const [identities, setIdentities] = useState<AppIdentity[] | null>(null);
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
  const [pendingUnlink, setPendingUnlink] = useState<AppIdentity | null>(null);

  const apiFail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });

  const accountName = account?.employee?.name ?? account?.phone ?? '';

  /**
   * Effective permissions carry the role that granted them, which is the only
   * honest answer to "why can they open it" and the only way to say what an
   * unlink will and will not take away.
   */
  const readGrants = (effective: Array<Grant & { permission: string }>): Record<string, Grant[]> => {
    const byPermission: Record<string, Grant[]> = {};
    for (const p of effective) {
      (byPermission[p.permission] ??= []).push({
        roleName: p.roleName,
        scopeType: p.scopeType,
        scopeId: p.scopeId,
      });
    }
    return byPermission;
  };

  useEffect(() => {
    if (!account) return;
    setIdentities(null);
    setGrants({});
    setListMissing(false);
    setUnavailable([]);
    setLinkFor(null);

    appIdentitiesApi
      .list(account.id)
      .then((r) => setIdentities(r.identities))
      .catch((err: unknown) => {
        setIdentities([]);
        if (isMissingRoute(err)) setListMissing(true);
        else apiFail("Couldn't load the linked apps")(err);
      });

    adminApi
      .accountPermissions(account.id)
      .then((r) => setGrants(readGrants(r.effective)))
      .catch(apiFail("Couldn't load permissions"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the account's id, the only part it reads: a new object for the same account must not reset the dialog and re-read both lists
  }, [account?.id]);

  /** Both halves again: linking and unlinking each move the permission too. */
  const refresh = async (accountId: string) => {
    const [list, perms] = await Promise.all([
      appIdentitiesApi.list(accountId),
      adminApi.accountPermissions(accountId),
    ]);
    setIdentities(list.identities);
    setGrants(readGrants(perms.effective));
  };

  const creating = (app: AppKey): boolean => CREATABLE_APPS.has(app) && linkMode === 'create';

  /** Everything the chosen mode needs is filled in. */
  const linkReady = (app: AppKey): boolean =>
    creating(app) ? appEmail.trim().length > 0 : externalUserId.trim().length > 0;

  const openLinkForm = (app: AppKey) => {
    setLinkFor(app);
    setExternalUserId('');
    setAppEmail('');
    setAppFullName('');
    setAppRole('staff');
    // Creating is the common case: most people being provisioned are new to
    // the app. Someone who is already in it switches.
    setLinkMode(CREATABLE_APPS.has(app) ? 'create' : 'existing');
  };

  const link = async (app: AppKey) => {
    if (!account || busy || !linkReady(app)) return;
    const accountId = account.id;
    const id = externalUserId.trim();
    const makeUser = creating(app);
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
            }
          : { accountId, externalUserId: id },
      );
      setLinkFor(null);
      setExternalUserId('');
      toast({
        title: `${APP_NAMES[app]} linked`,
        description: makeUser
          ? `${APP_NAMES[app]} now has a user for ${accountName} (${result.externalUserId}), and they open it from the launcher with no second password.`
          : `${accountName} opens ${APP_NAMES[app]} from the launcher as ${id}, with no second password.`,
      });
    } catch (err) {
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

  const unlink = async (identity: AppIdentity) => {
    if (!account || busy) return;
    const accountId = account.id;
    const name = APP_NAMES[identity.app];
    setBusy(true);
    try {
      const { accessRevoked } = await appIdentitiesApi.unlink(identity.app, accountId);
      // The API withdraws only the access the link itself granted, so a false
      // here is not "nothing happened": it means their access came from
      // somewhere else, and the refreshed row is the only place that can say
      // where.
      toast({
        title: `${name} unlinked`,
        description: accessRevoked
          ? `${name} no longer knows ${accountName}, and its tile is off their launcher.`
          : `${name} no longer knows ${accountName}. Their access did not come from this link — the row shows what they still hold.`,
      });
    } catch (err) {
      if (isMissingRoute(err)) setUnavailable((u) => (u.includes(identity.app) ? u : [...u, identity.app]));
      else apiFail(`Couldn't unlink ${name}`)(err);
    } finally {
      setBusy(false);
    }
    void refresh(accountId).catch(() => undefined);
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

          {identities === null ? (
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
                  <div key={app} className="rounded-lg border border-foreground/10 px-3 py-2.5 text-sm">
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
                    </dl>

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

                        <div className="mt-1 flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => void link(app)}
                            disabled={busy || !linkReady(app)}
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
                              launcher is the only way in. Which branches they cover is set inside{' '}
                              {APP_NAMES[app]}.
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
