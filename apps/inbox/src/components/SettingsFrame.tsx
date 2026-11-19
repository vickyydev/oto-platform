import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, FileText, GraduationCap, MessageSquareQuote, Radio, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { InboxMe } from '@/api/inbox';
import { assistantCapabilities } from '@/api/assistant';
import { AssistantSettings, assistantSections } from '@/components/AssistantSettings';
import { FOCUS_INSIDE, PAGE_COLUMN } from '@/components/settings-parts';
import { TemplateSettings } from '@/components/TemplateSettings';
import { BTN_ICON, SEGMENT, SEGMENT_OFF, SEGMENT_ON } from '@/components/ui';
import type { AssistantTab, SettingsPage } from '@/lib/url';

/** A page of the settings frame: Templates, or one of the assistant's sections. */
export type SettingsKey = 'templates' | AssistantTab;

export interface SettingsNavItem {
  key: SettingsKey;
  label: string;
  /** Where it lives in the address: `?settings=<page>` and, for the assistant, `&section=<section>`. */
  page: SettingsPage;
  section: AssistantTab | null;
}

const ICON: Record<SettingsKey, LucideIcon> = {
  templates: FileText,
  numbers: Radio,
  knowledge: BookOpen,
  examples: MessageSquareQuote,
  rules: ShieldCheck,
  teach: GraduationCap,
};

/** The back control's words, the same on a phone (its accessible name) and wider (its label). */
export const BACK_TO_INBOX = 'Back to inbox';

/**
 * The pages this viewer may open, in the frame's order, by today's rules:
 * Templates on `inbox:template:manage` (`capabilities.templates`); Numbers on
 * `inbox:ai:manage`; Knowledge, Examples, Rules and Teach on
 * `inbox:kb:manage` (`assistantSections`). Nobody else's. Pure, so the tests
 * read the real thing.
 */
export function settingsNav(me: InboxMe): SettingsNavItem[] {
  return [
    ...(me.capabilities.templates ? [{ key: 'templates', label: 'Templates', page: 'templates', section: null } as const] : []),
    ...assistantSections(assistantCapabilities(me)).map(
      ([section, label]): SettingsNavItem => ({ key: section, label, page: 'assistant', section }),
    ),
  ];
}

/**
 * The page the frame shows for an address: Templates; or the assistant's
 * named section, its first when none is named or the named one is not the
 * viewer's (the clamp the assistant's tabs always made). Null when the viewer
 * may open none of it.
 */
export function settingsCurrent(items: readonly SettingsNavItem[], page: SettingsPage, section: AssistantTab | null): SettingsKey | null {
  if (page === 'templates') return items.some((i) => i.key === 'templates') ? 'templates' : null;
  const assistant = items.filter((i) => i.page === 'assistant');
  return (assistant.find((i) => i.section === section) ?? assistant[0])?.key ?? null;
}

/** A line of the column (the views column's look, Rail `ScopeNav`): its icon, its words, chosen on the band. */
const NAV_ITEM = `hit flex min-h-row-touch w-full min-w-0 items-center gap-2.5 rounded-[10px] px-3 text-left text-ui text-ink transition ${FOCUS_INSIDE}`;

function NavList({ items, current, onOpen }: { items: readonly SettingsNavItem[]; current: SettingsKey | null; onOpen: (i: SettingsNavItem) => void }) {
  const groupId = useId();
  const line =(i: SettingsNavItem) => {
    const Icon = ICON[i.key];
    const on = i.key === current;
    return (
      <button
        key={i.key}
        type="button"
        data-settings-page={i.key}
        aria-current={on ? 'page' : undefined}
        onClick={() => onOpen(i)}
        className={`${NAV_ITEM} ${on ? 'bg-band font-bold' : 'font-medium hover:bg-wash'}`}
      >
        <Icon aria-hidden className={`h-4 w-4 shrink-0 ${on ? 'text-coral-ink' : 'text-ink-soft'}`} />
        <span className="min-w-0 flex-1 truncate">{i.label}</span>
      </button>
    );
  };
  const templates = items.filter((i) => i.page === 'templates');
  const assistant = items.filter((i) => i.page === 'assistant');
  return (
    <nav aria-label="Settings pages" className="flex flex-col gap-[18px]">
      {templates.length > 0 && <div className="flex flex-col gap-0.5">{templates.map(line)}</div>}
      {assistant.length > 0 && (
        <div role="group" aria-labelledby={groupId} className="flex flex-col gap-0.5">
          <h3 id={groupId} className="mb-1 px-3 text-meta font-bold text-ink-muted">
            Assistant
          </h3>
          {assistant.map(line)}
        </div>
      )}
    </nav>
  );
}

/** The band's ends fading where there is more to scroll to (before, after). */
const STRIP_FADE: Record<string, string> = {
  '00': '',
  '01': '[mask-image:linear-gradient(to_right,black_calc(100%_-_2.5rem),transparent)]',
  '10': '[mask-image:linear-gradient(to_right,transparent,black_2.5rem)]',
  '11': '[mask-image:linear-gradient(to_right,transparent,black_2.5rem,black_calc(100%_-_2.5rem),transparent)]',
};

/**
 * The pages on a phone: one band of segments under the title, scrolling
 * sideways when it is wider than the screen, the chosen one brought into
 * view, an end that has more to show fading out.
 */
function Strip({ items, current, onOpen }: { items: readonly SettingsNavItem[]; current: SettingsKey | null; onOpen: (i: SettingsNavItem) => void }) {
  const chosen = useRef<HTMLButtonElement | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  // Which ends have more to scroll to: that end fades out, so the band reads as one that moves.
  const [more, setMore] = useState({ before: false, after: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.before === before && m.after === after ? m : { before, after }));
  }, []);
  // The chosen page in the middle of the band, clear of either fade; again
  // once the faces have loaded (the words' widths change) and on a resize.
  // Only the band scrolls: nothing else on the page moves.
  const centre = useCallback(() => {
    const el = scroller.current;
    const item = chosen.current;
    if (el && item) {
      const band = el.getBoundingClientRect();
      const at = item.getBoundingClientRect();
      el.scrollLeft += at.left + at.width / 2 - (band.left + band.width / 2);
    }
    measure();
  }, [measure]);
  useEffect(() => {
    centre();
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) centre();
    });
    return () => {
      live = false;
    };
  }, [current, centre]);
  useEffect(() => {
    window.addEventListener('resize', centre);
    return () => window.removeEventListener('resize', centre);
  }, [centre]);
  return (
    <nav
      ref={scroller}
      aria-label="Settings pages"
      onScroll={measure}
      className={`-mx-4 overflow-x-auto px-4 [scrollbar-width:none] ${STRIP_FADE[`${more.before ? 1 : 0}${more.after ? 1 : 0}`]}`}
    >
      <div className="flex w-max min-w-full gap-1 rounded-[14px] bg-band p-1">
        {items.map((i) => {
          const on = i.key === current;
          return (
            <button
              key={i.key}
              ref={on ? chosen : undefined}
              type="button"
              data-settings-page={i.key}
              aria-current={on ? 'page' : undefined}
              onClick={() => onOpen(i)}
              className={`${SEGMENT} flex-1 shrink-0 justify-center whitespace-nowrap rounded-[10px] ${on ? SEGMENT_ON : SEGMENT_OFF}`}
            >
              {i.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The settings frame (SCRUM-1044, docs/progress/plans/inbox-redesign/
 * SETTINGS.md): settings as their own view inside the Inbox shell, under the
 * app bar. From 768 px a column on the left, the views column's width and
 * look, holds the way back, the title and the pages; the chosen page fills
 * the rest in a centred column of reading width. On a phone the way back and
 * the title sit under the app bar with the pages one tap away in a band, and
 * the page is one column.
 *
 * The address is today's (`?settings=…&section=…`, `lib/url.ts`): `onOpen`
 * names the page and the section, and the workspace writes them. Only the
 * pages the viewer may open are offered (`settingsNav`); the api checks every
 * read and write again.
 */
export function SettingsFrame({
  me,
  page,
  section,
  accessKey,
  onOpen,
  onBack,
}: {
  me: InboxMe;
  page: SettingsPage;
  section: AssistantTab | null;
  /** The viewer's limits (SCRUM-993): the assistant's pages start over when they change, as before. */
  accessKey: string;
  onOpen: (page: SettingsPage, section: AssistantTab | null) => void;
  onBack: () => void;
}) {
  const items = settingsNav(me);
  const current = settingsCurrent(items, page, section);
  const caps = assistantCapabilities(me);
  const open = (i: SettingsNavItem) => onOpen(i.page, i.section);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* From 768 px: the column, as the views column stands beside the list. */}
      <div data-pane="settings-nav" className="hidden w-56 shrink-0 flex-col border-r border-line bg-ground md:flex">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3.5">
          <button
            type="button"
            onClick={onBack}
            className={`hit flex min-h-row-touch w-full items-center gap-2 rounded-[10px] px-3 text-left text-ui font-semibold text-ink-soft transition hover:bg-wash hover:text-ink ${FOCUS_INSIDE}`}
          >
            <ArrowLeft aria-hidden className="h-4 w-4 shrink-0" />
            {BACK_TO_INBOX}
          </button>
          <h2 className="px-3 text-heading font-extrabold tracking-[-0.02em] text-ink">Settings</h2>
          <NavList items={items} current={current} onOpen={open} />
        </div>
      </div>

      {/* Below 768 px: the way back and the title under the app bar, then the pages in one band. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-line bg-ground px-4 pb-3 md:hidden">
        <div className="-ml-2 flex min-w-0 items-center gap-1">
          <button type="button" onClick={onBack} aria-label={BACK_TO_INBOX} className={BTN_ICON}>
            <ArrowLeft aria-hidden className="h-[22px] w-[22px]" />
          </button>
          <h2 className="min-w-0 truncate text-title font-bold text-ink">Settings</h2>
        </div>
        {items.length > 1 && <Strip items={items} current={current} onOpen={open} />}
      </div>

      <section data-pane="settings" aria-label="Settings page" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {/* Each page in the centred column; Teach, a chat, takes the whole area and its height, its message box at the foot. */}
        <div className={current === 'teach' ? 'flex min-h-full w-full flex-col' : `${PAGE_COLUMN} pb-8 pt-4 md:pt-6`}>
          {current === 'templates' && <TemplateSettings me={me} />}
          {/* The assistant's pages, or its own "You do not manage the assistant."; mounted for Teach while Templates shows. */}
          {(caps.kb || caps.ai || page === 'assistant') && (
            <AssistantSettings
              key={accessKey}
              me={me}
              tab={section}
              shown={page === 'assistant'}
              onTab={(t) => onOpen('assistant', t)}
            />
          )}
        </div>
      </section>
    </div>
  );
}
