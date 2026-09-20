import { MapPin, AlertTriangle, User, LogOut, Moon, Sun, Settings, Globe, LayoutDashboard, Palette, ArrowLeft, Building } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/lib/i18n";
import { useMode } from "@/lib/mode";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import type { Branch } from "@shared/schema";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Link } from "wouter";
import { BranchSwitcher } from "@/components/branch-switcher";

export function TopBar() {
  const { user, logout, effectiveBranchId, effectiveBranchName, directory, isLinkedToHR, isVisiting, isStale } = useAuth();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const { mode, setMode, canAccessStudio, canAccessDashboard } = useMode();
  const [, setLocation] = useLocation();
  
  const { data: branch, isLoading: isBranchLoading, isError: isBranchError } = useQuery<Branch>({
    queryKey: ["/api/branches", effectiveBranchId || user?.branchId],
    enabled: !!(effectiveBranchId || user?.branchId),
  });
  
  // Determine display name with better fallbacks
  let displayBranchName = "No Branch";
  if (effectiveBranchName) {
    displayBranchName = effectiveBranchName;
  } else if (branch?.name) {
    displayBranchName = branch.name;
  } else if (isBranchLoading) {
    displayBranchName = "Loading...";
  } else if (isBranchError || (!effectiveBranchId && !user?.branchId)) {
    displayBranchName = "No Branch";
  }

  const handleSwitchToStudio = () => {
    setMode("studio");
    setLocation("/studio");
  };

  const handleSwitchToCore = () => {
    setMode("core");
    setLocation("/today");
  };

  return (
    <header 
      className={`sticky top-0 z-40 backdrop-blur-md border-b ${
        mode === "studio" 
          ? "bg-violet-50/95 dark:bg-violet-950/95 border-violet-200 dark:border-violet-800" 
          : "bg-background/95 border-border"
      }`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      data-testid="header-top"
    >
      <div className="flex items-center justify-between h-14 px-4">
        <div className="flex items-center gap-2">
          {mode === "studio" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSwitchToCore}
                className="text-violet-700 dark:text-violet-300 -ml-2"
                data-testid="button-back-to-core"
              >
                <ArrowLeft className="h-4 w-4 mr-1" />
                Core
              </Button>
              <span className="text-sm font-semibold text-violet-700 dark:text-violet-300">
                OTO Studio
              </span>
            </>
          ) : (
            <>
              <MapPin className={`h-4 w-4 ${isVisiting ? "text-amber-500" : "text-primary"}`} />
              <span className="font-semibold text-sm" data-testid="text-branch-name">
                {displayBranchName}
              </span>
              {isVisiting && (
                <span className="text-xs text-amber-600 dark:text-amber-400 ml-1">(visiting)</span>
              )}
              {isStale && (
                <span className="text-xs text-orange-600 dark:text-orange-400 ml-2 animate-pulse">
                  (offline)
                </span>
              )}
              <BranchSwitcher className="ml-1" />
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          {mode === "core" && (
            <Link href="/escalate">
              <Button 
                size="icon" 
                variant="ghost" 
                className="text-destructive"
                data-testid="button-escalate"
              >
                <AlertTriangle className="h-5 w-5" />
              </Button>
            </Link>
          )}

          <Button
            size="icon"
            variant="ghost"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            data-testid="button-theme-toggle"
          >
            {resolvedTheme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" data-testid="button-language">
                <Globe className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t.settings.language}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem 
                onClick={() => setLanguage("en")}
                className={language === "en" ? "bg-accent" : ""}
              >
                {t.languages.en}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => setLanguage("ru")}
                className={language === "ru" ? "bg-accent" : ""}
              >
                {t.languages.ru}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => setLanguage("th")}
                className={language === "th" ? "bg-accent" : ""}
              >
                {t.languages.th}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" data-testid="button-profile">
                <User className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{user?.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
                {isLinkedToHR && directory ? (
                  <div className="mt-1 space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      Home: {directory.homeBranchName}
                    </p>
                    {isVisiting && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Working at: {directory.effectiveBranch.name}
                      </p>
                    )}
                  </div>
                ) : branch && (
                  <p className="text-xs text-muted-foreground mt-0.5">{branch.name}</p>
                )}
              </div>
              <DropdownMenuSeparator />
              
              {canAccessDashboard && (
                <DropdownMenuItem asChild>
                  <Link href="/dashboard" className="cursor-pointer">
                    <LayoutDashboard className="mr-2 h-4 w-4" />
                    Dashboard
                  </Link>
                </DropdownMenuItem>
              )}
              
              {canAccessStudio && mode === "core" && (
                <DropdownMenuItem onClick={handleSwitchToStudio} className="cursor-pointer">
                  <Palette className="mr-2 h-4 w-4" />
                  Switch to Studio
                </DropdownMenuItem>
              )}
              
              {mode === "studio" && (
                <DropdownMenuItem onClick={handleSwitchToCore} className="cursor-pointer">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Core
                </DropdownMenuItem>
              )}
              
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} className="text-destructive cursor-pointer">
                <LogOut className="mr-2 h-4 w-4" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
