import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";

const COPY_MODE_TIMEOUT_MS = 25000;

export type ClipboardShiftData = {
  shiftRowId: string;
  shiftDate: string;
  employeeId?: string | null;
  casualWorkerId?: string | null;
  assigneeType?: "employee" | "casual";
  dailyRateSnapshot?: number | null;
  isBorrowed?: boolean;
  borrowedFromBranchId?: string | null;
  startTime: string;
  endTime: string;
  label: string | null;
  departmentId: string;
  departmentName?: string;
  employeeName?: string;
  colorIndex?: number | null;
};

type CopyModeState = {
  isActive: boolean;
  clipboardData: ClipboardShiftData | null;
  sourceAssignmentId: string | null;
  pasteCount: number;
  lastPastedId: string | null;
};

type CopyModeContextType = CopyModeState & {
  enterCopyMode: (assignmentId: string, data: ClipboardShiftData) => void;
  exitCopyMode: () => void;
  setPasteCount: (count: number) => void;
  setLastPastedId: (id: string | null) => void;
  resetInteractionTimer: () => void;
};

const CopyModeContext = createContext<CopyModeContextType | null>(null);

export function CopyModeProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const [state, setState] = useState<CopyModeState>({
    isActive: false,
    clipboardData: null,
    sourceAssignmentId: null,
    pasteCount: 0,
    lastPastedId: null,
  });

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInteractionRef = useRef<number>(Date.now());

  const clearTimeout_ = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startTimeout = useCallback(() => {
    clearTimeout_();
    timeoutRef.current = setTimeout(() => {
      setState({
        isActive: false,
        clipboardData: null,
        sourceAssignmentId: null,
        pasteCount: 0,
        lastPastedId: null,
      });
      toast({
        title: "Copy mode ended",
        description: "Exited copy mode due to inactivity.",
      });
    }, COPY_MODE_TIMEOUT_MS);
  }, [clearTimeout_, toast]);

  const resetInteractionTimer = useCallback(() => {
    lastInteractionRef.current = Date.now();
    if (state.isActive) {
      startTimeout();
    }
  }, [state.isActive, startTimeout]);

  const enterCopyMode = useCallback((assignmentId: string, data: ClipboardShiftData) => {
    if (state.isActive && state.sourceAssignmentId === assignmentId) {
      setState({
        isActive: false,
        clipboardData: null,
        sourceAssignmentId: null,
        pasteCount: 0,
        lastPastedId: null,
      });
      clearTimeout_();
      return;
    }
    setState({
      isActive: true,
      clipboardData: data,
      sourceAssignmentId: assignmentId,
      pasteCount: 0,
      lastPastedId: null,
    });
    lastInteractionRef.current = Date.now();
    startTimeout();
  }, [state.isActive, state.sourceAssignmentId, clearTimeout_, startTimeout]);

  const exitCopyMode = useCallback(() => {
    setState({
      isActive: false,
      clipboardData: null,
      sourceAssignmentId: null,
      pasteCount: 0,
      lastPastedId: null,
    });
    clearTimeout_();
  }, [clearTimeout_]);

  const setPasteCount = useCallback((count: number) => {
    setState(prev => ({ ...prev, pasteCount: count }));
  }, []);

  const setLastPastedId = useCallback((id: string | null) => {
    setState(prev => ({ ...prev, lastPastedId: id }));
  }, []);

  useEffect(() => {
    return () => clearTimeout_();
  }, [clearTimeout_]);

  useEffect(() => {
    if (!state.isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        exitCopyMode();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.isActive, exitCopyMode]);

  return (
    <CopyModeContext.Provider value={{
      ...state,
      enterCopyMode,
      exitCopyMode,
      setPasteCount,
      setLastPastedId,
      resetInteractionTimer,
    }}>
      {children}
    </CopyModeContext.Provider>
  );
}

export function useCopyMode() {
  const context = useContext(CopyModeContext);
  if (!context) {
    throw new Error("useCopyMode must be used within a CopyModeProvider");
  }
  return context;
}
