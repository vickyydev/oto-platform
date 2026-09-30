import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ExternalLink, LayoutGrid, LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { StatusMark, type Tone } from '@/components/Status';
import { consoleNav, findSection, type ConsoleSection } from '@/components/consoleSections';
import { CommandBar, placeName } from '@/components/redesign/CommandBar';
import { CountBadge } from '@/components/redesign/chips';
import { useFailureCount } from '@/components/redesign/useFailureCount';
import { useSession, displayName } from '@/auth/SessionContext';
import type { MeResponse } from '@/api/platform';
import { useTheme } from '@/lib/theme';
import { unacknowledgedAlerts, usePlatformStatus } from '@/lib/platformStatus';
import { cn } from '@/lib/utils';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();
const POS_URL = import.meta.env.VITE_POS_URL?.trim();

/**
 * The pages that keep their previous layout for one more round (SCRUM-474
 * phase 2): their own rounds are landing on them, so only the navigation
 * around them changes now. They still get the old title block and the old
 * centred column, pixel for pixel.
 */
const PHASE_TWO = new Set(['booths', 'bookings']);

/**
 * The console shell, as the approved design draws it (SCRUM-474,
 * Shell.dc.html): one sidebar holding everything that used to be split between
 * a header and a rail — the brand, the four labelled groups of pages, and a
 * foot with the way back to the launcher and the signed-in person.
 *
 * What did NOT change is what the nav may show. Every entry is still filtered
 * by its own permission from `consoleSections`, and a group whose every entry
 * is hidden disappears whole rather than leaving a heading over nothing. On a
 * phone the same sidebar is the slide-over drawer it always was, opened from a
 * slim bar that carries only the menu button and the brand.
 */
export function ConsoleLayout({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [location] = useLocation();
  const { has } = useSession();
  const { snapshot, ready } = usePlatformStatus();
  // Read once for the shell, not once per sidebar: the rail and the phone's
  // drawer are two copies of the same list.
  const failures = useFailureCount(has('admin:health:read'));

  const openAlerts = unacknowledgedAlerts(snapshot);
  const unwell = ready !== null && !ready.ok;

  /** What earns a mark beside a nav item: a thing that page would tell you. */
  const attention = (id: string): NavMark | undefined => {
    if (id === 'health' && (unwell || openAlerts > 0)) {
      return {
        tone: unwell ? 'down' : 'warn',
        count: openAlerts || undefined,
        label: `${openAlerts} open alert${openAlerts === 1 ? '' : 's'}`,
      };
    }
    // Groups, not runs, and only when there are some: zero draws nothing, and
    // so does an account the route would refuse (the hook is off for it).
    if (id === 'failures' && failures && failures.count > 0) {
      const shown = failures.more ? `${failures.count}+` : String(failures.count);
      return {
        tone: 'warn',
        count: shown,
        label: `${shown} failure group${failures.count === 1 && !failures.more ? '' : 's'} in the last 24 hours`,
      };
    }
    return undefined;
  };

  const activeId = location.replace(/^\//, '').split('/')[0] || '';
  const section = findSection(activeId);
  const phaseTwo = section ? PHASE_TWO.has(section.id) : false;

  // The drawer is a navigation, not a place: going somewhere closes it.
  useEffect(() => {
    setNavOpen(false);
  }, [location]);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <Backdrop />

      {/* The phone's bar: the sidebar is a drawer below md, so this is the way into it. */}
      <header className="md:hidden sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-card-border bg-background/90 px-4 backdrop-blur">
        <button
          className="inline-flex h-10 w-10 items-center justify-center rounded-[12px] border border-border text-foreground/70"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
        <Brand compact />
      </header>

      <div className="flex">
        <aside className="hidden md:block w-[264px] shrink-0 border-r border-card-border bg-card">
          <div className="sticky top-0 h-[100dvh] overflow-y-auto">
            <Sidebar activeId={activeId} attention={attention} idPrefix="rail" />
          </div>
        </aside>

        {navOpen && (
          <div className="md:hidden fixed inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/60" onClick={() => setNavOpen(false)} />
            <div className="relative w-[264px] max-w-[85%] bg-card border-r border-card-border animate-in slide-in-from-left duration-200 overflow-y-auto">
              <button
                className="absolute right-3 top-5 inline-flex h-9 w-9 items-center justify-center rounded-[12px] text-foreground/70"
                onClick={() => setNavOpen(false)}
                aria-label="Close navigation"
              >
                <X className="w-5 h-5" />
              </button>
              <Sidebar activeId={activeId} attention={attention} idPrefix="drawer" />
            </div>
          </div>
        )}

        {phaseTwo ? (
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
        ) : (
          <main className="flex-1 min-w-0">
            {/*
              The container every redesigned page's grid measures itself
              against: the page's own width, not the window's, because the
              sidebar takes 264 px of the window from md up.
            */}
            <div className="@container mx-auto w-full max-w-[1440px] px-4 pt-6 pb-10 sm:px-6 lg:px-12 lg:pt-10 lg:pb-12">
              <div className="flex flex-col gap-5">
                {/*
                  A page reached by address without the permission to read it
                  renders its refusal, not its own command bar — so the bar is
                  drawn here instead, and the refusal still says whose page it is.
                */}
                {section && !has(section.permission) && <CommandBar sectionId={section.id} />}
                {children}
              </div>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

/** The mark and the name, linking home. */
function Brand({ compact = false }: { compact?: boolean }) {
  const { me } = useSession();
  return (
    <Link
      href="/"
      aria-label="Console home"
      className={cn('flex min-w-0 items-center gap-[11px]', !compact && 'px-2')}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-primary text-[15px] font-extrabold text-primary-foreground"
        aria-hidden="true"
      >
        O
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-extrabold tracking-[-0.01em]">OTO Console</span>
        {!compact && me?.branch?.name && (
          <span className="block truncate text-[11.5px] text-muted-foreground" title={me.branch.name}>
            {placeName(me.branch.name)}
          </span>
        )}
      </span>
    </Link>
  );
}

function Sidebar({
  activeId,
  attention,
  idPrefix,
}: {
  activeId: string;
  attention: (id: string) => NavMark | undefined;
  /** The rail and the drawer are both mounted on a phone; their ids must differ. */
  idPrefix: string;
}) {
  const { me, has, signOut } = useSession();
  const [theme, setTheme] = useTheme();

  const visible = consoleNav
    .map((group) => ({ ...group, sections: group.sections.filter((s) => has(s.permission)) }))
    .filter((group) => group.sections.length > 0);

  return (
    <div className="flex min-h-full flex-col gap-[22px] px-4 py-6">
      <Brand />

      <nav aria-label="Console" className="flex flex-col gap-[22px]">
        {visible.map((group) => (
          <div key={group.id} className="flex flex-col gap-[3px]">
            <span className="px-2.5 pb-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted-foreground/75">
              {group.label}
            </span>
            {group.sections.map((s) => (
              <NavItem
                key={s.id}
                section={s}
                active={activeId === s.id}
                mark={attention(s.id)}
                markId={`${idPrefix}-nav-${s.id}-mark`}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2.5 border-t border-card-border pt-3.5">
        {LAUNCHER_URL && (
          <a
            href={LAUNCHER_URL}
            className="flex items-center gap-[11px] rounded-[12px] px-2.5 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <LayoutGrid className="w-4 h-4 shrink-0" aria-hidden="true" />
            All apps
          </a>
        )}

        {/*
          The Sprint 1 back-office panels live in the till's own /admin this
          sprint. Naming that plainly, with one link, is better than a second
          copy of the catalogue screens that would drift from the first.
        */}
        {POS_URL && (
          <a
            href={`${POS_URL}/admin`}
            className="flex items-center gap-[11px] rounded-[12px] px-2.5 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ExternalLink className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">Catalogue, tax and accounts</span>
          </a>
        )}

        <div className="flex items-center gap-2.5 rounded-[12px] bg-foreground/[0.025] px-2.5 py-2">
          <span
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground"
            aria-hidden="true"
          >
            {initial(me)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-bold">{displayName(me)}</div>
            {roleLine(me) && (
              <div className="truncate text-[11px] text-muted-foreground">{roleLine(me)}</div>
            )}
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => void signOut()}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface NavMark {
  tone: Tone;
  count?: number | string;
  label: string;
}

/**
 * One entry: its existing lucide icon, its label, and a mark when its page has
 * something to say. The active entry is the warm pill in the primary tint.
 *
 * The link's accessible name is the label alone — the badge is hidden from
 * the name and its words are the link's description instead — so "Failures"
 * is still "Failures" to anything that looks for it by name, whatever the
 * badge says this minute. Deliberately NOT an `aria-label`: that would make
 * the link answer to a label search, and "Branches" would then be one more
 * thing called "Branch" on every page with a branch picker.
 */
function NavItem({
  section,
  active,
  mark,
  markId,
}: {
  section: ConsoleSection;
  active: boolean;
  mark?: NavMark;
  markId: string;
}) {
  const Icon = section.icon;
  const describedBy = mark ? markId : undefined;
  return (
    <Link
      href={`/${section.id}`}
      aria-current={active ? 'page' : undefined}
      aria-describedby={describedBy}
      className={cn(
        'flex items-center gap-[11px] rounded-[12px] px-2.5 py-[9px] text-[13.5px] transition-colors',
        active
          ? 'bg-primary/10 font-bold text-primary-ink'
          : 'font-semibold text-foreground hover:bg-foreground/5',
      )}
    >
      <Icon
        className={cn('w-[17px] h-[17px] shrink-0', active ? 'text-primary-ink' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{section.label}</span>
      {mark && (
        <>
          <span className="shrink-0" aria-hidden="true">
            {mark.count !== undefined ? (
              <CountBadge tone={mark.tone} count={mark.count} label={mark.label} />
            ) : (
              <StatusMark tone={mark.tone} />
            )}
          </span>
          <span id={describedBy} hidden>
            {mark.label}
          </span>
        </>
      )}
    </Link>
  );
}

/** The chip's letter: the person's own initial, or a digit of the phone. */
function initial(me: MeResponse | null): string {
  const name = displayName(me);
  return name ? name.trim().charAt(0).toUpperCase() : '·';
}

/**
 * The line under the name. The seed carries a desk in the employee's name —
 * "Som (Reception)" — which `displayName` strips for the header; it is the
 * one honest role word /me offers, so it goes here. Failing that, a platform
 * administrator is said so, and anybody else gets no second line rather than a
 * guessed one.
 */
function roleLine(me: MeResponse | null): string | null {
  const desk = (me?.employee?.name ?? '').match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
  if (desk) return desk;
  if (me?.isPlatformAdmin) return 'Platform administrator';
  return null;
}
