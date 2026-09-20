import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import type { User } from "@shared/schema";

export interface DirectoryPresence {
  isClockedIn: boolean;
  currentWorkBranchId: string | null;
  currentWorkBranchName: string | null;
  lastClockInAt: string | null;
  lastClockOutAt: string | null;
}

export interface EffectiveBranch {
  id: string;
  name: string;
  is_visiting: boolean;
}

export interface DirectoryEntry {
  employeeId: string;
  fullName: string;
  preferredName: string | null;
  employmentState: "ACTIVE" | "LEAVING" | "LEFT";
  homeBranchId: string;
  homeBranchName: string;
  departmentId: string | null;
  departmentName: string | null;
  roleIds: string[];
  roleNames: string[];
  presence: DirectoryPresence;
  effectiveBranch: EffectiveBranch;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  hireDate: string | null;
  isStale: boolean;
}

export interface UserModules {
  core: boolean;
  hr: boolean;
  studio: boolean;
}

export type AccessLevel = "STAFF" | "MANAGER" | "ADMIN";

interface AuthContextType {
  user: User | null;
  directory: DirectoryEntry | null;
  mustChangePassword: boolean;
  modules: UserModules;
  accessLevel: AccessLevel;
  isLoading: boolean;
  effectiveBranchId: string | null;
  effectiveBranchName: string | null;
  isVisiting: boolean;
  isLinkedToHR: boolean;
  employeeStatus: "ACTIVE" | "LEAVING" | "LEFT" | null;
  isStale: boolean;
  hasMultipleModules: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const DEFAULT_MODULES: UserModules = { core: true, hr: false, studio: false };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [directory, setDirectory] = useState<DirectoryEntry | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [modules, setModules] = useState<UserModules>(DEFAULT_MODULES);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("STAFF");
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setDirectory(data.directory || null);
        setMustChangePassword(data.mustChangePassword || false);
        setModules(data.modules || DEFAULT_MODULES);
        setAccessLevel(data.accessLevel || "STAFF");
      } else {
        setUser(null);
        setDirectory(null);
        setMustChangePassword(false);
        setModules(DEFAULT_MODULES);
        setAccessLevel("STAFF");
      }
    } catch {
      setUser(null);
      setDirectory(null);
      setMustChangePassword(false);
      setModules(DEFAULT_MODULES);
      setAccessLevel("STAFF");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || "Login failed");
    }
    
    const data = await res.json();
    setUser(data.user);
    setDirectory(data.directory || null);
    setMustChangePassword(data.mustChangePassword || false);
    setModules(data.modules || DEFAULT_MODULES);
    setAccessLevel(data.accessLevel || "STAFF");
  };

  const logout = async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    setUser(null);
    setDirectory(null);
    setMustChangePassword(false);
    setModules(DEFAULT_MODULES);
    setAccessLevel("STAFF");
  };

  const computed = useMemo(() => {
    const isLinkedToHR = Boolean(user?.hrPersonId);
    const employeeStatus = directory?.employmentState || null;
    const isStale = directory?.isStale || false;
    
    const enabledModules = [modules.core, modules.hr, modules.studio].filter(Boolean).length;
    const hasMultipleModules = enabledModules > 1;
    
    let effectiveBranchId: string | null = null;
    let effectiveBranchName: string | null = null;
    let isVisiting = false;
    
    if (directory) {
      effectiveBranchId = directory.effectiveBranch.id;
      effectiveBranchName = directory.effectiveBranch.name;
      isVisiting = directory.effectiveBranch.is_visiting;
    } else if (user?.branchId) {
      effectiveBranchId = user.branchId;
      effectiveBranchName = null;
    } else if (user?.branchIds && Array.isArray(user.branchIds) && user.branchIds.length > 0) {
      // Fallback to first branch from branchIds when no directory and no branchId
      effectiveBranchId = user.branchIds[0] as string;
      effectiveBranchName = null;
    }
    
    return {
      isLinkedToHR,
      employeeStatus,
      effectiveBranchId,
      effectiveBranchName,
      isVisiting,
      isStale,
      hasMultipleModules,
    };
  }, [user, directory, modules]);

  return (
    <AuthContext.Provider value={{ 
      user, 
      directory,
      mustChangePassword,
      modules,
      accessLevel,
      isLoading, 
      effectiveBranchId: computed.effectiveBranchId,
      effectiveBranchName: computed.effectiveBranchName,
      isVisiting: computed.isVisiting,
      isLinkedToHR: computed.isLinkedToHR,
      employeeStatus: computed.employeeStatus,
      isStale: computed.isStale,
      hasMultipleModules: computed.hasMultipleModules,
      login, 
      logout, 
      refetch: fetchUser 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
