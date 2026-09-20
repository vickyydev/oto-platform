import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Wrench, Lock } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import type { TroubleshootingFlow } from "@shared/schema";

export default function StudioTroubleshootingPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data: flows, isLoading } = useQuery<TroubleshootingFlow[]>({
    queryKey: ["/api/troubleshooting/flows"],
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
          <h1 className="text-xl font-bold">Troubleshooting Flows</h1>
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
              Troubleshooting flows can only be edited by administrators. Contact your admin to make changes.
            </CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {!flows || flows.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="No flows"
              description="No troubleshooting flows have been created yet"
            />
          ) : (
            flows.map((flow) => (
              <Card key={flow.id} className="overflow-visible" data-testid={`card-flow-${flow.id}`}>
                <CardContent className="p-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold mb-1">{flow.title}</h3>
                    {flow.description && (
                      <p className="text-sm text-muted-foreground mb-2">{flow.description}</p>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      {flow.departments.slice(0, 3).map((dept) => (
                        <Badge key={dept} variant="secondary" className="text-xs capitalize">
                          {dept.replace("_", "/")}
                        </Badge>
                      ))}
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
