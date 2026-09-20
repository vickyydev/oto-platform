import { useCallback, useEffect, useState } from "react";
import * as Sentry from "@sentry/react";
import { captureFeedback } from "@sentry/core";
import { useToast } from "@/hooks/use-toast";

export function useSessionReplay() {
  const [isRecording, setIsRecording] = useState(false);
  const { toast } = useToast();

  // Sync state with the actual replay integration status
  useEffect(() => {
    const replay = Sentry.getReplay();
    if (!replay) return;

    const check = () => {
      setIsRecording(!!replay.getReplayId());
    };

    check();
    const interval = setInterval(check, 1000);
    return () => clearInterval(interval);
  }, []);

  const startRecording = useCallback(async (description?: string) => {
    const replay = Sentry.getReplay();
    if (!replay) {
      toast({
        title: "Session replay unavailable",
        description: "Sentry is not configured in this environment.",
        variant: "destructive",
      });
      return;
    }
    await replay.start();
    setIsRecording(true);
    if (description) {
      // Give the replay integration a moment to register its replayId
      // before capturing feedback so includeReplay attaches correctly.
      setTimeout(() => {
        captureFeedback(
          { message: description, source: "session-replay-dialog" },
          { includeReplay: true }
        );
      }, 1000);
    }
    toast({
      title: "Recording started",
      description: "Session replay is now active.",
    });
  }, [toast]);

  const stopRecording = useCallback(() => {
    const replay = Sentry.getReplay();
    if (!replay) return;
    replay.stop();
    setIsRecording(false);
    toast({
      title: "Recording stopped",
      description: "Session replay has been saved to Sentry.",
    });
  }, [toast]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return { isRecording, startRecording, stopRecording, toggleRecording };
}
