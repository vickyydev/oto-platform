import { createContext, useContext, useState, useEffect, ReactNode, useMemo } from "react";
import { useLocation } from "wouter";
import { useAuth } from "./use-auth";
import { usePermissions } from "./use-permissions";

export type AppMode = "core" | "ops" | "events" | "hr" | "studio" | "setup";

const MODE_STORAGE_KEY = "oto_suite_mode";

interface ModeContextType {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  availableModes: AppMode[];
  canAccessMode: (mode: AppMode) => boolean;
}

const ModeContext = createContext<ModeContextType | null>(null);

function getModeFromPath(path: string): AppMode | null {
  if (path.startsWith("/core")) return "core";
  if (path.startsWith("/ops")) return "ops";
  if (path.startsWith("/events")) return "events";
  if (path.startsWith("/studio")) return "studio";
  if (path.startsWith("/setup")) return "setup";
  if (path === "/" || path.startsWith("/dashboard") || path.startsWith("/employees") || path.startsWith("/contracts") || 
      path.startsWith("/templates") || path.startsWith("/branches") || path.startsWith("/departments") ||
      path.startsWith("/roles") || path.startsWith("/scheduling") || path.startsWith("/settings") ||
      path.startsWith("/attention") || path.startsWith("/reviews") || path.startsWith("/users") ||
      path.startsWith("/policies") || path.startsWith("/activity-logbook") || path.startsWith("/time") ||
      path.startsWith("/advisors") || path.startsWith("/staff-movements") || path.startsWith("/operators")) {
    return "hr";
  }
  return null;
}

function getStoredMode(): AppMode | null {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored && ["core", "ops", "events", "hr", "studio", "setup"].includes(stored)) {
      return stored as AppMode;
    }
  } catch {}
  return null;
}

function storeMode(mode: AppMode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {}
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [location] = useLocation();
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  
  const getAvailableModes = (): AppMode[] => {
    if (!user) return [];
    
    // If we have effective permissions from the new engine, use those
    if (permissions?.appModes && permissions.appModes.length > 0) {
      return permissions.appModes as AppMode[];
    }
    
    // Fallback: determine role-based defaults (used while permissions are loading)
    const getRoleDefaults = (): AppMode[] => {
      if (user.role === "global_admin" || user.role === "admin" || user.role === "operator_admin") {
        return ["core", "ops", "events", "hr", "studio", "setup"];
      }
      if (user.role === "manager") {
        return ["core", "ops", "events", "hr", "studio"];
      }
      if (user.role === "staff") {
        return ["core", "ops", "events"];
      }
      // "advisor" role — the effective role is resolved server-side and returned via
      // getUserWithBranchAccess, so user.role here will already be staff/manager/admin
      // in normal operation. This branch is a safety net for any race condition where
      // the raw "advisor" value appears before the resolved session is available.
      if ((user.role as string) === "advisor") {
        // Raw "advisor" role before server resolution — safest is staff defaults.
        // Never grant HR/Setup/Studio to an unresolved advisor.
        if (user.modules) {
          const modes: AppMode[] = [];
          if (user.modules.core) modes.push("core");
          if (user.modules.ops) modes.push("ops");
          if (user.modules.events) modes.push("events");
          // HR/Setup/Studio intentionally excluded — staff-level cap for raw advisor role
          if (modes.length > 0) return modes;
        }
        return ["core", "ops", "events"];
      }
      return ["core", "ops", "events"];
    };
    
    // Use module access from user's access policy if available (legacy path).
    // Cap the derived modes by what the effective role actually permits so that
    // e.g. a STAFF advisor with hr:true in their access policy cannot see HR.
    if (user.modules) {
      const roleDefaults = new Set<AppMode>(getRoleDefaults());

      const modes: AppMode[] = [];
      if (user.modules.core && roleDefaults.has("core")) modes.push("core");
      if ((user.modules.ops || user.modules.studio) && roleDefaults.has("ops")) modes.push("ops");
      if ((user.modules.events || user.modules.studio) && roleDefaults.has("events")) modes.push("events");
      if (user.modules.hr && roleDefaults.has("hr")) modes.push("hr");
      if (user.modules.studio && roleDefaults.has("studio")) modes.push("studio");
      if ((user.modules.setup || user.modules.studio) && roleDefaults.has("setup")) modes.push("setup");
      
      if (user.role === "global_admin") {
        return getRoleDefaults();
      }
      
      if (modes.length > 0) {
        return modes;
      }
      return getRoleDefaults();
    }
    
    return getRoleDefaults();
  };

  const availableModes = useMemo(() => getAvailableModes(), [user?.id, user?.role, user?.modules, permissions?.appModes]);

  const canAccessMode = (mode: AppMode): boolean => {
    return availableModes.includes(mode);
  };

  const getDefaultMode = (): AppMode => {
    const stored = getStoredMode();
    if (stored && availableModes.includes(stored)) {
      return stored;
    }
    return availableModes[0] || "core";
  };

  const [mode, setModeState] = useState<AppMode>(getDefaultMode);

  const permissionsKey = permissions?.appModes ? permissions.appModes.join(",") : "";
  const modulesKey = user?.modules ? JSON.stringify(user.modules) : "";

  useEffect(() => {
    const pathMode = getModeFromPath(location);
    if (pathMode && canAccessMode(pathMode)) {
      setModeState(pathMode);
      storeMode(pathMode);
    }
  }, [location, user?.role, modulesKey, permissionsKey]);

  useEffect(() => {
    if (!availableModes.includes(mode)) {
      const newMode = availableModes[0] || "core";
      setModeState(newMode);
      storeMode(newMode);
    }
  }, [user?.role, modulesKey, permissionsKey]);

  const setMode = (newMode: AppMode) => {
    if (canAccessMode(newMode)) {
      setModeState(newMode);
      storeMode(newMode);
    }
  };

  return (
    <ModeContext.Provider value={{ 
      mode, 
      setMode, 
      availableModes,
      canAccessMode 
    }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode() {
  const context = useContext(ModeContext);
  if (!context) {
    throw new Error("useMode must be used within a ModeProvider");
  }
  return context;
}
