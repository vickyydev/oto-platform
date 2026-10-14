import { Switch, Route, useLocation, Link } from 'wouter';
import { OccupancyChip } from '@/components/shared/OccupancyChip';
import { ThemeMenu, ThemeMenuItems } from '@/components/shared/ThemeMenu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { OperatorBadge } from '@/components/auth/OperatorBadge';
import { BranchSwitcher } from '@/components/shared/BranchSwitcher';
import { usePaymentContextLocked } from '@/pwa/openSale';
import { useOperator } from '@/auth/OperatorContext';
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
import {
  Ticket,
  GlassWater,
  Baby,
  Users,
  ReceiptText,
  Settings,
  BarChart3,
  MessageCircle,
  MoreVertical,
} from 'lucide-react';

const TABS = [
  { href: '/', label: 'Tickets', icon: Ticket, exact: true },
  { href: '/order-station', label: 'F&B', icon: GlassWater, exact: false },
  { href: '/drop-off', label: 'Check-in', icon: Baby, exact: false },
  { href: '/parties', label: 'Events', icon: Users, exact: false },
  { href: '/history', label: 'History', icon: ReceiptText, exact: false },
  { href: '/today', label: 'Today', icon: BarChart3, exact: false },
  { href: '/messages', label: 'Messages', icon: MessageCircle, exact: false },
];

/**
 * SCRUM-509 — the phone bar's overflow menu: the theme switches and Station
 * setup behind one button, in the theme menu's own trigger style. Drawn below
 * `sm:` (640px) only, where the two buttons it replaces are hidden.
 */
function PhoneBarMenu() {
  const [, navigate] = useLocation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="More"
          aria-label="Theme and station setup"
          className="sm:hidden shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-full border border-border bg-muted text-muted-foreground hover-elevate active-elevate-2"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/station-setup')}>
          <Settings className="w-4 h-4" />
          Station setup
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const paymentContextLocked = usePaymentContextLocked();
  // SCRUM-371 — under a staff lock the shell stays mounted so the ticket till
  // keeps its sale (`App.tsx`); the bars are not drawn, so nothing they open
  // (the branch picker, the theme menu) can portal over the lock screen.
  const { locked } = useOperator();

  // Station setup is a full-screen page with its own header + Close button, so we
  // render it without the mobile tab chrome to avoid a double frame / clipping.
  // Its wizard and settings have addresses below it (S2-04) and are the same
  // full-screen page, so the whole branch is taken, not the one path.
  if (location.startsWith('/station-setup')) {
    return <StationSetup />;
  }

  // Unread WhatsApp count for the Messages tab badge. Recomputed each render;
  // navigating between surfaces refreshes it.
  const unreadMessages = getTotalUnreadCount();

  return (
    <div className="h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
      {/* Top bar — compact: logo | occupancy | park | settings | operator badge.
          SCRUM-509 — what gives way on a narrow phone, so the Lock button is
          always on screen: below `sm:` the theme and Station setup buttons
          fold into one overflow menu first; then the start cluster (logo,
          occupancy, park) yields — the park chip narrows, and what still does
          not fit is cut at the cluster's edge, never the end cluster. The
          logo keeps its own width. From `sm:` up the bar is as it was. */}
      {!locked && <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30" inert={paymentContextLocked}>
        <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden">
          <Link href="/" aria-label="Oto home" className="shrink-0">
            <img src={logoUrl} alt="Oto" className="h-7 w-auto max-w-none cursor-pointer" />
          </Link>
          <OccupancyChip />
          <div className="min-w-0 flex">
            <BranchSwitcher />
          </div>
        </div>
        <ThemeMenu triggerClassName="hidden sm:inline-flex shrink-0" />
        <Link href="/station-setup" aria-label="Station setup" className="hidden sm:inline-flex shrink-0">
          <button
            type="button"
            title="Station setup"
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        </Link>
        <PhoneBarMenu />
        <OperatorBadge />
      </div>}

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
      {!locked && <nav
        className="shrink-0 grid border-t bg-card/30"
        inert={paymentContextLocked}
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
      </nav>}
    </div>
  );
}
