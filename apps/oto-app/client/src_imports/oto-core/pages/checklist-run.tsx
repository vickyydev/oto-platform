import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Progress } from "@/components/ui/progress";
import { 
  ArrowLeft, 
  CheckCircle, 
  AlertTriangle, 
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Save,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { ChecklistRun, ChecklistRunItem, ChecklistTemplate, ChecklistTemplateItem } from "@shared/schema";
import { Link } from "wouter";

interface ChecklistRunWithDetails extends ChecklistRun {
  template: ChecklistTemplate;
  items: (ChecklistRunItem & { templateItem: ChecklistTemplateItem })[];
}

export default function ChecklistRunPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});

  const { data: run, isLoading } = useQuery<ChecklistRunWithDetails>({
    queryKey: ["/api/checklist-runs", id],
  });

  const updateItemMutation = useMutation({
    mutationFn: async ({ itemId, updates }: { itemId: string; updates: Partial<ChecklistRunItem> }) => {
      const res = await apiRequest("PATCH", `/api/checklist-run-items/${itemId}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs", id] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update item",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const completeRunMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/checklist-runs/${id}`, { status: "completed" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      toast({
        title: "Checklist completed!",
        description: "Great job completing this checklist.",
      });
      setLocation("/today");
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to complete checklist",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const toggleItem = (itemId: string, templateItem: ChecklistTemplateItem, currentCompleted: boolean) => {
    if (run?.status === "completed") return;

    if (templateItem.isCritical && currentCompleted) {
      if (!confirm("This is a critical item. Marking as incomplete may require escalation. Continue?")) {
        return;
      }
    }

    const note = itemNotes[itemId] || "";
    updateItemMutation.mutate({
      itemId,
      updates: {
        completed: !currentCompleted,
        note: note || undefined,
        completedAt: !currentCompleted ? new Date() : null,
      },
    });
  };

  const toggleExpand = (itemId: string) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(itemId)) {
      newExpanded.delete(itemId);
    } else {
      newExpanded.add(itemId);
    }
    setExpandedItems(newExpanded);
  };

  const saveNote = (itemId: string) => {
    const note = itemNotes[itemId];
    updateItemMutation.mutate({
      itemId,
      updates: { note },
    });
    toast({ title: "Note saved" });
  };

  if (isLoading || !run) {
    return (
      <AppLayout hideNav>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const completedCount = run.items.filter((item) => item.completed).length;
  const totalCount = run.items.length;
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const allCompleted = completedCount === totalCount;
  const isCompleted = run.status === "completed";

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center gap-3 max-w-lg mx-auto">
            <Link href="/today">
              <Button size="icon" variant="ghost" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold truncate">{run.template.name}</h1>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{completedCount}/{totalCount} items</span>
                <StatusBadge status={run.status} />
              </div>
            </div>
          </div>
          <div className="max-w-lg mx-auto mt-3">
            <Progress value={progress} className="h-2" />
          </div>
        </div>

        <div className="flex-1 p-4 pb-24 max-w-lg mx-auto w-full">
          <div className="space-y-3">
            {run.items
              .sort((a, b) => a.templateItem.sortOrder - b.templateItem.sortOrder)
              .map((item) => {
                const isExpanded = expandedItems.has(item.id);
                const hasNote = item.note || itemNotes[item.id];

                return (
                  <Card 
                    key={item.id} 
                    className={cn(
                      "overflow-visible transition-all",
                      item.completed && "bg-muted/50",
                      item.templateItem.isCritical && !item.completed && "border-destructive/50"
                    )}
                    data-testid={`card-item-${item.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={item.completed}
                          onCheckedChange={() => toggleItem(item.id, item.templateItem, item.completed)}
                          disabled={isCompleted}
                          className="mt-0.5 h-6 w-6"
                          data-testid={`checkbox-item-${item.id}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className={cn(
                                "font-medium",
                                item.completed && "line-through text-muted-foreground"
                              )}>
                                {item.templateItem.title}
                              </p>
                              {item.templateItem.isCritical && (
                                <span className="inline-flex items-center gap-1 text-xs text-destructive mt-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  Critical item
                                </span>
                              )}
                            </div>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => toggleExpand(item.id)}
                              className="shrink-0 h-8 w-8"
                              data-testid={`button-expand-${item.id}`}
                            >
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </Button>
                          </div>

                          {isExpanded && (
                            <div className="mt-3 space-y-3">
                              {item.templateItem.description && (
                                <p className="text-sm text-muted-foreground">{item.templateItem.description}</p>
                              )}
                              
                              <div className="space-y-2">
                                <label className="text-sm font-medium flex items-center gap-1">
                                  <MessageSquare className="h-3.5 w-3.5" />
                                  Notes {item.templateItem.requiresNote && <span className="text-destructive">*</span>}
                                </label>
                                <Textarea
                                  placeholder="Add notes..."
                                  value={itemNotes[item.id] ?? item.note ?? ""}
                                  onChange={(e) => setItemNotes({ ...itemNotes, [item.id]: e.target.value })}
                                  disabled={isCompleted}
                                  className="text-sm"
                                  data-testid={`textarea-note-${item.id}`}
                                />
                                {!isCompleted && (
                                  <Button 
                                    size="sm" 
                                    variant="secondary"
                                    onClick={() => saveNote(item.id)}
                                    disabled={updateItemMutation.isPending}
                                    data-testid={`button-save-note-${item.id}`}
                                  >
                                    <Save className="mr-1 h-3 w-3" />
                                    Save Note
                                  </Button>
                                )}
                              </div>
                            </div>
                          )}

                          {!isExpanded && hasNote && (
                            <p className="text-xs text-muted-foreground mt-1 truncate">
                              Note: {item.note || itemNotes[item.id]}
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
          </div>
        </div>

        {!isCompleted && (
          <div 
            className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur-md border-t border-border"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
          >
            <div className="max-w-lg mx-auto">
              <Button
                className="w-full h-12 text-base font-semibold"
                disabled={!allCompleted || completeRunMutation.isPending}
                onClick={() => completeRunMutation.mutate()}
                data-testid="button-complete-checklist"
              >
                <CheckCircle className="mr-2 h-5 w-5" />
                Complete Checklist
              </Button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
