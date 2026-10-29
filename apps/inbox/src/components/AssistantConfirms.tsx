import { Archive, CheckCircle2, Loader2 } from 'lucide-react';
import type { AiRule, KbEntry } from '@/api/assistant';
import type { InboxMe } from '@/api/inbox';
import { Refusal } from '@/components/confirms';
import { Dialog } from '@/components/Dialog';
import { ruleIntentLabel } from '@/lib/assistant';
import { branchLabel, langLabel } from '@/lib/view';

// The Assistant page's button styles (AssistantSettings.tsx keeps its own copy).
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-60';
const CANCEL = 'rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800';

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
      iconTint={acting?.what === 'approve' ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : undefined}
      title={acting?.what === 'approve' ? 'Approve this entry?' : 'Archive this entry?'}
      subtitle={acting ? `${acting.entry.key} · ${langLabel(acting.entry.language)}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {acting?.what === 'approve' ? 'Yes, approve' : 'Yes, archive'}
          </button>
        </>
      }
    >
      <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
        {acting?.what === 'approve'
          ? 'The assistant may answer customers from these words from now on, on every number that is live. You are recorded as the approver.'
          : 'The assistant stops using it, and its key is free for a new entry.'}
      </p>
      {acting?.what === 'approve' && (
        <p className="mt-2 whitespace-pre-line break-words rounded-lg bg-slate-50 dark:bg-slate-950/60 px-3 py-2 text-[12.5px] text-slate-700 dark:text-slate-200">
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
      iconTint={acting?.what === 'approve' ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : undefined}
      title={acting?.what === 'approve' ? 'Approve this rule?' : 'Archive this rule?'}
      subtitle={acting ? `${ruleIntentLabel(acting.rule.intent)} · ${acting.rule.branchId ? branchLabel(acting.rule.branchId, me.teams) : 'Both parks'}` : undefined}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {acting?.what === 'approve' ? 'Yes, approve' : 'Yes, archive'}
          </button>
        </>
      }
    >
      <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
        {acting?.what === 'approve'
          ? 'The assistant follows this rule from now on, on every number that is live. You are recorded as the approver.'
          : 'The assistant stops following it. It stays under Archived.'}
      </p>
      {acting && (
        <p className="mt-2 whitespace-pre-line break-words rounded-lg bg-slate-50 dark:bg-slate-950/60 px-3 py-2 text-[12.5px] text-slate-700 dark:text-slate-200">
          {acting.rule.instruction}
        </p>
      )}
      {error && <Refusal text={error} />}
    </Dialog>
  );
}
