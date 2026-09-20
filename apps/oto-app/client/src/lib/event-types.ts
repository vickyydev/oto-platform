// Single source of truth for Core Event type display labels.
// Keep these in sync with `coreEventTypeEnum` in server/db/coreSchema.ts.
// Used by both the "New Event" creation flow and the event type filter so the
// names always match — see studio/events.tsx.

export type CoreEventTypeValue =
  | "birthday"
  | "private_event"
  | "school_group"
  | "studio_event"
  | "workshop"
  | "camp"
  | "other";

// Singular labels — used for creation options, badges, and detail views.
export const EVENT_TYPE_LABELS: Record<CoreEventTypeValue, string> = {
  birthday: "Birthday Party",
  private_event: "Private Event",
  school_group: "School Group",
  studio_event: "One-off Event",
  workshop: "Workshop",
  camp: "Camp",
  other: "Other",
};

// Short badge labels — used for compact chips on calendar/list cards where
// space is tight. Kept here (not hardcoded per-component) so they stay in
// sync with the canonical labels above.
export const EVENT_TYPE_LABELS_SHORT: Record<CoreEventTypeValue, string> = {
  birthday: "Birthday",
  private_event: "Private",
  school_group: "School",
  studio_event: "One-off",
  workshop: "Workshop",
  camp: "Camp",
  other: "Other",
};

export function getEventTypeLabel(eventType: string | null | undefined): string {
  if (!eventType) return EVENT_TYPE_LABELS.other;
  return EVENT_TYPE_LABELS[eventType as CoreEventTypeValue] ?? eventType;
}

export function getEventTypeLabelShort(eventType: string | null | undefined): string {
  if (!eventType) return EVENT_TYPE_LABELS_SHORT.other;
  return EVENT_TYPE_LABELS_SHORT[eventType as CoreEventTypeValue] ?? eventType;
}

import {
  CAMP_CALENDAR_COLOR,
  DEFAULT_OTHER_EVENT_COLOR,
  OTHER_EVENT_COLOR_OPTIONS,
  OTHER_EVENT_LEGEND_COLORS,
  WORKSHOP_CALENDAR_COLOR,
  getBirthdayBranchFallbackColor,
  isBirthdayBranchColor,
  isHexCalendarColor,
} from "@shared/event-colors";

// Fixed calendar colors for event types with a dedicated calendar meaning.
export const FIXED_EVENT_TYPE_COLORS: Partial<Record<CoreEventTypeValue, string>> = {
  camp: CAMP_CALENDAR_COLOR,
  workshop: WORKSHOP_CALENDAR_COLOR,
};

// Selectable colors offered for Other Events. Fixed type and birthday colors
// are intentionally excluded so the legend remains semantically reliable.
export const ONE_OFF_EVENT_COLOR_OPTIONS = OTHER_EVENT_COLOR_OPTIONS;
export { OTHER_EVENT_LEGEND_COLORS };

export const DEFAULT_ONE_OFF_EVENT_COLOR = DEFAULT_OTHER_EVENT_COLOR;

// Birthday branch color wins before stored color. Camp and Workshop are fixed.
// Existing valid saved Other Event colors continue to render, even when they
// predate the restricted picker palette.
export function getEventCalendarColor(event: {
  eventType?: string | null;
  color?: string | null;
  branchCalendarColor?: string | null;
  branchId?: string | null;
  branchName?: string | null;
} | null | undefined): string {
  if (!event) return DEFAULT_ONE_OFF_EVENT_COLOR;
  if (event.eventType === "birthday") {
    return isBirthdayBranchColor(event.branchCalendarColor, event.branchName)
      ? event.branchCalendarColor
      : getBirthdayBranchFallbackColor(event.branchId || event.branchName);
  }
  const fixed = FIXED_EVENT_TYPE_COLORS[event.eventType as CoreEventTypeValue];
  if (fixed) return fixed;
  return isHexCalendarColor(event.color) ? event.color : DEFAULT_ONE_OFF_EVENT_COLOR;
}
