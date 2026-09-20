export const CAMP_CALENDAR_COLOR = "#10b981"; // emerald-500
export const WORKSHOP_CALENDAR_COLOR = "#f97316"; // orange-500

export const BIRTHDAY_BRANCH_COLOR_OPTIONS = [
  { value: "#ef4444", label: "Red" },
  { value: "#8b5cf6", label: "Purple" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#ec4899", label: "Pink" },
  { value: "#06b6d4", label: "Cyan" },
  { value: "#eab308", label: "Yellow" },
] as const;

export const BIRTHDAY_BRANCH_NAMED_COLORS = {
  chalong: "#ef4444",
  robinson: "#8b5cf6",
} as const;

// Other Event colors deliberately avoid every reserved birthday, Camp, and
// Workshop color. Existing legacy colors are still rendered when already saved.
export const OTHER_EVENT_COLOR_OPTIONS = [
  { value: "#6366f1", label: "Indigo" },
  { value: "#d946ef", label: "Fuchsia" },
  { value: "#0ea5e9", label: "Sky" },
  { value: "#84cc16", label: "Lime" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#64748b", label: "Slate" },
] as const;

export const DEFAULT_OTHER_EVENT_COLOR = OTHER_EVENT_COLOR_OPTIONS[0].value;

export const OTHER_EVENT_LEGEND_COLORS = OTHER_EVENT_COLOR_OPTIONS.slice(0, 4).map(
  ({ value }) => value,
);

export const RESERVED_CALENDAR_COLORS = new Set<string>([
  CAMP_CALENDAR_COLOR,
  WORKSHOP_CALENDAR_COLOR,
  ...BIRTHDAY_BRANCH_COLOR_OPTIONS.map(({ value }) => value),
]);

const BIRTHDAY_FALLBACK_EXCLUDED_COLORS = new Set<string>([
  ...Array.from(RESERVED_CALENDAR_COLORS),
  ...OTHER_EVENT_COLOR_OPTIONS.map(({ value }) => value),
]);

const INVALID_BIRTHDAY_COLORS = new Set<string>([
  CAMP_CALENDAR_COLOR,
  WORKSHOP_CALENDAR_COLOR,
  ...OTHER_EVENT_COLOR_OPTIONS.map(({ value }) => value),
]);

export function isOtherEventColor(color: unknown): color is string {
  return typeof color === "string"
    && OTHER_EVENT_COLOR_OPTIONS.some(({ value }) => value.toLowerCase() === color.toLowerCase());
}

export function getNamedBirthdayBranchColor(branchName: string | null | undefined): string | undefined {
  const normalizedName = branchName?.toLocaleLowerCase() ?? "";
  if (normalizedName.includes("chalong")) return BIRTHDAY_BRANCH_NAMED_COLORS.chalong;
  if (normalizedName.includes("robinson")) return BIRTHDAY_BRANCH_NAMED_COLORS.robinson;
  return undefined;
}

function hslToHex(hue: number, saturation = 65, lightness = 47): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const match = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const m = l - chroma / 2;
  return `#${match.map((value) => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Selects a stable birthday color for a newly-created branch. Named branches
 * receive their prescribed color. Generic branches avoid those named colors so
 * future Chalong/Robinson branches can remain unambiguous. If the standard
 * palette is exhausted, generated hues keep the assignment distinct.
 */
export function getNextBirthdayBranchColor(
  branchName: string,
  usedColors: Iterable<string | null | undefined>,
): string {
  const used = new Set(
    Array.from(usedColors)
      .filter((color): color is string => !!color)
      .map((color) => color.toLowerCase()),
  );
  const namedColor = getNamedBirthdayBranchColor(branchName);
  if (namedColor && !used.has(namedColor)) return namedColor;

  const protectedNamedColors = new Set(Object.values(BIRTHDAY_BRANCH_NAMED_COLORS));
  const availablePaletteColor = BIRTHDAY_BRANCH_COLOR_OPTIONS
    .map(({ value }) => value)
    .find((color) => !protectedNamedColors.has(color as never) && !used.has(color.toLowerCase()));

  if (availablePaletteColor) return availablePaletteColor;

  for (let index = 0; ; index += 1) {
    const candidate = hslToHex((index * 137.508) % 360);
    if (!BIRTHDAY_FALLBACK_EXCLUDED_COLORS.has(candidate) && !used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export function isHexCalendarColor(color: unknown): color is string {
  return typeof color === "string" && /^#[\da-f]{6}$/i.test(color);
}

export function isBirthdayBranchColor(
  color: unknown,
  _branchName?: string | null,
): color is string {
  if (!isHexCalendarColor(color)) return false;
  const normalizedColor = color.toLowerCase();
  return !INVALID_BIRTHDAY_COLORS.has(normalizedColor);
}

function hashBirthdayBranchIdentity(identity: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Branch-specific safety color for incomplete legacy API data. Persisted colors
 * remain authoritative; this only prevents every affected branch sharing one
 * red fallback while reconciliation is pending.
 */
export function getBirthdayBranchFallbackColor(
  branchIdentity: string | null | undefined,
): string {
  const identity = branchIdentity?.trim().toLocaleLowerCase() || "unknown-branch";
  const hash = hashBirthdayBranchIdentity(identity);
  for (let attempt = 0; ; attempt += 1) {
    const candidate = hslToHex((hash + attempt * 137.508) % 360);
    if (!BIRTHDAY_FALLBACK_EXCLUDED_COLORS.has(candidate)) return candidate;
  }
}