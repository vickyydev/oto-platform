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
 * the name the hand-off endpoint is asked for, so a new app is one entry here
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
    arriving: 'The till is live. If this shell opened instead, its address is not set on this build.',
  },
  {
    key: 'console',
    name: 'Console',
    purpose: 'Accounts and access, branches, the catalogue, activity and health.',
    icon: Settings,
    permission: 'app:console:access',
    origin: readOrigin(env.VITE_CONSOLE_URL),
    milestone: 'M0 — front door',
    arriving:
      'Console v1 arrives with the observability work: activity, failures, health and integrations, then devices and stations. Until then the back-office screens live inside the POS at /admin.',
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
      'Each branch will choose its source — the figures carried over from the old tills, or live analytics from this POS — and a sale made at the till will show up here.',
  },
  {
    key: 'booth',
    name: 'Lucky Wheel',
    purpose: 'The prize wheel at the sales booth — spins, prizes and vouchers.',
    icon: Gift,
    permission: 'app:booth:access',
    alsoRequires: 'admin:booth:read',
    origin: readOrigin(env.VITE_BOOTH_URL),
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

export function findApp(key: string): SuiteApp | undefined {
  return SUITE_APPS.find((a) => a.key === key);
}
