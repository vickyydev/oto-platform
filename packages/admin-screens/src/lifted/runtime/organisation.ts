import type { ReactNode } from 'react';
import type { createOrganisationAdminApi } from '../api/platform';
import type { Branch, PricingOverride } from '../model/types';
import type { AdminScreenRuntime } from './AdminScreenRuntime';

type OrganisationApi = ReturnType<typeof createOrganisationAdminApi>;
export type PhoneLanguagePort = AdminScreenRuntime['language'];
export interface OperatorsPanelPorts {
  adminApi: Pick<OrganisationApi['adminApi'], 'operators' | 'createOperator' | 'archiveOperator' | 'assignOperatorAdmin'>;
  opsApi: OrganisationApi['opsApi'];
  toast: AdminScreenRuntime['toast'];
  phoneLanguage?: PhoneLanguagePort;
  renderOperatorActions?: (
    operator: { id: string; name: string },
    refresh: () => Promise<unknown>,
  ) => ReactNode;
}
export interface BranchesPanelPorts {
  canCreate?: boolean;
  branches: Branch[];
  activeBranch: Branch | null;
  onSelectBranch: (slug: string) => void | Promise<void>;
  actorName: string;
  upsertBranch: (branch: Branch) => void | Promise<void>;
  branchesApi: Pick<OrganisationApi['branchesApi'], 'clonePreview' | 'clone'>;
  afterClone: (slug: string) => Promise<unknown>;
  renderBranchDetails?: (branch: Branch) => ReactNode;
  renderBranchActions?: (branch: Branch) => ReactNode;
}
export interface HolidaysPanelPorts {
  pricingOverrides: PricingOverride[];
  upsertPricingOverride: (range: PricingOverride) => void | Promise<void>;
  deletePricingOverride: (id: string) => void | Promise<void>;
  getActiveBranch: () => { id: string };
  holidaySaleCounts: (slug: string) => Promise<Record<string, number>>;
}

/** Only the server decides which owned fleet records prevent an archive. */
export function archiveFailureMessage(failure: unknown, fallback: string): string {
  const message = failure instanceof Error ? failure.message : fallback;
  if (
    !(failure instanceof Error) ||
    !('code' in failure) ||
    (failure.code !== 'BRANCH_HAS_LIVE_FLEET' && failure.code !== 'OPERATOR_HAS_LIVE_FLEET') ||
    !('details' in failure) ||
    typeof failure.details !== 'object' ||
    failure.details === null
  )
    return message;
  const details = failure.details as Record<string, unknown>;
  const groups = [
    ['boxes', 'Boxes'],
    ['stations', 'Stations'],
  ] as const;
  const names = groups.flatMap(([key, label]) => {
    const rows = details[key];
    if (!Array.isArray(rows)) return [];
    const values = rows.flatMap((row: unknown) =>
      typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string'
        ? [row.name]
        : [],
    );
    return values.length ? [label + ': ' + values.join(', ') + '.'] : [];
  });
  return [message, ...names].join(' ');
}
