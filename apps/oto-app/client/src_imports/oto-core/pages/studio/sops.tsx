import { useState } from "react";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { FileText, Lock, Search } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import type { SopArticle } from "@shared/schema";

export default function StudioSopsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [searchQuery, setSearchQuery] = useState("");

  const { data: sops, isLoading } = useQuery<SopArticle[]>({
    queryKey: ["/api/sops"],
    enabled: !!user,
  });

  const filteredSops = sops?.filter(sop => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return sop.title.toLowerCase().includes(query);
  }) || [];

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
          <h1 className="text-xl font-bold">SOP Articles</h1>
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
              SOP articles can only be edited by administrators. Contact your admin to make changes.
            </CardContent>
          </Card>
        )}

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search SOPs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-sops"
          />
        </div>

        <div className="space-y-3">
          {filteredSops.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No SOPs"
              description={searchQuery ? "No matching articles found" : "No SOP articles have been created yet"}
            />
          ) : (
            filteredSops.map((sop) => (
              <Card key={sop.id} className="overflow-visible" data-testid={`card-sop-${sop.id}`}>
                <CardContent className="p-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold mb-1">{sop.title}</h3>
                    <div className="flex items-center gap-2 flex-wrap">
                      {sop.departments.slice(0, 3).map((dept) => (
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
