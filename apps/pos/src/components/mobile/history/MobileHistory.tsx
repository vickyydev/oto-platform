import { useCallback, useEffect, useMemo, useState } from 'react';
import { TxnKind, MemberActivity as MemberActivityData, type Wristband } from '@/types';
import { scanWallet } from '@/api/wallet';
import {
  businessDateToday,
  calendarDateIn,
  listSales,
  historyDateRange,
  type HistoryDateFilter,
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
import { TransactionCard } from '@/components/history/TransactionCard';
import { MemberActivity } from '@/components/history/MemberActivity';
import { ClientActivity } from '@/components/history/ClientActivity';
import { Input } from '@/components/ui/input';
import { MobileTransactionDetail } from './MobileTransactionDetail';
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
  AlertCircle,
} from 'lucide-react';

/** The phone reads the park's real ledger, scoped to its business dates. */

type TabKey = 'all' | TxnKind;
/**
 * The list is the default; "scan" takes a bracelet code, "band" shows its
 * orders; "phone" looks up a member, "member" shows their orders.
 */
type View = 'list' | 'scan' | 'band' | 'phone' | 'member';

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
  const [dayScope, setDayScope] = useState<{ branchId: string | null; date: string } | null>(null);
  const [dateFilter, setDateFilter] = useState<HistoryDateFilter>('today');
  const date = dayScope?.branchId === branchApiId ? dayScope.date : '';
  const [txns, setTxns] = useState<HistoryTxn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to read the day again without changing the day — after a void (SCRUM-430). */
  const [reread, setReread] = useState(0);

  const [phoneInput, setPhoneInput] = useState('');
  const [memberActivity, setMemberActivity] = useState<MemberActivityData | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  // S2-11 — the bracelet scan, as on the counter's page.
  const [scanInput, setScanInput] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [bandResult, setBandResult] = useState<{
    code: string;
    label: string;
    sales: HistoryTxn[];
  } | null>(null);
  const [bandError, setBandError] = useState<string | null>(null);
  /** S2-14a round 2 — the platform wallet the scanned band carries, if any. */
  const [bandWallet, setBandWallet] = useState<Wristband | null>(null);

  // The day the park is on, from the branch's own clock and 05:00 boundary —
  // not the browser's calendar, which between midnight and five belongs to
  // tomorrow while the till is still ringing up today.
  useEffect(() => {
    let cancelled = false;
    setSelected(null);
    setTxns(null);
    setView('list');
    setMemberActivity(null);
    setBandResult(null);
    if (!branchApiId) {
      setDayScope({ branchId: branchApiId, date: calendarDateIn(timeZone) });
      return;
    }
    businessDateToday(branchApiId, timeZone).then((today) => {
      if (!cancelled) setDayScope({ branchId: branchApiId, date: today });
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
    listSales(branchApiId, historyDateRange(date, dateFilter))
      .then((sales) => {
        if (!cancelled) setTxns(sales);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(explain(err, 'the selected sales'));
      });
    return () => {
      cancelled = true;
    };
  }, [branchApiId, date, dateFilter, reread]);

  /**
   * A sale voided on its page (SCRUM-430), as on the counter's History: the
   * day's list is read again so its row stops saying "Unpaid", and a member's
   * orders on screen mark that sale voided in place.
   */
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

  const onVoided = useCallback(
    (saleId: string) => {
      setReread((n) => n + 1);
      patchEverywhere(saleId, (t) =>
        toTxn({ ...t.ledger, status: 'voided' }, { id: branch.id, name: branch.name }),
      );
    },
    [branch.id, branch.name, patchEverywhere],
  );

  /** A sale refunded on its page (S2-11): every row showing it takes the refunded totals. */
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

  /** The bracelet scan (S2-11): the platform finds the band and its sale. */
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
      setBandWallet(null);
      // S2-14a round 2 — the band's real credit, beside its sales. A lookup
      // that fails leaves the credit unsaid rather than reading ฿0.
      void scanWallet(search.code).then(setBandWallet, () => setBandWallet(null));
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
        // S2-11 — every sale of theirs on any day, through the phone lookup; a
        // deployment without it still answers by the member's id.
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
          // What this member actually paid, net of refunds: an order rung up
          // and never tendered, or one that was voided, is not spend.
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

  /** The search box asking the platform, when what it holds is a band code or a phone (S2-11). */
  const lookup = useSearchLookup(query, branchApiId, reread);

  const q = query.trim().toLowerCase();
  // Universal search across receipt number, customer name/phone, operator and
  // amount — combined with the active tab filter — plus, for a band code or a
  // phone, what the platform found for it on any day.
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
      <div className="h-full">
        <MobileTransactionDetail
          key={selected.id}
          txn={selected}
          timeZone={timeZone}
          onBack={() => setSelected(null)}
          onVoided={onVoided}
          onRefunded={onRefunded}
        />
      </div>
    );
  }

  // ── Bracelet scan (S2-11) ───────────────────────────────────────────────────

  if (view === 'scan') {
    return (
      <div className="flex flex-col h-full">
        {header('Scan bracelet')}
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="w-full max-w-sm">
            <div className="flex flex-col items-center text-center mb-8">
              <div className="w-16 h-16 rounded-2xl bg-primary/20 text-primary flex items-center justify-center mb-4">
                <ScanLine className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight">Bracelet lookup</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Scan or type a bracelet code to see everything bought on it.
              </p>
            </div>
            <form onSubmit={submitScan} className="flex flex-col gap-3">
              <Input
                autoFocus
                value={scanInput}
                onChange={(e) => {
                  setScanInput(e.target.value);
                  if (scanError) setScanError(null);
                }}
                placeholder="e.g. T1-7KMQ4X"
                aria-label="Bracelet code"
                className="h-14 text-xl font-mono"
              />
              <Button
                type="submit"
                size="lg"
                className="h-14 text-base gap-2"
                disabled={!scanInput.trim()}
              >
                Find
                <ArrowRight className="w-5 h-5" />
              </Button>
              {scanError && (
                <div className="flex items-start gap-2 text-destructive text-sm" role="alert">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{scanError}</span>
                </div>
              )}
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── One bracelet's orders — wrapped as the member view is, for the same reasons ──

  if (view === 'band') {
    const holder = bandResult?.sales.find((t) => t.ledger.member)?.ledger.member ?? null;
    return (
      <div className="flex flex-col h-full">
        {header(bandResult ? `Bracelet ${bandResult.label}` : 'Bracelet')}
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {bandError ? (
            <div className="h-full flex items-center justify-center text-center text-muted-foreground px-2">
              {bandError}
            </div>
          ) : !bandResult ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              Looking this bracelet up…
            </div>
          ) : (
            <div className="[&_.shrink-0.mb-4]:hidden h-full">
              <ClientActivity
                code={bandResult.label}
                activity={{
                  wristband: bandWallet,
                  member: null,
                  transactions: bandResult.sales,
                  totalSpent: spentOf(bandResult.sales),
                  orderCount: bandResult.sales.length,
                }}
                holderName={holder ? holder.nickname || holder.name || holder.phone : 'Walk-in'}
                memberLine={holder ? { nickname: holder.nickname, phone: holder.phone } : null}
                {...(bandWallet ? {} : { creditLabel: 'No credit on this band' })}
                spentLabel={`Total spent (${branch.name})`}
                onOpenTxn={(t) => setSelected(t as HistoryTxn)}
                onBack={backToList}
                badgeFor={(t) => (t as HistoryTxn).badge}
                timeZone={timeZone}
              />
            </div>
          )}
        </div>
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
                bandsLabel="Open an order to see its bracelet codes"
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
            placeholder="Receipt, name, bracelet, phone, amount…"
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

        <div className="flex gap-2" aria-label="Trading dates">
          {([{ key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
            { key: 'week', label: 'This week' }, { key: 'all', label: 'All time' }] as const).map(({ key, label }) => (
            <button key={key} type="button" onClick={() => setDateFilter(key)} aria-pressed={dateFilter === key}
              className={`px-3 h-8 rounded-full border text-xs font-semibold transition-colors ${dateFilter === key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Lookup actions row */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setView('scan')}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
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

        {/* What this read covers. A full page says it is a page, not a day. A
            band code or a phone in the search box says what the platform found. */}
        {lookup.search.kind !== 'text' ? (
          <div className="text-xs text-muted-foreground" data-testid="search-lookup">
            {lookup.error
              ? lookup.error
              : lookup.pending
                ? `Looking up ${lookup.search.kind === 'band' ? `bracelet ${lookup.search.label}` : 'this phone number'}…`
                : `${lookup.search.kind === 'band' ? `Bracelet ${lookup.search.label}` : 'This phone number'}: ${saleCountLabel(lookup.sales?.length ?? 0)} on the platform, any day`}
          </div>
        ) : (
          txns && (
            <div className="text-xs text-muted-foreground">
              {saleCountLabel(txns.length)} recorded at {branch.name}
            </div>
          )
        )}

        {/* The one notice: what this page cannot do yet. */}
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
                {q ? `No transactions match “${query.trim()}”` : 'No sales recorded in this period'}
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
