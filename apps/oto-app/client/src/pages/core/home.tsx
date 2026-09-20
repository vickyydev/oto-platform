import { Link } from "wouter";
import { Calendar, BookOpen, Search, Wrench, UserCheck } from "lucide-react";
import { AppLayout } from "@/components/layout/app-layout";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";

interface NavCardProps {
  href: string;
  icon: React.ElementType;
  label: string;
  description: string;
  badge?: number;
  color: string;
}

function NavCard({ href, icon: Icon, label, description, badge, color }: NavCardProps) {
  return (
    <Link href={href}>
      <Card 
        className="relative overflow-visible p-6 hover-elevate active-elevate-2 cursor-pointer transition-transform active:scale-[0.98]"
        data-testid={`card-nav-${label.toLowerCase()}`}
      >
        {badge !== undefined && badge > 0 && (
          <span className="absolute -top-2 -right-2 h-6 min-w-6 px-1.5 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs font-bold">
            {badge}
          </span>
        )}
        <div 
          className={cn("h-12 w-12 rounded-xl flex items-center justify-center mb-4", color)}
        >
          <Icon className="h-6 w-6 text-white" />
        </div>
        <h3 className="text-lg font-semibold mb-1">{label}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </Card>
    </Link>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  
  const { data: overdueCount } = useQuery<{ count: number }>({
    queryKey: ["/api/checklists/overdue-count"],
    enabled: !!user,
  });

  const { data: openIssuesCount } = useQuery<{ count: number }>({
    queryKey: ["/api/issues/open-count"],
    enabled: !!user,
  });

  const navCards: NavCardProps[] = [
    {
      href: "/today",
      icon: Calendar,
      label: "Today",
      description: "Checklists & tasks",
      badge: (overdueCount?.count || 0) + (openIssuesCount?.count || 0),
      color: "bg-blue-500",
    },
    {
      href: "/learn",
      icon: BookOpen,
      label: "Learn",
      description: "Training & quizzes",
      color: "bg-green-500",
    },
    {
      href: "/find",
      icon: Search,
      label: "Find",
      description: "SOPs & guides",
      color: "bg-purple-500",
    },
    {
      href: "/fix",
      icon: Wrench,
      label: "Fix",
      description: "Troubleshooting",
      color: "bg-orange-500",
    },
    {
      href: "/checkins",
      icon: UserCheck,
      label: "Check-ins",
      description: "Drop-off service",
      color: "bg-pink-500",
    },
  ];

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold mb-1" data-testid="text-welcome-greeting">
            Welcome, {user?.name?.split(" ")[0]}
          </h1>
          <p className="text-muted-foreground" data-testid="text-welcome-subtitle">
            What would you like to do?
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {navCards.map((card) => (
            <NavCard key={card.href} {...card} />
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
