import { useCallback, useEffect, useMemo, useState } from 'react';
import { StationHeader } from '@/components/shared/StationHeader';
import { TxnKind, MemberActivity as MemberActivityData } from '@/types';
import {
  businessDateToday,
  calendarDateIn,
  listSales,
  lookupSales,
  mergeLookup,
  parseHistorySearch,
  saleCountLabel,
  spentOf,
  toTxn,
  type ApiSale,
  type HistoryTxn,
} from '@/api/history';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { membersApi } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { useBranch } from '@/branch/BranchContext';
import { explainLookup, useSearchLookup } from '@/lib/historyLookup';
import { readRefundRequests, type RefundRequestNote } from '@/lib/refundRequests';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SaleDetail } from '@/components/history/SaleDetail';
import { TransactionCard } from '@/components/history/TransactionCard';
import { MemberActivity } from '@/components/history/MemberActivity';
import { ClientActivity } from '@/components/history/ClientActivity';
import { LEDGER_ONLY_NOTICE } from '@/components/history/ledgerNotice';
import { PhoneInput } from '@/components/shared/PhoneInput';
import {
  Search,
  X,
  ScanLine,
  ArrowLeft,
  Phone,
  ArrowRight,
  Info,
  Calendar,
  AlertCircle,
  Undo2,
} from 'lucide-react';

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
 * S2-11 (SCRUM-208) BRINGS BACK WHAT THE PROTOTYPE'S PAGE DID with the ledger
 * behind it: the bracelet scan (`GET /sales/lookup?band=`, the prototype's
 * `getTransactionsByWristband`), the phone lookup across days
 * (`?phone=`, `getTransactionsByMember`), the same two lookups from the search
 * box when what is typed is a band code or a phone, and — on the detail —
 * refunds and reprints. Refunds asked for while the station was offline are
 * noted on this till and listed here until a manager makes them. What is
 * still missing is named once, in `LEDGER_ONLY_NOTICE`.
 */

type TabKey = 'all' | TxnKind;
// The list is the default; "scan" takes a bracelet code and "band" shows its
// orders; "phone" looks up a member and "member" shows that member's orders.
// A selected sale opens SaleDetail on top of any of them.
type View = 'list' | 'scan' | 'band' | 'phone' | 'member';

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

/** The orders one bracelet leads to, and who they belong to. */
interface BandResult {
  code: string;
  label: string;
  sales: HistoryTxn[];
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
  /** Bumped to read the day again without changing the day — after a void (SCRUM-430) or a refund (S2-11). */
  const [reread, setReread] = useState(0);

  const [phoneInput, setPhoneInput] = useState('');
  const [memberActivity, setMemberActivity] = useState<MemberActivityData | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  // S2-11 — the bracelet scan.
  const [scanInput, setScanInput] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [bandResult, setBandResult] = useState<BandResult | null>(null);
  const [bandError, setBandError] = useState<string | null>(null);

  /** Refunds noted on this till while the station was offline, read again on the way back from a sale. */
  const [refundRequests, setRefundRequests] = useState<RefundRequestNote[]>(() => readRefundRequests());
  useEffect(() => {
    if (!selected) setRefundRequests(readRefundRequests());
  }, [selected]);

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
  }, [branchApiId, date, reread]);

  /** One sale on every list on this page, replaced by what `patch` makes of it. */
  const patchEverywhere = useCallback(
    (saleId: string, patch: (t: HistoryTxn) => HistoryTxn) => {
      const swap = (t: HistoryTxn) => (t.id === saleId ? patch(t) : t);
      setMemberActivity((current) =>
        current
          ? { ...current, transactions: current.transactions.map((t) => swap(t as HistoryTxn)) }
          : current,
      );
      setBandResult((current) => (current ? { ...current, sales: current.sales.map(swap) } : current));
    },
    [],
  );

  /**
   * A sale voided on its page (SCRUM-430): the day's list is read again from
   * the ledger, so its row stops saying "Unpaid" without a reload of the page;
   * a member's orders on screen mark that sale voided in place — the platform
   * has just confirmed the void, and reading them again would mean typing the
   * phone again.
   */
  const onVoided = useCallback(
    (saleId: string) => {
      setReread((n) => n + 1);
      patchEverywhere(saleId, (t) =>
        toTxn({ ...t.ledger, status: 'voided' }, { id: branch.id, name: branch.name }),
      );
    },
    [branch.id, branch.name, patchEverywhere],
  );

  /**
   * A sale refunded on its page (S2-11): the same, with the sale the refund
   * answered — its status and its refunded total — so every row showing it
   * says "Partial refund" or "Refunded" at once.
   */
  const onRefunded = useCallback(
    (saleId: string, refunded: ApiSale) => {
      setReread((n) => n + 1);
      patchEverywhere(saleId, (t) =>
        toTxn(
          { ...t.ledger, status: refunded.status, totals: refunded.totals },
          { id: branch.id, name: branch.name },
        ),
      );
    },
    [branch.id, branch.name, patchEverywhere],
  );

  const backToList = () => {
    setPhoneInput('');
    setMemberActivity(null);
    setMemberError(null);
    setScanInput('');
    setScanError(null);
    setBandResult(null);
    setBandError(null);
    setView('list');
  };

  /**
   * A member's orders, from the ledger: the phone finds the member, and the
   * platform's phone lookup (`GET /sales/lookup?phone=`, S2-11) finds every
   * sale of theirs, on any day. It is THIS BRANCH's sales — that is the width
   * the ledger answers for a reception session — so the header says so rather
   * than repeating the prototype's "all branches". A deployment without the
   * lookup still answers by the member's id, as it did before S2-11.
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
        const sales = await lookupSales(branchApiId, { phone: member.phone })
          .then((found) => found.sales)
          .catch((err: unknown) => {
            if (isMissingRoute(err)) return listSales(branchApiId, { memberId: member.id });
            throw err;
          });
        const withBranch = sales.map((t) => ({
          ...t,
          branchId: branch.id,
          branchName: branch.name,
        }));
        setMemberActivity({
          member: apiMemberToMember(member),
          phone: member.phone,
          bandCodes: [],
          transactions: withBranch,
          totalSpent: spentOf(withBranch),
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

  /**
   * THE BRACELET SCAN (S2-11) — the prototype's "Scan bracelet" view
   * (`ScanWristband` in History, `getTransactionsByWristband`). A scanner that
   * types reads the band's QR into the box; staff can also type the short code
   * printed under it. The platform finds the band and its sale; nothing here
   * checks the code's signature, which is the gate's job, not History's.
   */
  const submitScan = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const search = parseHistorySearch(scanInput);
      if (search.kind !== 'band') {
        setScanError(
          'That is not a bracelet code. Scan the QR on the band, or type the short code printed under it — for example T1-7KMQ4X.',
        );
        return;
      }
      setScanError(null);
      setView('band');
      setBandResult(null);
      setBandError(null);
      try {
        const found = await lookupSales(branchApiId, { band: search.code });
        setBandResult({
          code: search.code,
          label: search.label,
          sales: found.sales.map((t) => ({ ...t, branchId: branch.id, branchName: branch.name })),
        });
      } catch (err) {
        setBandError(explainLookup(err, 'band'));
      }
    },
    [scanInput, branchApiId, branch.id, branch.name],
  );

  /** The search box asking the platform, when what it holds is a band code or a phone. */
  const lookup = useSearchLookup(query, branchApiId, reread);

  const q = query.trim().toLowerCase();
  // Universal search across reference (receipt number), customer name/phone,
  // operator, and amount — combined with the active tab filter — plus, for a
  // band code or a phone, what the platform found for it on any day.
  const filtered = useMemo(() => {
    const all = txns ?? [];
    const onTab = (t: HistoryTxn) => tab === 'all' || t.kind === tab;
    const byTab = all.filter(onTab);
    if (!q) return byTab;
    const local = byTab.filter(
      (t) =>
        t.reference.toLowerCase().includes(q) ||
        (t.customerLabel?.toLowerCase().includes(q) ?? false) ||
        (t.ledger.member?.phone.toLowerCase().includes(q) ?? false) ||
        t.operatorName.toLowerCase().includes(q) ||
        String(t.total).includes(q),
    );
    return mergeLookup(local, lookup.sales ? lookup.sales.filter(onTab) : null);
  }, [txns, tab, q, lookup.sales]);

  const lookupCaption =
    lookup.search.kind === 'text'
      ? null
      : lookup.error
        ? lookup.error
        : lookup.pending
          ? `Looking up ${lookup.search.kind === 'band' ? `bracelet ${lookup.search.label}` : 'this phone number'}…`
          : `${lookup.search.kind === 'band' ? `Bracelet ${lookup.search.label}` : 'This phone number'}: ${saleCountLabel(lookup.sales?.length ?? 0)} on the platform, any day`;

  const back = (
    <div className="shrink-0 mb-2">
      <Button variant="ghost" size="sm" className="gap-2 -ml-2" onClick={backToList}>
        <ArrowLeft className="w-4 h-4" />
        Back to all transactions
      </Button>
    </div>
  );

  const bandHolder = bandResult?.sales.find((t) => t.ledger.member)?.ledger.member ?? null;

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <StationHeader active="history" />

      {/* Body */}
      <div className="flex-1 min-h-0 p-6">
        <div className="mx-auto h-full max-w-5xl flex flex-col min-h-0">
          {selected ? (
            <SaleDetail
              txn={selected}
              timeZone={timeZone}
              onBack={() => setSelected(null)}
              onVoided={onVoided}
              onRefunded={onRefunded}
            />
          ) : view === 'scan' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {back}
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-6 animate-in fade-in duration-500">
                <div className="w-full max-w-2xl">
                  <div className="flex flex-col items-center text-center mb-8">
                    <div className="w-20 h-20 rounded-2xl bg-primary/20 text-primary flex items-center justify-center mb-4">
                      <ScanLine className="w-10 h-10" />
                    </div>
                    <h2 className="text-3xl font-bold tracking-tight">Scan bracelet</h2>
                    <p className="text-muted-foreground mt-2 text-lg">
                      Scan or type a bracelet code to see everything bought on it.
                    </p>
                  </div>
                  <form onSubmit={submitScan} className="flex gap-3 mb-3">
                    <Input
                      autoFocus
                      value={scanInput}
                      onChange={(e) => {
                        setScanInput(e.target.value);
                        if (scanError) setScanError(null);
                      }}
                      placeholder="Bracelet code e.g. T1-7KMQ4X"
                      aria-label="Bracelet code"
                      className="h-16 text-2xl px-5 font-mono"
                    />
                    <Button
                      type="submit"
                      size="lg"
                      className="h-16 px-8 text-xl gap-2 shrink-0"
                      disabled={!scanInput.trim()}
                    >
                      Find
                      <ArrowRight className="w-5 h-5" />
                    </Button>
                  </form>
                  {scanError && (
                    <div className="flex items-center gap-2 text-destructive text-sm mb-4" role="alert">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{scanError}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : view === 'band' ? (
            bandError ? (
              <div className="flex-1 min-h-0 flex flex-col">
                {back}
                <div className="flex-1 flex items-center justify-center text-center text-muted-foreground px-6">
                  {bandError}
                </div>
              </div>
            ) : !bandResult ? (
              <div className="flex-1 min-h-0 flex flex-col">
                {back}
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  Looking this bracelet up…
                </div>
              </div>
            ) : (
              <ClientActivity
                code={bandResult.label}
                activity={{
                  wristband: null,
                  member: null,
                  transactions: bandResult.sales,
                  totalSpent: spentOf(bandResult.sales),
                  orderCount: bandResult.sales.length,
                }}
                holderName={
                  bandHolder
                    ? bandHolder.nickname || bandHolder.name || bandHolder.phone
                    : bandResult.sales.length > 0
                      ? 'Walk-in'
                      : 'Unknown band'
                }
                memberLine={bandHolder ? { nickname: bandHolder.nickname, phone: bandHolder.phone } : null}
                creditLabel="Wallet credit arrives with S2-14a"
                spentLabel={`Total spent (${branch.name})`}
                onOpenTxn={(t) => setSelected(t as HistoryTxn)}
                onBack={backToList}
                badgeFor={(t) => (t as HistoryTxn).badge}
                timeZone={timeZone}
              />
            )
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
                bandsLabel="Open an order to see its bracelet codes"
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
                    placeholder="Search by name, receipt number, bracelet, phone, operator, amount…"
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
                <Button size="lg" className="h-12 gap-2 shrink-0" onClick={() => setView('scan')}>
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
                {lookupCaption ? (
                  <span className="text-sm text-muted-foreground" data-testid="search-lookup">
                    {lookupCaption}
                  </span>
                ) : (
                  txns && (
                    <span className="text-sm text-muted-foreground">
                      {saleCountLabel(txns.length)} recorded at {branch.name}
                    </span>
                  )
                )}
              </div>

              {/* S2-11 — refunds noted while the station was offline, until one is made. */}
              {refundRequests.length > 0 && (
                <div
                  className="shrink-0 mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2"
                  data-testid="refund-requests-waiting"
                >
                  <Undo2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="min-w-0">
                    {refundRequests.length === 1
                      ? '1 refund was requested while the station was offline'
                      : `${refundRequests.length} refunds were requested while the station was offline`}
                    {' — '}
                    {[...new Set(refundRequests.map((r) => r.receiptNumber ?? 'a sale with no receipt number'))].join(', ')}
                    . Open the sale to make the refund.
                  </span>
                </div>
              )}

              {/* The one notice: what this page cannot do yet. */}
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
                    ? lookup.pending
                      ? `Looking for “${query.trim()}”…`
                      : `No transactions match “${query.trim()}”.`
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
