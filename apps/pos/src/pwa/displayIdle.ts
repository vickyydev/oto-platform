import { useSyncExternalStore } from 'react';

/**
 * SCRUM-975 — WHEN THE COUNTER'S DISPLAY PAGE MAY TAKE A NEW BUILD.
 *
 * The display page (`/display`, `pages/Display.tsx`) stays open for weeks on
 * the counter's screen. It takes a new web build only by reloading, and a
 * reload under a family's fingers would throw away what they typed, so it
 * reloads only when nobody can be on it ("idle"):
 *
 *   - it is paired and showing its box's document (never the set-up screen,
 *     whose pairing code a reload would replace while somebody types it);
 *   - the box is heard from (no "Reconnecting", nothing paused);
 *   - nothing of the family's is on its way to the box (no answer sending or
 *     kept to send again);
 *   - and the till shows its welcome screen on it: the document's stage is
 *     `welcome`, with no prompt (no first screen, details, review or family
 *     form) and no member. Any sale in progress is another stage.
 *
 * The page says it here (`setDisplayIdle`), and `DisplayUpdater` reads it.
 */
export interface DisplayIdleFacts {
  paired: boolean;
  connected: boolean;
  sending: boolean;
  stage: string | null;
  prompt: unknown;
  member: unknown;
}

export function displayIdleForUpdate(facts: DisplayIdleFacts): boolean {
  return facts.paired && facts.connected && !facts.sending && facts.stage === 'welcome'
    && (facts.prompt === null || facts.prompt === undefined) && (facts.member === null || facts.member === undefined);
}

let idle = false;
const listeners = new Set<() => void>();

export function setDisplayIdle(value: boolean): void {
  if (value === idle) return;
  idle = value;
  for (const listener of listeners) listener();
}

export function getDisplayIdle(): boolean {
  return idle;
}

export function subscribeDisplayIdle(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useDisplayIdle(): boolean {
  return useSyncExternalStore(subscribeDisplayIdle, getDisplayIdle, getDisplayIdle);
}
