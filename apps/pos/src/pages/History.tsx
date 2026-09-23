import { useCallback, useEffect, useMemo, useState } from 'react';
import { StationHeader } from '@/components/shared/StationHeader';
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
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SaleDetail } from '@/components/history/SaleDetail';
import { TransactionCard } from '@/components/history/TransactionCard';
import { MemberActivity } from '@/components/history/MemberActivity';
import { LEDGER_ONLY_NOTICE } from '@/components/history/ledgerNotice';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { Search, X, ScanLine, ArrowLeft, Phone, ArrowRight, Info, Calendar } from 'lucide-react';

/**
 * ORDER HISTORY — the platform's sale ledger, not a sample of one (SCRUM-238).
 *
 * WHAT CHANGED AND WHY. This page read `mockApi.getTransactions()`, so a park
 * whose till had been recording real sales for weeks saw eight invented ones
 * (#D9N4T7, #A4K2P9, dated 14–15 June) and none of its own. The design is
 * untouched — the same search, the same tabs, the same cards, the same detail
 * panel — and only the data source moved: `GET /sales` for the day's list,
 * `GET /sales/:id` for one sale.
 *
 * THERE IS NO MOCK FALLBACK, deliberately. A History that quietly showed made-up
 * transactions when the platform was unreachable would be worse than one that
 * showed nothing: the figures on this page are read as the day's takings. When
 * the read fails, the page says so and lists nothing.
 *
 * WHAT STILL DOES NOT WORK is named once, in `LEDGER_ONLY_NOTICE`: refunds,
 * voids, reprints, adding time and the bracelet scan are S2-11 (SCRUM-208), and
 * the scan needs band codes the ledger does not carry yet. Those controls are
 * disabled with that reason rather than left to act on nothing.
 */

type TabKey = 'all' | TxnKind;
// The list is the default; "phone" looks up a member and "member" shows that
// member's orders. A selected sale opens SaleDetail on top of either.
type View = 'list' | 'phone' | 'member';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'fnb', label: 'F&B' },
];

/** What went wrong, in the words the rest of the till uses for the same faults. */
function explain(err: unknown, subject: string): string {
  if (err instanceof NetworkError) {
    return `No connection to the platform, so ${subject} cannot be read here.`;
  }
  if (isMissingRoute(err)) {
    return `This deployment has no sale ledger yet (SCRUM-203), so ${subject} cannot be read.`;
  }
  return err instanceof ApiError ? err.message : `${subject} could not be read.`;
}

export default function History() {
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
   * member's id filters the same sale list. It is THIS BRANCH's sales — that is
   * the width `GET /sales` answers for a reception session — so the header says
   * so rather than repeating the prototype's "all branches".
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
  // Universal search across reference (receipt number), customer name/phone,
  // operator, and amount — combined with the active tab filter.
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

  const back = (
    <div className="shrink-0 mb-2">
      <Button variant="ghost" size="sm" className="gap-2 -ml-2" onClick={backToList}>
        <ArrowLeft className="w-4 h-4" />
        Back to all transactions
      </Button>
    </div>
  );

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <StationHeader active="history" />

      {/* Body */}
      <div className="flex-1 min-h-0 p-6">
        <div className="mx-auto h-full max-w-5xl flex flex-col min-h-0">
          {selected ? (
            <SaleDetail txn={selected} timeZone={timeZone} onBack={() => setSelected(null)} />
          ) : view === 'phone' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {back}
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-6 animate-in fade-in duration-500">
                <div className="w-full max-w-2xl">
                  <div className="flex flex-col items-center text-center mb-8">
                    <div className="w-20 h-20 rounded-2xl bg-primary/20 text-primary flex items-center justify-center mb-4">
                      <Phone className="w-10 h-10" />
                    </div>
                    <h2 className="text-3xl font-bold tracking-tight">Find by phone</h2>
                    <p className="text-muted-foreground mt-2 text-lg">
                      Enter a member's phone number to see all their orders.
                    </p>
                  </div>
                  <form onSubmit={submitPhone} className="flex gap-3 items-end">
                    <div className="flex-1">
                      <PhoneInput
                        value={phoneInput}
                        onChange={setPhoneInput}
                        label=""
                        inputClassName="h-16 text-2xl px-5"
                      />
                    </div>
                    <Button
                      type="submit"
                      size="lg"
                      className="h-16 px-8 text-xl gap-2 shrink-0"
                      disabled={!phoneInput.trim()}
                    >
                      Find
                      <ArrowRight className="w-5 h-5" />
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          ) : view === 'member' ? (
            memberError ? (
              <div className="flex-1 min-h-0 flex flex-col">
                {back}
                <div className="flex-1 flex items-center justify-center text-center text-muted-foreground px-6">
                  {memberError}
                </div>
              </div>
            ) : !memberActivity ? (
              <div className="flex-1 min-h-0 flex flex-col">
                {back}
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  Looking this member up…
                </div>
              </div>
            ) : (
              <MemberActivity
                activity={memberActivity}
                onOpenTxn={(t) => setSelected(t as HistoryTxn)}
                onBack={backToList}
                spentLabel={`Total spent (${branch.name})`}
                bandsLabel="Bracelet codes arrive with SCRUM-208"
                badgeFor={(t) => (t as HistoryTxn).badge}
                timeZone={timeZone}
              />
            )
          ) : (
            <>
              {/* Universal search + trading day + the lookups */}
              <div className="shrink-0 mb-4 flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    inputMode="search"
                    aria-label="Search transactions"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, receipt number, operator, amount…"
                    className="w-full h-12 pl-12 pr-12 rounded-xl bg-muted/50 border border-border text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                      className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  )}
                </div>
                {/* The trading day on screen — SCRUM-238's one added control. */}
                <div className="relative shrink-0">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="date"
                    aria-label="Trading day"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="h-12 pl-9 pr-3 rounded-xl bg-muted/50 border border-border text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-12 gap-2 shrink-0"
                  onClick={() => setView('phone')}
                >
                  <Phone className="w-5 h-5" />
                  Find by phone
                </Button>
                <Button
                  size="lg"
                  className="h-12 gap-2 shrink-0"
                  disabled
                  title={LEDGER_ONLY_NOTICE}
                >
                  <ScanLine className="w-5 h-5" />
                  Scan bracelet
                </Button>
              </div>

              {/* Tabs */}
              <div className="shrink-0 mb-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
                  {TABS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTab(t.key)}
                      className={`rounded-md px-4 h-9 text-sm font-semibold transition-colors ${
                        tab === t.key
                          ? 'bg-background text-foreground shadow'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                {txns && (
                  <span className="text-sm text-muted-foreground">
                    {saleCountLabel(txns.length)} recorded at {branch.name}
                  </span>
                )}
              </div>

              {/* The one notice: what this page cannot do yet, and the ticket. */}
              <div className="shrink-0 mb-4 rounded-lg border border-dashed p-3 text-sm text-muted-foreground flex items-start gap-2">
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{LEDGER_ONLY_NOTICE}</span>
              </div>

              {error ? (
                <div className="flex-1 flex items-center justify-center text-center text-muted-foreground px-6">
                  {error}
                </div>
              ) : !txns ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  Reading the day's sales…
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  {q
                    ? `No transactions match “${query.trim()}”.`
                    : tab !== 'all' && (txns?.length ?? 0) > 0
                      ? `No ${TABS.find((t) => t.key === tab)?.label.toLowerCase() ?? tab} sales on ${date} — ${txns!.length} other sale${txns!.length === 1 ? '' : 's'} that day.`
                      : `No sales recorded on ${date}.`}
                </div>
              ) : (
                <ScrollArea className="flex-1 -mx-1 px-1">
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
                </ScrollArea>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
