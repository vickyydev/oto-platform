import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { ApiError, apiRequest, queryClient } from "@/lib/queryClient";

/** The roles DELETE /api/fix-reports/:id accepts; the server holds the rule, this hides the button. */
const DELETE_ROLES = ["admin", "global_admin", "operator_admin", "manager"];

interface FixReportDeleteProps {
  reportId: string;
  /** The report is gone: close whatever is showing it. */
  onDeleted: () => void;
}

/**
 * Deleting a Fix report that is not needed or is a duplicate, for managers and
 * admins, asking first. The server keeps the row and records who deleted it.
 */
export function FixReportDelete({ reportId, onDeleted }: FixReportDeleteProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  const finish = (title: string) => {
    toast({ title });
    setConfirming(false);
    queryClient.removeQueries({ queryKey: ["/api/fix-reports", reportId] });
    queryClient.invalidateQueries({ queryKey: ["/api/fix-reports"] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs"] });
    onDeleted();
  };

  const deleteReport = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/fix-reports/${reportId}`),
    onSuccess: () => finish("Report deleted"),
    onError: (error: Error) => {
      // Somebody else got there first: the result is what was asked for.
      if (error instanceof ApiError && error.status === 404) {
        finish("This report was already deleted");
        return;
      }
      toast({ title: "Failed to delete report", description: error.message, variant: "destructive" });
    },
  });

  if (!user?.role || !DELETE_ROLES.includes(user.role)) return null;

  return (
    <>
      <div className="px-4 py-3 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-destructive hover:text-destructive"
          onClick={() => setConfirming(true)}
          data-testid="button-delete-fix-report"
        >
          <Trash2 className="w-4 h-4" />
          Delete report
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={(open) => !deleteReport.isPending && setConfirming(open)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-fix-report">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this report?</AlertDialogTitle>
            <AlertDialogDescription>
              Use this for a report that is not needed or is a duplicate. It will disappear from the Fix Board and
              from everyone's lists.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteReport.isPending} data-testid="button-cancel-delete-fix-report">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={deleteReport.isPending}
              onClick={(event) => {
                // Stays open until the server has answered.
                event.preventDefault();
                deleteReport.mutate();
              }}
              data-testid="button-confirm-delete-fix-report"
            >
              {deleteReport.isPending ? "Deleting…" : "Delete report"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
