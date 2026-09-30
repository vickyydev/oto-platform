import { api } from '@/api/client';

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

export const templatesApi = {
  /**
   * The draft's sample, drawn by the renderer that drives the printer. The
   * body is `previewRequest`'s string, parsed back, so what is sent is exactly
   * what the preview's effect keyed on.
   */
  previewPng: (id: string, request: string, signal?: AbortSignal) =>
    api.postBlob(
      `/print-templates/${encodeURIComponent(id)}/preview.png`,
      JSON.parse(request) as unknown,
      signal,
    ),
  testPrintTarget: (id: string, stationId: string | null) =>
    api.get<TestPrintTarget>(
      `/print-templates/${encodeURIComponent(id)}/test-print-target${
        stationId ? `?stationId=${encodeURIComponent(stationId)}` : ''
      }`,
    ),
};
