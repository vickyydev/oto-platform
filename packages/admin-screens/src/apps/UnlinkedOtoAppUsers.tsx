import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Loader2, Search, UserRoundX } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { toast } from '../hooks/use-toast';
import {
  createAppIdentitiesApi,
  OTO_APP_ROLES,
  type UnlinkedOtoAppUser,
  type UnlinkedOtoAppUsers as UnlinkedList,
  isMissingRoute,
} from '../api/app-identities';
import { createAccountsApi } from '../api/accounts';
import type { AdminApi } from '../api/admin-api';

/**
 * S2-17b round 1 — the OTO App's users with no suite sign-in (plan section 4,
 * Q6). UI addition in the Login Users design language.
 *
 * With the app's own password sign-in off, somebody made in the OTO App's
 * Users screen has a password nothing accepts and no platform account behind
 * them: there is no way in for them at all, and nothing on this side said so.
 * This lists them, and Link points the existing claim-by-id at one — the same
 * request the Apps dialog's "Already has a user" sends, so the tile and the
 * user arrive together and the audit row is the one every link writes.
 *
 * The app's own screens are not touched (Q5): a person is still created there
 * or here exactly as before. This only closes the gap between the two.
 */
type AccountOption = {
  id: string;
  phone: string;
  status: string;
  employee: { id: string; name: string } | null;
};

/** The app's six by name; any other word the app's database holds, as it is. */
const roleLabel = (role: UnlinkedOtoAppUser['role']): string =>
  OTO_APP_ROLES.find((r) => r.value === role)?.label ?? (role === 'advisor' ? 'Advisor' : role);

const branchLine = (u: UnlinkedOtoAppUser): string =>
  u.allBranches
    ? 'Every branch'
    : u.branches.length > 0
      ? u.branches.map((b) => b.name.trim()).join(', ')
      : 'No branch yet';

export function UnlinkedOtoAppUsers({ api, canLink, onLinked }: { api: AdminApi; canLink: boolean; onLinked?: () => void }) {
  const appIdentitiesApi = useMemo(() => createAppIdentitiesApi(api), [api]);
  const adminApi = useMemo(() => createAccountsApi(api), [api]);
  const mayLink = canLink;
  const [list, setList] = useState<UnlinkedList | null>(null);
  const [missing, setMissing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [linkFor, setLinkFor] = useState<UnlinkedOtoAppUser | null>(null);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<AccountOption[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRequest = useRef<object | null>(null);
  const searchRequest = useRef<object | null>(null);
  const selectedPerson = useRef<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!mounted.current) return;
    const request = {};
    listRequest.current = request;
    setList(null); setMissing(false); setListError(null);
    try {
      const answer = await appIdentitiesApi.unlinkedOtoAppUsers();
      if (listRequest.current === request) setList(answer);
    } catch (error) {
      if (listRequest.current !== request) return;
      if (isMissingRoute(error)) setMissing(true);
      else setListError(error instanceof Error ? error.message : 'Unknown error');
    }
  }, [appIdentitiesApi]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false; listRequest.current = null; searchRequest.current = null; selectedPerson.current = null;
    };
  }, [load]);

  const search = (q: string) => {
    setQuery(q);
    setChosen(null); setOptions(null); setSearchError(null);
    const request = {};
    const personId = selectedPerson.current;
    searchRequest.current = request;
    void adminApi
      .accounts(q || undefined)
      .then((r) => { if (searchRequest.current === request && selectedPerson.current === personId) setOptions(r.accounts); })
      .catch((error: unknown) => {
        if (searchRequest.current === request && selectedPerson.current === personId) {
          setSearchError(error instanceof Error ? error.message : 'Unknown error');
        }
      });
  };

  const closeLink = () => {
    selectedPerson.current = null; searchRequest.current = null;
    setLinkFor(null); setChosen(null);
  };

  const openLink = (u: UnlinkedOtoAppUser) => {
    setLinkFor(u);
    selectedPerson.current = u.id;
    setChosen(null);
    setOptions(null);
    // Their phone in the app is the likeliest way to find the same person
    // here: both sides keep it in E.164.
    search(u.phoneE164 ?? '');
  };

  const link = async () => {
    if (!mayLink || !linkFor || !chosen || busy || searchError) return;
    const person = linkFor;
    const target = options?.find((a) => a.id === chosen);
    if (!target) return;
    setBusy(true);
    try {
      await appIdentitiesApi.link('oto_app', { accountId: chosen, externalUserId: person.id });
      if (selectedPerson.current !== person.id) return;
      toast({
        title: 'OTO App linked',
        description: `${target?.employee?.name ?? target?.phone ?? 'That account'} now opens the OTO App from the launcher as ${person.fullName}, with no second password.`,
      });
      closeLink();
      onLinked?.();
    } catch (err) {
      if (selectedPerson.current !== person.id) return;
      toast({
        title: "Couldn't link the OTO App",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      if (mounted.current) setBusy(false);
      // Linked, or refused because somebody moved first: either way the list
      // on screen is out of date.
      void load();
    }
  };

  // Nothing to say on a deployment without the route or without the app.
  if (missing || (list && !list.installed)) return null;

  return (
    <div className="rounded-2xl border border-foreground/10">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-foreground/10">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <UserRoundX className="w-4 h-4 text-amber-500" />
          OTO App users with no suite sign-in
        </h3>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {listError ? <p role="alert" className="px-4 py-4 text-sm text-destructive">OTO App users could not be read. {listError}</p> : list === null ? (
        <div className="flex justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-foreground/40" />
        </div>
      ) : !list.anchored ? (
        <p className="px-4 py-4 text-sm text-foreground/50">
          None of this operator's branches is joined to a branch of the OTO App yet, so whose users
          they are cannot be told. Reconcile the branch lists on the Console's Branches page first.
        </p>
      ) : list.users.length === 0 ? (
        <p className="px-4 py-4 text-sm text-foreground/50">
          Everyone in the OTO App has a suite sign-in. Somebody added in the app's own Users screen
          appears here until they are linked.
        </p>
      ) : (
        <>
          <p className="px-4 pt-3 text-xs text-foreground/50">
            Made in the OTO App's own Users screen, so the launcher cannot open the app as them yet.
            Link each to the staff account that is the same person.
          </p>
          <ul className="divide-y divide-foreground/10">
            {list.users.map((u) => (
              <li key={u.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    <span className="truncate">{u.fullName}</span>
                    <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-semibold text-foreground/60 shrink-0">
                      {roleLabel(u.role)}
                    </span>
                    {!u.isActive && (
                      <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-semibold text-foreground/50 shrink-0">
                        switched off in the app
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-foreground/50">
                    {u.email}
                    {u.phoneE164 ? ` · ${u.phoneE164}` : ''} · {branchLine(u)}
                  </div>
                  <div className="truncate font-mono text-[11px] text-foreground/40">{u.id}</div>
                </div>
                {mayLink && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openLink(u)}
                  >
                    <Link2 className="w-4 h-4" />
                    Link
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={linkFor !== null} onOpenChange={(o) => !o && !busy && closeLink()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Link {linkFor?.fullName} to a sign-in</DialogTitle>
            <DialogDescription>
              Pick the staff account that is this person. They then open the OTO App from the
              launcher as this user, with no second password. Invite a sign-in account in Accounts
              first, then link it here.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
              <input
                value={query}
                onChange={(e) => search(e.target.value)}
                placeholder="Search name or phone…"
                aria-label="Search staff accounts"
                className="w-full h-10 rounded-lg border border-input bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {searchError ? <p role="alert" className="py-2 text-sm text-destructive">Staff accounts could not be read. {searchError}</p> : options === null ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-foreground/40" />
                </div>
              ) : options.length === 0 ? (
                <p className="py-2 text-sm text-foreground/50">No staff account matches.</p>
              ) : (
                options.map((a) => (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                      chosen === a.id ? 'border-ring bg-foreground/[0.04]' : 'border-foreground/10'
                    }`}
                  >
                    <input
                      type="radio"
                      name="link-account"
                      checked={chosen === a.id}
                      onChange={() => setChosen(a.id)}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {a.employee?.name ?? '—'}
                    </span>
                    <span className="tabular-nums text-foreground/60">{a.phone}</span>
                    <span className="text-xs text-foreground/40">{a.status}</span>
                  </label>
                ))
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void link()} disabled={busy || !mayLink || !chosen || !options?.some(account => account.id === chosen) || searchError !== null}>
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Link2 className="w-4 h-4" />
                )}
                Link OTO App
              </Button>
              <Button variant="ghost" size="sm" onClick={closeLink} disabled={busy}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-foreground/40">
              Linking grants <span className="font-mono">app:oto_app:access</span> as well, so the
              tile and the user arrive together. Their role and branches stay as the OTO App has
              them.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
