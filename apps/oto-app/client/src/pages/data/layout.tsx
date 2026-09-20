import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Database, LogOut, ExternalLink, GitFork } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataAdminSidebar } from "./sidebar";

export function DataAdminLayout({ children }: { children: React.ReactNode }) {
  const { user, logoutMutation } = useAuth();
  const [location] = useLocation();

  return (
    <div className="flex h-screen w-full bg-background font-sans">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        {/* Logo / title — height matches the main header bar */}
        <div className="flex items-center gap-2 px-4 border-b border-sidebar-border" style={{height: '3.5em'}}>
          <Database className="h-5 w-5 text-sidebar-primary" />
          <Link href="/data">
            <span className="font-semibold text-sidebar-foreground tracking-wide hover:text-sidebar-primary transition-colors">
              Oto Data
            </span>
          </Link>
        </div>

        {/* Model nav */}
        <DataAdminSidebar />

        {/* Footer */}
        <div className="mt-auto border-t border-sidebar-border p-3 space-y-1">
          <Link href="/data/schema">
            <Button
              variant="ghost"
              className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground"
            >
              <GitFork className="h-4 w-4 mr-2" />
              Schema diagram
            </Button>
          </Link>
          <Link href="/">
            <Button
              variant="ghost"
              className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground"
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Back to app
            </Button>
          </Link>
          <Button
            variant="ghost"
            className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground"
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
          >
            <LogOut className="h-4 w-4 mr-2" />
            {logoutMutation.isPending ? "Logging out…" : "Logout"}
          </Button>
          <p className="px-2 pt-1 text-sm text-sidebar-foreground/50 truncate">
            {user?.email}
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center px-6 border-b border-border bg-background/95 backdrop-blur flex-shrink-0" style={{height: '3.5em'}}>
          <nav className="flex items-center gap-1 text-muted-foreground">
            <Link href="/data">
              <span className="hover:text-foreground cursor-pointer">Data Admin</span>
            </Link>
            {location !== "/data" && location !== "/data/" && (() => {
              const parts = location.split("/").filter(Boolean).slice(1); // strip leading 'data'
              return parts.map((part, i) => {
                const href = "/data/" + parts.slice(0, i + 1).join("/");
                const isLast = i === parts.length - 1;
                return (
                  <>
                    <span key={`sep-${i}`}>/</span>
                    {isLast ? (
                      <span key={href} className="text-foreground capitalize">{part}</span>
                    ) : (
                      <Link key={href} href={href}>
                        <span className="hover:text-foreground cursor-pointer capitalize">{part}</span>
                      </Link>
                    )}
                  </>
                );
              });
            })()}
          </nav>
        </header>

        <main className="flex-1 overflow-auto p-6 bg-background">
          {children}
        </main>
      </div>
    </div>
  );
}
