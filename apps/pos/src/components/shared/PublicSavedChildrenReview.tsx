import { useEffect, useRef, useState } from 'react';
import { DISPLAY_CHILD_MAX_AGE, childReviewAge, type ChildReviewAction, type ChildReviewPrompt } from '@oto/shared';
import { SavedChildrenReview, type SavedChildrenReviewSlot } from './SavedChildrenReview';
import { slotAge } from '@/components/till/SupervisionGate';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/i18n/LanguageContext';

type ServerSlot = ChildReviewPrompt['slots'][number];
const draftFrom = (slot: ServerSlot): SavedChildrenReviewSlot => ({
  id: slot.id, savedChildId: slot.savedChildId ?? undefined, name: slot.name,
  dateOfBirth: slot.dateOfBirth ?? undefined, age: slot.ageYears === null ? '' : String(slot.ageYears),
});
const matches = (draft: SavedChildrenReviewSlot, slot: ServerSlot) =>
  (draft.savedChildId ?? null) === slot.savedChildId && draft.name.trim() === slot.name.trim()
  && (draft.dateOfBirth ?? null) === slot.dateOfBirth
  && (draft.age.trim() ? Number(draft.age) : null) === slot.ageYears;

/**
 * SCRUM-1014 — how long a new child's name and age wait after the family's
 * last keystroke or pick before they go to the till, so a name is sent when
 * it is typed rather than letter by letter.
 */
export const NEW_CHILD_SEND_MS = 600;

/** Public drafts never carry health, supervision, photos or full child records. */
export function PublicSavedChildrenReview({ prompt, busy, answerPending = busy, onAction }: {
  prompt: ChildReviewPrompt;
  /** An answer the screen waits on is out: nothing may be typed or pressed. */
  busy: boolean;
  /**
   * SCRUM-1014 — any answer is out, a new child's name included. The family
   * keeps typing while the till takes a new child's name (`busy` stays
   * false for it), but nothing else is sent until the till has it.
   */
  answerPending?: boolean;
  onAction: (action: ChildReviewAction) => void;
}) {
  const { lang, t } = useLanguage();
  const [drafts, setDrafts] = useState(() => prompt.slots.map(draftFrom));
  const previousSlots = useRef(prompt.slots);
  useEffect(() => {
    const previous = new Map(previousSlots.current.map(slot => [slot.id, slot]));
    previousSlots.current = prompt.slots;
    setDrafts(current => {
      const next = prompt.slots.map(slot => {
        const draft = current.find(item => item.id === slot.id);
        const before = previous.get(slot.id);
        if (draft && before && before.savedChildId === slot.savedChildId && !matches(draft, before)) return draft;
        if (draft && matches(draft, slot)) return draft;
        return draftFrom(slot);
      });
      return next.length === current.length && next.every((slot, index) => slot === current[index]) ? current : next;
    });
  }, [prompt.slots]);

  const editLocked = busy || prompt.save.status !== 'idle';
  const locked = editLocked || answerPending;
  const confirmedIds = prompt.slots.filter(slot => slot.confirmed
    && drafts.some(draft => draft.id === slot.id && matches(draft, slot))).map(slot => slot.id);
  // SCRUM-1014 — a new child is ready once the till holds the name and age
  // shown here; a saved child once the family confirmed it.
  const heldByTill = (slot: ServerSlot) => drafts.some(draft => draft.id === slot.id && matches(draft, slot));
  const canContinue = !locked && prompt.canContinue
    && prompt.slots.every(slot => slot.savedChildId ? confirmedIds.includes(slot.id) : heldByTill(slot));
  const fence = { requestId: prompt.requestId, visitorId: prompt.visitorId };
  const staffHelp = () => onAction({ ...fence, action: 'staff_help' });
  const ageOf = (slot: SavedChildrenReviewSlot) =>
    slot.dateOfBirth ? childReviewAge(slot.dateOfBirth, prompt.referenceDate) : slotAge(slot);

  /**
   * SCRUM-1014 — A NEW CHILD'S NAME AND AGE GO TO THE TILL AS THEY ARE TYPED,
   * one answer at a time: the till shows them to the cashier and saves the
   * child to the family's record with the rest of the visit's children. A
   * place the family emptied with "+ A new child" or "Remove from saved" has
   * no saved child in it; its name and age are sent once both are there.
   */
  const latestAction = useRef(onAction);
  latestAction.current = onAction;
  useEffect(() => {
    if (locked) return;
    const due = drafts.find(draft => {
      const slot = prompt.slots.find(item => item.id === draft.id);
      const age = ageOf(draft);
      return !!slot && slot.savedChildId === null && !draft.savedChildId && !matches(draft, slot)
        && draft.name.trim().length > 0 && age !== null && age <= DISPLAY_CHILD_MAX_AGE;
    });
    if (!due) return;
    const age = ageOf(due)!;
    const timer = setTimeout(() => latestAction.current({ ...fence, action: 'new_child', slotId: due.id,
      name: due.name.trim(), dateOfBirth: due.dateOfBirth ?? null, ageYears: age }), NEW_CHILD_SEND_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the fence and the age follow the prompt
  }, [drafts, prompt, locked]);

  return <div className="flex h-full min-h-0 flex-col" data-testid="display-child-review">
    {prompt.save.status === 'saving' && <p role="status" className="shrink-0 px-8 py-3 text-center">
      {t('childReview.saving')}
    </p>}
    {prompt.save.status === 'failed' && <div role="alert" className="shrink-0 px-8 py-3 text-center">
      <p>{t('childReview.saveFailed')}</p>
      <Button className="mt-2" disabled={busy} onClick={() => {
        if (prompt.save.slotId && prompt.save.actionId) onAction({ ...fence, action: 'retry',
          slotId: prompt.save.slotId, retryActionId: prompt.save.actionId });
      }}>{t('childReview.retrySave')}</Button>
    </div>}
    <div className="flex-1 min-h-0">
      <SavedChildrenReview publicMode lang={lang} busy={editLocked} slots={drafts}
        publicReferenceDate={prompt.referenceDate}
        savedChildren={prompt.choices.map(child => ({ id: child.id, childName: child.name,
          dateOfBirth: child.dateOfBirth ?? undefined, childAge: child.ageYears }))}
        confirmedIds={confirmedIds} canContinue={canContinue} onStaffHelp={staffHelp}
        onUpdateSlot={(id, patch) => {
          if (editLocked) return;
          setDrafts(current => current.map(slot => slot.id !== id ? slot : { ...slot,
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.age === undefined ? {} : { age: patch.age }),
            ...('dateOfBirth' in patch ? { dateOfBirth: patch.dateOfBirth } : {}),
            ...(patch.dateOfBirth ? { age: String(childReviewAge(patch.dateOfBirth, prompt.referenceDate) ?? '') } : {}),
          }));
        }}
        onConfirmSlot={id => {
          if (locked) return;
          const slot = drafts.find(draft => draft.id === id);
          const currentSlot = prompt.slots.find(item => item.id === id);
          const age = slot ? ageOf(slot) : null;
          if (!slot?.savedChildId || currentSlot?.savedChildId !== slot.savedChildId
            || !slot.name.trim() || age === null || age > 17) return;
          setDrafts(current => current.map(draft => draft.id === id ? { ...draft, name: slot.name.trim(), age: String(age) } : draft));
          onAction({ ...fence, action: 'confirm', slotId: id, savedChildId: currentSlot.savedChildId, name: slot.name.trim(),
            dateOfBirth: slot.dateOfBirth ?? null, ageYears: age });
        }}
        onAssignSaved={(slotId, child) => { if (!locked) onAction({ ...fence, action: 'select', slotId, choiceId: child.id }); }}
        // SCRUM-1014 — "+ A new child" empties the place for a new child, and
        // "Remove from saved" takes the saved child off the family's record,
        // as on the prototype's customer screen; the till carries both out.
        onMarkNew={slotId => { if (!locked) onAction({ ...fence, action: 'select', slotId, choiceId: null }); }}
        onRemoveSaved={(slotId, childId) => {
          if (locked || prompt.slots.find(slot => slot.id === slotId)?.savedChildId !== childId) return;
          onAction({ ...fence, action: 'remove', slotId, savedChildId: childId });
        }}
        onBack={() => { if (!locked) onAction({ ...fence, action: 'back' }); }}
        onContinue={() => { if (canContinue) onAction({ ...fence, action: 'done' }); }} />
    </div>
  </div>;
}
