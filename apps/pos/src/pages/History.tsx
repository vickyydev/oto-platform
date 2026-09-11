import { useMemo, useState } from 'react';
import { StationHeader } from '@/components/shared/StationHeader';
import { TxnSummary, TxnKind, Wristband } from '@/types';
import {
  getTransactions,
  getTransactionsByWristband,
  getTransactionsByMember,
} from '@/mockApi';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TransactionDetail } from '@/components/history/TransactionDetail';
import { TransactionCard } from '@/components/history/TransactionCard';
import { ClientActivity } from '@/components/history/ClientActivity';
import { MemberActivity } from '@/components/history/MemberActivity';
import { ScanWristband } from '@/components/fnb/ScanWristband';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { Search, X, ScanLine, ArrowLeft, Phone, ArrowRight } from 'lucide-react';

type TabKey = 'all' | TxnKind;
// The list is the default; "scan" looks up a band, "client" shows that band's
// activity; "phone" looks up a member, "member" shows that member's activity.
// A selected txn opens TransactionDetail on top of whichever view.
type View = 'list' | 'scan' | 'client' | 'phone' | 'member';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'fnb', label: 'F&B' },
];

export default function History() {
  const [view, setView] = useState<View>('list');
  const [scannedCode, setScannedCode] = useState('');
  const [lookupPhone, setLookupPhone] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<TxnSummary | null>(null);
  // Bumped whenever a refund mutates a transaction so the list re-reads.
  const [version, setVersion] = useState(0);

  const txns = useMemo(() => getTransactions(), [version]);
  // Re-read the scanned band's activity whenever the code changes or a refund lands.
  const activity = useMemo(
    () => (scannedCode ? getTransactionsByWristband(scannedCode) : null),
    [scannedCode, version],
  );
  // Re-read the member's activity whenever the looked-up phone changes or a refund lands.
  const memberActivity = useMemo(
    () => (lookupPhone ? getTransactionsByMember(lookupPhone) : null),
    [lookupPhone, version],
  );

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
  const q = query.trim().toLowerCase();
  // Universal search across reference (order number), customer name/wristband,
  // operator, and amount — combined with the active tab filter.
  const filtered = useMemo(() => {
    const byTab = tab === 'all' ? txns : txns.filter((t) => t.kind === tab);
    if (!q) return byTab;
    return byTab.filter(
      (t) =>
        t.reference.toLowerCase().includes(q) ||
        (t.customerLabel?.toLowerCase().includes(q) ?? false) ||
        t.operatorName.toLowerCase().includes(q) ||
        String(t.total).includes(q)
    );
  }, [txns, tab, q]);

  // Keep the selected summary in sync with the latest status after a refund.
  const selectedLatest = selected
    ? txns.find((t) => t.kind === selected.kind && t.id === selected.id) ?? selected
    : null;

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <StationHeader active="history" />

      {/* Body */}
      <div className="flex-1 min-h-0 p-6">
        <div className="mx-auto h-full max-w-5xl flex flex-col min-h-0">
          {selectedLatest ? (
            <TransactionDetail
              txn={selectedLatest}
              onBack={() => setSelected(null)}
              onChanged={() => setVersion((v) => v + 1)}
            />
          ) : view === 'scan' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="shrink-0 mb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 -ml-2"
                  onClick={backToList}
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to all transactions
                </Button>
              </div>
              <div className="flex-1 min-h-0">
                <ScanWristband
                  onLoadTab={handleLoadBand}
                  onUnknownCode={openClient}
                  title="Scan bracelet"
                  subtitle="Scan or type a bracelet code to see everything bought on it."
                />
              </div>
            </div>
          ) : view === 'phone' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="shrink-0 mb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 -ml-2"
                  onClick={backToList}
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to all transactions
                </Button>
              </div>
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
          ) : view === 'client' && activity ? (
            <ClientActivity
              code={scannedCode}
              activity={activity}
              onOpenTxn={(t) => setSelected(t)}
              onBack={backToList}
            />
          ) : view === 'member' && memberActivity ? (
            <MemberActivity
              activity={memberActivity}
              onOpenTxn={(t) => setSelected(t)}
              onBack={backToList}
            />
          ) : (
            <>
              {/* Universal search + scan-bracelet entry */}
              <div className="shrink-0 mb-4 flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    inputMode="search"
                    aria-label="Search transactions"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, order number, operator, amount…"
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
                  onClick={() => setView('scan')}
                >
                  <ScanLine className="w-5 h-5" />
                  Scan bracelet
                </Button>
              </div>

              {/* Tabs */}
              <div className="shrink-0 mb-4 inline-flex items-center gap-1 rounded-lg bg-muted p-1 self-start">
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

              {filtered.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  {q ? `No transactions match “${query.trim()}”.` : 'No transactions yet.'}
                </div>
              ) : (
                <ScrollArea className="flex-1 -mx-1 px-1">
                  <div className="space-y-2">
                    {filtered.map((t) => (
                      <TransactionCard
                        key={`${t.kind}-${t.id}`}
                        txn={t}
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
