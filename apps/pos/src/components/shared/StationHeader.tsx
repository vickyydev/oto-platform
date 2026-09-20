import { ReactNode } from 'react';
import { Link } from 'wouter';
import { Ticket, GlassWater, ShoppingBag, Users, ReceiptText, Settings, Baby, LineChart, MessageCircle, PackageX, AlertTriangle } from 'lucide-react';
import { OperatorBadge } from '@/components/auth/OperatorBadge';
import { OccupancyChip } from '@/components/shared/OccupancyChip';
import { ThemeMenu } from '@/components/shared/ThemeMenu';
import { BranchSwitcher } from '@/components/shared/BranchSwitcher';
import { PricingModeIndicator } from '@/components/shared/PricingModeIndicator';
import { StationLinkBanner } from '@/components/shared/StationLinkBanner';
import { useStation } from '@/station/StationContext';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { getRestockAlerts } from '@/lib/inventory';
import { getTotalUnreadCount, UnreadBadge } from '@/components/mobile/messaging/messagingUtils';
import logoUrl from '@/assets/logo-oto.png';

type Surface = 'tickets' | 'fnb' | 'merch' | 'parties' | 'dropoff' | 'history' | 'today' | 'messages';

interface StationHeaderProps {
  /** Which staff surface is currently active — highlights its nav button. */
  active: Surface;
  /** Optional content shown next to the logo (e.g. the live customer chip). */
  leftExtra?: ReactNode;
  /** Optional content shown before the operator badge (e.g. Scan Discount). */
  rightExtra?: ReactNode;
}

const baseBtn =
  'rounded-md px-3 h-9 flex items-center gap-1.5 text-sm font-semibold transition-colors';
const activeBtn = `${baseBtn} bg-background shadow`;
const idleBtn = `${baseBtn} text-muted-foreground hover:text-foreground`;

// Shared top bar for every staff-facing surface so the brand logo and the POS
// navigation (menu buttons) are identical on each screen.
export function StationHeader({ active, leftExtra, rightExtra }: StationHeaderProps) {
  const { station } = useStation();
  const { inventory } = useCatalogStore();
  // From the F&B surface, Parties carries the surface hint so PartyDetail leads
  // with kitchen/bar emphasis. Everywhere else it's the plain reception view.
  const partiesHref = active === 'fnb' ? '/parties?surface=fnb' : '/parties';
  // Unread WhatsApp count for the Messages nav badge. Recomputed each render;
  // navigating between surfaces refreshes it.
  const unread = getTotalUnreadCount();

  // Live low-stock reminder shown on EVERY staff surface (same source of truth as
  // the Admin Inventory panel + nav badge): so the floor team notices a depleted
  // line without opening Admin. Out-of-stock first.
  const alerts = getRestockAlerts(inventory);
  const outCount = alerts.filter((a) => a.status === 'out').length;
  const lowCount = alerts.length - outCount;

  return (
    <>
    {/* Flex header: the logo/chip (left) and actions/badge (right) clusters take
        their content width; the nav lives in a flex-1 band between them and is
        centred within it. With six surfaces the nav can be wide, so it shrinks and
        scrolls horizontally on a crowded screen (e.g. the till with its Scan
        Discount action) rather than overlapping the side clusters. */}
    <div className="shrink-0 flex items-center gap-3 px-6 h-16 border-b bg-card/30">
      <div className="flex items-center gap-3 min-w-0 shrink">
        <Link href="/" aria-label="Oto home">
          <img src={logoUrl} alt="Oto" className="h-8 w-auto cursor-pointer" />
        </Link>
        <OccupancyChip />
        <BranchSwitcher />
        {leftExtra}
      </div>

      {/* Permanent POS navigation — always available between surfaces. */}
      <div className="flex-1 min-w-0 flex justify-center">
      <nav className="max-w-full overflow-x-auto flex items-center gap-1 rounded-lg bg-muted p-1">
          {active === 'tickets' ? (
            <span className={activeBtn}>
              <Ticket className="w-4 h-4" />
              Tickets
            </span>
          ) : (
            <Link href="/">
              <button className={idleBtn}>
                <Ticket className="w-4 h-4" />
                Tickets
              </button>
            </Link>
          )}

          {active === 'fnb' ? (
            <span className={activeBtn}>
              <GlassWater className="w-4 h-4" />
              F&amp;B
            </span>
          ) : (
            <Link href="/order-station">
              <button className={idleBtn}>
                <GlassWater className="w-4 h-4" />
                F&amp;B
              </button>
            </Link>
          )}

          {active === 'merch' ? (
            <span className={activeBtn}>
              <ShoppingBag className="w-4 h-4" />
              Shop
            </span>
          ) : (
            <Link href="/merch-station">
              <button className={idleBtn}>
                <ShoppingBag className="w-4 h-4" />
                Shop
              </button>
            </Link>
          )}

          {active === 'parties' ? (
            <span className={activeBtn}>
              <Users className="w-4 h-4" />
              Events
            </span>
          ) : (
            <Link href={partiesHref}>
              <button className={idleBtn}>
                <Users className="w-4 h-4" />
                Events
              </button>
            </Link>
          )}

          {active === 'dropoff' ? (
            <span className={activeBtn}>
              <Baby className="w-4 h-4" />
              Check-in
            </span>
          ) : (
            <Link href="/drop-off">
              <button className={idleBtn}>
                <Baby className="w-4 h-4" />
                Check-in
              </button>
            </Link>
          )}

          {active === 'history' ? (
            <span className={activeBtn}>
              <ReceiptText className="w-4 h-4" />
              History
            </span>
          ) : (
            <Link href="/history">
              <button className={idleBtn}>
                <ReceiptText className="w-4 h-4" />
                History
              </button>
            </Link>
          )}

          {active === 'today' ? (
            <span className={activeBtn}>
              <LineChart className="w-4 h-4" />
              Today
            </span>
          ) : (
            <Link href="/today">
              <button className={idleBtn}>
                <LineChart className="w-4 h-4" />
                Today
              </button>
            </Link>
          )}

          {active === 'messages' ? (
            <span className={activeBtn}>
              <span className="relative">
                <MessageCircle className="w-4 h-4" />
                <UnreadBadge count={unread} />
              </span>
              Messages
            </span>
          ) : (
            <Link href="/messages">
              <button className={idleBtn}>
                <span className="relative">
                  <MessageCircle className="w-4 h-4" />
                  <UnreadBadge count={unread} />
                </span>
                Messages
              </button>
            </Link>
          )}
      </nav>
      </div>

      <div className="flex items-center justify-end gap-3 min-w-0 shrink">
        <PricingModeIndicator />
        {rightExtra}
        <div className="shrink-0">
          <ThemeMenu />
        </div>
        <Link href="/station-setup">
          <button className={idleBtn} title="Station setup">
            <Settings className="w-4 h-4" />
            {/* Label only on very wide screens — the nav now has six surfaces, so
                hiding it below 2xl keeps the centred nav from overlapping this. */}
            <span className="hidden 2xl:inline max-w-[140px] truncate">
              {station?.stationName ?? 'Set up station'}
            </span>
          </button>
        </Link>
        <OperatorBadge />
      </div>
    </div>

    {/* POS-wide link strip: shown only when this till is working without the
        internet, or cannot reach the platform at all. Above the low-stock
        strip because a link fault outranks a low bottle of syrup — and, like
        it, hidden entirely when there is nothing to say. */}
    <StationLinkBanner />

    {/* POS-wide low-stock reminder strip. Hidden when nothing needs restocking. */}
    {alerts.length > 0 && (
      <div
        role="status"
        className={`shrink-0 flex items-center gap-2 px-6 py-1.5 text-sm font-semibold border-b ${
          outCount > 0
            ? 'bg-destructive/15 text-destructive border-destructive/30'
            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
        }`}
      >
        {outCount > 0 ? (
          <PackageX className="w-4 h-4 shrink-0" />
        ) : (
          <AlertTriangle className="w-4 h-4 shrink-0" />
        )}
        <span className="shrink-0">
          {outCount > 0 && `${outCount} out of stock`}
          {outCount > 0 && lowCount > 0 && ' · '}
          {lowCount > 0 && `${lowCount} low`}
        </span>
        <span className="min-w-0 truncate font-normal opacity-80">
          {alerts
            .slice(0, 4)
            .map((a) =>
              a.item.variants.length > 1
                ? `${a.item.name} (${a.variant.label})`
                : a.item.name,
            )
            .join(', ')}
          {alerts.length > 4 && ` +${alerts.length - 4} more`}
        </span>
      </div>
    )}
    </>
  );
}
