import { useManagerActionRequest } from "@/hooks/use-manager-action-request";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, Redirect } from "wouter";
import { Employee, Branch } from "@shared/schema";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowRight, CheckCircle, Clock, AlertTriangle, Check } from "lucide-react";
import { addDays, differenceInDays } from "date-fns";
import { formatDate } from "@/lib/format-utils";

function ReviewsTableSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <CheckCircle className="h-16 w-16 mx-auto mb-4 text-green-500/50" />
      <h3 className="text-lg font-medium mb-2">No upcoming reviews</h3>
      <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
        All probation reviews have been completed or are not yet due.
      </p>
    </div>
  );
}

function DueBadge({ dueDate }: { dueDate: Date }) {
  const today = new Date();
  const daysUntilDue = differenceInDays(dueDate, today);

  if (daysUntilDue < 0) {
    return (
      <Badge variant="destructive" className="whitespace-nowrap">
        <AlertTriangle className="h-3 w-3 mr-1" />
        Overdue ({Math.abs(daysUntilDue)}d)
      </Badge>
    );
  } else if (daysUntilDue <= 7) {
    return (
      <Badge variant="outline" className="border-red-500 text-red-600 dark:text-red-400 whitespace-nowrap">
        <Clock className="h-3 w-3 mr-1" />
        {daysUntilDue}d left
      </Badge>
    );
  } else if (daysUntilDue <= 14) {
    return (
      <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400 whitespace-nowrap">
        <Clock className="h-3 w-3 mr-1" />
        {daysUntilDue}d left
      </Badge>
    );
  } else {
    return (
      <Badge variant="secondary" className="whitespace-nowrap">
        <Clock className="h-3 w-3 mr-1" />
        {daysUntilDue}d left
      </Badge>
    );
  }
}

export function ProbationReviewsPanel() {
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const { toast } = useToast();
  const actionRequest = useManagerActionRequest();

  const { data: employees, isLoading: employeesLoading, isError: employeesError, refetch: refetchEmployees } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: branches, isLoading: branchesLoading, isError: branchesError, refetch: refetchBranches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const completeProbationMutation = useMutation({
    mutationFn: async (employeeId: string) => {
      const res = await apiRequest("POST", `/api/employees/${employeeId}/complete-probation-review`, { requestId: actionRequest.requestIdFor(employeeId) });
      return res.json();
    },
    onSuccess: (_, employeeId) => {
      actionRequest.completed(employeeId);
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId] });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/attention-items"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/sidebar/badges"] });
      toast({
        title: "Review completed",
        description: "Probation review has been marked as completed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to complete probation review.",
        variant: "destructive",
      });
    },
  });

  const branchMap = new Map(branches?.map((b) => [b.id, b]) || []);

  const filteredEmployees = employees?.filter(e => {
    if (e.status !== "active") return false;
    if (isAllBranches) return true;
    return e.branchId === selectedBranchId;
  }) || [];

  const thirtyDaysFromNow = addDays(new Date(), 30);

  const upcomingReviews = filteredEmployees
    .filter(e => {
      if (!e.probationEndDate || e.probationReviewCompletedAt) return false;
      const endDate = new Date(e.probationEndDate);
      // Include overdue reviews (no lower limit) and upcoming reviews within 30 days
      return endDate <= thirtyDaysFromNow;
    })
    .sort((a, b) => {
      const dateA = new Date(a.probationEndDate!);
      const dateB = new Date(b.probationEndDate!);
      return dateA.getTime() - dateB.getTime();
    });

  const reviewActions = (employee: Employee, mobile = false) => (
    <div className="flex items-center gap-2 flex-wrap sm:justify-end">
      <Button
        variant="outline"
        size="sm"
        onClick={() => completeProbationMutation.mutate(employee.id)}
        disabled={completeProbationMutation.isPending}
        data-testid={`button-complete-review-${employee.id}${mobile ? "-mobile" : ""}`}
      >
        <Check className="h-3 w-3 mr-1" />
        {completeProbationMutation.isPending && completeProbationMutation.variables === employee.id ? "Completing..." : "Complete"}
      </Button>
      <Link
        href={`/employees/${employee.id}`}
        className="inline-flex min-h-9 items-center px-3 text-sm font-medium rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`button-view-employee-${employee.id}${mobile ? "-mobile" : ""}`}
      >
        View <ArrowRight className="ml-1 h-3 w-3" />
      </Link>
    </div>
  );

  return (
    <section aria-label="Probation reviews" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Probation reviews</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Overdue and due in the next 30 days {isAllBranches ? "across all branches" : "for the selected branch"}.
        </p>
      </div>
      <Card>
        <CardContent className="p-0">
          {employeesError || (isAllBranches && branchesError) ? (
            <div className="py-12 px-4 text-center space-y-3" role="alert">
              <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
              <p className="font-medium">Couldn't load probation reviews</p>
              <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button variant="outline" onClick={() => { refetchEmployees(); if (branchesError) refetchBranches(); }}>Try again</Button>
            </div>
          ) : employeesLoading || (isAllBranches && branchesLoading) ? (
            <ReviewsTableSkeleton />
          ) : upcomingReviews.length === 0 ? (
            <EmptyState />
          ) : (
            <>
            <div className="divide-y sm:hidden">
              {upcomingReviews.map(employee => {
                const dueDate = new Date(employee.probationEndDate!);
                const branch = branchMap.get(employee.branchId || "");
                return (
                  <div key={employee.id} className="p-4 space-y-3" data-testid={`review-row-${employee.id}-mobile`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium break-words">{employee.fullName}</p>
                        <p className="text-sm text-muted-foreground break-all">{employee.email}</p>
                        {isAllBranches && <p className="text-xs text-muted-foreground mt-1">{branch?.name || "Unknown branch"}</p>}
                      </div>
                      <DueBadge dueDate={dueDate} />
                    </div>
                    <p className="text-sm text-muted-foreground">Probation · Due {formatDate(dueDate)}</p>
                    {reviewActions(employee, true)}
                  </div>
                );
              })}
            </div>
            <div className="hidden sm:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  {isAllBranches && <TableHead>Branch</TableHead>}
                  <TableHead>Review Type</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcomingReviews.map((employee) => {
                  const branch = branchMap.get(employee.branchId || "");
                  const dueDate = new Date(employee.probationEndDate!);

                  return (
                    <TableRow key={employee.id} data-testid={`review-row-${employee.id}`}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{employee.fullName}</p>
                          <p className="text-sm text-muted-foreground">{employee.email}</p>
                        </div>
                      </TableCell>
                      {isAllBranches && (
                        <TableCell>
                          <span className="text-sm">{branch?.name || "Unknown"}</span>
                        </TableCell>
                      )}
                      <TableCell>
                        <Badge variant="outline">Probation</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{formatDate(dueDate)}</span>
                      </TableCell>
                      <TableCell>
                        <DueBadge dueDate={dueDate} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {reviewActions(employee)}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export default function ReviewsPage() {
  return <Redirect to="/attention?tab=probation" replace />;
}
