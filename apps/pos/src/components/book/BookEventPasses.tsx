import type { OtoEvent } from '@/types';
import { resolveRateToday } from '@/lib/pricingMode';
import { useLanguage } from '@/i18n/LanguageContext';
import {
  AttendeeFormFields,
  attendeeFormValid,
  type AttendeeForm,
  type SetAttendeeField,
} from '@/components/shared/AttendeeFormFields';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Ticket,
  CalendarDays,
  Clock,
  Plus,
  Pencil,
  Trash2,
  ArrowLeft,
  Tent,
  Sparkles,
} from 'lucide-react';

// A single event pass the customer is adding online: the chosen event plus the
// attendee draft (reuses the SAME AttendeeForm the reception door modal edits).
export interface PassSelection {
  id: string;
  /**
   * S2-20 E5 — the attendee's id (UUIDv7), minted when the pass is added and
   * kept through edits: the OTO App keeps the child under it once the booking
   * is paid, so every write of it is a replay.
   */
  attendeeId: string;
  event: OtoEvent;
  form: AttendeeForm;
}

const fmtDate = (iso: string): string =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

// Event-pass section shown on the booking site (picker + basket). Lists active
// events at their flat entry price and the passes already added. Renders nothing
// when there is neither an available event nor an added pass, so it stays out of
// the way for venues with no upcoming events.
export function EventPassSection({
  events,
  passes,
  onAddPass,
  onEditPass,
  onRemovePass,
}: {
  events: OtoEvent[];
  passes: PassSelection[];
  onAddPass: (event: OtoEvent) => void;
  onEditPass: (pass: PassSelection) => void;
  onRemovePass: (id: string) => void;
}) {
  const { t } = useLanguage();
  if (events.length === 0 && passes.length === 0) return null;

  return (
    <div className="mt-7">
      <div className="flex items-center gap-2 text-slate-700 font-semibold mb-1">
        <Ticket className="w-5 h-5 text-violet-600" />
        <span>{t('book.eventPasses.title')}</span>
      </div>
      <p className="text-sm text-slate-500 mb-3">{t('book.eventPasses.subtitle')}</p>

      {/* Already-added passes */}
      {passes.length > 0 && (
        <div className="space-y-2 mb-3">
          {passes.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 p-4 rounded-2xl bg-violet-500/10 border border-violet-300/60"
            >
              <div className="w-10 h-10 rounded-xl bg-violet-500/20 text-violet-700 flex items-center justify-center shrink-0">
                {p.event.type === 'camp' ? <Tent className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">
                  {p.form.name.trim() || t('book.eventPasses.attendee')}
                </div>
                <div className="text-xs text-slate-500 truncate">
                  {p.event.title}
                  {p.form.parentAttending ? ` · ${t('book.eventPasses.parentBand')}` : ''}
                </div>
              </div>
              <span className="font-bold tabular-nums shrink-0">฿{resolveRateToday(p.event.entryPriceTHB)}</span>
              <button
                type="button"
                onClick={() => onEditPass(p)}
                className="text-slate-400 hover:text-violet-700 p-1.5"
                aria-label="Edit pass"
              >
                <Pencil className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => onRemovePass(p.id)}
                className="text-slate-400 hover:text-red-500 p-1.5"
                aria-label="Remove pass"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Available events to add */}
      <div className="space-y-2">
        {events.map((ev) => (
          <button
            key={ev.id}
            type="button"
            onClick={() => onAddPass(ev)}
            className="w-full flex items-center gap-3 p-4 rounded-2xl bg-white border border-slate-200 text-left hover:border-violet-400/50 transition-colors"
          >
            <div className="w-10 h-10 rounded-xl bg-slate-100 text-violet-700 flex items-center justify-center shrink-0">
              {ev.type === 'camp' ? <Tent className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{ev.title}</div>
              <div className="flex items-center gap-3 text-xs text-slate-500 mt-0.5">
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="w-3.5 h-3.5" />
                  {ev.type === 'camp' && ev.dateRange
                    ? `${fmtDate(ev.dateRange.start)} – ${fmtDate(ev.dateRange.end)}`
                    : fmtDate(ev.date)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  {ev.startTime}
                </span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="font-bold tabular-nums text-violet-700">฿{resolveRateToday(ev.entryPriceTHB)}</div>
              <div className="inline-flex items-center gap-1 text-xs text-slate-500">
                <Plus className="w-3 h-3" /> {t('book.eventPasses.addPass')}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Full-screen attendee-capture step for one event pass. Reuses the shared
// AttendeeFormFields so the online sign-up captures EXACTLY what the door does
// (incl. parentAttending), minus the staff-only camp full-range toggle.
export function BookEventPassForm({
  event,
  form,
  onChange,
  onSave,
  onCancel,
}: {
  event: OtoEvent;
  form: AttendeeForm;
  onChange: SetAttendeeField;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const fee = resolveRateToday(event.entryPriceTHB);
  const valid = attendeeFormValid(form);
  return (
    <div className="flex-1 flex flex-col min-h-0 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="shrink-0 px-5 pt-6">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-2 text-slate-500 mb-4"
        >
          <ArrowLeft className="w-5 h-5" /> {t('common.back')}
        </button>
        <div className="flex items-center gap-2 text-violet-600">
          <Ticket className="w-5 h-5" />
          <span className="uppercase tracking-widest text-xs font-bold">
            {t('book.eventPasses.eventPass')}
          </span>
        </div>
        <h2 className="text-3xl font-black leading-tight mt-1">{event.title}</h2>
        <p className="text-slate-500 mt-1">
          ฿{fee} {t('book.eventPasses.entryTellUs')}
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0 mt-2">
        <AttendeeFormFields
          form={form}
          set={onChange}
          isCamp={event.type === 'camp'}
          idPrefix="book-pass"
          showStaffControls={false}
          showParentAttending
        />
      </ScrollArea>

      <div className="shrink-0 border-t border-slate-200 bg-white/90 px-5 py-4">
        {!valid && (
          <p className="text-amber-600 text-sm mb-2 text-center">
            {t('book.eventPasses.addChildParent')}
          </p>
        )}
        <Button
          size="lg"
          disabled={!valid}
          className="w-full h-16 text-lg font-bold gap-2"
          onClick={onSave}
        >
          {t('book.eventPasses.addPassPrice', { fee: String(fee) })}
        </Button>
      </div>
    </div>
  );
}
