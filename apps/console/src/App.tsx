import { useEffect, type ReactElement } from 'react';
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { KeyRound, Loader2, ShieldOff } from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { ConsoleLayout } from '@/components/ConsoleLayout';
import { LockedPanel } from '@/components/LockedPanel';
import { SignInPanel } from '@/components/SignInPanel';
import { PermissionRequired } from '@/components/Panel';
import { DEFAULT_SECTION, findSection } from '@/components/consoleSections';
import { SessionProvider, useSession, displayName } from '@/auth/SessionContext';
import { PlatformStatusProvider } from '@/lib/platformStatus';
import { useTheme } from '@/lib/theme';
import { Activity } from '@/pages/Activity';
import { Devices } from '@/pages/Devices';
import { Failures } from '@/pages/Failures';
import { Health } from '@/pages/Health';
import { Integrations } from '@/pages/Integrations';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

function Splash() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4">
      <Backdrop />
      <BrandMark className="h-10 opacity-90" />
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Signed in, but this account has no business on the console. */
function NoConsoleAccess() {
  const { me, signOut } = useSession();
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 sm:px-6 py-10 text-center">
      <Backdrop />
      <div className="w-full max-w-md">
        <span className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-muted text-muted-foreground">
          <ShieldOff className="w-7 h-7" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">The console is not on your access</h1>
        <p className="mt-2 text-base text-foreground/60">
          {displayName(me)} is signed in, but opening the console needs{' '}
          <code className="font-mono text-sm">app:console:access</code>. A manager grants it from the
          Login Users panel.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          {LAUNCHER_URL && (
            <Button asChild variant="outline">
              <a href={LAUNCHER_URL}>Back to the suite</a>
            </Button>
          )}
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A temporary password blocks every guarded route, so there is nothing here to
 * show until it is changed — and the form that changes it lives on the front
 * door, where an account owing a password change is meant to land.
 */
function MustChangePassword() {
  const { signOut } = useSession();
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 sm:px-6 py-10 text-center">
      <Backdrop />
      <div className="w-full max-w-md">
        <span className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
          <KeyRound className="w-7 h-7" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">Choose a password first</h1>
        <p className="mt-2 text-base text-foreground/60">
          This account is on a temporary password. Every page here stays closed until it is changed.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          {LAUNCHER_URL && (
            <Button asChild>
              <a href={LAUNCHER_URL}>Change it on the suite front door</a>
            </Button>
          )}
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A section reached by address rather than by the nav that would have hidden it. */
function Section({ id, children }: { id: string; children: ReactElement }) {
  const { has } = useSession();
  const section = findSection(id);
  if (!section) return <Redirect to={`/${DEFAULT_SECTION}`} />;
  if (!has(section.permission)) return <PermissionRequired permission={section.permission} />;
  return children;
}

function NotFound() {
  const [, navigate] = useLocation();
  return (
    <div className="rounded-2xl border border-dashed p-10 text-center">
      <p className="font-semibold">That page is not part of the console</p>
      <Button variant="outline" className="mt-4" onClick={() => navigate(`/${DEFAULT_SECTION}`)}>
        Go to Health
      </Button>
    </div>
  );
}

function Routes() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to={`/${DEFAULT_SECTION}`} />
      </Route>
      <Route path="/health">
        <Section id="health">
          <Health />
        </Section>
      </Route>
      <Route path="/failures">
        <Section id="failures">
          <Failures />
        </Section>
      </Route>
      <Route path="/activity">
        <Section id="activity">
          <Activity />
        </Section>
      </Route>
      <Route path="/devices">
        <Section id="devices">
          <Devices />
        </Section>
      </Route>
      <Route path="/integrations">
        <Section id="integrations">
          <Integrations />
        </Section>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function Shell() {
  const { state, me, locked, has } = useSession();

  if (state === 'loading') return <Splash />;
  if (state === 'signed-out') return <SignInPanel />;
  if (locked) return <LockedPanel />;
  if (me?.account.mustChangePassword) return <MustChangePassword />;
  if (!has('app:console:access')) return <NoConsoleAccess />;

  return (
    // The status poll is what puts an alert count in the sidebar from any page,
    // so it belongs above the routes — and it is off for anyone who may not read
    // health, rather than polling a route that would refuse them every 30s.
    <PlatformStatusProvider enabled={has('admin:health:read')}>
      <ConsoleLayout>
        <Routes />
      </ConsoleLayout>
    </PlatformStatusProvider>
  );
}

export default function App() {
  // The theme drives the document root, so anything portaled to <body> follows
  // it — the same arrangement the POS and the launcher use.
  const [theme] = useTheme();
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('dark', theme === 'dark');
    el.classList.toggle('light', theme === 'light');
  }, [theme]);

  return (
    <SessionProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Shell />
      </WouterRouter>
    </SessionProvider>
  );
}
