import { Activity, HeartPulse, Plug, TriangleAlert, type LucideIcon } from 'lucide-react';
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
 * Console v1. One group today; Devices joins it in S2-04 and Booths in S2-07b,
 * which is why the shape is a group of sections rather than a flat list.
 *
 * The Sprint 1 back-office panels — catalogue, tax, members, accounts — stay in
 * the POS at /admin this sprint and are linked from the foot of the nav rather
 * than duplicated here.
 */
export const consoleNav: ConsoleNavGroup[] = [
  {
    id: 'operations',
    label: 'Operations',
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
