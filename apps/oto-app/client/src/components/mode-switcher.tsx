import { useMode, AppMode } from "@/hooks/use-mode";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Zap, Palette, Users, Bug, CalendarDays, ClipboardCheck, Settings } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEffect, useState } from "react";

const modeConfig: Record<AppMode, { label: string; icon: typeof Zap; path: string }> = {
  core: { label: "Today", icon: Zap, path: "/core" },
  ops: { label: "Ops", icon: ClipboardCheck, path: "/ops" },
  events: { label: "Events", icon: CalendarDays, path: "/events" },
  hr: { label: "HR", icon: Users, path: "/dashboard" },
  studio: { label: "Studio", icon: Palette, path: "/studio" },
  setup: { label: "Setup", icon: Settings, path: "/setup" },
};

function PermsDebugPanel() {
  const { user } = useAuth();
  const { mode, availableModes } = useMode();
  const [showDebug, setShowDebug] = useState(false);
  
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const debugEnabled = params.get("debugPerms") === "1";
    setShowDebug(debugEnabled);
    
    if (debugEnabled && user) {
      const permInfo = {
        userId: user.id,
        email: user.email,
        role: user.role,
        modules: user.modules,
        currentMode: mode,
        availableModes,
        shouldShowModuleSwitcher: availableModes.length >= 2,
        hasModulesFromPolicy: !!user.modules,
      };
      console.log("[PERMS DEBUG]", permInfo);
    }
  }, [user, mode, availableModes]);
  
  if (!showDebug || !user) return null;
  
  // Only show for managers and above
  if (!["global_admin", "admin", "operator_admin", "manager"].includes(user.role)) {
    return null;
  }
  
  const shouldShowSwitcher = availableModes.length >= 2;
  
  return (
    <Card className="fixed bottom-4 right-4 z-50 w-80 text-xs shadow-lg" data-testid="perms-debug-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Bug className="h-4 w-4" />
          Permissions Debug
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div><strong>Environment:</strong> {import.meta.env.MODE}</div>
        <div><strong>User ID:</strong> {user.id}</div>
        <div><strong>Email:</strong> {user.email}</div>
        <div><strong>Role:</strong> {user.role}</div>
        <div><strong>Modules (from policy):</strong> {user.modules ? JSON.stringify(user.modules) : "null (using fallback)"}</div>
        <div><strong>Effective Modules:</strong> [{availableModes.join(", ")}]</div>
        <div><strong>Current Mode:</strong> {mode}</div>
        <div className={shouldShowSwitcher ? "text-green-600" : "text-red-600"}>
          <strong>Show Module Switcher:</strong> {shouldShowSwitcher ? "YES" : "NO"}
        </div>
        <div><strong>Reason:</strong> {user.modules 
          ? `Policy: ${JSON.stringify(user.modules)} merged with role (${user.role})` 
          : `Role-based default for: ${user.role}`}
        </div>
      </CardContent>
    </Card>
  );
}

export function ModeSwitcher() {
  const { mode, availableModes, setMode } = useMode();
  const [, navigate] = useLocation();

  const handleModeChange = (newMode: AppMode) => {
    setMode(newMode);
    navigate(modeConfig[newMode].path);
  };

  return (
    <>
      <PermsDebugPanel />
      {availableModes.filter(m => m !== "studio").length > 1 && (
        <div className="flex items-center gap-1 p-1 bg-muted rounded-lg" data-testid="mode-switcher">
          {availableModes.filter(m => m !== "studio").map((m) => {
            const config = modeConfig[m];
            const Icon = config.icon;
            const isActive = mode === m;
            return (
              <Button
                key={m}
                variant={isActive ? "default" : "ghost"}
                size="sm"
                onClick={() => handleModeChange(m)}
                className="gap-1.5"
                data-testid={`button-mode-${m}`}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{config.label}</span>
              </Button>
            );
          })}
        </div>
      )}
    </>
  );
}
