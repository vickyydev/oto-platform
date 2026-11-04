import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  TIER_APPROVAL_REASONS,
  TIER_APPROVAL_REASON_LABELS,
  TIER_APPROVAL_TEXT_MAX,
  tierApprovalProblem,
  type TierApprovalChoice,
  type TierApprovalReason,
} from '@/lib/tierApproval';
import { ArrowLeft, Hand, Loader2, UserCheck } from 'lucide-react';

/**
 * SCRUM-772 — the verify step's special case: the Thai rate approved by hand.
 *
 * Shown in place of the document list once staff press "Special case,
 * approve by hand". A reason from the short list (Other asks what, in at
 * least two words), an optional note, and one press. Nobody else confirms
 * it: the approver is the signed-in account, recorded with the time, and the
 * rate applies to this sale only. The same visual language as the document
 * list it replaces: tall choice buttons, the dashed "recorded automatically"
 * line, the full-width confirm.
 */
export interface TierApprovalDraft {
  reason: TierApprovalReason | null;
  reasonText: string;
  note: string;
}

export const EMPTY_TIER_APPROVAL: TierApprovalDraft = { reason: null, reasonText: '', note: '' };

/**
 * The choice the draft makes, or the sentence that says why it cannot be
 * sent yet — the platform's own rule (`tierApprovalProblem`), so the till
 * never sends what the route would refuse.
 */
export function tierApprovalChoiceOf(
  tier: string,
  draft: TierApprovalDraft,
): { choice: TierApprovalChoice | null; problem: string | null } {
  if (!draft.reason) return { choice: null, problem: null };
  const reasonText = draft.reason === 'other' ? draft.reasonText.trim() : '';
  const note = draft.note.trim();
  const problem = tierApprovalProblem({ toTier: tier, reason: draft.reason, reasonText, note });
  if (problem) return { choice: null, problem };
  return {
    choice: {
      reason: draft.reason,
      ...(reasonText ? { reasonText } : {}),
      ...(note ? { note } : {}),
    },
    problem: null,
  };
}

interface TierApprovalPanelProps {
  /** The rate's label, "Thai". */
  tierName: string;
  /** The tier code the approval is for, which the rule checks. */
  tier: string;
  /** The signed-in account, shown as the approver. */
  approverName: string;
  draft: TierApprovalDraft;
  onDraftChange: (draft: TierApprovalDraft) => void;
  busy: boolean;
  /** Why the platform refused the last press, if it did. */
  error: string | null;
  onBack: () => void;
  onApprove: (choice: TierApprovalChoice) => void;
}

export function TierApprovalPanel({
  tierName,
  tier,
  approverName,
  draft,
  onDraftChange,
  busy,
  error,
  onBack,
  onApprove,
}: TierApprovalPanelProps) {
  const { choice, problem } = tierApprovalChoiceOf(tier, draft);
  const isOther = draft.reason === 'other';
  // Say what is wrong once something has been typed, not on an empty field.
  const typed = (isOther && draft.reasonText !== '') || draft.note !== '';
  return (
    <div className="space-y-5" data-testid="tier-approval-panel">
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">
          Why approve the {tierName} rate by hand? <span className="text-destructive">*</span>
        </p>
        <div className="grid grid-cols-1 gap-2">
          {TIER_APPROVAL_REASONS.map((reason) => (
            <Button
              key={reason}
              type="button"
              variant={draft.reason === reason ? 'default' : 'outline'}
              className="h-14 justify-start text-base"
              disabled={busy}
              onClick={() => onDraftChange({ ...draft, reason })}
            >
              {TIER_APPROVAL_REASON_LABELS[reason]}
            </Button>
          ))}
        </div>
      </div>

      {isOther && (
        <div className="space-y-2">
          <label htmlFor="tier-approval-reason" className="text-sm font-medium text-muted-foreground">
            What is the reason? <span className="text-destructive">*</span>
          </label>
          <Input
            id="tier-approval-reason"
            value={draft.reasonText}
            maxLength={TIER_APPROVAL_TEXT_MAX}
            placeholder="e.g. Thai grandparent with the family"
            autoFocus
            disabled={busy}
            onChange={(e) => onDraftChange({ ...draft, reasonText: e.target.value })}
          />
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="tier-approval-note" className="text-sm font-medium text-muted-foreground">
          Note (optional)
        </label>
        <Input
          id="tier-approval-note"
          value={draft.note}
          maxLength={TIER_APPROVAL_TEXT_MAX}
          placeholder="Anything the next person should know"
          disabled={busy}
          onChange={(e) => onDraftChange({ ...draft, note: e.target.value })}
        />
      </div>

      {typed && problem && <p className="text-sm text-destructive">{problem}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Recorded automatically — the approver is the signed-in account. */}
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
        <UserCheck className="w-4 h-4 shrink-0 text-primary" />
        <span>
          Approved by <span className="font-semibold text-foreground">{approverName}</span> — recorded
          automatically with date &amp; time, for this sale only. The member profile is not changed.
        </span>
      </div>

      <Button
        className="w-full h-14 text-lg gap-2"
        disabled={!choice || busy}
        onClick={() => choice && onApprove(choice)}
      >
        {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Hand className="w-5 h-5" />}
        {busy ? 'Saving…' : `Approve ${tierName} rate by hand`}
      </Button>
      <Button type="button" variant="ghost" className="w-full h-11 gap-2" disabled={busy} onClick={onBack}>
        <ArrowLeft className="w-4 h-4" />
        Back to the document check
      </Button>
    </div>
  );
}
