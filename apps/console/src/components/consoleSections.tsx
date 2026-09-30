import {
  Activity,
  Building2,
  CalendarCheck,
  FerrisWheel,
  HeartPulse,
  Plug,
  Router,
  Ticket,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@oto/shared/permissions';

export interface ConsoleSection {
  /** Also the route: /activity, /failures, /health, /integrations. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** One line under the page title — what this page is for. */
  description: string;
  /** What it takes to open it at all. The nav hides what an account cannot see. */
  permission: Permission;
}

export interface ConsoleNavGroup {
  id: string;
  label: string;
  sections: ConsoleSection[];
}

/**
 * The console's navigation, in the four groups of the approved design
 * (SCRUM-474, Shell.dc.html): what is wrong (Watch), what stands at the park
 * (The park), what is sold (Selling) and what the platform leans on
 * (Connections). The groups are labels only — every entry keeps its own route,
 * icon and permission, and the sidebar drops an entry the account cannot open
 * and a group whose every entry it drops.
 *
 * The Sprint 1 back-office panels — catalogue, tax, members, accounts — stay in
 * the POS at /admin this sprint and are linked from the foot of the nav rather
 * than duplicated here.
 */
export const consoleNav: ConsoleNavGroup[] = [
  {
    id: 'watch',
    label: 'Watch',
    sections: [
      {
        id: 'health',
        label: 'Health',
        icon: HeartPulse,
        description: 'Is anything wrong right now — the database, storage, the jobs and any open alert.',
        permission: 'admin:health:read',
      },
      {
        id: 'failures',
        label: 'Failures',
        icon: TriangleAlert,
        description: 'Everything that did not succeed, grouped so one broken thing reads as one problem.',
        permission: 'admin:health:read',
      },
      {
        id: 'activity',
        label: 'Activity',
        icon: Activity,
        description: 'The audit log: who did what, to what, from where, and whether it went through.',
        permission: 'admin:audit:read',
      },
    ],
  },
  {
    id: 'park',
    label: 'The park',
    sections: [
      {
        id: 'booths',
        label: 'Booths',
        icon: FerrisWheel,
        description:
          'The Lucky Wheel at each booth: its prizes, their odds and what they cost, and the version each booth is running.',
        // Reading the wheel is the page; changing it needs `admin:booth:manage`
        // and publishing it `admin:booth:publish`, both checked on the panels
        // themselves — so somebody who may look at the odds gets the page
        // rather than a locked door.
        permission: 'admin:booth:read',
      },
      {
        id: 'devices',
        label: 'Devices',
        icon: Router,
        description:
          'The boxes at the park, the stations that sit on them, and who may pick each one.',
        // The floor is reading stations: boxes and devices are panels within
        // the page and each is gated on its own, so an account that may see
        // the stations but not the fleet gets the half it is entitled to
        // rather than a locked page.
        permission: 'admin:station:read',
      },
      {
        id: 'branches',
        label: 'Branches',
        icon: Building2,
        description:
          'Every park, and the row it is joined to in the OTO App — mapped, app-only, or not mapped and why.',
        // Reading the estate is the page; reconciling the two lists needs
        // `admin:branch:update` and is checked on the button, so a manager who
        // may see their own park gets the page rather than a locked door.
        permission: 'admin:branch:read',
      },
    ],
  },
  {
    id: 'selling',
    label: 'Selling',
    sections: [
      {
        id: 'bookings',
        label: 'Bookings',
        icon: CalendarCheck,
        description:
          'Online bookings in every state, and the payment behind each — paid only when the payment gateway confirms the money.',
        // The counter's own read, at the park's own scope: the list names the
        // same families the redeem screen does (S2-12).
        permission: 'pos:booking:read',
      },
      {
        id: 'vouchers',
        label: 'Vouchers',
        icon: Ticket,
        description: 'Issued vouchers, their value and where they were redeemed.',
        permission: 'admin:booth:read',
      },
      {
        id: 'voucher-types',
        label: 'Voucher types',
        icon: Ticket,
        description:
          'What each Lucky Wheel prize is worth at the park and the words its slip prints — set up here before a booth gives one away.',
        // Beside Vouchers under Selling (SCRUM-474); the Booths prize editor
        // picks from this list. The same split as there: reading is the page,
        // and changing a type needs `admin:booth:manage`, checked on the buttons
        // (SCRUM-400).
        permission: 'admin:booth:read',
      },
    ],
  },
  {
    id: 'connections',
    label: 'Connections',
    sections: [
      {
        id: 'integrations',
        label: 'Integrations',
        icon: Plug,
        description: 'The outside services this platform depends on, and what each one is doing.',
        permission: 'admin:health:read',
      },
    ],
  },
];

export const CONSOLE_SECTIONS: ConsoleSection[] = consoleNav.flatMap((g) => g.sections);

export function findSection(id: string): ConsoleSection | undefined {
  return CONSOLE_SECTIONS.find((s) => s.id === id);
}

/**
 * Health, not Activity, is where the console opens. Someone who typed this
 * address in a hurry is asking "is anything wrong", and that page answers it in
 * one screen; the audit log answers a different question, slowly, and only once
 * you know what you are looking for.
 */
export const DEFAULT_SECTION = 'health';
