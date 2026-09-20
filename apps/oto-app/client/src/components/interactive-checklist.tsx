import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Check, Image as ImageIcon, ListChecks, CheckCircle2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChecklistStep {
  stepNumber: number;
  title: string;
  description?: string;
  imageUrl?: string;
}

interface InteractiveChecklistProps {
  title: string;
  steps: ChecklistStep[];
  onComplete?: () => void;
}

export function InteractiveChecklist({ title, steps, onComplete }: InteractiveChecklistProps) {
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [viewingImage, setViewingImage] = useState<{ url: string; title: string } | null>(null);

  const toggleStep = (stepNumber: number) => {
    const newSet = new Set(completedSteps);
    if (newSet.has(stepNumber)) {
      newSet.delete(stepNumber);
    } else {
      newSet.add(stepNumber);
    }
    setCompletedSteps(newSet);

    if (newSet.size === steps.length && onComplete) {
      onComplete();
    }
  };

  const completedCount = completedSteps.size;
  const totalSteps = steps.length;
  const progress = totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0;
  const isAllDone = completedCount === totalSteps;

  return (
    <Card className={cn(
      "border-2 transition-colors",
      isAllDone ? "border-green-500 bg-green-50/50 dark:bg-green-950/20" : ""
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          <Badge variant={isAllDone ? "default" : "secondary"} className={isAllDone ? "bg-green-500" : ""}>
            {completedCount}/{totalSteps} done
          </Badge>
        </div>
        <div className="w-full bg-muted rounded-full h-2 mt-2">
          <div 
            className={cn(
              "h-2 rounded-full transition-all duration-300",
              isAllDone ? "bg-green-500" : "bg-primary"
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-2">
        {steps.map((step) => {
          const isCompleted = completedSteps.has(step.stepNumber);
          
          return (
            <div
              key={step.stepNumber}
              className={cn(
                "flex items-start gap-3 p-3 rounded-lg border transition-all cursor-pointer",
                isCompleted 
                  ? "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800" 
                  : "bg-card hover:bg-muted/50"
              )}
              onClick={() => toggleStep(step.stepNumber)}
              data-testid={`checklist-step-${step.stepNumber}`}
            >
              <button
                type="button"
                className={cn(
                  "flex-shrink-0 h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all",
                  isCompleted
                    ? "bg-green-500 border-green-500 text-white scale-110"
                    : "border-muted-foreground/40 hover:border-primary"
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStep(step.stepNumber);
                }}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : <span className="text-xs font-medium">{step.stepNumber}</span>}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className={cn(
                      "font-medium text-sm",
                      isCompleted && "line-through text-muted-foreground"
                    )}>
                      {step.title}
                    </p>
                    {step.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
                    )}
                  </div>

                  {step.imageUrl && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setViewingImage({ url: step.imageUrl!, title: step.title });
                      }}
                      className="flex-shrink-0 text-xs"
                      data-testid={`button-view-photo-${step.stepNumber}`}
                    >
                      <ImageIcon className="h-3 w-3 mr-1" />
                      View Photo
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {isAllDone && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
            <CheckCircle2 className="h-5 w-5" />
            <span className="text-sm font-medium">All steps completed!</span>
          </div>
        )}
      </CardContent>

      <Dialog open={!!viewingImage} onOpenChange={() => setViewingImage(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewingImage?.title}</DialogTitle>
          </DialogHeader>
          {viewingImage && (
            <img 
              src={viewingImage.url} 
              alt={viewingImage.title}
              className="w-full h-auto rounded-lg"
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function ChecklistSkeleton() {
  return (
    <Card className="animate-pulse">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-muted" />
          <div className="h-5 w-32 rounded bg-muted" />
        </div>
        <div className="w-full bg-muted rounded-full h-2 mt-2" />
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-start gap-3 p-3 rounded-lg border">
            <div className="h-6 w-6 rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-3/4 rounded bg-muted" />
              <div className="h-3 w-1/2 rounded bg-muted" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
