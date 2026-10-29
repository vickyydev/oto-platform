import {
  ClipboardList,
  Gift,
  MessagesSquare,
  Radar,
  Settings,
  Store,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@oto/shared/permissions';

/**
 * The suite, as one list. The key is also the slug in `app:<key>:access` and
 * the name the hand-off endpoint is asked for — except for an app with
 * `signOn: false`, which takes no hand-off — so a new app is one entry here
 * plus its permission in packages/shared.
 */
export type SuiteAppKey = 'pos' | 'console' | 'oto_app' | 'radar' | 'booth' | 'inbox';

export interface SuiteApp {
  key: SuiteAppKey;
  name: string;
  /** One line, on the tile: what a person would open it to do. */
  purpose: string;
  icon: LucideIcon;
  /** Holding this is what makes the tile appear at all. */
  permission: Permission;
  /**
   * A second permission for tiles that are not part of anyone's day job. The
   * booth's own screen runs unattended at the sales desk; its tile here is a
   * demonstration control, so reception — who holds `app:booth:access` to work
   * a booth — is not offered it.
   */
  alsoRequires?: Permission;
  /** Deployed origin, from the build environment. Absent = not deployed yet. */
  origin?: string;
  /**
   * `false` for an app that takes no hand-off (SCRUM-694): the launcher opens
   * `${origin}${entryPath}` and mints nothing. Absent is an app that signs on.
   */
  signOn?: false;
  /** Where an app with `signOn: false` opens, under its origin: `/#fake`. */
  entryPath?: string;
  /** The system doing this job today, where one exists and is not ours. */
  legacyUrl?: string;
  legacyLabel?: string;
  /** Named on the shell while the app is not here yet. */
  milestone: string;
  /** What the shell tells someone who opens it early. */
  arriving: string;
}

/**
 * An origin only counts if it parses. A half-set variable ("changeme", a bare
 * hostname, a trailing newline from a paste into a dashboard) would otherwise
 * become a dead tile that fails after the click rather than before it.
 */
function readOrigin(value: string | undefined, devFallback?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return import.meta.env.DEV ? devFallback : undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

const env = import.meta.env;

export const SUITE_APPS: SuiteApp[] = [
  {
    key: 'pos',
    name: 'POS',
    purpose: 'The till — admissions, membership, the customer display and check-in.',
    icon: Store,
    permission: 'app:pos:access',
    origin: readOrigin(env.VITE_POS_URL, 'http://localhost:25741'),
    milestone: 'M0 — front door',
    arriving:
      'The till is live. If this shell opened instead, its address is not set on this build.',
  },
  {
    key: 'console',
    name: 'Admin',
    purpose: 'Accounts and access, branches, the catalogue, activity and health.',
    icon: Settings,
    permission: 'app:console:access',
    origin: readOrigin(env.VITE_CONSOLE_URL),
    milestone: 'M0 — front door',
    arriving:
      'Admin brings people, the catalogue, devices, reports and platform health together. If this shell opened instead, its address is not set on this build.',
  },
  {
    key: 'oto_app',
    name: 'OTO App',
    purpose: 'Staff operations — shifts, tasks, events, camps and drop-off.',
    icon: ClipboardList,
    permission: 'app:oto_app:access',
    // 5000 is the port the app's own `npm run dev` listens on, so the whole
    // hand-off — tile, token, exchange, session — can be walked through on a
    // laptop without a deployment.
    origin: readOrigin(env.VITE_OTO_APP_URL, 'http://localhost:5000'),
    legacyUrl: readOrigin(env.VITE_OTO_APP_LEGACY_URL),
    legacyLabel: 'Open the OTO App that is running today',
    milestone: 'M10 — OTO App on the platform',
    arriving:
      'Its tables are in the central database and it opens from here with no second password. If this shell opened instead, its address is not set on this build.',
  },
  {
    key: 'radar',
    name: 'Radar',
    purpose: 'Revenue and attendance across the branches, past and present.',
    icon: Radar,
    permission: 'app:radar:access',
    origin: readOrigin(env.VITE_RADAR_URL),
    legacyUrl: readOrigin(env.VITE_RADAR_LEGACY_URL),
    legacyLabel: 'Open the Radar that is running today',
    milestone: 'M11 — Radar live',
    arriving:
      'The dashboard reads this POS’s own live analytics — a sale made at the till shows up here within minutes. The old systems’ history joins the same figures when their data is carried over.',
  },
  {
    key: 'booth',
    name: 'Lucky Wheel',
    purpose: 'The prize wheel at the sales booth — spins, prizes and vouchers.',
    icon: Gift,
    permission: 'app:booth:access',
    alsoRequires: 'admin:booth:read',
    origin: readOrigin(env.VITE_BOOTH_URL),
    /**
     * The demonstration wheel, with no hand-off (SCRUM-694): nobody signs in
     * at a booth any more, and `#fake` is honoured before the booth site's
     * own build switch, so the staging site still opens the demo.
     */
    signOn: false,
    entryPath: '/#fake',
    legacyUrl: readOrigin(env.VITE_BOOTH_LEGACY_URL),
    legacyLabel: 'Open the wheel that is running today',
    milestone: 'M2 — Lucky Wheel',
    arriving:
      'A virtual booth for demonstrations: the wheel spins, a voucher prints to the printer simulator, and prizes and odds are set from the admin side instead of being fixed in the code.',
  },
  {
    key: 'inbox',
    name: 'Inbox',
    purpose: 'Every message from a family in one place, routed to the right team.',
    icon: MessagesSquare,
    permission: 'app:inbox:access',
    origin: readOrigin(env.VITE_INBOX_URL),
    milestone: 'M12 — Inbox working',
    arriving:
      'WhatsApp, Instagram and Facebook in one queue with a named owner per conversation. The data it stands on is being laid now; the screens follow.',
  },
];

/**
 * Where an app that takes no hand-off opens: its origin plus its entry path,
 * or null for an app that signs on (or has no address on this build).
 */
export function directEntryUrl(app: SuiteApp): string | null {
  if (app.signOn !== false || !app.origin) return null;
  return `${app.origin}${app.entryPath ?? '/'}`;
}

export function findApp(key: string): SuiteApp | undefined {
  return SUITE_APPS.find((a) => a.key === key);
}

/**
 * The apps on this person's launcher: the tiles drawn on the home page, and
 * the only apps the assistant's "Take me there" buttons may open (SCRUM-591).
 */
export function tilesFor(has: (permission: Permission) => boolean): SuiteApp[] {
  return SUITE_APPS.filter((app) => has(app.permission) && (!app.alsoRequires || has(app.alsoRequires)));
}

/**
 * The suite registry's word on an app (SCRUM-643, `GET /suite/apps`): what the
 * Console has set, already resolved by the API — an expired maintenance window
 * arrives as the state it restored. It never adds a tile: the key, icon, name
 * and both permission gates above stay this file's, so a registry row can only
 * order a tile, hide it, mark it coming soon or put it in maintenance.
 */
export interface RegistryTile {
  key: SuiteAppKey;
  sortOrder: number;
  state: 'open' | 'coming_soon' | 'hidden' | 'maintenance';
  maintenance: { message: string; expiresAt: string } | null;
}

export interface LauncherTile {
  app: SuiteApp;
  state: 'open' | 'coming_soon' | 'maintenance';
  maintenance: { message: string; expiresAt: string } | null;
}

/**
 * The home page's tiles: this person's apps by the existing gates, then the
 * registry's state and order applied to them. No registry (an older API, or a
 * read that failed) leaves the tiles exactly as they were before it existed.
 */
export function launcherTiles(
  has: (permission: Permission) => boolean,
  registry: readonly RegistryTile[] | null,
): LauncherTile[] {
  const mine = tilesFor(has);
  if (!registry) return mine.map((app) => ({ app, state: 'open', maintenance: null }));
  const rows = new Map(registry.map((row) => [row.key, row]));
  const tiles: Array<LauncherTile & { order: number; index: number }> = [];
  mine.forEach((app, index) => {
    const row = rows.get(app.key);
    if (row?.state === 'hidden') return;
    const state = row?.state === 'maintenance' && row.maintenance ? 'maintenance'
      : row?.state === 'coming_soon' ? 'coming_soon' : 'open';
    tiles.push({ app, state, maintenance: state === 'maintenance' ? row!.maintenance : null,
      order: row?.sortOrder ?? Number.MAX_SAFE_INTEGER, index });
  });
  return tiles.sort((a, b) => a.order - b.order || a.index - b.index).map(({ app, state, maintenance }) => ({ app, state, maintenance }));
}

/**
 * What pressing a tile may do. A tile in maintenance does nothing; one whose
 * window has passed since it was drawn is stale and reads the registry again
 * rather than acting on what it showed; one not live goes to its "coming
 * soon" page; only an open, deployed app asks for a hand-off.
 */
export function tileAction(tile: LauncherTile, now: number = Date.now()): 'open' | 'soon' | 'refresh' | 'none' {
  if (tile.state === 'maintenance') {
    const until = Date.parse(tile.maintenance?.expiresAt ?? '');
    return Number.isFinite(until) && until <= now ? 'refresh' : 'none';
  }
  if (tile.state === 'coming_soon' || !tile.app.origin) return 'soon';
  return 'open';
}

/** The API's refusal of a NEW hand-off into an app that is closed for now (maintenance, or sign-ins blocked). */
export function closedForNow(code: string | undefined): boolean {
  return code === 'APP_IN_MAINTENANCE' || code === 'APP_SIGN_IN_BLOCKED';
}
