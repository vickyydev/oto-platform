import { ReactNode } from 'react';
import { Link } from 'wouter';
import { Ticket, GlassWater, ShoppingBag, Users, ReceiptText, Settings, Baby, LineChart, MessageCircle, PackageX, AlertTriangle } from 'lucide-react';
import { OperatorBadge } from '@/components/auth/OperatorBadge';
import { OccupancyChip } from '@/components/shared/OccupancyChip';
import { ThemeMenu } from '@/components/shared/ThemeMenu';
import { BranchSwitcher } from '@/components/shared/BranchSwitcher';
import { PricingModeIndicator } from '@/components/shared/PricingModeIndicator';
import { PrinterHealthIndicator } from '@/components/shared/PrinterHealthIndicator';
import { CashMovementButton } from '@/components/shared/CashMovementButton';
import { StationLinkBanner } from '@/components/shared/StationLinkBanner';
import { useStation } from '@/station/StationContext';
import { sellableRestockAlerts, useSellableStockVersion } from '@/api/stock';
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

/**
 * `shrink-0 whitespace-nowrap` is what makes the nav's `overflow-x-auto`
 * mean anything.
 *
 * A flex item shrinks to min-content by default, so without these the tabs
 * squeezed themselves narrower instead of overflowing, the nav never scrolled,
 * and the only label with a break opportunity in it — `Check-in`, on its
 * hyphen — wrapped to two lines and was then clipped by the row's height. It
 * read `Che` over `i` on a perfectly healthy till at 1600px, because the six
 * tabs are wider than the band between the side clusters: measured at 782px
 * of tabs in a 755px band on one till, and the gap widens with a longer
 * station name, an extra chip, or a printer fault. The figures move; the
 * relationship does not, which is why the tabs must overflow rather than
 * squeeze.
 *
 * A reviewer found it in a screenshot. Nobody had seen it in the code,
 * including in a comment two lines below claiming the nav "shrinks and scrolls
 * horizontally on a crowded screen" — it did the first and never the second.
 */
const baseBtn =
  'shrink-0 whitespace-nowrap rounded-md px-3 h-9 flex items-center gap-1.5 text-sm font-semibold transition-colors';
const activeBtn = `${baseBtn} bg-background shadow`;
const idleBtn = `${baseBtn} text-muted-foreground hover:text-foreground`;

// Shared top bar for every staff-facing surface so the brand logo and the POS
// navigation (menu buttons) are identical on each screen.
export function StationHeader({ active, leftExtra, rightExtra }: StationHeaderProps) {
  const { station } = useStation();
  // S2-14b round 2 — the strip reads the platform's counts (`api/stock.ts`),
  // refreshed after every sale the till closes and every stock write, not the
  // ported seed's in-memory inventory.
  useSellableStockVersion();
  // From the F&B surface, Parties carries the surface hint so PartyDetail leads
  // with kitchen/bar emphasis. Everywhere else it's the plain reception view.
  const partiesHref = active === 'fnb' ? '/parties?surface=fnb' : '/parties';
  // Unread WhatsApp count for the Messages nav badge. Recomputed each render;
  // navigating between surfaces refreshes it.
  const unread = getTotalUnreadCount();

  // Live low-stock reminder shown on EVERY staff surface (same source of truth as
  // the Admin Inventory panel + nav badge): so the floor team notices a depleted
  // line without opening Admin. Out-of-stock first.
  const alerts = sellableRestockAlerts();
  const outCount = alerts.filter((a) => a.status === 'out').length;
  const lowCount = alerts.length - outCount;

  return (
    <>
    {/* Flex header: the logo/chip (left) and actions/badge (right) clusters take
        their content width; the nav lives in a band between them and is
        centred within it. With six surfaces the nav is wider than that band on
        most screens, so the band scrolls horizontally rather than overlapping
        the side clusters or clipping a label — which needs `shrink-0` on the
        tabs themselves to work at all; see `baseBtn` above for what happened
        without it. On one row the band has basis zero, so it takes what the
        two clusters leave, and scrolls.

        SCRUM-505 — WHEN THE ROW RUNS OUT. The prototype's header is one row
        with no rule for a narrow tablet (below 768px the phone shell takes
        over; its only other breakpoint here is the station name at 2xl), and
        its clusters were `min-w-0 shrink`. Where the row ran short they shrank
        under their own content: the actions spilled leftwards over the park
        chip (`justify-end` overflows towards the start), the logo, an image
        the browser treats as compressible, was squeezed, and the band got 8px
        and showed no tab. The prototype's own header did this at 768
        (measured in Chromium with its own Khun Anan and HKT Central: an 8px
        band, the logo at 50 of its 74px, the pricing chip 7px over the park
        chip). The Cash action, the occupancy chip's "no gate" words and the
        two-line park name have taken more of the row since: with staging's
        content the Cash button sat 81px over the park chip from 768 to 820
        and the band was 8px wide up to 1024.

        So the clusters keep their content width (`shrink-0`) and the row
        wraps instead (`flex-wrap`): nothing is drawn over anything. Three
        rules, in the header's own vocabulary:
          - below lg (an upright tablet) the tabs take a row of their own under
            the bar, full width and centred, in the same pill with the same
            scroll, as the phone shell gives its tabs a bar of their own;
          - below xl the bar's labels drop to their icons the way the prototype
            drops them at its tightest widths: "in park", the pricing words,
            and Cash as the Settings button drops the station name. Each keeps
            its words in its tooltip;
          - the band is never narrower than two whole tabs (Tickets and F&B,
            181px measured), so where the clusters would squeeze it under that
            the actions wrap onto a row of their own, `ml-auto` keeping them at
            the right, instead of the tabs vanishing. Only unusually wide
            content does that: a printer chip, or a long name beside a stale
            gate, on the narrowest tablets and just above xl, where the
            labels come back.
        Each cluster is the old row's height (`h-16` less its 1px border), so
        a row of the bar is the 64px it was, and from xl up, with the till's
        usual content, the header is the prototype's one row as it was.
        Measured at nine widths from 360 to 1600px in
        `test/scrum-505-header-widths.test.ts`. */}
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 px-6 border-b bg-card/30">
      <div className="flex items-center gap-3 h-[calc(4rem-1px)] shrink-0">
        <Link href="/" aria-label="Oto home">
          <img src={logoUrl} alt="Oto" className="h-8 w-auto cursor-pointer" />
        </Link>
        <OccupancyChip />
        <BranchSwitcher />
        {leftExtra}
      </div>

      {/* Permanent POS navigation — always available between surfaces. */}
      <div className="grow basis-full min-w-[184px] order-last pb-3 flex justify-center lg:basis-0 lg:order-none lg:pb-0">
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

      <div className="flex items-center justify-end gap-3 h-[calc(4rem-1px)] shrink-0 ml-auto">
        {/* Silent while every printer on this station is well; red the moment
            one is out of paper or stops answering (S2-06, PROJECT_CONTEXT
            §7.3) — before anybody notices a receipt that never came out. */}
        <PrinterHealthIndicator />
        {/* S2-15a — the Cash action: record a paid-out or a safe drop against the
            branch's one combined count (UI addition). */}
        <CashMovementButton className={idleBtn} />
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
            .map((a) => (a.sizeLabel ? `${a.name} (${a.sizeLabel})` : a.name))
            .join(', ')}
          {alerts.length > 4 && ` +${alerts.length - 4} more`}
        </span>
      </div>
    )}
    </>
  );
}
