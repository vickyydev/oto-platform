import type { ApiBody, ApiResponse } from '@oto/api-types';
import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey, qs } from './client';

export type AnalyticsMetadata = ApiResponse<'/console/analytics', 'get'>;
export type AnalyticsDrift = ApiResponse<'/console/analytics/drift', 'get'>;
export type DriftComparison = AnalyticsDrift['comparisons'][number];
export type ConfigurationIndex = ApiResponse<'/console/configuration', 'get'>;
export type ConfigurationEntry = ConfigurationIndex['entries'][number];
export type SettingsTarget = NonNullable<ConfigurationEntry['openInApp']>;
export type AnalyticsSummary = ApiResponse<'/analytics/summary', 'get'>;

const SETTINGS_APPS: ReadonlySet<string> = new Set<SettingsTarget['app']>(['oto_app', 'radar', 'inbox']);

/** A Console page address: one leading slash, no scheme, host or backslash. */
export function consolePagePath(url: string | null): string | null {
  return url !== null && /^\/(?![/\\])[^\s\\]*$/.test(url) ? url : null;
}

/** An app-owned settings target the index may hand off to: a known app and a path within it. */
export function settingsTarget(target: ConfigurationEntry['openInApp']): SettingsTarget | null {
  return target && SETTINGS_APPS.has(target.app) && consolePagePath(target.path) ? target : null;
}

const branchList = (branches?: readonly string[]) => (branches?.length ? branches.join(',') : undefined);

export const consoleConfigurationApi = {
  analytics: (branches?: readonly string[]) =>
    api.get<ApiResponse<'/console/analytics', 'get'>>(`/console/analytics${qs({ branches: branchList(branches) })}`),
  drift: (branches?: readonly string[]) =>
    api.get<ApiResponse<'/console/analytics/drift', 'get'>>(`/console/analytics/drift${qs({ branches: branchList(branches) })}`),
  configuration: (branchId?: string | null) =>
    api.get<ApiResponse<'/console/configuration', 'get'>>(`/console/configuration${qs({ branchId: branchId || undefined })}`),
  summary: (from: string, to: string, branches: readonly string[]) =>
    api.get<ApiResponse<'/analytics/summary', 'get'>>(`/analytics/summary${qs({ from, to, group: 'total', branches: branches.join(',') })}`),
  /**
   * Open an app-owned setting through a fresh acting-user handoff, issued only
   * when the person chooses it. The app's own page keeps its own access rules.
   */
  openInApp: async (target: SettingsTarget, isCurrent: () => boolean): Promise<void> => {
    const safe = settingsTarget(target);
    if (!safe) throw new Error('That settings page is not available.');
    if (!isCurrent()) return;
    const issued = await api.post<ApiResponse<'/auth/handoff', 'post'>>('/auth/handoff',
      { app: safe.app } satisfies ApiBody<'/auth/handoff', 'post'>, { idempotencyKey: idemKey() });
    if (!isCurrent()) return;
    if (!issued?.launchUrl) throw new Error('The settings owner has no configured destination.');
    try {
      const destination = new URL(issued.launchUrl);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password
        || !/^#handoff=[^&]+$/.test(destination.hash)) throw new Error();
    } catch {
      throw new Error('The settings owner has no configured destination.');
    }
    try {
      window.location.assign(withHandoffTarget(issued.launchUrl, safe.path));
    } catch {
      // A browser exception can contain the one-use destination.
      throw new Error('The settings page could not be opened. Please try again.');
    }
  },
};
