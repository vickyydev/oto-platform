import { ReactNode } from "react";

interface AppLayoutProps {
  children: ReactNode;
  title?: string;
}

export function AppLayout({ children }: AppLayoutProps) {
  return <>{children}</>;
}
