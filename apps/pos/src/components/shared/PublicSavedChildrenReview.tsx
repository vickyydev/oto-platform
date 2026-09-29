import { useEffect, useRef, useState } from 'react';
import { childReviewAge, type ChildReviewAction, type ChildReviewPrompt } from '@oto/shared';
import { SavedChildrenReview, type SavedChildrenReviewSlot } from './SavedChildrenReview';
import { slotAge } from '@/components/till/SupervisionGate';
import { Button } from '@/components/ui/button';

type ServerSlot = ChildReviewPrompt['slots'][number];
const draftFrom = (slot: ServerSlot): SavedChildrenReviewSlot => ({
  id: slot.id, savedChildId: slot.savedChildId ?? undefined, name: slot.name,
  dateOfBirth: slot.dateOfBirth ?? undefined, age: slot.ageYears === null ? '' : String(slot.ageYears),
});
const matches = (draft: SavedChildrenReviewSlot, slot: ServerSlot) =>
  (draft.savedChildId ?? null) === slot.savedChildId && draft.name.trim() === slot.name.trim()
  && (draft.dateOfBirth ?? null) === slot.dateOfBirth
  && (draft.age.trim() ? Number(draft.age) : null) === slot.ageYears;

/** Public drafts never carry health, supervision, photos or full child records. */
export function PublicSavedChildrenReview({ prompt, busy, onAction }: {
  prompt: ChildReviewPrompt;
  busy: boolean;
  onAction: (action: ChildReviewAction) => void;
}) {
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

  const locked = busy || prompt.save.status !== 'idle';
  const confirmedIds = prompt.slots.filter(slot => slot.confirmed
    && drafts.some(draft => draft.id === slot.id && matches(draft, slot))).map(slot => slot.id);
  const canContinue = !locked && prompt.canContinue && confirmedIds.length === prompt.slots.length;
  const fence = { requestId: prompt.requestId, visitorId: prompt.visitorId };
  const staffHelp = () => onAction({ ...fence, action: 'staff_help' });

  return <div className="flex h-full min-h-0 flex-col" data-testid="display-child-review">
    {prompt.save.status === 'saving' && <p role="status" className="shrink-0 px-8 py-3 text-center">
      Saving the confirmed details to the member's record. Please wait.
    </p>}
    {prompt.save.status === 'failed' && <div role="alert" className="shrink-0 px-8 py-3 text-center">
      <p>The save could not be confirmed. Retry the same change or ask the team to continue on the staff screen.</p>
      <Button className="mt-2" disabled={busy} onClick={() => {
        if (prompt.save.slotId && prompt.save.actionId) onAction({ ...fence, action: 'retry',
          slotId: prompt.save.slotId, retryActionId: prompt.save.actionId });
      }}>Retry child save</Button>
    </div>}
    <div className="flex-1 min-h-0">
      <SavedChildrenReview publicMode busy={locked} slots={drafts}
        publicReferenceDate={prompt.referenceDate}
        savedChildren={prompt.choices.map(child => ({ id: child.id, childName: child.name,
          dateOfBirth: child.dateOfBirth ?? undefined, childAge: child.ageYears }))}
        confirmedIds={confirmedIds} canContinue={canContinue} onStaffHelp={staffHelp}
        onUpdateSlot={(id, patch) => {
          if (locked) return;
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
          const age = slot?.dateOfBirth ? childReviewAge(slot.dateOfBirth, prompt.referenceDate) : slot ? slotAge(slot) : null;
          if (!slot?.savedChildId || currentSlot?.savedChildId !== slot.savedChildId
            || !slot.name.trim() || age === null || age > 17) return;
          setDrafts(current => current.map(draft => draft.id === id ? { ...draft, name: slot.name.trim(), age: String(age) } : draft));
          onAction({ ...fence, action: 'confirm', slotId: id, savedChildId: currentSlot.savedChildId, name: slot.name.trim(),
            dateOfBirth: slot.dateOfBirth ?? null, ageYears: age });
        }}
        onAssignSaved={(slotId, child) => { if (!locked) onAction({ ...fence, action: 'select', slotId, choiceId: child.id }); }}
        onMarkNew={staffHelp} onRemoveSaved={staffHelp}
        onBack={() => { if (!locked) onAction({ ...fence, action: 'back' }); }}
        onContinue={() => { if (canContinue) onAction({ ...fence, action: 'done' }); }} />
    </div>
  </div>;
}
