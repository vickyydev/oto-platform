import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowLeft, Users, ExternalLink, Building2, Shield, UserX, Key, AlertTriangle, Clock } from "lucide-react";
import type { User, Branch } from "@shared/schema";
import { format } from "date-fns";

const HR_APP_URL = import.meta.env.VITE_HR_APP_URL || "https://oto-hr.replit.app";

type UserWithBranch = Omit<User, 'password'> & { 
  branch?: Branch;
  hrEmployee?: {
    fullName: string;
    preferredName?: string | null;
    employmentState: "ACTIVE" | "LEAVING" | "LEFT";
    homeBranchName: string;
  } | null;
};

const accessLevelColors: Record<string, string> = {
  ADMIN: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  MANAGER: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  STAFF: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  LEAVING: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  LEFT: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

export default function AdminUsersPage() {
  const { data: users, isLoading } = useQuery<UserWithBranch[]>({
    queryKey: ["/api/admin/users"],
  });

  const getHRLink = (user: UserWithBranch) => {
    if (user.hrPersonId) {
      return `${HR_APP_URL}/people/${user.hrPersonId}`;
    }
    return null;
  };

  const getBranchScopeSummary = (user: UserWithBranch) => {
    if (user.branchScope === "ALL") return "All branches";
    if (user.branchIds && user.branchIds.length > 0) {
      return `${user.branchIds.length} branch${user.branchIds.length > 1 ? "es" : ""}`;
    }
    return "No branches";
  };

  if (isLoading) {
    return (
      <AppLayout hideNav>
        <LoadingScreen />
      </AppLayout>
    );
  }

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center justify-between max-w-2xl mx-auto">
            <div className="flex items-center gap-3">
              <Link href="/admin">
                <Button size="icon" variant="ghost" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <h1 className="text-lg font-semibold">Users</h1>
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 pb-8 max-w-2xl mx-auto w-full space-y-4">
          <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
              <ExternalLink className="h-5 w-5 shrink-0" />
              <div>
                <span className="font-medium">Managed by HR</span>
                <span className="text-sm ml-2">User accounts are created and managed in OTO HR.</span>
              </div>
            </div>
          </Card>

          {!users || users.length === 0 ? (
            <EmptyState icon={Users} title="No users" description="Users are provisioned from OTO HR" />
          ) : (
            <div className="space-y-3">
              {users.map((user) => (
                <Card key={user.id} data-testid={`card-user-${user.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold">{user.name}</p>
                          <Badge className={accessLevelColors[user.accessLevel || "STAFF"] || accessLevelColors.STAFF}>
                            <Shield className="h-3 w-3 mr-1" />
                            {user.accessLevel || user.role}
                          </Badge>
                          {user.isActive === false && (
                            <Badge variant="outline" className="text-xs bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                              <UserX className="h-3 w-3 mr-1" />
                              Disabled
                            </Badge>
                          )}
                          {user.mustChangePassword && (
                            <Badge variant="outline" className="text-xs bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                              <Key className="h-3 w-3 mr-1" />
                              Password Change
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{user.email}</p>
                        <div className="flex gap-2 mt-2 flex-wrap">
                          {user.branch && (
                            <Badge variant="outline" className="text-xs">
                              <Building2 className="h-3 w-3 mr-1" />
                              {user.branch.name}
                            </Badge>
                          )}
                          <Badge variant="secondary" className="text-xs">
                            {getBranchScopeSummary(user)}
                          </Badge>
                        </div>
                        
                        {user.hrPersonId ? (
                          <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
                            {user.hrEmployee ? (
                              <>
                                <span className="text-green-600">HR:</span>
                                <span>{user.hrEmployee.fullName}</span>
                                <Badge className={`${statusColors[user.hrEmployee.employmentState]} text-xs`}>
                                  {user.hrEmployee.employmentState}
                                </Badge>
                              </>
                            ) : (
                              <span>HR ID: {user.hrPersonId}</span>
                            )}
                          </div>
                        ) : (
                          <div className="mt-2 text-xs text-yellow-600 dark:text-yellow-400 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            <span>Not linked to HR</span>
                          </div>
                        )}

                        {user.lastLoginAt && (
                          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Last login: {format(new Date(user.lastLoginAt), "MMM d, yyyy")}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0">
                        {getHRLink(user) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            asChild
                            data-testid={`button-open-hr-${user.id}`}
                          >
                            <a href={getHRLink(user)!} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-4 w-4 mr-1" />
                              Open in HR
                            </a>
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled
                            title="User not linked to HR"
                          >
                            Not linked
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
