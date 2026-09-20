import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Users, Building2, Shield, CalendarDays } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Redirect } from "wouter";

export default function StudioSettingsPage() {
  const { user } = useAuth();

  if (user?.role !== "admin") {
    return <Redirect to="/studio" />;
  }

  const settingsSections = [
    {
      title: "Event Settings",
      description: "Manage event locations, entertainment options, and setup items",
      icon: CalendarDays,
      href: "/studio/event-settings",
    },
    {
      title: "User Management",
      description: "View staff accounts (managed by OTO HR)",
      icon: Users,
      href: "/admin/users",
    },
    {
      title: "Branch Management",
      description: "View park locations (managed by OTO HR)",
      icon: Building2,
      href: "/admin/branches",
    },
  ];

  return (
    <StudioLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-2 mb-6">
          <Shield className="h-5 w-5 text-violet-600" />
          <h1 className="text-xl font-bold">Admin Settings</h1>
        </div>

        <div className="space-y-3">
          {settingsSections.map((section) => (
            <Link key={section.href} href={section.href}>
              <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`card-settings-${section.title.toLowerCase().replace(" ", "-")}`}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-lg bg-violet-100 dark:bg-violet-900/30">
                      <section.icon className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{section.title}</h3>
                      <p className="text-sm text-muted-foreground">{section.description}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </StudioLayout>
  );
}
