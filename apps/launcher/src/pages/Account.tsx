import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import {
  ArrowLeft,
  Loader2,
  LogOut,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { SuiteHeader } from '@/components/SuiteHeader';
import { Button } from '@/components/ui/button';
import { accountApi, type AuditEntry } from '@/api/platform';
import { findApp } from '@/suite/apps';
import { clearOpened, openedApps } from '@/suite/handoff';
import { useSession, displayName } from '@/auth/SessionContext';
import { formatWhen } from '@/lib/time';

interface SessionRow {
  id: string;
  branchId: string | null;
  lockedAt: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
}

/** Why a hand-off was turned away, in words rather than a code. */
const REJECTION_REASONS: Record<string, string> = {
  replayed: 'The link had already been used',
  expired: 'It was opened too long after it was issued',
  audience: 'It was meant for a different app',
  origin: 'It arrived from an unexpected address',
  revoked: 'The session had already ended',
};

function readString(after: Record<string, unknown> | null, key: string): string | null {
  const value = after?.[key];
  return typeof value === 'string' ? value : null;
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-card/80 backdrop-blur-sm shadow-sm p-5 sm:p-6">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Account() {
  const { me, has, signOut, locked } = useSession();
  const timezone = me?.branch?.timezone;
  const accountId = me?.account.id;

  const canSeeSessions = has('admin:account:read');
  const canRevokeSessions = has('admin:account:update');
  const canSeeAudit = has('admin:audit:read');

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [rejections, setRejections] = useState<AuditEntry[] | null>(null);
  const [revoking, setRevoking] = useState(false);
  const opened = openedApps();

  const loadSessions = useCallback(async () => {
    if (!accountId || !canSeeSessions) return;
    try {
      const { sessions: rows } = await accountApi.sessions(accountId);
      setSessions(rows);
    } catch {
      // The panel simply does not appear; nothing here is worth an error page.
      setSessions(null);
    }
  }, [accountId, canSeeSessions]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!accountId || !canSeeAudit) return;
    let cancelled = false;
    void accountApi
      .handoffRejections(accountId)
      .then(({ entries }) => {
        if (!cancelled) setRejections(entries);
      })
      .catch(() => {
        if (!cancelled) setRejections(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, canSeeAudit]);

  const revokeEverywhere = async () => {
    if (!accountId || revoking) return;
    setRevoking(true);
    try {
      await accountApi.revokeSessions(accountId);
      clearOpened();
      // The session this page is holding is one of the ones just ended.
      await signOut();
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <Backdrop />
      <SuiteHeader />

      <main className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-foreground/50 hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to the suite
        </Link>

        <h1 className="mt-4 text-3xl font-black tracking-tight">Your account</h1>
        <p className="mt-2 text-base text-foreground/60">
          One sign-in, shared by every app you open from here.
        </p>

        <div className="mt-8 flex flex-col gap-4">
          <Panel title="You">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <UserRound className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-foreground/45">
                    Name
                  </dt>
                  <dd className="text-sm font-bold truncate">{displayName(me)}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-foreground/45">
                    Signs in with
                  </dt>
                  <dd className="text-sm font-bold truncate">{me?.account.phone}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <MonitorSmartphone className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-foreground/45">
                    Branch
                  </dt>
                  <dd className="text-sm font-bold truncate">
                    {me?.branch ? me.branch.name : 'None on this session'}
                  </dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  {locked ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                </span>
                <div className="min-w-0">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-foreground/45">
                    Session
                  </dt>
                  <dd className="text-sm font-bold truncate">{locked ? 'Locked' : 'Open'}</dd>
                </div>
              </div>
            </dl>
          </Panel>

          <Panel
            title="Apps opened from this device"
            description="Each one holds its own cookie against this same sign-in. Ending the session ends all of them."
          >
            {opened.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None yet in this sitting. Open one from the suite and it appears here.
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {opened.map((entry) => {
                  const app = findApp(entry.key);
                  const Icon = app?.icon;
                  return (
                    <li key={entry.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        {Icon ? <Icon className="w-4 h-4" /> : null}
                      </span>
                      <span className="text-sm font-semibold flex-1 truncate">
                        {app?.name ?? entry.key}
                      </span>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {formatWhen(entry.at, timezone)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          {canSeeSessions && sessions && sessions.length > 0 && (
            <Panel
              title="Sessions on this account"
              description="Every device where this account is signed in right now."
            >
              <ul className="flex flex-col divide-y">
                {sessions.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                    <span className="text-sm font-semibold">
                      {row.lockedAt ? 'Locked' : 'Active'}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      last used {formatWhen(row.lastSeenAt, timezone)}
                    </span>
                    <span className="text-sm text-muted-foreground ml-auto">
                      ends {formatWhen(row.expiresAt, timezone)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel
            title="Recent rejections"
            description="Times an app refused to let this sign-in through."
          >
            {!canSeeAudit ? (
              <p className="text-sm text-muted-foreground">
                A manager can see these on your account in the console.
              </p>
            ) : rejections === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Looking…
              </p>
            ) : rejections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None. Every app you opened let you straight in.
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {rejections.map((entry) => {
                  const reason = readString(entry.after, 'reason');
                  const appKey = readString(entry.after, 'app');
                  const app = appKey ? findApp(appKey) : undefined;
                  return (
                    <li key={entry.id} className="py-2.5 first:pt-0 last:pb-0">
                      <p className="text-sm font-semibold">
                        {app?.name ?? appKey ?? 'An app'} —{' '}
                        {(reason && REJECTION_REASONS[reason]) ?? reason ?? 'Refused'}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatWhen(entry.createdAt, timezone)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel
            title="Ending the session"
            description="Signing out here ends this sign-in everywhere it was carried."
          >
            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => {
                  clearOpened();
                  void signOut();
                }}
              >
                <LogOut className="w-4 h-4" /> Sign out
              </Button>
              {canRevokeSessions && (
                <Button
                  variant="destructive"
                  className="gap-2"
                  disabled={revoking}
                  onClick={() => void revokeEverywhere()}
                >
                  {revoking ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
                  Sign out everywhere
                </Button>
              )}
            </div>
            {!canRevokeSessions && (
              <p className="mt-3 text-sm text-muted-foreground">
                To end a session on a device you no longer have, ask a manager to sign your account
                out everywhere.
              </p>
            )}
          </Panel>
        </div>
      </main>
    </div>
  );
}
