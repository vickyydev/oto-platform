import { useState, useEffect, type ReactNode } from 'react';
import { Link } from 'wouter';
import { Menu, X, ArrowLeft, ShieldCheck, ChevronDown } from 'lucide-react';
import { adminNav, panelGroupMap, type AdminNavEntry } from './adminSections';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { countRestockAlerts } from '@/lib/inventory';
import { useOperator } from '@/auth/OperatorContext';

/** Drops manager-only groups/panels for a non-manager operator. Staff never
 *  see the Reporting nav at all — the till has no separate admin login, so
 *  this is the single gate for the manager-only Reports module. */
function visibleNavFor(isManager: boolean): AdminNavEntry[] {
  if (isManager) return adminNav;
  return adminNav.reduce<AdminNavEntry[]>((acc, entry) => {
    if (entry.kind === 'panel') {
      if (!entry.panel.managerOnly) acc.push(entry);
      return acc;
    }
    if (entry.managerOnly) return acc;
    const panels = entry.panels.filter((p) => !p.managerOnly);
    if (panels.length > 0) acc.push({ ...entry, panels });
    return acc;
  }, []);
}

interface AdminLayoutProps {
  activeId: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}

function initialOpenGroups(activeId: string): Record<string, boolean> {
  const activeGroup = panelGroupMap[activeId];
  const result: Record<string, boolean> = {};
  for (const entry of adminNav) {
    if (entry.kind !== 'group') continue;
    result[entry.id] = entry.id === 'catalog' || entry.id === activeGroup;
  }
  return result;
}

/**
 * Responsive Admin shell: a persistent left sidebar on desktop and a slide-over
 * drawer on mobile. This is a normal responsive web admin — NOT the
 * iPad-landscape-locked POS UI.
 */
export function AdminLayout({ activeId, onSelect, children }: AdminLayoutProps) {
  const [navOpen, setNavOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    initialOpenGroups(activeId)
  );
  const { inventory } = useCatalogStore();
  const restockCount = countRestockAlerts(inventory);
  const { operator } = useOperator();
  const visibleNav = visibleNavFor(operator?.role === 'manager');

  // Auto-expand the group containing the newly active panel.
  useEffect(() => {
    const groupId = panelGroupMap[activeId];
    if (groupId) {
      setOpenGroups((prev) => (prev[groupId] ? prev : { ...prev, [groupId]: true }));
    }
  }, [activeId]);

  const select = (id: string) => {
    onSelect(id);
    setNavOpen(false);
  };

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const badgeFor = (id: string) =>
    id === 'inventory' && restockCount > 0 ? restockCount : undefined;

  const nav = (
    <nav className="flex flex-col gap-1.5 p-4">
      {visibleNav.map((entry) => {
        // Standalone top-level page — rendered as an item, no group header.
        if (entry.kind === 'panel') {
          const p = entry.panel;
          return (
            <NavButton
              key={p.id}
              label={p.label}
              active={activeId === p.id}
              badge={badgeFor(p.id)}
              onClick={() => select(p.id)}
            />
          );
        }

        // Collapsible group (2+ items).
        const isOpen = !!openGroups[entry.id];
        const hasActivePanelInGroup = entry.panels.some((p) => p.id === activeId);
        return (
          <div key={entry.id} className="flex flex-col gap-0.5">
            {/* Group header — toggle only, does not navigate */}
            <button
              onClick={() => toggleGroup(entry.id)}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-widest transition-colors ${
                hasActivePanelInGroup
                  ? 'text-foreground/60'
                  : 'text-foreground/35 hover:text-foreground/55'
              }`}
            >
              <span className="flex-1">{entry.label}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${
                  isOpen ? 'rotate-0' : '-rotate-90'
                }`}
              />
            </button>

            {/* Panel items — only shown when group is open */}
            {isOpen && (
              <div className="flex flex-col gap-1 pb-1">
                {entry.panels.map((p) => (
                  <NavButton
                    key={p.id}
                    label={p.label}
                    active={activeId === p.id}
                    badge={badgeFor(p.id)}
                    onClick={() => select(p.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-foreground/10 bg-background/90 px-4 py-3 backdrop-blur">
        <button
          className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-xl border border-foreground/10 text-foreground/70"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex flex-col">
          <span className="text-lg font-black tracking-tight">Oto Admin Console</span>
          <span className="text-xs text-foreground/40">Back-office settings</span>
        </div>
        {/* Access is gated by AdminAccessGate (signed-in manager only); show
            who is signed in rather than the old "temporary dev access" badge. */}
        <span className="ml-2 hidden sm:inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-300">
          <ShieldCheck className="w-3.5 h-3.5" />
          {operator?.name} · Manager
        </span>
        <Link
          href="/"
          className="ml-auto inline-flex items-center gap-2 rounded-xl border border-foreground/10 px-3 py-2 text-sm text-foreground/70 hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Back to POS</span>
        </Link>
      </header>

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="hidden md:block w-72 shrink-0 border-r border-foreground/10 min-h-[calc(100dvh-65px)]">
          {nav}
        </aside>

        {/* Mobile drawer */}
        {navOpen && (
          <div className="md:hidden fixed inset-0 z-40 flex">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setNavOpen(false)}
            />
            <div className="relative w-72 max-w-[80%] bg-background border-r border-foreground/10 animate-in slide-in-from-left duration-200 overflow-y-auto">
              <div className="flex items-center justify-between px-4 py-3 border-b border-foreground/10">
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

        {/* Content */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

function NavButton({
  label,
  active,
  badge,
  onClick,
}: {
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground/70 hover:bg-foreground/5 hover:text-foreground'
      }`}
    >
      <span className="flex-1">{label}</span>
      {badge !== undefined && (
        <span
          className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums ${
            active
              ? 'bg-primary-foreground/20 text-primary-foreground'
              : 'bg-amber-500 text-black'
          }`}
          aria-label={`${badge} need restocking`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
