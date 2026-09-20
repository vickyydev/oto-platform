import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { ArrowLeft, RotateCcw, CheckCircle, AlertTriangle, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { TroubleshootingFlow, TroubleshootingNode } from "@shared/schema";

interface FlowWithNodes extends TroubleshootingFlow {
  nodes: TroubleshootingNode[];
}

export default function TroubleshootPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const { data: flow, isLoading } = useQuery<FlowWithNodes>({
    queryKey: ["/api/troubleshooting/flows", id],
  });

  // Set initial node when flow loads
  if (flow && !currentNodeId && !history.length) {
    const startNode = flow.nodes.find((n) => n.isStart);
    if (startNode) {
      setCurrentNodeId(startNode.id);
    }
  }

  if (isLoading || !flow) {
    return (
      <AppLayout hideNav>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const currentNode = flow.nodes.find((n) => n.id === currentNodeId);
  const options = currentNode?.options as { text: string; nextNodeId: string | null }[] | undefined;

  const handleOptionSelect = (nextNodeId: string | null) => {
    if (currentNodeId) {
      setHistory([...history, currentNodeId]);
    }
    if (nextNodeId) {
      setCurrentNodeId(nextNodeId);
    }
  };

  const handleBack = () => {
    if (history.length > 0) {
      const prevNodeId = history[history.length - 1];
      setHistory(history.slice(0, -1));
      setCurrentNodeId(prevNodeId);
    }
  };

  const handleRestart = () => {
    const startNode = flow.nodes.find((n) => n.isStart);
    if (startNode) {
      setCurrentNodeId(startNode.id);
      setHistory([]);
    }
  };

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center gap-3 max-w-lg mx-auto">
            <Link href="/fix">
              <Button size="icon" variant="ghost" data-testid="button-back-to-fix">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold truncate">{flow.title}</h1>
              <p className="text-sm text-muted-foreground">Step {history.length + 1}</p>
            </div>
            <Button size="icon" variant="ghost" onClick={handleRestart} data-testid="button-restart">
              <RotateCcw className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {history.length > 0 && (
          <div className="p-4 pb-0 max-w-lg mx-auto w-full">
            <Button variant="ghost" size="sm" onClick={handleBack} data-testid="button-back-step">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Previous Step
            </Button>
          </div>
        )}

        <div className="flex-1 p-4 max-w-lg mx-auto w-full">
          {currentNode && (
            <div className="space-y-6">
              <Card className={cn(
                "overflow-visible",
                currentNode.isResolution && "border-green-500/50 bg-green-50 dark:bg-green-900/10",
                currentNode.isEscalation && "border-destructive/50 bg-destructive/5"
              )}>
                <CardContent className="p-6">
                  {currentNode.isResolution && (
                    <div className="flex items-center gap-2 mb-4 text-green-600 dark:text-green-400">
                      <CheckCircle className="h-5 w-5" />
                      <span className="font-semibold">Resolution</span>
                    </div>
                  )}
                  {currentNode.isEscalation && (
                    <div className="flex items-center gap-2 mb-4 text-destructive">
                      <AlertTriangle className="h-5 w-5" />
                      <span className="font-semibold">Escalation Required</span>
                    </div>
                  )}
                  <p className="text-lg">{currentNode.prompt}</p>
                </CardContent>
              </Card>

              {!currentNode.isResolution && !currentNode.isEscalation && options && (
                <div className="space-y-3">
                  {options.map((option, idx) => (
                    <Button
                      key={idx}
                      variant="secondary"
                      className="w-full h-auto min-h-14 py-4 px-4 text-left justify-between whitespace-normal"
                      onClick={() => handleOptionSelect(option.nextNodeId)}
                      data-testid={`button-option-${idx}`}
                    >
                      <span>{option.text}</span>
                      <ChevronRight className="h-5 w-5 shrink-0 ml-2" />
                    </Button>
                  ))}
                </div>
              )}

              {currentNode.isEscalation && (
                <Link href="/escalate">
                  <Button className="w-full h-12 bg-destructive hover:bg-destructive/90" data-testid="button-escalate-now">
                    <AlertTriangle className="mr-2 h-5 w-5" />
                    Escalate Now
                  </Button>
                </Link>
              )}

              {currentNode.isResolution && (
                <div className="space-y-3">
                  <Link href="/fix">
                    <Button className="w-full h-12" data-testid="button-done">
                      <CheckCircle className="mr-2 h-5 w-5" />
                      Done
                    </Button>
                  </Link>
                  <p className="text-sm text-muted-foreground text-center">
                    Issue not resolved? <Link href="/escalate" className="text-primary underline">Escalate to manager</Link>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
