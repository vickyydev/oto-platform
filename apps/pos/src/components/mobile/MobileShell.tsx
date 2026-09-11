import { Switch, Route, useLocation, Link } from 'wouter';
import { OccupancyChip } from '@/components/shared/OccupancyChip';
import { ThemeMenu } from '@/components/shared/ThemeMenu';
import { OperatorBadge } from '@/components/auth/OperatorBadge';
import { BranchSwitcher } from '@/components/shared/BranchSwitcher';
import MobileTill from './MobileTill';
import { MobileOrderStation } from './order-station/MobileOrderStation';
import { MobileTodayPage } from './today/MobileTodayPage';
import { MobileParties } from './parties/MobileParties';
import { MobileHistory } from './history/MobileHistory';
import { MobileDropOffBoard } from './dropoff/MobileDropOffBoard';
import { MobileMessaging } from './messaging/MobileMessaging';
import { MobileStock } from './stock/MobileStock';
import StationSetup from '@/pages/StationSetup';
import logoUrl from '@/assets/logo-oto.png';
import { getTotalUnreadCount, UnreadBadge } from './messaging/messagingUtils';
import { Ticket, GlassWater, Baby, Users, ReceiptText, Settings, BarChart3, MessageCircle } from 'lucide-react';

const TABS = [
  { href: '/', label: 'Tickets', icon: Ticket, exact: true },
  { href: '/order-station', label: 'F&B', icon: GlassWater, exact: false },
  { href: '/drop-off', label: 'Check-in', icon: Baby, exact: false },
  { href: '/parties', label: 'Events', icon: Users, exact: false },
  { href: '/history', label: 'History', icon: ReceiptText, exact: false },
  { href: '/today', label: 'Today', icon: BarChart3, exact: false },
  { href: '/messages', label: 'Messages', icon: MessageCircle, exact: false },
];

function ComingSoon({ surface }: { surface: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8 text-center gap-4">
      <div className="text-5xl opacity-20">🚧</div>
      <h2 className="text-xl font-bold">{surface}</h2>
      <p className="text-sm max-w-xs">
        This surface is coming soon on mobile. Use the iPad view for now.
      </p>
    </div>
  );
}

/**
 * Portrait phone shell for the mobile POS. Wraps all mobile routes with:
 *   - a compact top bar (logo · occupancy chip · operator badge + lock)
 *   - a bottom tab bar (Tickets live; all others are "coming soon" placeholders)
 *
 * Sits inside the existing auth gate / provider tree so the operator session,
 * station profile, and contexts are shared across the breakpoint switch.
 * Landscape rotation keeps the portrait single-column layout intact since the
 * CSS never switches to a wide layout — it simply letterboxes / scrolls.
 */
export function MobileShell() {
  const [location] = useLocation();

  // Station setup is a full-screen page with its own header + Close button, so we
  // render it without the mobile tab chrome to avoid a double frame / clipping.
  if (location === '/station-setup') {
    return <StationSetup />;
  }

  // Unread WhatsApp count for the Messages tab badge. Recomputed each render;
  // navigating between surfaces refreshes it.
  const unreadMessages = getTotalUnreadCount();

  return (
    <div className="h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
      {/* Top bar — compact: logo | occupancy | spacer | settings | operator badge */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
        <Link href="/" aria-label="Oto home">
          <img src={logoUrl} alt="Oto" className="h-7 w-auto cursor-pointer" />
        </Link>
        <OccupancyChip />
        <BranchSwitcher />
        <div className="flex-1" />
        <ThemeMenu />
        <Link href="/station-setup" aria-label="Station setup">
          <button
            type="button"
            title="Station setup"
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        </Link>
        <OperatorBadge />
      </div>

      {/* Content area — routes render here */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Route path="/" component={MobileTill} />
          <Route
            path="/order-station"
            component={MobileOrderStation}
          />
          <Route path="/drop-off" component={MobileDropOffBoard} />
          <Route
            path="/parties"
            component={MobileParties}
          />
          <Route path="/history" component={MobileHistory} />
          <Route path="/today" component={MobileTodayPage} />
          <Route path="/stock" component={MobileStock} />
          <Route path="/messages" component={MobileMessaging} />
          <Route component={() => <ComingSoon surface="This page" />} />
        </Switch>
      </div>

      {/* Bottom tab bar */}
      <nav
        className="shrink-0 grid border-t bg-card/30"
        style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))` }}
      >
        {TABS.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? location === '/' : location.startsWith(href);
          return (
            <Link key={href} href={href}>
              <button
                type="button"
                className={`w-full flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-semibold transition-colors ${
                  active ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <span className="relative">
                  <Icon
                    className={`w-5 h-5 ${active ? 'text-primary' : 'text-muted-foreground'}`}
                  />
                  {href === '/messages' && <UnreadBadge count={unreadMessages} />}
                </span>
                {label}
              </button>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
