import { TopBar } from "./top-bar";
import { BottomNav } from "./bottom-nav";

interface AppLayoutProps {
  children: React.ReactNode;
  hideNav?: boolean;
}

export function AppLayout({ children, hideNav = false }: AppLayoutProps) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <TopBar />
      <main 
        className="flex-1 overflow-y-auto"
        style={{ paddingBottom: hideNav ? "env(safe-area-inset-bottom)" : "calc(4rem + env(safe-area-inset-bottom))" }}
      >
        {children}
      </main>
      {!hideNav && <BottomNav />}
    </div>
  );
}
