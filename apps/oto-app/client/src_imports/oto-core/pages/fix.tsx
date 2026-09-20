import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Wrench, ChevronRight, AlertTriangle, Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { TroubleshootingFlow } from "@shared/schema";

export default function FixPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");

  const { data: flows, isLoading } = useQuery<TroubleshootingFlow[]>({
    queryKey: ["/api/troubleshooting/flows"],
    enabled: !!user,
  });

  const filteredFlows = flows?.filter(flow => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      flow.title.toLowerCase().includes(query) ||
      flow.description?.toLowerCase().includes(query) ||
      flow.departments.some(d => d.toLowerCase().includes(query))
    );
  }) || [];

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="space-y-4 mb-6">
          <h2 className="text-lg font-semibold">{t.today.quickActions}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Link href="/report-issue">
              <Card className="hover-elevate active-elevate-2 cursor-pointer p-4 text-center overflow-visible" data-testid="button-report-issue">
                <Plus className="h-6 w-6 mx-auto mb-2 text-primary" />
                <span className="text-sm font-medium">{t.today.reportIssue}</span>
              </Card>
            </Link>
            <Link href="/escalate">
              <Card className="hover-elevate active-elevate-2 cursor-pointer p-4 text-center border-destructive/20 overflow-visible" data-testid="button-escalate">
                <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-destructive" />
                <span className="text-sm font-medium text-destructive">{t.today.escalate}</span>
              </Card>
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            Report any issues you notice: broken equipment, maintenance needs, cleaning required, 
            safety concerns, or anything that needs attention. For urgent matters, use Escalate.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Troubleshooting</h2>
          
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t.common.search + "..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-issues"
            />
          </div>

          {filteredFlows.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title={searchQuery ? t.common.noResults : "No troubleshooting guides"}
              description={searchQuery ? "Try a different search term" : "Troubleshooting flows will appear here"}
            />
          ) : (
            filteredFlows.map((flow) => (
              <Link key={flow.id} href={`/fix/${flow.id}`}>
                <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`card-flow-${flow.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold mb-1">{flow.title}</h3>
                        {flow.description && (
                          <p className="text-sm text-muted-foreground line-clamp-1">{flow.description}</p>
                        )}
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {flow.departments.slice(0, 2).map((dept) => (
                            <Badge key={dept} variant="secondary" className="text-xs capitalize">
                              {dept.replace("_", "/")}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          )}
        </div>
      </div>
    </AppLayout>
  );
}
