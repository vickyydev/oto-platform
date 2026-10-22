import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { bahtFromSatang, satangFromBaht, type EventDropInPricing } from "@oto/shared";
import { type WeekdayWeekendPrice } from "../../../model/types";



import { Button } from "../../ui/button";
import { WeekdayWeekendPriceInput } from "../../shared/WeekdayWeekendPriceInput";
import { AdminNoticeBanner } from "../NotSavedNotice";
import { useMoneyCapabilities, type EventsPanelPorts } from '../../../runtime/money';

/**
 * S2-20 E2 — THE ADMIN EVENTS PANEL: the branch's walk-up prices.
 *
 * The prototype keeps three weekday/weekend pairs per branch
 * (`EventDropInPricing`, types.ts) and a mutator to change them
 * (`updateEventDropInPricing`, catalogStore.ts) that no screen ever called;
 * this is that screen, in the drop-off pricing panel's design. All three are
 * stored and shown here; only the party-guest price is read anywhere — a camp
 * or event pass is priced from the event's own entry price, which the OTO App
 * holds (Q8's default). Saved to `PUT /branches/:branchId/event-drop-in-pricing`,
 * audited there.
 */

type Key = keyof EventDropInPricing;
type Prices = Record<Key, WeekdayWeekendPrice>;

const FIELDS: { key: Key; label: string; hint: string }[] = [
  {
    key: 'campDay',
    label: 'Camp day',
    hint: "Kept for a camp's walk-up day. A camp pass at the till is priced from the camp's own entry price.",
  },
  {
    key: 'eventDay',
    label: 'Event day',
    hint: "Kept for a one-off event's walk-up. An event pass at the till is priced from the event's own entry price.",
  },
  {
    key: 'partyGuest',
    label: 'Party guest',
    hint: "Added to the party's tab for each walk-up guest — no door payment.",
  },
];

const ZERO: Prices = {
  campDay: { weekday: 0, weekend: 0 },
  eventDay: { weekday: 0, weekend: 0 },
  partyGuest: { weekday: 0, weekend: 0 },
};

const toBaht = (p: EventDropInPricing): Prices => ({
  campDay: { weekday: bahtFromSatang(p.campDay.weekday), weekend: bahtFromSatang(p.campDay.weekend) },
  eventDay: { weekday: bahtFromSatang(p.eventDay.weekday), weekend: bahtFromSatang(p.eventDay.weekend) },
  partyGuest: { weekday: bahtFromSatang(p.partyGuest.weekday), weekend: bahtFromSatang(p.partyGuest.weekend) },
});

const toSatang = (p: Prices): EventDropInPricing => ({
  campDay: { weekday: satangFromBaht(p.campDay.weekday), weekend: satangFromBaht(p.campDay.weekend) },
  eventDay: { weekday: satangFromBaht(p.eventDay.weekday), weekend: satangFromBaht(p.eventDay.weekend) },
  partyGuest: { weekday: satangFromBaht(p.partyGuest.weekday), weekend: satangFromBaht(p.partyGuest.weekend) },
});

const same = (a: Prices, b: Prices) =>
  FIELDS.every((f) => a[f.key].weekday === b[f.key].weekday && a[f.key].weekend === b[f.key].weekend);

export function EventsPanel() {
  const runtime = useAdminScreenRuntime();
  const getActiveBranch = runtime.reads.getActiveBranch;
  const apiBranchIdForSlug = runtime.api.catalogBridge.apiBranchIdForSlug;
  const EVENTS_NOT_LINKED = runtime.api.events.EVENTS_NOT_LINKED;
  const eventsApi = runtime.api.events.eventsApi;

  const platformId = apiBranchIdForSlug(getActiveBranch().id);
  const scope = useMoneyCapabilities(runtime.transport, runtime.session?.operator?.id, Boolean(platformId), runtime.session?.operator, platformId ?? undefined);
  const [answer, setAnswer] = useState<{ branchId: string; pricing: EventDropInPricing | null; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!platformId) return;
    let live = true;
    void eventsApi.dropInPricing(platformId).then(result => {
      if (live) setAnswer({ branchId: platformId, pricing: result.pricing });
    }).catch((err: unknown) => {
      if (live) setAnswer({ branchId: platformId, pricing: null, error: err instanceof Error ? err.message : 'Could not load the prices.' });
    });
    return () => { live = false; };
  }, [platformId, eventsApi, attempt]);
  const current = answer?.branchId === platformId ? answer : null;
  return <EventsPanelWithPorts key={`${runtime.session?.operator?.id ?? ''}:${platformId ?? ''}`} ports={{ pricing: current?.pricing ?? null, loading: Boolean(platformId) && !current, error: platformId ? current?.error : EVENTS_NOT_LINKED, onRetry: () => { setAnswer(null); setAttempt(value => value + 1); }, canManage: scope.canManageEvents, authorityMessage: scope.authorityMessage, savePricing: async pricing => {
    if (!platformId) throw new Error(EVENTS_NOT_LINKED);
    return (await eventsApi.saveDropInPricing(platformId, pricing)).pricing;
  } }} />;
}

export function EventsPanelWithPorts({ ports }: { ports: EventsPanelPorts }) {
  const [saved, setSaved] = useState<Prices>(ZERO);
  const [prices, setPrices] = useState<Prices>(ZERO);
  const loaded = ports.pricing !== null;
  const canManage = ports.canManage !== false;
  const [writeError, setError] = useState<string | null>(null);
  const error = writeError ?? ports.error;
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const busyRef = useRef(false);
  const manageRef = useRef(canManage);
  manageRef.current = canManage;
  const draftEpoch = useRef(0);
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!ports.pricing) return;
    const baht = toBaht(ports.pricing);
    const untouched = same(pricesRef.current, savedRef.current);
    setSaved(baht);
    if (untouched) setPrices(baht);
  }, [ports.pricing]);

  const dirty = useMemo(() => !same(prices, saved), [prices, saved]);
  const invalid = FIELDS.some((f) => prices[f.key].weekday < 0 || prices[f.key].weekend < 0);

  const setField = (key: Key, next: WeekdayWeekendPrice) => {
    draftEpoch.current++;
    setPrices((p) => ({ ...p, [key]: next }));
    setJustSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loaded || invalid || busyRef.current || !manageRef.current || !mounted.current) return;
    const epoch = draftEpoch.current;
    busyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const answer = await ports.savePricing(toSatang(prices));
      if (!mounted.current || !manageRef.current) return;
      const baht = toBaht(answer);
      setSaved(baht);
      if (draftEpoch.current === epoch) {
        setPrices(baht);
        setJustSaved(true);
      } else setJustSaved(false);
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : 'Could not save.');
        setJustSaved(false);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-5">
          <h2 className="text-base font-bold">Walk-up prices</h2>
          <p className="mt-1 text-sm text-foreground/50">
            Walk-up / drop-in day pricing for camps, one-off events and party additions.
          </p>

          {error && (
            <div className="mt-4">
              <AdminNoticeBanner>{error}</AdminNoticeBanner>
              {ports.onRetry && <Button type="button" variant="outline" onClick={ports.onRetry}>Retry</Button>}
            </div>
          )}
          {ports.loading && <p role="status" className="mt-4 text-sm text-foreground/60">Loading prices…</p>}
          {ports.authorityMessage && <p className="mt-4 text-sm text-foreground/60">{ports.authorityMessage}</p>}

          <fieldset disabled={!canManage || !loaded} className="mt-5 grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <WeekdayWeekendPriceInput
                key={f.key}
                label={f.label}
                hint={f.hint}
                value={prices[f.key]}
                onChange={(next) => setField(f.key, next)}
                error={prices[f.key].weekday < 0 || prices[f.key].weekend < 0 ? 'Must be 0 or more.' : undefined}
              />
            ))}
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canManage || !dirty || invalid || saving || !loaded}>
            <Check className="w-4 h-4" />
            Save changes
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                draftEpoch.current++;
                setPrices(saved);
                setJustSaved(false);
              }}
            >
              Discard
            </Button>
          )}
          {justSaved && !dirty && (
            <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
              <Check className="w-4 h-4" />
              Saved — live in the till.
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
