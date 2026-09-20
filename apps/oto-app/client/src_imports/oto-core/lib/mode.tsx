import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useAuth } from "./auth";

export type AppMode = "core" | "studio";

interface ModeContextType {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  canAccessStudio: boolean;
  canAccessDashboard: boolean;
}

const ModeContext = createContext<ModeContextType | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [mode, setModeState] = useState<AppMode>("core");

  const canAccessStudio = user?.role === "manager" || user?.role === "admin";
  const canAccessDashboard = user?.role === "manager" || user?.role === "admin";

  useEffect(() => {
    const savedMode = localStorage.getItem("oto-mode") as AppMode | null;
    if (savedMode && (savedMode === "core" || savedMode === "studio")) {
      if (canAccessStudio || savedMode === "core") {
        setModeState(savedMode);
      } else {
        setModeState("core");
      }
    }
  }, [canAccessStudio]);

  useEffect(() => {
    if (!canAccessStudio && mode === "studio") {
      setModeState("core");
      localStorage.setItem("oto-mode", "core");
    }
  }, [canAccessStudio, mode]);

  const setMode = (newMode: AppMode) => {
    if (newMode === "studio" && !canAccessStudio) {
      return;
    }
    setModeState(newMode);
    localStorage.setItem("oto-mode", newMode);
  };

  return (
    <ModeContext.Provider value={{ mode, setMode, canAccessStudio, canAccessDashboard }}>
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
