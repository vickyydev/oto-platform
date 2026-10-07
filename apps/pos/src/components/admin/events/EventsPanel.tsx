import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { bahtFromSatang, satangFromBaht, type EventDropInPricing } from '@oto/shared';
import type { WeekdayWeekendPrice } from '@/types';
import { getActiveBranch } from '@/store/catalogStore';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { EVENTS_NOT_LINKED, eventsApi } from '@/api/events';
import { Button } from '@/components/ui/button';
import { WeekdayWeekendPriceInput } from '@/components/shared/WeekdayWeekendPriceInput';
import { AdminNoticeBanner } from '../NotSavedNotice';

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
  const platformId = apiBranchIdForSlug(getActiveBranch().id);
  const [saved, setSaved] = useState<Prices>(ZERO);
  const [prices, setPrices] = useState<Prices>(ZERO);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(platformId ? null : EVENTS_NOT_LINKED);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!platformId) {
      setError(EVENTS_NOT_LINKED);
      return;
    }
    let live = true;
    eventsApi
      .dropInPricing(platformId)
      .then((answer) => {
        if (!live) return;
        const baht = toBaht(answer.pricing);
        setSaved(baht);
        setPrices(baht);
        setLoaded(true);
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : 'Could not load the prices.'));
    return () => {
      live = false;
    };
  }, [platformId]);

  const dirty = useMemo(() => !same(prices, saved), [prices, saved]);
  const invalid = FIELDS.some((f) => prices[f.key].weekday < 0 || prices[f.key].weekend < 0);

  const setField = (key: Key, next: WeekdayWeekendPrice) => {
    setPrices((p) => ({ ...p, [key]: next }));
    setJustSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!platformId || invalid) return;
    setSaving(true);
    setError(null);
    try {
      const answer = await eventsApi.saveDropInPricing(platformId, toSatang(prices));
      const baht = toBaht(answer.pricing);
      setSaved(baht);
      setPrices(baht);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setJustSaved(false);
    } finally {
      setSaving(false);
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
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
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
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!dirty || invalid || saving || !platformId || !loaded}>
            <Check className="w-4 h-4" />
            Save changes
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
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
