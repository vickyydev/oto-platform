import type { InboxNextAction } from '@oto/shared';

export const NEXT_ACTION_LABELS: Record<InboxNextAction, string> = {
  staff_reply_needed: 'Staff reply needed',
  ai_replying: 'AI replying',
  ai_previewing: 'Preparing AI preview · not sent',
  ai_sent: 'AI sent · waiting for customer',
  waiting_customer: 'Waiting for customer',
  shadow_preview: 'AI preview · not sent',
  handled: 'Handled',
};
export const NEXT_ACTION_COLOURS: Record<InboxNextAction, string> = {
  staff_reply_needed: 'bg-amber-100 text-amber-950 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700',
  ai_replying: 'bg-indigo-100 text-indigo-950 ring-indigo-300 dark:bg-indigo-950 dark:text-indigo-100 dark:ring-indigo-700',
  ai_previewing: 'bg-violet-100 text-violet-950 ring-violet-300 dark:bg-violet-950 dark:text-violet-100 dark:ring-violet-700',
  ai_sent: 'bg-emerald-100 text-emerald-950 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-700',
  waiting_customer: 'bg-slate-100 text-slate-800 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
  shadow_preview: 'bg-violet-100 text-violet-950 ring-violet-300 dark:bg-violet-950 dark:text-violet-100 dark:ring-violet-700',
  handled: 'bg-slate-100 text-slate-800 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
};

/** Selection and per-viewer unread remain separately visible in either theme. */
export function conversationRowColour(selected: boolean, unread: number): string {
  return [unread > 0 ? 'border-l-4 border-l-indigo-600 dark:border-l-indigo-400' : 'border-l-4 border-l-transparent',
    selected ? 'bg-emerald-50 ring-2 ring-inset ring-emerald-700 dark:bg-emerald-950 dark:ring-emerald-300'
      : unread > 0 ? 'bg-indigo-50 dark:bg-indigo-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800'].join(' ');
}
