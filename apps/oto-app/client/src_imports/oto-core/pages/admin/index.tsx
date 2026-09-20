import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { 
  Users, 
  Building2, 
  ClipboardList, 
  FileText, 
  BookOpen, 
  Wrench,
  ChevronRight,
  ArrowLeft,
  Database,
  Loader2,
  CheckCircle,
  XCircle,
  PartyPopper
} from "lucide-react";

const adminSections = [
  {
    href: "/admin/users",
    icon: Users,
    label: "Users",
    description: "Manage staff accounts and roles",
  },
  {
    href: "/admin/branches",
    icon: Building2,
    label: "Branches",
    description: "Manage locations and manager contacts",
  },
  {
    href: "/admin/checklists",
    icon: ClipboardList,
    label: "Checklist Templates",
    description: "Create and edit checklist templates",
  },
  {
    href: "/admin/sops",
    icon: FileText,
    label: "SOP Articles",
    description: "Manage standard operating procedures",
  },
  {
    href: "/admin/training",
    icon: BookOpen,
    label: "Training Modules",
    description: "Create training content and quizzes",
  },
  {
    href: "/admin/troubleshooting",
    icon: Wrench,
    label: "Troubleshooting Flows",
    description: "Build decision tree workflows",
  },
  {
    href: "/admin/events",
    icon: PartyPopper,
    label: "Events & Birthdays",
    description: "Manage birthday parties and special events",
  },
];

interface DbStatus {
  userCount?: number;
  branchCount?: number;
  checklistCount?: number;
  sopCount?: number;
  moduleCount?: number;
  hasData?: boolean;
  error?: string;
}

export default function AdminPage() {
  const { toast } = useToast();
  const [isSeeding, setIsSeeding] = useState(false);
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);

  useEffect(() => {
    checkDbStatus();
  }, []);

  const checkDbStatus = async () => {
    setIsLoadingStatus(true);
    try {
      const response = await fetch("/api/db-status");
      const data = await response.json();
      setDbStatus(data);
    } catch (error) {
      setDbStatus({ error: "Failed to check database" });
    } finally {
      setIsLoadingStatus(false);
    }
  };

  const handleSeedData = async () => {
    if (!confirm("This will reset and seed the database with sample data. You will be logged out. Are you sure?")) {
      return;
    }
    
    setIsSeeding(true);
    try {
      const response = await apiRequest("POST", "/api/force-seed");
      const result = await response.json();
      
      if (result.success && result.data) {
        toast({
          title: "Database Seeded Successfully",
          description: `Created ${result.data.users} users, ${result.data.checklists} checklists, ${result.data.sops} SOPs, ${result.data.trainingModules} training modules. Redirecting to login...`,
        });
      } else {
        toast({
          title: "Success",
          description: "Database seeded. Redirecting to login...",
        });
      }
      
      setTimeout(() => {
        window.location.href = "/";
      }, 2000);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to seed database. Please try again.",
        variant: "destructive",
      });
      setIsSeeding(false);
    }
  };

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center gap-3 max-w-2xl mx-auto">
            <Link href="/">
              <Button size="icon" variant="ghost" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-lg font-semibold">Admin Console</h1>
          </div>
        </div>

        <div className="flex-1 p-4 pb-8 max-w-2xl mx-auto w-full">
          <div className="grid gap-3">
            {adminSections.map((section) => (
              <Link key={section.href} href={section.href}>
                <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`card-admin-${section.label.toLowerCase().replace(" ", "-")}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                        <section.icon className="h-6 w-6 text-primary" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-semibold">{section.label}</h3>
                        <p className="text-sm text-muted-foreground">{section.description}</p>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>

          <div className="mt-8 border-t pt-6">
            <h2 className="text-sm font-semibold text-muted-foreground mb-3">Database Tools</h2>
            
            <Card className="overflow-visible mb-3" data-testid="card-db-status">
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <div className={`h-12 w-12 rounded-lg flex items-center justify-center ${dbStatus?.hasData ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                    {isLoadingStatus ? (
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    ) : dbStatus?.hasData ? (
                      <CheckCircle className="h-6 w-6 text-green-500" />
                    ) : (
                      <XCircle className="h-6 w-6 text-red-500" />
                    )}
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold">Database Status</h3>
                    {isLoadingStatus ? (
                      <p className="text-sm text-muted-foreground">Checking...</p>
                    ) : dbStatus?.error ? (
                      <p className="text-sm text-destructive">{dbStatus.error}</p>
                    ) : dbStatus?.hasData ? (
                      <p className="text-sm text-muted-foreground">
                        {dbStatus.userCount} users, {dbStatus.branchCount} branches, {dbStatus.checklistCount} checklists, {dbStatus.sopCount} SOPs
                      </p>
                    ) : (
                      <p className="text-sm text-destructive">Database is empty - click Seed Data below</p>
                    )}
                  </div>
                  <Button 
                    variant="outline"
                    size="sm"
                    onClick={checkDbStatus}
                    disabled={isLoadingStatus}
                    data-testid="button-refresh-status"
                  >
                    Refresh
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-visible" data-testid="card-admin-seed-data">
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 rounded-lg bg-orange-500/10 flex items-center justify-center">
                    <Database className="h-6 w-6 text-orange-500" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold">Seed Sample Data</h3>
                    <p className="text-sm text-muted-foreground">Load demo users, checklists, training, and SOPs</p>
                  </div>
                  <Button 
                    onClick={handleSeedData} 
                    disabled={isSeeding}
                    data-testid="button-seed-data"
                  >
                    {isSeeding ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Seeding...
                      </>
                    ) : (
                      "Seed Data"
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
