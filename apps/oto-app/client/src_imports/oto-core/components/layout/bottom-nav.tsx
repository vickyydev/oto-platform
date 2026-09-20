import { Link, useLocation } from "wouter";
import { Calendar, BookOpen, Search, AlertTriangle, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function BottomNav() {
  const [location] = useLocation();
  const { t } = useI18n();

  const navItems = [
    { href: "/checkins", label: t.nav.checkins, icon: UserCheck },
    { href: "/today", label: t.nav.today, icon: Calendar },
    { href: "/fix", label: t.nav.fix, icon: AlertTriangle },
    { href: "/find", label: t.nav.find, icon: Search },
    { href: "/learn", label: t.nav.learn, icon: BookOpen },
  ];

  return (
    <nav 
      className="fixed bottom-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-md border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      data-testid="nav-bottom"
    >
      <div className="flex items-center justify-around h-16 max-w-lg mx-auto">
        {navItems.map((item) => {
          const isActive = location.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href}>
              <button
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 w-14 h-14 rounded-lg transition-colors",
                  isActive 
                    ? "text-primary" 
                    : "text-muted-foreground hover:text-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon className={cn("h-5 w-5", isActive && "fill-primary/10")} strokeWidth={isActive ? 2.5 : 2} />
                <span className={cn("text-[10px] font-medium", isActive && "font-semibold")}>{item.label}</span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
