import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Loader2, Check, AlertCircle, Clock, UserPlus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface BorrowCandidate {
  employeeId: string;
  name: string;
  nickname: string;
  homeBranchId: string;
  homeBranchName: string;
  roles: { id: string; name: string }[];
  availabilityStatus: "AVAILABLE" | "NOT_AVAILABLE" | "ON_LEAVE";
  conflictingShiftSummary?: string;
}

interface BorrowStaffModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftRowId: string;
  weekPlanId: string;
  date: string;
  branchId: string;
  weekStartFormatted: string;
  shiftLabel?: string;
  shiftTime: string;
  departmentName: string;
}

export function BorrowStaffModal({
  open,
  onOpenChange,
  shiftRowId,
  weekPlanId,
  date,
  branchId,
  weekStartFormatted,
  shiftLabel,
  shiftTime,
  departmentName,
}: BorrowStaffModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data: borrowData, isLoading, error } = useQuery<{ candidates: BorrowCandidate[]; hasSiblingBranches: boolean }>({
    queryKey: ["/api/schedule/shift-rows", shiftRowId, "borrow-candidates", date, branchId],
    queryFn: async () => {
      const response = await fetch(
        `/api/schedule/shift-rows/${shiftRowId}/borrow-candidates?date=${date}&branchId=${branchId}`
      );
      if (!response.ok) throw new Error("Failed to fetch candidates");
      return response.json();
    },
    enabled: open && !!shiftRowId && !!date && !!branchId,
  });
  const candidates = borrowData?.candidates ?? [];
  const hasSiblingBranches = borrowData?.hasSiblingBranches ?? true;

  const assignMutation = useMutation({
    mutationFn: async (candidate: BorrowCandidate) => {
      return apiRequest("POST", "/api/schedule/assignments", {
        weekPlanId: weekPlanId || undefined,
        shiftRowId,
        shiftDate: date,
        employeeId: candidate.employeeId,
        isBorrowed: true,
        borrowedFromBranchId: candidate.homeBranchId,
      });
    },
    onSuccess: () => {
      toast({
        title: "Staff assigned",
        description: "The borrowed staff member has been assigned to this shift.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", branchId, weekStartFormatted] });
      queryClient.invalidateQueries({ queryKey: ["/api/rota", branchId] });
      onOpenChange(false);
    },
    onError: (error: any) => {
      toast({
        title: "Assignment failed",
        description: error.message || "Could not assign staff to this shift.",
        variant: "destructive",
      });
    },
    onSettled: () => {
      setAssigningId(null);
    },
  });

  const handleAssign = (candidate: BorrowCandidate) => {
    setAssigningId(candidate.employeeId);
    assignMutation.mutate(candidate);
  };

  const searchLower = search.trim().toLowerCase();
  const matchesSearch = (c: BorrowCandidate) => {
    if (!searchLower) return true;
    return (
      (c.nickname || "").toLowerCase().includes(searchLower) ||
      c.name.toLowerCase().includes(searchLower)
    );
  };

  const allAvailable = candidates.filter(c => c.availabilityStatus === "AVAILABLE");
  const allUnavailable = candidates.filter(c => c.availabilityStatus !== "AVAILABLE");
  const availableCandidates = allAvailable.filter(matchesSearch);
  const unavailableCandidates = allUnavailable.filter(matchesSearch);

  const hasResults = availableCandidates.length > 0 || unavailableCandidates.length > 0;
  const candidatesLoaded = !isLoading && !error && candidates.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Find Staff from Other Branches
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground mb-3 space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{departmentName}</Badge>
            {shiftLabel && <Badge variant="secondary">{shiftLabel}</Badge>}
          </div>
          <div>
            {new Date(date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
            {" • "}
            {shiftTime}
          </div>
        </div>

        {candidatesLoaded && (
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8 text-destructive">
              <AlertCircle className="h-5 w-5 mr-2" />
              Failed to load candidates
            </div>
          ) : candidates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <UserPlus className="h-8 w-8 mx-auto mb-2 opacity-50" />
              {hasSiblingBranches ? (
                <>
                  <p>No eligible staff found in other branches.</p>
                  <p className="text-xs mt-1">Staff must have matching roles and be available on this date.</p>
                </>
              ) : (
                <>
                  <p>Cross-branch borrowing is not configured.</p>
                  <p className="text-xs mt-1">Branches must be linked via Operators. Contact your administrator.</p>
                </>
              )}
            </div>
          ) : !hasResults ? (
            <div className="text-center py-8 text-muted-foreground">
              <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No matches for "{search}".</p>
            </div>
          ) : (
            <>
              {availableCandidates.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-green-600 dark:text-green-400 flex items-center gap-1">
                    <Check className="h-4 w-4" />
                    Available ({availableCandidates.length})
                  </h4>
                  {availableCandidates.map((candidate) => (
                    <CandidateCard
                      key={candidate.employeeId}
                      candidate={candidate}
                      onAssign={handleAssign}
                      isAssigning={assigningId === candidate.employeeId}
                      disabled={!!assigningId}
                    />
                  ))}
                </div>
              )}

              {unavailableCandidates.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    Not Available ({unavailableCandidates.length})
                  </h4>
                  {unavailableCandidates.map((candidate) => (
                    <CandidateCard
                      key={candidate.employeeId}
                      candidate={candidate}
                      onAssign={handleAssign}
                      isAssigning={false}
                      disabled={true}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CandidateCard({
  candidate,
  onAssign,
  isAssigning,
  disabled,
}: {
  candidate: BorrowCandidate;
  onAssign: (candidate: BorrowCandidate) => void;
  isAssigning: boolean;
  disabled: boolean;
}) {
  const displayName = candidate.nickname || candidate.name;
  const showFullName = candidate.nickname && candidate.nickname !== candidate.name;

  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const isAvailable = candidate.availabilityStatus === "AVAILABLE";

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border",
        isAvailable ? "bg-card" : "bg-muted/50 opacity-70"
      )}
      data-testid={`borrow-candidate-${candidate.employeeId}`}
    >
      <Avatar className="h-10 w-10 bg-primary shrink-0">
        <AvatarFallback className="text-sm text-white bg-primary">{initials}</AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{displayName}</div>
        {showFullName && (
          <div className="text-xs text-muted-foreground">{candidate.name}</div>
        )}
        <div className="text-xs text-muted-foreground">From: {candidate.homeBranchName}</div>
        <div className="flex flex-wrap gap-1 mt-1">
          {candidate.roles.slice(0, 3).map((role) => (
            <Badge key={role.id} variant="secondary" className="text-[10px] px-1.5 py-0">
              {role.name}
            </Badge>
          ))}
          {candidate.roles.length > 3 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              +{candidate.roles.length - 3}
            </Badge>
          )}
        </div>
        {candidate.conflictingShiftSummary && (
          <div className="text-xs text-orange-600 dark:text-orange-400 mt-1">
            Conflict: {candidate.conflictingShiftSummary}
          </div>
        )}
        {candidate.availabilityStatus === "ON_LEAVE" && (
          <div className="text-xs text-red-600 dark:text-red-400 mt-1">On leave / day off</div>
        )}
      </div>

      <Button
        size="sm"
        onClick={() => onAssign(candidate)}
        disabled={disabled || !isAvailable}
        className="shrink-0"
        data-testid={`button-assign-borrow-${candidate.employeeId}`}
      >
        {isAssigning ? <Loader2 className="h-4 w-4 animate-spin" /> : "Assign"}
      </Button>
    </div>
  );
}
