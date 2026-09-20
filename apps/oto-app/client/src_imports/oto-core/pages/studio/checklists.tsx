import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ClipboardList, Lock } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";

interface ChecklistTemplate {
  id: string;
  name: string;
  description: string | null;
  frequency: string;
  recommendedDueTime: string;
  departments: string[];
}

export default function StudioChecklistsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data: checklists, isLoading } = useQuery<ChecklistTemplate[]>({
    queryKey: ["/api/checklists/today"],
    enabled: !!user,
  });

  if (isLoading) {
    return (
      <StudioLayout>
        <LoadingScreen />
      </StudioLayout>
    );
  }

  return (
    <StudioLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-xl font-bold">Checklists</h1>
          {!isAdmin && (
            <Badge variant="secondary" className="flex items-center gap-1">
              <Lock className="h-3 w-3" />
              View Only
            </Badge>
          )}
        </div>

        {!isAdmin && (
          <Card className="mb-4 bg-muted/50">
            <CardContent className="p-3 text-sm text-muted-foreground">
              Checklist templates can only be edited by administrators. Contact your admin to make changes.
            </CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {!checklists || checklists.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No checklists"
              description="No checklist templates have been created yet"
            />
          ) : (
            checklists.map((checklist) => (
              <Card key={checklist.id} className="overflow-visible" data-testid={`card-checklist-${checklist.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold mb-1">{checklist.name}</h3>
                      {checklist.description && (
                        <p className="text-sm text-muted-foreground mb-2">{checklist.description}</p>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs">
                          Due by {checklist.recommendedDueTime}
                        </Badge>
                        {checklist.departments.slice(0, 2).map((dept) => (
                          <Badge key={dept} variant="secondary" className="text-xs capitalize">
                            {dept.replace("_", "/")}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </StudioLayout>
  );
}
