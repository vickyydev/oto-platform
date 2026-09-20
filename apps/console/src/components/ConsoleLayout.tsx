import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ExternalLink,
  LogOut,
  Menu,
  Moon,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { StatusMark, type Tone } from '@/components/Status';
import { consoleNav, findSection, type ConsoleSection } from '@/components/consoleSections';
import { useSession, displayName } from '@/auth/SessionContext';
import { useTheme } from '@/lib/theme';
import { unacknowledgedAlerts, usePlatformStatus } from '@/lib/platformStatus';
import { cn } from '@/lib/utils';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();
const POS_URL = import.meta.env.VITE_POS_URL?.trim();

/**
 * The console shell: the launcher's header over the POS admin's navigation.
 *
 * Neither half is new. The bar is apps/launcher/src/components/SuiteHeader.tsx
 * — same height, same border, same card wash — and the sidebar is
 * apps/pos/src/components/admin/AdminLayout.tsx: a persistent rail on desktop,
 * a slide-over drawer on a phone, the same group heading and the same active
 * pill. Someone moving between the till, the front door and this page should
 * not notice a seam.
 */
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [location] = useLocation();
  const { me, has, signOut } = useSession();
  const [theme, setTheme] = useTheme();
  const { snapshot, ready } = usePlatformStatus();

  const activeId = location.replace(/^\//, '').split('/')[0] || '';
  const section = findSection(activeId);

  // The drawer is a navigation, not a place: going somewhere closes it.
  useEffect(() => {
    setNavOpen(false);
  }, [location]);

  const openAlerts = unacknowledgedAlerts(snapshot);
  const unwell = ready !== null && !ready.ok;

  /** What earns a mark beside a nav item: a thing this page would tell you. */
  const attention = (id: string): { tone: Tone; count?: number } | undefined => {
    if (id === 'health' && (unwell || openAlerts > 0)) {
      return { tone: unwell ? 'down' : 'warn', count: openAlerts || undefined };
    }
    return undefined;
  };

  const visible = consoleNav
    .map((group) => ({ ...group, sections: group.sections.filter((s) => has(s.permission)) }))
    .filter((group) => group.sections.length > 0);

  const nav = (
    <nav className="flex flex-col gap-1.5 p-4">
      {visible.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <span className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground/35">
            {group.label}
          </span>
          <div className="flex flex-col gap-1 pb-1">
            {group.sections.map((s) => (
              <NavButton key={s.id} section={s} active={activeId === s.id} mark={attention(s.id)} />
            ))}
          </div>
        </div>
      ))}

      {/*
        The Sprint 1 back-office panels live in the till's own /admin this
        sprint. Naming that plainly, with one link, is better than a second copy
        of the catalogue screens that would drift from the first.
      */}
      {POS_URL && (
        <div className="mt-4 flex flex-col gap-0.5 border-t pt-4">
          <span className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground/35">
            Back office
          </span>
          <a
            href={`${POS_URL}/admin`}
            className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-foreground/70 hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <span className="flex-1">Catalogue, tax and accounts</span>
            <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60" />
          </a>
        </div>
      )}
    </nav>
  );

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <Backdrop />

      <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/90 px-4 sm:px-6 h-16 backdrop-blur">
        <button
          className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-xl border text-foreground/70"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>

        <Link href="/" aria-label="Console home" className="flex items-center gap-3 min-w-0">
          <BrandMark />
          <span className="hidden sm:block text-sm font-semibold text-muted-foreground border-l pl-3">
            Console
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {LAUNCHER_URL && (
            <a
              href={LAUNCHER_URL}
              className="hidden sm:inline-flex items-center gap-2 rounded-md border [border-color:var(--button-outline)] h-9 px-3 text-sm text-foreground/70 hover:text-foreground hover-elevate active-elevate-2"
            >
              <ExternalLink className="w-4 h-4" />
              Back to the suite
            </a>
          )}

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

          <span className="hidden sm:flex items-center gap-2 rounded-full border bg-card/60 pl-2 pr-3 h-9">
            <span className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <UserRound className="w-3.5 h-3.5" />
            </span>
            <span className="text-sm font-bold leading-tight max-w-[8rem] truncate">
              {displayName(me)}
            </span>
          </span>

          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => void signOut()}>
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      <div className="flex">
        <aside className="hidden md:block w-64 lg:w-72 shrink-0 border-r min-h-[calc(100dvh-4rem)]">
          <div className="sticky top-16">{nav}</div>
        </aside>

        {navOpen && (
          <div className="md:hidden fixed inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/60" onClick={() => setNavOpen(false)} />
            <div className="relative w-72 max-w-[80%] bg-background border-r animate-in slide-in-from-left duration-200 overflow-y-auto">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <span className="font-bold">Menu</span>
                <button
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground/70"
                  onClick={() => setNavOpen(false)}
                  aria-label="Close navigation"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              {nav}
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-5xl flex flex-col gap-6">
            {section && (
              <div className="flex items-start gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-foreground/5 text-foreground/80 shrink-0">
                  <section.icon className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <h1 className="text-2xl font-black tracking-tight">{section.label}</h1>
                  <p className="text-sm text-foreground/50">{section.description}</p>
                </div>
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function NavButton({
  section,
  active,
  mark,
}: {
  section: ConsoleSection;
  active: boolean;
  mark?: { tone: Tone; count?: number };
}) {
  return (
    <Link
      href={`/${section.id}`}
      className={cn(
        'flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground/70 hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      <span className="flex-1">{section.label}</span>
      {mark &&
        (mark.count !== undefined ? (
          <span
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums"
            style={{
              color: active ? undefined : `hsl(var(--status-${mark.tone}))`,
              backgroundColor: active
                ? 'hsl(var(--primary-foreground) / 0.2)'
                : `hsl(var(--status-${mark.tone}) / 0.15)`,
            }}
            aria-label={`${mark.count} open alerts`}
          >
            {mark.count}
          </span>
        ) : (
          <StatusMark tone={mark.tone} />
        ))}
    </Link>
  );
}
