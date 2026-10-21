import { PERMISSION_WORDS, type Permission } from '@oto/shared/permissions';
import type { AdminBranch } from '../accounts/LoginUsersPanel';

export function permissionWords(permission: string): string {
  return Object.hasOwn(PERMISSION_WORDS, permission)
    ? PERMISSION_WORDS[permission as Permission]
    : permission;
}

/** Names only: the server decides scope ownership and effective access. */
export function scopeWords(scopeType: string, scopeId: string | null, branches: readonly AdminBranch[]): string {
  if (scopeType === 'operator') return scopeId ? 'operator-wide' : 'platform-wide';
  if (scopeType === 'branch') {
    const branch = branches.find((row) => (row.apiId ?? row.id) === scopeId);
    return branch ? `branch: ${branch.name}` : `branch: ${scopeId ?? 'unspecified'}`;
  }
  return scopeId ? `${scopeType}: ${scopeId}` : scopeType;
}
