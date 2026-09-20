import type { ReactNode } from 'react';
import { Loader2, Moon, Radar, Settings, Store, Sun } from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { BrandMark } from '@/components/BrandMark';
import { SignInPanel } from '@/components/SignInPanel';
import { LockedPanel } from '@/components/LockedPanel';
import { ChangePasswordPanel } from '@/components/ChangePasswordPanel';
import { SuiteHeader } from '@/components/SuiteHeader';
import { AppTile } from '@/components/AppTile';
import { Button } from '@/components/ui/button';
import { SUITE_APPS } from '@/suite/apps';
import { useSession, displayName } from '@/auth/SessionContext';
import { greeting, inWords } from '@/lib/greeting';
import { useTheme } from '@/lib/theme';

function Splash() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4">
      <Backdrop />
      <BrandMark className="h-10 opacity-90" />
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/** The signed-out, locked and password-change screens share this frame. */
function Centred({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 sm:px-6 py-10">
      <Backdrop />
      {children}
    </div>
  );
}

const PROMISES = [
  { icon: Store, text: 'The till, the customer display and the check-in desk.' },
  { icon: Settings, text: 'People, access, branches and prices — set once, used everywhere.' },
  { icon: Radar, text: "The park's numbers, every branch, in one place." },
];

function SignedOut() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="min-h-[100dvh] flex flex-col">
      <Backdrop />
      <div className="flex items-center justify-between px-4 sm:px-6 h-16 shrink-0">
        <BrandMark />
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
      </div>

      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-6">
        <div className="w-full max-w-5xl grid gap-10 lg:gap-16 lg:grid-cols-[1.05fr_1fr] items-center">
          <section className="text-center lg:text-left">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">Oto Play Park</p>
            <h1 className="mt-3 text-4xl sm:text-5xl font-black tracking-tight leading-[1.05]">
              One door to
              <br className="hidden sm:block" /> every OTO app.
            </h1>
            <p className="mt-4 text-lg text-foreground/60 max-w-md mx-auto lg:mx-0">
              Sign in once with your phone number. The apps you work in open without asking again.
            </p>
            {/* Context for a first visit, and a scroll obstacle on a phone
                where the only thing wanted is the password field. */}
            <ul className="mt-8 hidden sm:flex flex-col gap-3 max-w-md mx-auto lg:mx-0 text-left">
              {PROMISES.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-start gap-3">
                  <span className="mt-0.5 w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="text-sm text-foreground/70 leading-relaxed">{text}</span>
                </li>
              ))}
            </ul>
          </section>

          <SignInPanel />
        </div>
      </main>

      <footer className="shrink-0 px-6 py-6 text-center text-xs text-foreground/40">
        For the park's team. Every sign-in and every refusal is recorded.
      </footer>
    </div>
  );
}

function SignedIn() {
  const { me, has } = useSession();

  const open = SUITE_APPS.filter(
    (app) => has(app.permission) && (!app.alsoRequires || has(app.alsoRequires)),
  );
  // Apps the account simply has no grant for are named in a line underneath, so
  // a person knows the suite is larger than their tiles and who to ask. Apps
  // gated by a second permission — the demonstration booth — are not named at
  // all: they are not part of anyone's day and reading about them would only
  // raise a question with no answer.
  const withoutAccess = SUITE_APPS.filter((app) => !app.alsoRequires && !has(app.permission));

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <Backdrop />
      <SuiteHeader />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight">
          {greeting(me?.branch?.timezone)}, {displayName(me)}
        </h1>
        <p className="mt-2 text-base text-foreground/60">
          {me?.branch ? `${me.branch.name} · ` : ''}Pick an app — you stay signed in across the suite.
        </p>

        {open.length > 0 ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {open.map((app) => (
              <AppTile key={app.key} app={app} />
            ))}
          </div>
        ) : (
          <div className="mt-8 rounded-2xl border border-dashed p-8 text-center text-foreground/60">
            <p className="font-semibold text-foreground">No apps on your access yet.</p>
            <p className="mt-1 text-sm">
              A manager grants access to an app from the console. Until then there is nothing here to
              open.
            </p>
          </div>
        )}

        {withoutAccess.length > 0 && (
          <p className="mt-6 text-sm text-foreground/45">
            Also in the suite, not on your access: {inWords(withoutAccess.map((a) => a.name))}. A
            manager can grant it.
          </p>
        )}
      </main>

      <footer className="shrink-0 px-6 py-6 text-center text-xs text-foreground/40">
        Signed in across the suite. Sign out here ends it everywhere.
      </footer>
    </div>
  );
}

export function Landing() {
  const { state, me, locked } = useSession();

  if (state === 'loading') return <Splash />;
  if (state === 'signed-out') return <SignedOut />;
  if (locked)
    return (
      <Centred>
        <LockedPanel />
      </Centred>
    );
  if (me?.account.mustChangePassword)
    return (
      <Centred>
        <ChangePasswordPanel />
      </Centred>
    );
  return <SignedIn />;
}
