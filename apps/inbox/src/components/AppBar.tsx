import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bot, Check, FileText, FlaskConical, LayoutGrid, LogOut, Monitor, Moon, PanelRight, Plus, Search, Sun, X, type LucideIcon } from 'lucide-react';
import type { InboxMe } from '@/api/inbox';
import { assistantCapabilities } from '@/api/assistant';
import logoUrl from '@/assets/logo-oto.png';
import { NEW_CONTACT_LABEL } from '@/lib/contacts';
import type { Theme } from '@/lib/theme';
import type { SettingsPage } from '@/lib/url';
import { initialsOf } from '@/lib/view';

/** A 44 px square icon control (every touch target at least 44 px, SCRUM-1016). */
const ICON_BUTTON =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink transition hover:bg-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral';
const SEARCH_PLACEHOLDER = 'Search a family, a message';

/**
 * Who is reading (the prototype's "Viewing as", :1407-1416): the owner view,
 * else the teams they are in, else a staff member who sees only what they are
 * put on. Since SCRUM-1016 it is said once, in the account menu.
 */
export function viewerRoleLabel(me: Pick<InboxMe, 'roles' | 'teams'>): string {
  // 'Owner view' names the view, not the person (SCRUM-652 polish): the GM
  // reads under it too.
  if (me.roles.includes('owner')) return 'Owner view';
  const teams = me.teams.filter((t) => t.member).map((t) => t.name);
  return teams.length > 0 ? teams.join(' · ') : 'Staff';
}

/** What the account menu's settings part offers this viewer (owner UI round 2026-10-22, F2). */
export type SettingsEntryKey = SettingsPage | 'simulator';

export function settingsMenuEntries(me: InboxMe): { key: SettingsEntryKey; label: string }[] {
  const caps = assistantCapabilities(me);
  return [
    ...(me.capabilities.templates ? [{ key: 'templates' as const, label: 'Templates' }] : []),
    ...(caps.kb || caps.ai ? [{ key: 'assistant' as const, label: 'Assistant' }] : []),
    ...(me.simulator ? [{ key: 'simulator' as const, label: 'Simulator · test only' }] : []),
  ];
}

const ENTRY_ICON: Record<SettingsEntryKey, LucideIcon> = { templates: FileText, assistant: Bot, simulator: FlaskConical };

/** The three themes (SCRUM-653), chosen in the account menu; the choice is saved on the account. */
export const THEME_CHOICES: { theme: Theme; label: string; icon: LucideIcon }[] = [
  { theme: 'light', label: 'Light', icon: Sun },
  { theme: 'dark', label: 'Dark', icon: Moon },
  { theme: 'system', label: 'System', icon: Monitor },
];

export const SHOW_SIMULATOR_LABEL = 'Show simulator';
export const BACK_TO_SUITE_LABEL = 'Back to the suite';
export const SIGN_OUT_LABEL = 'Sign out';

const ITEM =
  'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] font-medium text-ink hover:bg-wash focus:bg-wash focus:outline-none';

export type AccountMenuProps = {
  me: InboxMe;
  theme: Theme;
  onTheme: (t: Theme) => void;
  /** The settings page open in place of the inbox, if any. */
  settings: SettingsPage | null;
  onSettings: (key: SettingsEntryKey) => void;
  /** The simulator side panel is hidden and may be brought back; the menu offers it from 1280 px, where the panel shows. */
  showSimulator: boolean;
  onShowSimulator: () => void;
  launcherUrl?: string;
  onSignOut: () => void;
};

/**
 * The one menu behind the account button (SCRUM-1016): what the old header's
 * buttons did, each where the viewer has it — Templates, Assistant, the
 * Simulator; the simulator panel's way back; the theme; Back to the suite;
 * Sign out — under the viewer's name, said here once. Rendered on its own so
 * the markup tests read it open.
 */
export function AccountMenuItems({
  me,
  theme,
  onTheme,
  settings,
  onSettings,
  showSimulator,
  onShowSimulator,
  launcherUrl,
  onSignOut,
}: AccountMenuProps) {
  const entries = settingsMenuEntries(me);
  return (
    <div
      role="menu"
      aria-label="Your account"
      className="w-72 max-w-[calc(100vw-1rem)] rounded-2xl border border-line bg-card p-1.5 text-ink shadow-pop"
    >
      <div role="none" className="px-3 pb-2 pt-2">
        <div className="truncate text-[14px] font-bold">{me.name ?? 'You'}</div>
        <div className="truncate text-[12.5px] text-ink-muted">{viewerRoleLabel(me)}</div>
      </div>
      {entries.length > 0 && (
        <div role="group" aria-label="Settings" className="border-t border-line-soft py-1">
          {entries.map(({ key, label }) => {
            const Icon = ENTRY_ICON[key];
            const open = key !== 'simulator' && settings === key;
            return (
              <button key={key} type="button" role="menuitem" aria-current={open ? 'page' : undefined} onClick={() => onSettings(key)} className={ITEM}>
                <Icon aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-soft" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {open && <Check aria-hidden className="h-4 w-4 shrink-0 text-coral-ink" />}
              </button>
            );
          })}
          {/* The simulator panel's way back (SCRUM-837): an entry here, never floating over the page. */}
          {me.simulator && showSimulator && (
            <button type="button" role="menuitem" onClick={onShowSimulator} className={ITEM}>
              <PanelRight aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-soft" />
              <span className="min-w-0 flex-1 truncate">{SHOW_SIMULATOR_LABEL}</span>
            </button>
          )}
        </div>
      )}
      <div role="group" aria-label="Theme" className="border-t border-line-soft py-1">
        <div aria-hidden className="px-3 pb-1 pt-1.5 text-[12px] font-bold text-ink-muted">
          Theme
        </div>
        {THEME_CHOICES.map(({ theme: t, label, icon: Icon }) => (
          <button key={t} type="button" role="menuitemradio" aria-checked={theme === t} onClick={() => onTheme(t)} className={ITEM}>
            <Icon aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-soft" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {theme === t && <Check aria-hidden className="h-4 w-4 shrink-0 text-coral-ink" />}
          </button>
        ))}
      </div>
      <div className="border-t border-line-soft pt-1" role="none">
        {launcherUrl && (
          <a role="menuitem" href={launcherUrl} className={ITEM}>
            <LayoutGrid aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-soft" />
            {BACK_TO_SUITE_LABEL}
          </a>
        )}
        <button type="button" role="menuitem" onClick={onSignOut} className={ITEM}>
          <LogOut aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-soft" />
          {SIGN_OUT_LABEL}
        </button>
      </div>
    </div>
  );
}

/** The menu's items, in order: every one rendered is one a person can reach. */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')] : [];
}

/** The simulator side panel shows from 1280 px (Workspace), so its way back is offered there only. */
const WIDE = '(min-width: 1280px)';
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(WIDE).matches === true);
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * The account button and its menu (SCRUM-1016): the viewer's initials; the
 * menu opens on a press or ArrowDown, moves with the arrow keys, Home and
 * End, closes on Escape, Tab, a choice or a press outside, and gives focus
 * back to the button. Choosing a theme keeps it open, so the change is seen.
 */
export function AccountMenu(props: AccountMenuProps) {
  const { me } = props;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const wide = useWide();
  const name = me.name ?? 'You';

  useEffect(() => {
    if (!open) return;
    menuItems(wrap.current)[0]?.focus();
    const away = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target) && !button.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  /** A choice closes the menu first, focus back on the button, then acts. */
  const then =
    <A extends unknown[]>(act: (...args: A) => void) =>
    (...args: A) => {
      close();
      act(...args);
    };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(wrap.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Your account: ${name}, ${viewerRoleLabel(me)}`}
        // From 1280 px the name beside the initials, as Desktop.dc.html draws it ("AN Anya").
        className={`${ICON_BUTTON} rounded-full xl:w-auto xl:max-w-[14rem] xl:gap-2 xl:pl-1.5 xl:pr-3`}
      >
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-mint text-[12px] font-bold text-teal">
          {initialsOf(name)}
        </span>
        <span aria-hidden data-account-name className="hidden min-w-0 truncate text-[13.5px] font-semibold xl:inline">
          {name}
        </span>
      </button>
      {open && (
        <div ref={wrap} onKeyDown={onKeyDown} className="absolute right-0 top-full z-40 mt-1">
          <AccountMenuItems
            {...props}
            showSimulator={props.showSimulator && wide}
            onSettings={then(props.onSettings)}
            onShowSimulator={then(props.onShowSimulator)}
            onSignOut={then(props.onSignOut)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The compact app bar in place of the old header card (SCRUM-1016): the OTO
 * logo and "Inbox"; the search; on desktop the day's figures inline (the
 * children); New contact where the viewer may make one; the account menu. On
 * a phone the search is a button that opens a full-width field under the bar.
 */
export function AppBar({
  search,
  onSearch,
  onNewContact,
  account,
  children,
}: {
  search: string;
  onSearch: (q: string) => void;
  /** SCRUM-860: "New contact", for a viewer the api lets create one; absent otherwise. */
  onNewContact?: () => void;
  account: ReactNode;
  /** The desktop's inline figures (`StatsRow` bar), shown at 1024 px and wider. */
  children?: ReactNode;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const phoneSearch = searchOpen || search !== '';
  return (
    <header className="shrink-0 bg-ground md:border-b md:border-line md:bg-card">
      <div className="flex min-h-14 items-center gap-2 py-1.5 pl-4 pr-2 md:gap-x-6 md:px-5">
        <div className="flex shrink-0 items-center gap-2.5">
          <img src={logoUrl} alt="OTO" className="block h-5 w-auto md:h-[22px]" />
          <h1 className="text-[20px] font-extrabold leading-none tracking-[-0.02em] text-ink md:text-[18px]">Inbox</h1>
        </div>
        <label className="hidden h-10 min-w-0 max-w-[380px] flex-[1_1_260px] items-center gap-2 rounded-xl border border-field bg-ground px-3 focus-within:border-ink-muted md:flex">
          <Search aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="Search"
            placeholder={SEARCH_PLACEHOLDER}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-muted focus:outline-none"
          />
        </label>
        <div className="ml-auto hidden min-w-0 lg:flex">{children}</div>
        <div className="ml-auto flex shrink-0 items-center lg:ml-0">
          {!phoneSearch && (
            <button type="button" onClick={() => setSearchOpen(true)} aria-label="Open search" className={`${ICON_BUTTON} md:hidden`}>
              <Search aria-hidden className="h-[22px] w-[22px]" />
            </button>
          )}
          {onNewContact && (
            <button type="button" onClick={onNewContact} aria-label={NEW_CONTACT_LABEL} className={`${ICON_BUTTON} md:w-auto md:gap-1.5 md:px-3`}>
              <Plus aria-hidden className="h-[22px] w-[22px] md:h-[18px] md:w-[18px]" />
              <span className="hidden text-[13.5px] font-semibold md:inline">New</span>
            </button>
          )}
          {account}
        </div>
      </div>
      {phoneSearch && (
        <div className="flex items-center gap-1 pb-2 pl-4 pr-2 md:hidden">
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-field bg-card px-3 focus-within:border-ink-muted">
            <Search aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              aria-label="Search"
              placeholder={SEARCH_PLACEHOLDER}
              autoFocus={searchOpen}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-muted focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              onSearch('');
              setSearchOpen(false);
            }}
            aria-label="Close search"
            className={ICON_BUTTON}
          >
            <X aria-hidden className="h-5 w-5" />
          </button>
        </div>
      )}
    </header>
  );
}
