// THE ASSISTANT PAGES' OWN PARTS (SCRUM-1044, docs/progress/plans/
// inbox-redesign/SETTINGS.md): what Numbers, Knowledge, Examples, Rules and
// Teach share beyond the settings frame's parts (`settings-parts.tsx`), in a
// module of their own so the pages import them without importing each other.
import { createContext, useContext, type ReactNode } from 'react';
import type { KbLanguage, KbStatus } from '@/api/assistant';
import { PageHeader } from '@/components/settings-parts';
import { BADGE, TONE } from '@/components/ui';
import { KB_LANGUAGES, KB_STATUS_LABEL, intentLabel, ruleIntentLabel } from '@/lib/assistant';
import type { AssistantTab } from '@/lib/url';

/** The assistant's line at the head of each of its pages, as the page has said it since SCRUM-590. */
export const ASSISTANT_HELP =
  'The assistant answers simple questions from the approved knowledge base and hands everything else to the team. A person replying always takes over.';

/**
 * The first of the assistant's pages this viewer may open (Numbers; Knowledge
 * for someone without the numbers' right): the one page that says the
 * assistant's line. Every page has its own note under it, so the line said on
 * all five pushed a phone's list below the fold (SCRUM-1044 review). Null, a
 * page shown on its own, says it.
 */
export const AssistantFirstPage = createContext<AssistantTab | null>(null);

/**
 * The head of an assistant page: "Assistant" over its name, its main action on
 * the right, and the assistant's line on the first page only.
 */
export function AssistantHeader({ section, title, actions }: { section: AssistantTab; title: string; actions?: ReactNode }) {
  const first = useContext(AssistantFirstPage);
  return <PageHeader eyebrow="Assistant" title={title} help={first === null || first === section ? ASSISTANT_HELP : undefined} actions={actions} />;
}

/** A draft, an approval or the archive as a row's one badge, in the tones the template rows wear. */
const STATUS_TONE: Record<KbStatus, string> = { draft: TONE.ask, approved: TONE.money, archived: TONE.neutral };
export function StatusBadge({ status }: { status: KbStatus }) {
  return <span className={`${BADGE} ${STATUS_TONE[status]}`}>{KB_STATUS_LABEL[status]}</span>;
}

/** A knowledge entry's or an example's language by name ("English"). */
export function kbLanguageName(code: KbLanguage | string): string {
  return KB_LANGUAGES.find(([v]) => v === code)?.[1] ?? code.toUpperCase();
}

/** Words an intent spells in lower case that are said in capitals ("FAQ", "About OTO"). */
const INTENT_CAPITALS = new Set(['faq', 'oto', 'gm', 'beo']);

/**
 * A kind of message as a title or a choice, in sentence case: `lost_item`
 * reads "Lost item", `faq` "FAQ", the rules' `any` "Any message" (as
 * `ruleIntentLabel` says it). The value sent is always the intent itself.
 */
export function intentTitle(intent: string): string {
  const label = ruleIntentLabel(intent);
  if (label !== intentLabel(intent)) return label;
  const words = intent
    .split('_')
    .filter(Boolean)
    .map((w) => (INTENT_CAPITALS.has(w) ? w.toUpperCase() : w))
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "4 entries, 1 archived", "1 rule": what a list holds, in words. */
export function countWords(n: number, one: string, many: string, archived = 0): string {
  return `${n} ${n === 1 ? one : many}${archived > 0 ? `, ${archived} archived` : ''}`;
}

/** A person's words quoted in a control's accessible name, cut at a word near `max` characters. */
export function quoteFor(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return `“${flat}”`;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `“${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…”`;
}
