import { ReactNode } from "react";
import { TopBar } from "./top-bar";
import { StudioNav } from "./studio-nav";

interface StudioLayoutProps {
  children: ReactNode;
}

export function StudioLayout({ children }: StudioLayoutProps) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <TopBar />
      <main 
        className="flex-1 overflow-y-auto"
        style={{ paddingBottom: "calc(4rem + env(safe-area-inset-bottom))" }}
      >
        {children}
      </main>
      <StudioNav />
    </div>
  );
}
