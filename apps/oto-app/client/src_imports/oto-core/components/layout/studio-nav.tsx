import { Link, useLocation } from "wouter";
import { ListTodo, CalendarDays, ClipboardList, FileText, GraduationCap, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

export function StudioNav() {
  const [location] = useLocation();

  const navItems = [
    { href: "/studio/tasks", label: "Tasks", icon: ListTodo },
    { href: "/studio/events", label: "Events", icon: CalendarDays },
    { href: "/studio/checklists", label: "Checklists", icon: ClipboardList },
    { href: "/studio/sops", label: "KB", icon: FileText },
    { href: "/studio/quizzes", label: "Quizzes", icon: GraduationCap },
    { href: "/studio/troubleshooting", label: "Flows", icon: Wrench },
  ];

  return (
    <nav 
      className="fixed bottom-0 left-0 right-0 z-50 bg-violet-50/95 dark:bg-violet-950/95 backdrop-blur-md border-t border-violet-200 dark:border-violet-800"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      data-testid="nav-studio"
    >
      <div className="flex items-center justify-around h-16 max-w-2xl mx-auto overflow-x-auto">
        {navItems.map((item) => {
          const isActive = location.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href}>
              <button
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 min-w-[3rem] h-14 rounded-lg transition-colors px-1",
                  isActive 
                    ? "text-violet-700 dark:text-violet-300" 
                    : "text-muted-foreground hover:text-foreground"
                )}
                data-testid={`nav-studio-${item.label.toLowerCase()}`}
              >
                <item.icon className={cn("h-5 w-5", isActive && "fill-violet-200/50 dark:fill-violet-800/50")} strokeWidth={isActive ? 2.5 : 2} />
                <span className={cn("text-[10px] font-medium whitespace-nowrap", isActive && "font-semibold")}>{item.label}</span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
