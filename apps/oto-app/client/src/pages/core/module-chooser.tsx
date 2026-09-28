import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ClipboardList, Users, Settings } from "lucide-react";

const LAST_MODULE_KEY = "oto-last-module";

export function getLastModule(): string | null {
  return localStorage.getItem(LAST_MODULE_KEY);
}

export function setLastModule(module: string): void {
  localStorage.setItem(LAST_MODULE_KEY, module);
}

export default function ModuleChooser() {
  const { modules, user } = useAuth();
  const [, navigate] = useLocation();

  const handleSelectModule = (module: "core" | "hr" | "studio") => {
    setLastModule(module);
    if (module === "core") {
      navigate("/");
    } else if (module === "hr") {
      window.location.href = import.meta.env.VITE_HR_APP_URL || "/hr";
    } else if (module === "studio") {
      navigate("/studio");
    }
  };

  const availableModules = [
    {
      key: "core" as const,
      name: "OTO Core",
      description: "Daily operations, checklists, tasks, and service check-ins",
      icon: ClipboardList,
      enabled: modules.core,
      color: "bg-blue-500",
    },
    {
      key: "hr" as const,
      name: "OTO HR",
      description: "Time tracking, schedules, leave requests, and employee management",
      icon: Users,
      enabled: modules.hr,
      color: "bg-green-500",
    },
    {
      key: "studio" as const,
      name: "OTO Studio",
      description: "Configure checklists, SOPs, and training content",
      icon: Settings,
      enabled: modules.studio,
      color: "bg-violet-500",
    },
  ].filter((m) => m.enabled);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold" data-testid="text-module-chooser-title">
            Welcome, {user?.name?.split(" ")[0] || "User"}
          </h1>
          <p className="text-muted-foreground" data-testid="text-module-chooser-subtitle">
            Choose which app you'd like to use
          </p>
        </div>

        <div className="space-y-3">
          {availableModules.map((module) => (
            <Card
              key={module.key}
              className="cursor-pointer transition-all hover-elevate"
              onClick={() => handleSelectModule(module.key)}
              data-testid={`card-module-${module.key}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-md ${module.color} text-white`}>
                    <module.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">{module.name}</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>{module.description}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>

        {availableModules.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No modules are available for your account.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
