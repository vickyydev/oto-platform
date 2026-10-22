

/**
 * The two calls the redesigned editor adds (SCRUM-472), kept beside it.
 *
 * `printApi` in `@/api/platform` still carries the template list, the save and
 * the test print; these are the preview with a scenario named, and the
 * question of where a test print would come out.
 */

/** Where this template's Test print would reach from a station. */
export interface TestPrintTarget {
  printer: { deviceId: string; label: string } | null;
  /** Why nothing would print, in words for the editor; null when a printer is there. */
  note: string | null;
  widthDots: number;
}
