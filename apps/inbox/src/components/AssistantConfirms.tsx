import { Archive, CheckCircle2, Loader2 } from 'lucide-react';
import type { AiRule, KbEntry } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { Refusal } from '@/components/confirms';
import { Dialog } from '@/components/Dialog';
import { BTN_MAIN, BTN_QUIET } from '@/components/ui';
import { ruleIntentLabel } from '@/lib/assistant';
import { branchLabel, langLabel } from '@/lib/view';

// The house controls (SCRUM-1016, components/ui.ts).
const PRIMARY = BTN_MAIN;
const CANCEL = BTN_QUIET;

export type AssistantAct = 'approve' | 'archive';

interface ConfirmProps {
  busy: boolean;
  /** The server's refusal, shown as it was said. */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * "Approve this entry?" / "Archive this entry?" — the Knowledge tab's
 * confirmation, written once so the Teach chat's cards open the same one
 * (SCRUM-696).
 */
export function KbConfirm({ acting, busy, error, onCancel, onConfirm }: ConfirmProps & { acting: { entry: KbEntry; what: AssistantAct } | null }) {
  return (
    <Dialog
      open={acting !== null}
      onClose={onCancel}
      icon={acting?.what === 'approve' ? CheckCircle2 : Archive}
      tone={acting?.what === 'approve' ? 'money' : 'neutral'}
      title={acting?.what === 'approve' ? 'Approve this entry?' : 'Archive this entry?'}
      subtitle={acting ? `${acting.entry.key} · ${langLabel(acting.entry.language)}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            {acting?.what === 'approve' ? 'Yes, approve' : 'Yes, archive'}
          </button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed text-ink-soft md:text-[13px]">
        {acting?.what === 'approve'
          ? 'The assistant may answer customers from these words from now on, on every number that is live. You are recorded as the approver.'
          : 'The assistant stops using it, and its key is free for a new entry.'}
      </p>
      {acting?.what === 'approve' && (
        <p className="mt-2 whitespace-pre-line break-words rounded-xl border border-line bg-card px-3 py-2 text-[13.5px] text-ink md:bg-ground">
          {acting.entry.body}
        </p>
      )}
      {error && <Refusal text={error} />}
    </Dialog>
  );
}

/**
 * "Approve this rule?" / "Archive this rule?" — the Rules tab's confirmation,
 * written once so the Teach chat's cards open the same one (SCRUM-696).
 */
export function RuleConfirm({
  me,
  acting,
  busy,
  error,
  onCancel,
  onConfirm,
}: ConfirmProps & { me: InboxMe; acting: { rule: AiRule; what: AssistantAct } | null }) {
  return (
    <Dialog
      open={acting !== null}
      onClose={onCancel}
      icon={acting?.what === 'approve' ? CheckCircle2 : Archive}
      tone={acting?.what === 'approve' ? 'money' : 'neutral'}
      title={acting?.what === 'approve' ? 'Approve this rule?' : 'Archive this rule?'}
      subtitle={acting ? `${ruleIntentLabel(acting.rule.intent)} · ${acting.rule.branchId ? branchLabel(acting.rule.branchId, me.teams) : 'Both parks'}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY}>
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            {acting?.what === 'approve' ? 'Yes, approve' : 'Yes, archive'}
          </button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed text-ink-soft md:text-[13px]">
        {acting?.what === 'approve'
          ? 'The assistant follows this rule from now on, on every number that is live. You are recorded as the approver.'
          : 'The assistant stops following it. It stays under Archived.'}
      </p>
      {acting && (
        <p className="mt-2 whitespace-pre-line break-words rounded-xl border border-line bg-card px-3 py-2 text-[13.5px] text-ink md:bg-ground">
          {acting.rule.instruction}
        </p>
      )}
      {error && <Refusal text={error} />}
    </Dialog>
  );
}
