import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Bot } from 'lucide-react';
import { INTERNAL_ASSISTANT_LABEL } from '@oto/assistant/internal-lines';
import type { Permission } from '@oto/shared/permissions';
import { useSession } from '@/auth/SessionContext';
import { ASK_PERMISSION } from '@/assistant/ask';
import { shellReducer, type ShellEvent } from '@/assistant/shell';
import { cn } from '@/lib/utils';
import { tilesFor, type SuiteApp } from '@/suite/apps';
import { openApp } from '@/suite/handoff';
import type { LinkOpeners } from './AskAnswer';
import { AssistantPopup } from './AssistantPopup';
import { useAskThread, type ThreadApi } from './useAskThread';

/**
 * On the document while the floating button is on the page, so every page's
 * main keeps the bottom-right corner clear of it (index.css).
 */
export const DOCKED_CLASS = 'assistant-docked';

/**
 * Where the floating button sits: bottom-right, above the phone's bottom safe
 * area. A wrapper, because the pill's `hover-elevate` surface (index.css) is
 * `position: relative` and would undo `fixed` on the same element.
 */
export const DOCK_POSITION =
  'fixed z-40 right-[calc(1rem_+_env(safe-area-inset-right))] bottom-[calc(1rem_+_env(safe-area-inset-bottom))]';

/** The floating button itself: the brand's coral pill, with the assistant's icon and name. */
export const DOCK_BUTTON = cn(
  'inline-flex items-center gap-2 h-11 rounded-full border border-primary-border bg-primary pl-3 pr-4 text-sm font-semibold text-primary-foreground shadow-lg',
  'hover-elevate active-elevate-2',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
);

export interface AssistantDockProps {
  has: (permission: Permission) => boolean;
  tiles: SuiteApp[];
  openers: LinkOpeners;
  client?: ThreadApi;
  timezone?: string | null;
}

/**
 * The internal assistant's door (SCRUM-591, the chat-popup round): a small
 * floating button, bottom-right, and the chat popup it opens. Nothing on the
 * launcher home itself. Without `assistant:ask:use` there is no button at
 * all — no disabled stub and no line about it (the capability gate).
 *
 * Open or closed and the typed draft live here, and the dock stays mounted
 * across the launcher's pages, so both survive a move to the account page and
 * back. The popup is closed on first visit.
 */
export function AssistantDock({ has, tiles, openers, client, timezone }: AssistantDockProps) {
  const shown = has(ASK_PERMISSION);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const thread = useAskThread(client);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!shown) return;
    document.documentElement.classList.add(DOCKED_CLASS);
    return () => document.documentElement.classList.remove(DOCKED_CLASS);
  }, [shown]);

  // Esc closes the popup from anywhere on the page, not only from inside it:
  // the popup is not modal, so focus may well be on the page behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen((o) => shellReducer(o, 'escape'));
      buttonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!shown) return null;

  const dispatch = (event: ShellEvent) => setOpen((o) => shellReducer(o, event));
  const close = () => {
    dispatch('close');
    buttonRef.current?.focus();
  };

  return (
    <>
      <div className={DOCK_POSITION}>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => dispatch('toggle')}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={DOCK_BUTTON}
        >
          <Bot className="w-5 h-5" />
          {INTERNAL_ASSISTANT_LABEL.en}
        </button>
      </div>
      {open && (
        <AssistantPopup
          thread={thread}
          draft={draft}
          onDraft={setDraft}
          onClose={close}
          has={has}
          tiles={tiles}
          openers={openers}
          timezone={timezone}
        />
      )}
    </>
  );
}

/**
 * The dock on a signed-in session: the tiles this person has are the only
 * apps "Take me there" may open, and a launcher page opens by its own router.
 * Nothing while signed out, locked, or on the password-change screen.
 */
export function SuiteAssistant({ client }: { client?: ThreadApi } = {}) {
  const { state, me, has, locked } = useSession();
  const [, navigate] = useLocation();
  if (state !== 'signed-in' || locked || me?.account.mustChangePassword) return null;
  return (
    <AssistantDock
      has={has}
      tiles={tilesFor(has)}
      openers={{ openApp, navigate: (path) => navigate(path) }}
      client={client}
      timezone={me?.branch?.timezone}
    />
  );
}
