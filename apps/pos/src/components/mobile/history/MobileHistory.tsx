import { useMemo, useState } from 'react';
import { TxnSummary, TxnKind, Wristband } from '@/types';
import {
  getTransactions,
  getTransactionsByWristband,
  getTransactionsByMember,
} from '@/mockApi';
import { TransactionCard } from '@/components/history/TransactionCard';
import { ClientActivity } from '@/components/history/ClientActivity';
import { MemberActivity } from '@/components/history/MemberActivity';
import { MobileTransactionDetail } from './MobileTransactionDetail';
import { MobileBraceletScanner } from './MobileBraceletScanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/shared/PhoneInput';
import {
  Search,
  X,
  ScanLine,
  ArrowLeft,
  Phone,
  ArrowRight,
  ReceiptText,
} from 'lucide-react';

type TabKey = 'all' | TxnKind;
type View = 'list' | 'scan' | 'client' | 'phone' | 'member';
type DateFilter = 'today' | 'yesterday' | 'week' | 'all';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'fnb', label: 'F&B' },
];

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'all', label: 'All time' },
];

/** Returns the start-of-day (midnight) for a date offset by `daysAgo` from now. */
function startOf(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  return d;
}

function applyDateFilter(txns: TxnSummary[], filter: DateFilter): TxnSummary[] {
  if (filter === 'all') return txns;
  const today = startOf(0);
  const yesterday = startOf(1);
  const weekAgo = startOf(6);
  return txns.filter((t) => {
    const ts = new Date(t.createdAt).getTime();
    if (filter === 'today') return ts >= today.getTime();
    if (filter === 'yesterday') return ts >= yesterday.getTime() && ts < today.getTime();
    if (filter === 'week') return ts >= weekAgo.getTime();
    return true;
  });
}

/**
 * Portrait mobile Order History surface. Replaces the ComingSoon placeholder at
 * /history in MobileShell. View state machine:
 *   list  → tap row → detail (full-screen, with refund/reprint sub-flows)
 *   list  → Scan bracelet → scan → client activity
 *   list  → Find by phone → phone → member activity
 * All business logic comes from the existing getters / mutators / lib seams.
 */
export function MobileHistory() {
  const [view, setView] = useState<View>('list');
  const [scannedCode, setScannedCode] = useState('');
  const [lookupPhone, setLookupPhone] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [tab, setTab] = useState<TabKey>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('today');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<TxnSummary | null>(null);
  const [version, setVersion] = useState(0);

  const txns = useMemo(() => getTransactions(), [version]);
  const activity = useMemo(
    () => (scannedCode ? getTransactionsByWristband(scannedCode) : null),
    [scannedCode, version],
  );
  const memberActivity = useMemo(
    () => (lookupPhone ? getTransactionsByMember(lookupPhone) : null),
    [lookupPhone, version],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const byDate = applyDateFilter(txns, dateFilter);
    const byTab = tab === 'all' ? byDate : byDate.filter((t) => t.kind === tab);
    if (!q) return byTab;
    return byTab.filter(
      (t) =>
        t.reference.toLowerCase().includes(q) ||
        (t.customerLabel?.toLowerCase().includes(q) ?? false) ||
        t.operatorName.toLowerCase().includes(q) ||
        String(t.total).includes(q),
    );
  }, [txns, tab, dateFilter, q]);

  // Keep selected in sync with latest status after a refund
  const selectedLatest = selected
    ? txns.find((t) => t.kind === selected.kind && t.id === selected.id) ?? selected
    : null;

  // ── Navigation helpers ──────────────────────────────────────────────────────

  const openClient = (code: string) => {
    setScannedCode(code);
    setView('client');
  };
  const handleLoadBand = (wb: Wristband) => openClient(wb.code);

  const backToList = () => {
    setScannedCode('');
    setLookupPhone('');
    setPhoneInput('');
    setView('list');
  };

  const submitPhone = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneInput.trim()) return;
    setLookupPhone(phoneInput.trim());
    setView('member');
  };

  // ── Full-screen Transaction Detail ─────────────────────────────────────────

  if (selectedLatest) {
    return (
      <MobileTransactionDetail
        txn={selectedLatest}
        onBack={() => setSelected(null)}
        onChanged={() => setVersion((v) => v + 1)}
      />
    );
  }

  // ── Scan view ──────────────────────────────────────────────────────────────

  if (view === 'scan') {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
          <button
            type="button"
            onClick={backToList}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="font-bold">Scan bracelet</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <MobileBraceletScanner
            onLoaded={handleLoadBand}
            onUnknownCode={openClient}
          />
        </div>
      </div>
    );
  }

  // ── Phone lookup view ──────────────────────────────────────────────────────

  if (view === 'phone') {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
          <button
            type="button"
            onClick={backToList}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="font-bold">Find by phone</span>
        </div>
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
              <PhoneInput
                value={phoneInput}
                onChange={setPhoneInput}
                label=""
              />
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

  // ── Client / Member activity views ─────────────────────────────────────────
  // These reuse the shared desktop components — they are single-column and scroll
  // well on portrait, only the header back button is replaced by our mobile nav.

  if (view === 'client' && activity) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
          <button
            type="button"
            onClick={backToList}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="font-bold truncate">Bracelet #{scannedCode}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {/* ClientActivity manages its own back button, so we hide that and
              wire the header back above; pass a no-op so it doesn't double-nav */}
          <div className="[&_.shrink-0.mb-4]:hidden h-full">
            <ClientActivity
              code={scannedCode}
              activity={activity}
              onOpenTxn={(t) => setSelected(t)}
              onBack={backToList}
            />
          </div>
        </div>
      </div>
    );
  }

  if (view === 'member' && memberActivity) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
          <button
            type="button"
            onClick={backToList}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="font-bold truncate">Member: {lookupPhone}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <div className="[&_.shrink-0.mb-4]:hidden h-full">
            <MemberActivity
              activity={memberActivity}
              onOpenTxn={(t) => setSelected(t)}
              onBack={backToList}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Main list view ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Search bar */}
      <div className="shrink-0 px-4 pt-3 pb-2 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            inputMode="search"
            aria-label="Search transactions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Order, name, operator, amount…"
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

        {/* Date filter chips */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
          {DATE_FILTERS.map((df) => (
            <button
              key={df.key}
              type="button"
              onClick={() => setDateFilter(df.key)}
              className={`shrink-0 px-3 h-8 rounded-full border text-xs font-semibold transition-colors ${
                dateFilter === df.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground'
              }`}
            >
              {df.label}
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
      </div>

      {/* Transaction list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {filtered.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3 py-16">
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
              <ReceiptText className="w-7 h-7" />
            </div>
            <div className="text-center">
              <div className="font-semibold text-foreground mb-1">
                {q ? `No results for "${query.trim()}"` : 'No transactions yet'}
              </div>
              {q && (
                <p className="text-xs">Try a different name, order number, or amount.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((t) => (
              <TransactionCard
                key={`${t.kind}-${t.id}`}
                txn={t}
                onClick={() => setSelected(t)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
