import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./use-auth";
import type { ModuleKey, AppModeKey, EffectivePermissions, EffectiveModulePermission } from "../../../shared/permissions";

export function usePermissions() {
  const { user } = useAuth();

  const { data: permissions, isLoading } = useQuery<EffectivePermissions>({
    queryKey: ["/api/permissions/me"],
    enabled: !!user,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  function canModule(moduleKey: ModuleKey): boolean {
    if (!permissions) return false;
    const mod = permissions.modules.find(m => m.moduleKey === moduleKey);
    return mod?.allowed ?? false;
  }

  function canAppMode(mode: AppModeKey): boolean {
    if (!permissions) return false;
    return permissions.appModes.includes(mode);
  }

  function getModulePermission(moduleKey: ModuleKey): EffectiveModulePermission | undefined {
    if (!permissions) return undefined;
    return permissions.modules.find(m => m.moduleKey === moduleKey);
  }

  function getAllowedModules(): ModuleKey[] {
    if (!permissions) return [];
    return permissions.modules.filter(m => m.allowed).map(m => m.moduleKey);
  }

  function getAllowedAppModes(): AppModeKey[] {
    if (!permissions) return [];
    return permissions.appModes;
  }

  return {
    permissions,
    isLoading,
    canModule,
    canAppMode,
    getModulePermission,
    getAllowedModules,
    getAllowedAppModes,
    role: permissions?.role ?? null,
  };
}
