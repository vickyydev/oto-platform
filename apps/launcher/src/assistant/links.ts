/**
 * "Take me there" (SCRUM-591, round I3a; plan §C). The api resolves a link
 * key to `{ app, path, shows }` and has already dropped any the asker may not
 * open; the launcher decides only HOW to open it, from the tiles this person
 * has:
 *
 *   - `launcher` → a page of this app, by its own router;
 *   - an app on their launcher with an address → the hand-off with the path
 *     as its target (P1: `openApp(app, path)`);
 *   - an app on their launcher with no address on this deployment → a plain
 *     note, in the words the hand-off itself fails with;
 *   - an app NOT on their launcher → a plain note, never a button.
 */
import { safeTargetPath } from '@oto/shared/handoff-target';
import type { AskLink } from '@/api/assistant';
import type { SuiteApp } from '@/suite/apps';

export type LinkTarget =
  | { kind: 'launcher'; path: string }
  | { kind: 'app'; app: SuiteApp; path: string }
  | { kind: 'not-deployed'; note: string }
  | { kind: 'not-on-launcher'; note: string };

/** What each app is called where it is not on a person's launcher to name itself. */
const APP_NAMES: Record<AskLink['app'], string> = {
  oto_app: 'OTO App',
  console: 'Console',
  inbox: 'Inbox',
  launcher: 'the launcher',
};

/**
 * @param tiles The apps on this person's launcher (`tilesFor` in suite/apps.ts):
 *   the same list the tiles above the panel are drawn from.
 */
export function resolveLink(link: AskLink, tiles: SuiteApp[]): LinkTarget {
  const path = safeTargetPath(link.path) ?? '/';
  if (link.app === 'launcher') return { kind: 'launcher', path };
  const app = tiles.find((t) => t.key === link.app);
  if (!app) {
    return {
      kind: 'not-on-launcher',
      note: `${link.shows} is in ${APP_NAMES[link.app]}, which is not on your launcher.`,
    };
  }
  if (!app.origin) return { kind: 'not-deployed', note: `${app.name} has no address on this deployment` };
  return { kind: 'app', app, path };
}
