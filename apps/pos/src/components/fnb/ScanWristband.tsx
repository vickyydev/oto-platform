import { useEffect, useRef, useState } from 'react';
import { Wristband } from '@/types';
import { getWristbandByCode, getMockWristbands } from '@/mockApi';
import { ApiError } from '@/api/client';
import { BOX_CREDIT_REFUSAL_CODES, lookupBandFoodOnBox, lookupWalletOnBox, scanBand, walletKeyOf, wristbandOfBoxScan, wristbandOfBoxWallet } from '@/api/wallet';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { getActiveBranch } from '@/store/catalogStore';
import { currentLane, isBoxLaneTrigger, laneStation, noteLaneFailure, useLane } from '@/lib/lane';
import { useDemoControls } from '@/lib/demoControls';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScanLine, UserRound, Wallet, AlertCircle, ArrowRight, Gift } from 'lucide-react';

interface ScanWristbandProps {
  onLoadTab: (wristband: Wristband) => void;
  /** When provided, shows the "continue as guest" fallback. Omit to hide it. */
  onGuest?: () => void;
  /** Override the default heading/subheading (e.g. for the History lookup). */
  title?: string;
  subtitle?: string;
  /** When set, an unknown code calls back here instead of showing the inline error. */
  onUnknownCode?: (code: string) => void;
}

export function ScanWristband({
  onLoadTab,
  onGuest,
  title = 'Scan Wristband',
  subtitle = "Scan or type a wristband code to load the customer's tab.",
  onUnknownCode,
}: ScanWristbandProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  // S2-14a round 2 — the demo bands carry the allergy and prepaid-item notes
  // the stations still show from this till's own list, but NO credit: the only
  // spendable balance is a platform wallet's, so a demo band reads ฿0 rather
  // than offering money the platform does not hold.
  const presets = getMockWristbands().map(withoutLocalCredit);
  // SCRUM-515 — and only where people play, never on a real park's till.
  const showDemoBands = useDemoControls();

  const submit = async (value: string) => {
    if (looking) return;
    setLooking(true);
    const found = await loadScannedTab(value);
    setLooking(false);
    if (found.error) {
      setError(found.error);
      return;
    }
    const wb = found.wristband;
    if (!wb) {
      if (onUnknownCode) {
        setError(null);
        onUnknownCode(value.trim());
        return;
      }
      setError(`No tab found for "${value}". Try a code below or continue as guest.`);
      return;
    }
    setError(null);
    onLoadTab(wb);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    void submit(code);
  };

  return (
    // Centred by the block's own auto margins rather than `justify-center`: a
    // centred column that is taller than the screen (a tablet held sideways is
    // 820px tall, and ten demo bands plus the guest button are more) overflows
    // at BOTH ends, with the heading under the header and "continue as guest"
    // below the fold and nothing to scroll. Auto margins centre the block when
    // there is room and give way to a scroll when there is not.
    <div className="h-full flex flex-col items-center p-6 overflow-y-auto animate-in fade-in duration-500">
      <div className="w-full max-w-2xl my-auto">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-20 h-20 rounded-2xl bg-primary/20 text-primary flex items-center justify-center mb-4">
            <ScanLine className="w-10 h-10" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
          <p className="text-muted-foreground mt-2 text-lg">{subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="flex gap-3 mb-3">
          <Input
            autoFocus
            inputMode="numeric"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Wristband code e.g. 1001"
            className="h-16 text-2xl px-5"
          />
          <Button type="submit" size="lg" className="h-16 px-8 text-xl gap-2" disabled={!code.trim() || looking}>
            Load Tab
            <ArrowRight className="w-5 h-5" />
          </Button>
        </form>

        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm mb-4">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {showDemoBands && <div className="mt-6">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
            Demo wristbands
          </div>
          <div className="grid grid-cols-2 gap-3">
            {presets.map((wb) => (
              <Card
                key={wb.id}
                role="button"
                tabIndex={0}
                onClick={() => void submit(wb.code)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void submit(wb.code);
                  }
                }}
                className="p-4 flex items-center gap-3 cursor-pointer select-none hover:border-primary/60 transition-all active:scale-[0.98]"
              >
                <div className="w-11 h-11 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                  <UserRound className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold leading-tight truncate">{wb.customerNickname}</div>
                  <div className="text-xs text-muted-foreground font-mono">#{wb.code}</div>
                  {wb.foodProvision?.mode === 'prepaid_items' && (
                    <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-300">
                      <Gift className="w-3 h-3" />
                      Prepaid food
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  {wb.foodProvision?.mode === 'prepaid_credit' ? (
                    <>
                      <div className="flex items-center gap-1 text-xs text-violet-300 justify-end">
                        <Gift className="w-3 h-3" />
                        prepaid
                      </div>
                      <div className="font-bold tabular-nums text-violet-300">฿{wb.creditBalanceTHB}</div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                        <Wallet className="w-3 h-3" />
                        credit
                      </div>
                      <div className="font-bold tabular-nums text-primary">฿{wb.creditBalanceTHB}</div>
                    </>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>}

        {onGuest && (
          <>
            <div className="mt-8 flex items-center gap-4">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <Button
              variant="outline"
              size="lg"
              className="w-full h-16 text-xl gap-3 mt-6"
              onClick={onGuest}
            >
              <UserRound className="w-6 h-6" />
              No wristband — continue as guest
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A band from this till's own demo list, with no spendable credit on it and no
 * prepaid items to serve: the only spendable balance is a platform wallet's,
 * and the only servable entitlements are a platform stay's (SCRUM-494).
 */
function withoutLocalCredit(wb: Wristband): Wristband {
  return {
    ...wb,
    creditBalanceTHB: 0,
    ledger: undefined,
    ...(wb.foodProvision?.items ? { foodProvision: { ...wb.foodProvision, items: [] } } : {}),
  };
}

/**
 * THE PLATFORM FIRST (plan §2.3): a band's code, its short code or a
 * voucher's `QR-…` names a real wallet — balance, ledger, and the key the
 * confirm press spends. A key no wallet carries falls back to this till's
 * demo band list (allergy and food notes only); a key neither knows is the
 * unknown-code path (`wristband: null`, no error).
 *
 * A lookup that could not be made is never read as "no credit": when the
 * platform cannot be reached (round-2 gate, finding 6) the station still
 * loads the band it holds itself — its notes, with ฿0 credit — and only a band
 * it does not hold is refused, in the platform's words when it answered and the
 * connection's when it did not.
 *
 * Staging F3 — A TILL WORKING THROUGH ITS BOX ASKS THE BOX (`wallet.lookup`),
 * which holds the branch's balance snapshot and the day's offline cap: the tab
 * offers the credit the box will really take, and the box's refusals are shown
 * in its words. A till still on the platform lane whose call meets a dropped
 * link moves to its box for this scan, as every other call does.
 */
export async function loadScannedTab(value: string): Promise<{ wristband: Wristband | null; error: string | null }> {
  const local = getWristbandByCode(value);
  const station = laneStation();
  if (station && currentLane() === 'box') return loadFromBox(station, value, local);
  try {
    // SCRUM-494 — the wallet and, beside it, the child's stay at this park:
    // the allergy alert, the food consent and the prepaid items.
    const wb = await scanBand(value, apiBranchIdForSlug(getActiveBranch().id));
    if (wb) return { wristband: wb, error: null };
  } catch (err) {
    if (station && isBoxLaneTrigger(err)) {
      noteLaneFailure(err);
      return loadFromBox(station, value, local);
    }
    if (local) return { wristband: withoutLocalCredit(local), error: null };
    const said = err instanceof ApiError ? err.message : null;
    return { wristband: null, error: said
      ? `The platform could not look this band up: ${said}`
      : 'Could not reach the platform to look this band up — check the connection and scan again.' };
  }
  return { wristband: local ? withoutLocalCredit(local) : null, error: null };
}

/**
 * The box lane's half of the scan. The box's refusal of credit (the cap, an
 * expired wallet, a wallet it holds no copy of, a snapshot too old) still
 * opens the station's own band, or the wallet the box named, with no credit and
 * the box's words on it; a key the box knows nothing of and the station does
 * not hold is refused in those same words.
 *
 * SCRUM-498 — the box is asked for the child's stay first (`checkin.band_food`):
 * the allergy alert, the food consent and the prepaid items reach the order as
 * they do online, and a stay the box knows opens the tab whatever it says
 * about credit.
 */
async function loadFromBox(
  stationId: string,
  value: string,
  local: Wristband | null,
): Promise<{ wristband: Wristband | null; error: string | null }> {
  const key = value.trim();
  if (!key) return { wristband: null, error: null };
  const base = local ? withoutLocalCredit(local) : null;
  // A box that cannot answer the stay still answers the credit; its refusal reaches the till there.
  const food = await lookupBandFoodOnBox(stationId, key).catch(() => null);
  try {
    const read = await lookupWalletOnBox(stationId, key);
    return { wristband: wristbandOfBoxScan(food, read, key, base), error: null };
  } catch (err) {
    const said = err instanceof ApiError ? err.message : null;
    const stayTab = food?.stay ? wristbandOfBoxScan(food, null, key) : null;
    if (err instanceof ApiError && BOX_CREDIT_REFUSAL_CODES.includes(err.code)) {
      if (stayTab) return { wristband: { ...stayTab, creditNote: err.message }, error: null };
      if (base) return { wristband: { ...base, creditNote: err.message }, error: null };
      const walletId = (err.details as { walletId?: unknown } | undefined)?.walletId;
      if (typeof walletId === 'string') {
        // The box knows the wallet (its credit has expired): the tab opens, ฿0.
        return { wristband: { id: walletId, code: key, customerNickname: 'Guest', creditBalanceTHB: 0, gateAccess: false,
          creditNote: err.message }, error: null };
      }
      return { wristband: null, error: err.message };
    }
    if (stayTab) return { wristband: said ? { ...stayTab, creditNote: said } : stayTab, error: null };
    if (base) return { wristband: base, error: null };
    return { wristband: null, error: said
      ? `This counter’s box could not look this band up: ${said}`
      : 'Could not reach this counter’s box to look this band up — check the connection and scan again.' };
  }
}

/**
 * SCRUM-483 — A BAND HELD WHEN THE COUNTER MOVES TO ITS BOX.
 *
 * A band scanned while the counter was online carries the platform's whole
 * balance. When the link drops before payment the counter works through its
 * box, which will take only what its snapshot and the day's offline cap allow
 * — so the guest's screen could say the credit covers an order the box will
 * then only part-pay. The held band is read again on the box (`wallet.lookup`,
 * as a scan on the box lane is) and its credit replaced by what the box will
 * really take, the cap's sentence with it.
 *
 * Only the credit is replaced; the band's stay, notes and prepaid items stay
 * as they were read. Only a band showing credit is asked about, because a band
 * with none has nothing to over-promise. A box that does not answer at all
 * leaves the band as it was: the press then meets the box, as before.
 */
export type HeldBandCredit = { creditBalanceTHB: number; creditNote?: string };

export async function rereadHeldBandOnBox(held: Wristband): Promise<HeldBandCredit | null> {
  const station = laneStation();
  const key = walletKeyOf(held).trim();
  if (!station || currentLane() !== 'box' || !key || held.creditBalanceTHB <= 0) return null;
  try {
    const tab = wristbandOfBoxWallet(await lookupWalletOnBox(station, key), key);
    return { creditBalanceTHB: tab.creditBalanceTHB, ...(tab.creditNote ? { creditNote: tab.creditNote } : {}) };
  } catch (err) {
    if (err instanceof ApiError && BOX_CREDIT_REFUSAL_CODES.includes(err.code)) {
      return { creditBalanceTHB: 0, creditNote: err.message };
    }
    return null;
  }
}

/** The held band with its credit replaced by the box's answer. */
export function withHeldBandCredit(held: Wristband, credit: HeldBandCredit): Wristband {
  const { creditNote: _previous, ...rest } = held;
  return { ...rest, ...credit };
}

/**
 * Re-read the held band on the box the moment the counter moves there.
 * `canReread` is asked when the lane moves and again when the box answers:
 * a station passes false once the payment has taken any money, so a figure
 * already being settled is never changed under it. The answer is applied only
 * while the same band is still held.
 */
export function useHeldBandOnBox(
  held: Wristband | null,
  apply: (next: Wristband) => void,
  canReread: () => boolean,
): void {
  const lane = useLane();
  const previousLane = useRef(lane);
  const latest = useRef({ held, apply, canReread });
  latest.current = { held, apply, canReread };
  useEffect(() => {
    const was = previousLane.current;
    previousLane.current = lane;
    if (was === 'box' || lane !== 'box') return;
    const band = latest.current.held;
    if (!band || !latest.current.canReread()) return;
    let live = true;
    void rereadHeldBandOnBox(band).then((credit) => {
      const now = latest.current.held;
      if (!live || !credit || !now || walletKeyOf(now) !== walletKeyOf(band) || !latest.current.canReread()) return;
      latest.current.apply(withHeldBandCredit(now, credit));
    });
    return () => { live = false; };
  }, [lane]);
}
