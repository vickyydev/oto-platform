import { useCallback, useEffect, useMemo, useState } from 'react';
import { TxnKind, MemberActivity as MemberActivityData } from '@/types';
import {
  businessDateToday,
  calendarDateIn,
  listSales,
  saleCountLabel,
  type HistoryTxn,
} from '@/api/history';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { membersApi } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { useBranch } from '@/branch/BranchContext';
import { TransactionCard } from '@/components/history/TransactionCard';
import { MemberActivity } from '@/components/history/MemberActivity';
import { SaleDetail } from '@/components/history/SaleDetail';
import { LEDGER_ONLY_NOTICE } from '@/components/history/ledgerNotice';
import { Button } from '@/components/ui/button';
import { PhoneInput } from '@/components/shared/PhoneInput';
import {
  Search,
  X,
  ScanLine,
  ArrowLeft,
  Phone,
  ArrowRight,
  ReceiptText,
  Info,
  Calendar,
} from 'lucide-react';

/**
 * ORDER HISTORY ON THE HANDHELD — the same sale ledger the counter reads
 * (SCRUM-320).
 *
 * WHAT WAS WRONG. `pages/History.tsx` was moved onto `GET /sales` by SCRUM-238;
 * this surface — everything under 768px, which is the phone in a floor
 * supervisor's hand — was left on `mockApi.getTransactions()`. So the same park,
 * on the same afternoon, showed its real takings on the iPad and eight invented
 * June orders (#D9N4T7, #A4K2P9) on the phone. A figure that changes with the
 * screen it is read on is worse than no figure.
 *
 * It now reads exactly what the counter reads, through the same `api/history`
 * seam: the branch's own TRADING day (05:00 boundary, not the browser's
 * midnight), a date control to look at another one, the same search, the same
 * cards, and `SaleDetail` for one sale. THERE IS NO MOCK FALLBACK — no
 * connection, a deployment without the route, or a refusal each say so and list
 * nothing, because a page that invents transactions when the platform is
 * unreachable is how a shift ends up counted twice.
 *
 * WHAT IS GONE FROM THIS SCREEN, and why it is not a regression:
 *   - The bracelet scan found a sale by band code. The ledger carries no band
 *     codes yet (they are minted in S2-11 / SCRUM-208), so the button is
 *     disabled with that reason instead of searching sample data.
 *   - Refund, reprint and add-time were mock mutations on mock rows. They are
 *     disabled in `SaleDetail` with the same one sentence — `LEDGER_ONLY_NOTICE`
 *     — that the counter shows, so the two screens cannot drift apart.
 *   - "Yesterday / This week / All time" chips became one date control: the
 *     ledger read answers ONE trading day, and a chip that silently showed a
 *     different span than it named would be the same lie in a smaller place.
 */

type TabKey = 'all' | TxnKind;
/** The list is the default; "phone" looks up a member, "member" shows their orders. */
type View = 'list' | 'phone' | 'member';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'fnb', label: 'F&B' },
];

/**
 * What went wrong, in the words the rest of the till uses for the same faults.
 *
 * Follows `explain` in `pages/History.tsx` — the two History surfaces must fail
 * in the same sentence — with one case that page does not have yet, found by
 * driving this one: see the 5xx branch. It is copied rather than shared because
 * that page belongs to another slice this session; folding both onto one helper
 * is a follow-up when the counter page is next open.
 */
function explain(err: unknown, subject: string): string {
  if (err instanceof NetworkError) {
    return `No connection to the platform, so ${subject} cannot be read here.`;
  }
  if (isMissingRoute(err)) {
    return `This deployment has no sale ledger yet (SCRUM-203), so ${subject} cannot be read.`;
  }
  /**
   * A 5xx carrying no error envelope did not come from the platform: the api's
   * own faults are sent as `INTERNAL`, so an `UNKNOWN` one was written by
   * whatever sits in front of it — the dev proxy, or the deployment's rewrite —
   * and means nothing answered behind that. `fetch` only rejects, and only then
   * is this a `NetworkError`, when the network itself is gone; an api that has
   * stopped while the wifi is fine is the commoner outage by far, and it was
   * putting the bare words "Internal Server Error" in front of somebody trying
   * to read the day's takings.
   */
  if (err instanceof ApiError && err.status >= 500 && err.code === 'UNKNOWN') {
    return `The platform is not answering, so ${subject} cannot be read here.`;
  }
  return err instanceof ApiError ? err.message : `${subject} could not be read.`;
}

export function MobileHistory() {
  const { branch } = useBranch();
  const branchApiId = branch.apiId ?? null;
  const timeZone = branch.timezone;

  const [view, setView] = useState<View>('list');
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<HistoryTxn | null>(null);

  /** The trading day on screen. Empty until the branch's own day is known. */
  const [date, setDate] = useState('');
  const [txns, setTxns] = useState<HistoryTxn[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [phoneInput, setPhoneInput] = useState('');
  const [memberActivity, setMemberActivity] = useState<MemberActivityData | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  // The day the park is on, from the branch's own clock and 05:00 boundary —
  // not the browser's calendar, which between midnight and five belongs to
  // tomorrow while the till is still ringing up today.
  useEffect(() => {
    let cancelled = false;
    if (!branchApiId) {
      setDate(calendarDateIn(timeZone));
      return;
    }
    businessDateToday(branchApiId, timeZone).then((today) => {
      if (!cancelled) setDate(today);
    });
    return () => {
      cancelled = true;
    };
  }, [branchApiId, timeZone]);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setTxns(null);
    setError(null);
    if (!branchApiId) {
      setError('This branch is not on the platform, so it has no recorded sales to show.');
      return;
    }
    listSales(branchApiId, { date })
      .then((sales) => {
        if (!cancelled) setTxns(sales);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(explain(err, "the day's sales"));
      });
    return () => {
      cancelled = true;
    };
  }, [branchApiId, date]);

  const backToList = () => {
    setPhoneInput('');
    setMemberActivity(null);
    setMemberError(null);
    setView('list');
  };

  /**
   * A member's orders, from the ledger: the phone finds the member, and the
   * member's id filters the same sale list. It is THIS BRANCH's sales — the
   * width `GET /sales` answers for a reception session — so `spentLabel` below
   * names the branch rather than "all branches". On THIS surface that label is
   * not on screen at all: see the view's own note about what the prototype's
   * wrapper hides. It is passed so the figure cannot be mislabelled wherever
   * that header does show.
   */
  const submitPhone = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const phone = phoneInput.trim();
      if (!phone) return;
      setView('member');
      setMemberActivity(null);
      setMemberError(null);
      try {
        const { member } = await membersApi.lookup(phone);
        if (!member) {
          setMemberActivity({
            member: null,
            phone,
            bandCodes: [],
            transactions: [],
            totalSpent: 0,
            orderCount: 0,
            branchVisits: [],
          });
          return;
        }
        const sales = await listSales(branchApiId, { memberId: member.id });
        const withBranch = sales.map((t) => ({
          ...t,
          branchId: branch.id,
          branchName: branch.name,
        }));
        // What this member actually paid: an order rung up and never tendered,
        // or one that was voided, is not spend.
        const spent = withBranch
          .filter((t) => t.badge !== 'unpaid' && t.badge !== 'voided')
          .reduce(
            (sum, t) => sum + (t.ledger.totals.grossSatang - t.ledger.totals.refundedSatang) / 100,
            0,
          );
        setMemberActivity({
          member: apiMemberToMember(member),
          phone: member.phone,
          bandCodes: [],
          transactions: withBranch,
          totalSpent: Math.round(spent * 100) / 100,
          orderCount: withBranch.length,
          branchVisits: withBranch.length
            ? [{ branchId: branch.id, branchName: branch.name, count: withBranch.length }]
            : [],
        });
      } catch (err) {
        setMemberError(explain(err, "this member's orders"));
      }
    },
    [phoneInput, branchApiId, branch.id, branch.name],
  );

  const q = query.trim().toLowerCase();
  // Universal search across receipt number, customer name/phone, operator and
  // amount — combined with the active tab filter.
  const filtered = useMemo(() => {
    const all = txns ?? [];
    const byTab = tab === 'all' ? all : all.filter((t) => t.kind === tab);
    if (!q) return byTab;
    return byTab.filter(
      (t) =>
        t.reference.toLowerCase().includes(q) ||
        (t.customerLabel?.toLowerCase().includes(q) ?? false) ||
        (t.ledger.member?.phone.toLowerCase().includes(q) ?? false) ||
        t.operatorName.toLowerCase().includes(q) ||
        String(t.total).includes(q),
    );
  }, [txns, tab, q]);

  /** The mobile surfaces' own header bar — one back control, one title. */
  const header = (title: string) => (
    <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
      <button
        type="button"
        onClick={backToList}
        aria-label="Back to all transactions"
        className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-5 h-5" />
      </button>
      <span className="font-bold truncate">{title}</span>
    </div>
  );

  // ── One sale, full screen ───────────────────────────────────────────────────

  if (selected) {
    return (
      <div className="h-full p-3">
        <SaleDetail
          txn={selected}
          timeZone={timeZone}
          onBack={() => setSelected(null)}
          layout="stacked"
        />
      </div>
    );
  }

  // ── Phone lookup ────────────────────────────────────────────────────────────

  if (view === 'phone') {
    return (
      <div className="flex flex-col h-full">
        {header('Find by phone')}
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="w-full max-w-sm">
            <div className="flex flex-col items-center text-center mb-8">
              <div className="w-16 h-16 rounded-2xl bg-primary/20 text-primary flex items-center justify-center mb-4">
                <Phone className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight">Member lookup</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Enter a member's phone number to see all their orders.
              </p>
            </div>
            <form onSubmit={submitPhone} className="flex flex-col gap-3">
              <PhoneInput value={phoneInput} onChange={setPhoneInput} label="" />
              <Button
                type="submit"
                size="lg"
                className="h-14 text-base gap-2"
                disabled={!phoneInput.trim()}
              >
                Find
                <ArrowRight className="w-5 h-5" />
              </Button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── One member's orders ─────────────────────────────────────────────────────
  // Reuses the counter's component, wrapped exactly as the prototype wrapped it.
  // That wrapper's `[&_.shrink-0.mb-4]:hidden` is a class-shape hack, and it
  // hides more than the duplicate back control it was aimed at: MemberActivity's
  // header card (nickname, phone, bands line, total spent) and ActivityList's
  // filter row and order count carry the same two classes, so none of them
  // render here — the member's orders list, and the header bar's name, are the
  // whole of this screen. Left as the prototype has it (§7); untangling it means
  // a prop on MemberActivity, which is a change to a shared component and
  // another screen's design.

  if (view === 'member') {
    return (
      <div className="flex flex-col h-full">
        {header(memberActivity?.member?.nickname ?? `Member: ${phoneInput || '—'}`)}
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {memberError ? (
            <div className="h-full flex items-center justify-center text-center text-muted-foreground px-2">
              {memberError}
            </div>
          ) : !memberActivity ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              Looking this member up…
            </div>
          ) : (
            <div className="[&_.shrink-0.mb-4]:hidden h-full">
              <MemberActivity
                activity={memberActivity}
                onOpenTxn={(t) => setSelected(t as HistoryTxn)}
                onBack={backToList}
                spentLabel={`Total spent (${branch.name})`}
                bandsLabel="Bracelet codes arrive with SCRUM-208"
                badgeFor={(t) => (t as HistoryTxn).badge}
                timeZone={timeZone}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Main list ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      <div className="shrink-0 px-4 pt-3 pb-2 space-y-3">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            inputMode="search"
            aria-label="Search transactions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Receipt, name, operator, amount…"
            className="w-full h-10 pl-9 pr-9 rounded-xl bg-muted/50 border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* The trading day on screen — what the date chips became. */}
        <div className="relative">
          <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="date"
            aria-label="Trading day"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full h-10 pl-9 pr-3 rounded-xl bg-muted/50 border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        {/* Lookup actions row */}
        <div className="flex gap-2">
          <button
            type="button"
            disabled
            title={LEDGER_ONLY_NOTICE}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-xl border border-border text-xs font-semibold text-muted-foreground opacity-50"
          >
            <ScanLine className="w-4 h-4" />
            Scan bracelet
          </button>
          <button
            type="button"
            onClick={() => setView('phone')}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
          >
            <Phone className="w-4 h-4" />
            Find by phone
          </button>
        </div>

        {/* Segmented tab control */}
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1 w-full">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-1 rounded-md h-8 text-xs font-semibold transition-colors ${
                tab === t.key
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* What this read covers. A full page says it is a page, not a day. */}
        {txns && (
          <div className="text-xs text-muted-foreground">
            {saleCountLabel(txns.length)} recorded at {branch.name}
          </div>
        )}

        {/* The one notice: what this page cannot do yet, and the ticket. */}
        <div className="rounded-lg border border-dashed p-2.5 text-[11px] leading-snug text-muted-foreground flex items-start gap-2">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>{LEDGER_ONLY_NOTICE}</span>
        </div>
      </div>

      {/* Transaction list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {error ? (
          <div className="h-full flex items-center justify-center text-center text-muted-foreground py-16">
            {error}
          </div>
        ) : !txns ? (
          <div className="h-full flex items-center justify-center text-muted-foreground py-16">
            Reading the day's sales…
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3 py-16">
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
              <ReceiptText className="w-7 h-7" />
            </div>
            <div className="text-center px-2">
              <div className="font-semibold text-foreground mb-1">
                {q ? `No transactions match “${query.trim()}”` : `No sales recorded on ${date}`}
              </div>
              {q && <p className="text-xs">Try a different name, receipt number, or amount.</p>}
              {!q && tab !== 'all' && txns.length > 0 && (
                <p className="text-xs">
                  {txns.length} other sale{txns.length === 1 ? '' : 's'} that day, on another tab.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((t) => (
              <TransactionCard
                key={t.id}
                txn={t}
                badge={t.badge}
                timeZone={timeZone}
                onClick={() => setSelected(t)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
