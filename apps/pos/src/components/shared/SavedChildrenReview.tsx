import { useMemo } from 'react';
import type { SavedChild } from '@/types';
import { type SupervisedSlot, slotAge } from '@/components/till/SupervisionGate';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { ageFromDob } from '@/lib/childDob';
import { childReviewAge } from '@oto/shared';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { tFor } from '@/i18n/LanguageContext';
import type { SupportedLang } from '@/i18n/types';
import {
  Baby,
  Check,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  ArrowLeft,
  ArrowRight,
  Lock,
} from 'lucide-react';

export type SavedChildrenReviewSlot = Pick<SupervisedSlot, 'id' | 'savedChildId' | 'name' | 'age' | 'dateOfBirth'>
  & Partial<Pick<SupervisedSlot, 'allergiesMedical' | 'foodRestrictions'>>;
export type SavedChildrenReviewChoice = Pick<SavedChild, 'id' | 'childName' | 'dateOfBirth'> & { childAge: number | null };

interface SavedChildrenReviewProps<Child extends SavedChildrenReviewChoice> {
  // One slot per child coming today (count fixed by the cart's kid tickets). A
  // slot with savedChildId was pre-filled from a saved profile; one without is a
  // brand-new child being entered (and saved on capture).
  slots: SavedChildrenReviewSlot[];
  // The member's full saved-children list — drives the per-slot swap picker.
  savedChildren: Child[];
  // Slot ids the parent has explicitly re-confirmed ("still correct?").
  confirmedIds: string[];
  onUpdateSlot: (id: string, patch: Partial<SupervisedSlot>) => void;
  onConfirmSlot: (id: string) => void;
  // Swap a (different) saved child into a slot, or mark the slot as a new child.
  onAssignSaved: (slotId: string, child: Child) => void;
  onMarkNew: (slotId: string) => void;
  // Delete a saved child from the member's profile (and free the slot to new).
  onRemoveSaved: (slotId: string, childId: string) => void;
  onBack: () => void;
  onContinue: () => void;
  canContinue: boolean;
  /**
   * SCRUM-338 — which store the details typed on this screen go to, which is
   * what the note at the bottom has to tell the person reading it.
   *
   * The component is shared by two flows that no longer answer the same way.
   * On the till, Confirm writes to the member's record through the member API
   * (SCRUM-233) and Remove archives the child there (SCRUM-337), both audited;
   * on the booking site the same buttons write nothing: the saved children are
   * read from the family's record once the code sent to the phone is typed
   * back (SCRUM-357), and an edit stays on that booking — the site has no
   * route that writes a member (S2-09b). One note cannot be true for both, and
   * the one it carried — "a prototype convenience held in memory only" — was
   * false exactly where staff read it most.
   *
   * The caller names its store rather than passing wording, so the sentence
   * stays here with the screen that shows it. Left out it reads as the
   * member's record: both of the till's uses are on the API, and the booking
   * site says its edits are this booking's only.
   */
  detailsStore?: 'member-record' | 'booking-only';
  /** The separate display reviews saved names and ages; other changes use staff. */
  publicMode?: boolean;
  busy?: boolean;
  onStaffHelp?: () => void;
  publicReferenceDate?: string;
  /**
   * The customer's language, where this runs on the customer's half of the
   * counter or on a paired display. Left out where it runs on the staff screen,
   * which stays in English whatever the display is set to (SCRUM-729).
   */
  lang?: SupportedLang;
}

/**
 * Shared "your children" re-confirmation step for a returning member. Reused by
 * the Till door flow and the public booking flow. Saved children pre-fill the
 * per-child form, but NOTHING is applied silently — the parent confirms each one
 * ("still correct?") or edits a field (which writes back to the profile on
 * confirm). They can swap in a different saved child, remove one from the
 * profile, or leave a slot as a brand-new child. The photo, consent and
 * supervision still run afterwards every visit — only the text fields pre-fill.
 */
export function SavedChildrenReview<Child extends SavedChildrenReviewChoice>({
  slots,
  savedChildren,
  confirmedIds,
  onUpdateSlot,
  onConfirmSlot,
  onAssignSaved,
  onMarkNew,
  onRemoveSaved,
  onBack,
  onContinue,
  canContinue,
  detailsStore = 'member-record',
  publicMode = false,
  busy = false,
  onStaffHelp,
  publicReferenceDate,
  lang,
}: SavedChildrenReviewProps<Child>) {
  const t = tFor(lang ?? 'en');
  // Saved children already mapped to a slot — so a swap picker never offers the
  // same child twice across two slots.
  const assignedIds = useMemo(
    () => new Set(slots.map((s) => s.savedChildId).filter(Boolean) as string[]),
    [slots],
  );

  return (
    <div className="flex h-full w-full flex-col bg-[image:var(--cd-gradient)] text-foreground">
      <div className="shrink-0 px-8 pt-8 pb-4 text-center">
        <div className="mb-2 inline-flex items-center gap-2 text-primary">
          <Sparkles className="h-6 w-6" />
          <span className="text-sm font-bold uppercase tracking-widest">{t('childReview.welcomeBack')}</span>
        </div>
        <h2 className="text-4xl font-black">
          {slots.length === 1 ? t('childReview.titleOne') : t('childReview.titleMany')}
        </h2>
        <p className="mt-1 text-lg text-foreground/60">
          {publicMode ? t('childReview.subtitlePublic') : t('childReview.subtitle')}
        </p>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-8 pb-6">
        {slots.map((slot, idx) => {
          const prefilled = !!slot.savedChildId;
          const confirmed = confirmedIds.includes(slot.id);
          const effectiveAge = publicMode && slot.dateOfBirth && publicReferenceDate
            ? childReviewAge(slot.dateOfBirth, publicReferenceDate) : slotAge(slot);
          const aged = effectiveAge !== null && (!publicMode || effectiveAge <= 17);
          const named = slot.name.trim().length > 0;
          // Saved children selectable for THIS slot: unassigned ones + its own.
          const pickable = savedChildren.filter(
            (c) => !assignedIds.has(c.id) || c.id === slot.savedChildId,
          );

          return (
            <div
              key={slot.id}
              data-testid="saved-child-review-card"
              className={`rounded-3xl border p-6 transition-colors ${
                confirmed
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : 'border-foreground/10 bg-foreground/5'
              }`}
            >
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="gap-1.5 px-3 py-1.5 text-base">
                  <Baby className="h-4 w-4" /> {t('childReview.childN', { n: idx + 1 })}
                </Badge>
                {prefilled ? (
                  confirmed ? (
                    <Badge className="gap-1.5 bg-emerald-500/20 px-3 py-1.5 text-base text-emerald-300">
                      <Check className="h-4 w-4" /> {t('childReview.confirmed')}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-base text-amber-300">
                      <ShieldCheck className="h-4 w-4" /> {t('childReview.stillCorrect')}
                    </Badge>
                  )
                ) : (
                  <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-base text-primary">
                    <UserPlus className="h-4 w-4" /> {publicMode ? t('childReview.chooseOrAsk') : t('childReview.newWillSave')}
                  </Badge>
                )}
              </div>

              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="flex-1">
                  <label className="text-lg text-foreground/70">{t('superviseConsent.childName')}</label>
                  <Input
                    aria-label={t('childReview.nameAria', { n: idx + 1 })}
                    value={slot.name}
                    disabled={busy || publicMode && !prefilled}
                    maxLength={publicMode ? 100 : undefined}
                    onChange={(e) => onUpdateSlot(slot.id, { name: e.target.value })}
                    placeholder={t('superviseConsent.fullName')}
                    className="mt-2 h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground placeholder:text-foreground/30"
                  />
                </div>
                <div className="sm:w-40">
                  <label className="text-lg text-foreground/70">{t('superviseConsent.age')}</label>
                  <ChildDobPicker
                    lang={lang}
                    disabled={busy || publicMode && !prefilled}
                    referenceDate={publicMode ? publicReferenceDate : undefined}
                    maxAge={publicMode ? 17 : undefined}
                    dateOfBirth={slot.dateOfBirth}
                    age={effectiveAge}
                    childName={slot.name}
                    onChange={({ dateOfBirth, age }) =>
                      onUpdateSlot(slot.id, { dateOfBirth, age: String(age) })
                    }
                    className="mt-2"
                  />
                </div>
              </div>

              {!publicMode && (slot.allergiesMedical?.trim() || slot.foodRestrictions?.trim()) && (
                <div className="mt-3 space-y-1 text-base text-foreground/60">
                  {slot.allergiesMedical?.trim() && (
                    <p>
                      <span className="font-semibold text-foreground/80">{t('childReview.allergiesMedical')}</span>{' '}
                      {slot.allergiesMedical}
                    </p>
                  )}
                  {slot.foodRestrictions?.trim() && (
                    <p>
                      <span className="font-semibold text-foreground/80">{t('childReview.dietary')}</span>{' '}
                      {slot.foodRestrictions}
                    </p>
                  )}
                  <p className="text-sm text-foreground/40">
                    {t('childReview.adjustNext')}
                  </p>
                </div>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-3">
                {prefilled && !confirmed && (
                  <Button
                    size="lg"
                    className="h-12 rounded-2xl px-6 text-lg font-bold"
                    disabled={busy || !named || !aged}
                    onClick={() => onConfirmSlot(slot.id)}
                  >
                    <Check className="mr-2 h-5 w-5" /> {t('common.confirm')}
                  </Button>
                )}

                {/* Swap a different saved child into this slot, or mark it new. */}
                {savedChildren.length > 0 && (
                  <select
                    aria-label={t('childReview.savedProfileAria', { n: idx + 1 })}
                    disabled={busy}
                    value={slot.savedChildId ?? '__new__'}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__new__') {
                        if (publicMode) onStaffHelp?.();
                        else onMarkNew(slot.id);
                        return;
                      }
                      const child = savedChildren.find((c) => c.id === v);
                      if (child) onAssignSaved(slot.id, child);
                    }}
                    className="h-12 rounded-2xl border border-foreground/10 bg-foreground/5 px-4 text-lg text-foreground"
                  >
                    {pickable.map((c) => (
                      <option key={c.id} value={c.id}>
                        {t('childReview.ageOption', {
                          name: c.childName,
                          age: (c.dateOfBirth
                            ? publicMode && publicReferenceDate ? childReviewAge(c.dateOfBirth, publicReferenceDate) : ageFromDob(c.dateOfBirth)
                            : c.childAge) ?? t('childReview.ageNotSet'),
                        })}
                      </option>
                    ))}
                    <option value="__new__">{publicMode ? t('childReview.newChildAsk') : t('childReview.newChild')}</option>
                  </select>
                )}

                {prefilled && (
                  <Button
                    variant="ghost"
                    size="lg"
                    className="h-12 rounded-2xl px-4 text-base text-destructive hover:text-destructive"
                    disabled={!publicMode && busy}
                    onClick={() => publicMode ? onStaffHelp?.() : onRemoveSaved(slot.id, slot.savedChildId!)}
                  >
                    <Trash2 className="mr-2 h-5 w-5" /> {publicMode ? t('childReview.askRemove') : t('childReview.removeSaved')}
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        {/* Privacy note — what happens to what is typed here, per detailsStore. */}
        <div className="flex items-start gap-3 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-sm text-foreground/60">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-foreground/40" />
          {publicMode ? (
            <p>{t('childReview.notePublic')}</p>
          ) : detailsStore === 'booking-only' ? (
            <p>{t('childReview.noteBooking')}</p>
          ) : (
            <p>{t('childReview.noteMember')}</p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-foreground/10 bg-background/40 px-8 py-4">
        <div className="flex gap-3">
          <Button
            variant="outline"
            size="lg"
            className="h-14 rounded-2xl px-6 text-lg"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft className="mr-2 h-5 w-5" /> {t('common.back')}
          </Button>
          {publicMode && onStaffHelp && <Button variant="outline" size="lg"
            className="h-14 rounded-2xl px-6 text-lg" onClick={onStaffHelp}>
            {t('childReview.continueOnStaff')}
          </Button>}
          <Button
            size="lg"
            disabled={busy || !canContinue}
            className="h-14 flex-1 rounded-2xl text-lg font-bold gap-2"
            onClick={onContinue}
          >
            {publicMode ? t('common.done') : t('common.continue')}
            <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
