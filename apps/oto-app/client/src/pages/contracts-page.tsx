import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { ContractInstance, Employee } from "@shared/schema";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Plus, FileSignature, Eye, Clock, CheckCircle, Send, AlertCircle, PenTool, Building2, Trash2, Archive, X, History } from "lucide-react";
import { formatDate } from "@/lib/format-utils";
import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { Branch } from "@shared/schema";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ActivityPreviewTooltip } from "@/components/activity-preview-tooltip";

function ContractsTableSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="h-10 w-10 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-9 w-20" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ isAllBranches, canEdit }: { isAllBranches: boolean; canEdit: boolean }) {
  return (
    <div className="text-center py-16">
      <FileSignature className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
      <h3 className="text-lg font-medium mb-2">No contracts yet</h3>
      <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
        {isAllBranches 
          ? "Select a branch from the sidebar to generate contracts."
          : canEdit 
            ? "Generate your first contract to start sending to employees."
            : "No contracts have been created for this branch yet."}
      </p>
      {!isAllBranches && canEdit && (
        <Link href="/contracts/new">
          <Button data-testid="button-create-first-contract">
            <Plus className="mr-2 h-4 w-4" />
            Generate Contract
          </Button>
        </Link>
      )}
    </div>
  );
}

function StatusBadge({ status, signingStatus }: { status: string; signingStatus?: string }) {
  if (signingStatus === "signed") {
    return (
      <Badge variant="default" className="capitalize bg-green-600 dark:bg-green-700">
        <PenTool className="h-3 w-3 mr-1" />
        signed
      </Badge>
    );
  }
  
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }> = {
    draft: { variant: "secondary", icon: Clock },
    finalized: { variant: "outline", icon: CheckCircle },
    sent: { variant: "default", icon: Send },
    failed: { variant: "destructive", icon: AlertCircle },
  };

  const config = variants[status] || variants.draft;
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className="capitalize">
      <Icon className="h-3 w-3 mr-1" />
      {status}
    </Badge>
  );
}

export default function ContractsPage() {
  const searchString = useSearch();
  const urlParams = new URLSearchParams(searchString);
  const initialFilter = urlParams.get("status") || "pending";
  
  const [statusFilter, setStatusFilter] = useState<string>(initialFilter);
  const [contractToDelete, setContractToDelete] = useState<ContractInstance | null>(null);
  const [contractToArchive, setContractToArchive] = useState<ContractInstance | null>(null);
  const [selectedContracts, setSelectedContracts] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"delete" | "archive" | null>(null);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const { selectedBranchId, isAllBranches, selectedBranch } = useBranchContext();
  const { user } = useAuth();
  const { toast } = useToast();
  
  // Staff role has read-only access
  const canEdit = user?.role !== "staff";
  const isAdmin = user?.role === "admin";
  
  // Clear selection when filter changes
  useEffect(() => {
    setSelectedContracts(new Set());
  }, [statusFilter]);

  const deleteContractMutation = useMutation({
    mutationFn: async (contractId: string) => {
      await apiRequest("DELETE", `/api/contracts/${contractId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      toast({ title: "Contract deleted", description: "The contract has been permanently removed." });
      setContractToDelete(null);
    },
    onError: (error: Error) => {
      toast({ title: "Cannot delete contract", description: error.message, variant: "destructive" });
      setContractToDelete(null);
    },
  });

  const archiveContractMutation = useMutation({
    mutationFn: async (contractId: string) => {
      await apiRequest("PATCH", `/api/contracts/${contractId}/archive`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      toast({ title: "Contract archived", description: "The signed contract has been moved to the archive." });
      setContractToArchive(null);
    },
    onError: (error: Error) => {
      toast({ title: "Cannot archive contract", description: error.message, variant: "destructive" });
      setContractToArchive(null);
    },
  });

  // Bulk operations
  const executeBulkAction = async (action: "delete" | "archive", contractIds: string[]) => {
    setBulkAction(action);
    setBulkProgress({ current: 0, total: contractIds.length });
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < contractIds.length; i++) {
      try {
        if (action === "delete") {
          await apiRequest("DELETE", `/api/contracts/${contractIds[i]}`);
        } else {
          await apiRequest("PATCH", `/api/contracts/${contractIds[i]}/archive`);
        }
        successCount++;
      } catch (error) {
        failCount++;
      }
      setBulkProgress({ current: i + 1, total: contractIds.length });
    }
    
    queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
    setSelectedContracts(new Set());
    setBulkAction(null);
    setBulkProgress({ current: 0, total: 0 });
    
    const actionWord = action === "delete" ? "deleted" : "archived";
    if (failCount === 0) {
      toast({ 
        title: `Bulk ${action} complete`, 
        description: `Successfully ${actionWord} ${successCount} contract${successCount !== 1 ? "s" : ""}.` 
      });
    } else {
      toast({ 
        title: `Bulk ${action} completed with errors`, 
        description: `${successCount} succeeded, ${failCount} failed.`,
        variant: "destructive"
      });
    }
  };

  const toggleSelectContract = (contractId: string) => {
    setSelectedContracts(prev => {
      const next = new Set(prev);
      if (next.has(contractId)) {
        next.delete(contractId);
      } else {
        next.add(contractId);
      }
      return next;
    });
  };

  const toggleSelectAll = (contracts: ContractInstance[]) => {
    if (selectedContracts.size === contracts.length) {
      setSelectedContracts(new Set());
    } else {
      setSelectedContracts(new Set(contracts.map(c => c.id)));
    }
  };

  // Get selected contracts that can be deleted (not signed)
  const getSelectableForDelete = () => {
    return filteredContracts.filter(c => 
      selectedContracts.has(c.id) && 
      c.signingStatus !== "signed" && 
      !c.archivedAt
    );
  };

  // Get selected contracts that can be archived (signed and not archived)
  const getSelectableForArchive = () => {
    return filteredContracts.filter(c => 
      selectedContracts.has(c.id) && 
      c.signingStatus === "signed" && 
      !c.archivedAt
    );
  };

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const urlStatus = params.get("status") || "pending";
    if (urlStatus !== statusFilter) {
      setStatusFilter(urlStatus);
    }
  }, [searchString]);

  const { data: contracts, isLoading: contractsLoading } = useQuery<ContractInstance[]>({
    queryKey: ["/api/contracts"],
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const employeeMap = new Map(employees?.map((e) => [e.id, e]) || []);
  const branchMap = new Map(branches?.map((b) => [b.id, b]) || []);

  const branchFilteredContracts = contracts?.filter(c => {
    if (!isAllBranches && c.branchId !== selectedBranchId) return false;
    return true;
  }) || [];

  // Filter out archived contracts from non-archived views
  const activeContracts = branchFilteredContracts.filter(c => !c.archivedAt);
  const archivedContracts = branchFilteredContracts.filter(c => !!c.archivedAt);

  const filteredContracts = (statusFilter === "archived" ? archivedContracts : activeContracts).filter((c) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "archived") return true;
    if (statusFilter === "pending") {
      return c.status === "draft" || c.status === "finalized";
    }
    if (statusFilter === "awaiting") {
      return c.signingStatus === "awaiting_signature";
    }
    if (statusFilter === "signed") {
      return c.signingStatus === "signed" && !c.archivedAt;
    }
    return true;
  });

  const counts = {
    pending: activeContracts.filter(c => c.status === "draft" || c.status === "finalized").length,
    awaiting: activeContracts.filter(c => c.signingStatus === "awaiting_signature").length,
    signed: activeContracts.filter(c => c.signingStatus === "signed").length,
    archived: archivedContracts.length,
    all: activeContracts.length,
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-medium" data-testid="text-contracts-title">Contracts</h1>
          <p className="text-muted-foreground">
            Manage and track all contract instances
          </p>
        </div>
        {!isAllBranches && canEdit && (
          <Link href="/contracts/new">
            <Button data-testid="button-new-contract">
              <Plus className="mr-2 h-4 w-4" />
              Generate Contract
            </Button>
          </Link>
        )}
      </div>

      <Tabs value={statusFilter} onValueChange={setStatusFilter} className="w-full">
        <TabsList data-testid="tabs-contract-status">
          <TabsTrigger value="pending" data-testid="tab-pending">
            Pending ({counts.pending})
          </TabsTrigger>
          <TabsTrigger value="awaiting" data-testid="tab-awaiting">
            Awaiting Signature ({counts.awaiting})
          </TabsTrigger>
          <TabsTrigger value="signed" data-testid="tab-signed">
            Signed ({counts.signed})
          </TabsTrigger>
          <TabsTrigger value="archived" data-testid="tab-archived">
            Archived ({counts.archived})
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">
            All ({counts.all})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>
              {isAllBranches ? "All Contracts" : `${selectedBranch?.name} Contracts`}
            </CardTitle>
            <CardDescription>
              {filteredContracts.length} contract{filteredContracts.length !== 1 ? "s" : ""} 
              {statusFilter !== "all" && ` (${statusFilter})`}
            </CardDescription>
          </div>
        </CardHeader>
        
        {/* Bulk Action Bar */}
        {isAdmin && selectedContracts.size > 0 && (
          <div className="mx-6 mb-4 p-3 bg-muted rounded-lg flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">
                {selectedContracts.size} contract{selectedContracts.size !== 1 ? "s" : ""} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedContracts(new Set())}
                data-testid="button-clear-selection"
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
            
            {bulkAction ? (
              <div className="flex items-center gap-3 min-w-48">
                <span className="text-sm text-muted-foreground">
                  {bulkAction === "delete" ? "Deleting" : "Archiving"}... {bulkProgress.current}/{bulkProgress.total}
                </span>
                <Progress value={(bulkProgress.current / bulkProgress.total) * 100} className="w-24 h-2" />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {getSelectableForDelete().length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => executeBulkAction("delete", getSelectableForDelete().map(c => c.id))}
                    className="text-destructive border-destructive hover:bg-destructive hover:text-destructive-foreground"
                    data-testid="button-bulk-delete"
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete ({getSelectableForDelete().length})
                  </Button>
                )}
                {getSelectableForArchive().length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => executeBulkAction("archive", getSelectableForArchive().map(c => c.id))}
                    data-testid="button-bulk-archive"
                  >
                    <Archive className="h-4 w-4 mr-1" />
                    Archive ({getSelectableForArchive().length})
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        <CardContent>
          {contractsLoading ? (
            <ContractsTableSkeleton />
          ) : filteredContracts.length === 0 ? (
            statusFilter === "all" ? (
              <EmptyState isAllBranches={isAllBranches} canEdit={canEdit} />
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p>No contracts with status "{statusFilter}"</p>
              </div>
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {isAdmin && statusFilter !== "archived" && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={filteredContracts.length > 0 && selectedContracts.size === filteredContracts.length}
                        onCheckedChange={() => toggleSelectAll(filteredContracts)}
                        aria-label="Select all"
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                  )}
                  <TableHead>Employee</TableHead>
                  {isAllBranches && <TableHead>Branch</TableHead>}
                  <TableHead>Position</TableHead>
                  <TableHead>Salary</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredContracts.map((contract) => {
                  const employee = employeeMap.get(contract.employeeId);
                  return (
                    <TableRow key={contract.id} data-testid={`contract-row-${contract.id}`}>
                      {isAdmin && statusFilter !== "archived" && (
                        <TableCell className="w-10">
                          <Checkbox
                            checked={selectedContracts.has(contract.id)}
                            onCheckedChange={() => toggleSelectContract(contract.id)}
                            aria-label={`Select contract for ${employee?.fullName || "Unknown"}`}
                            data-testid={`checkbox-contract-${contract.id}`}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                            <FileSignature className="h-5 w-5 text-muted-foreground" />
                          </div>
                          <div>
                            {employee ? (
                              <Link href={`/employees/${employee.id}`}>
                                <span className="font-medium text-primary hover:underline cursor-pointer" data-testid={`link-employee-${contract.id}`}>
                                  {employee.fullName}
                                </span>
                              </Link>
                            ) : (
                              <p className="font-medium">Unknown</p>
                            )}
                            <p className="text-sm text-muted-foreground">
                              {employee?.email || "—"}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      {isAllBranches && (
                        <TableCell>
                          <div className="flex items-center gap-1 text-sm">
                            <Building2 className="h-3 w-3 text-muted-foreground" />
                            <span>{branchMap.get(contract.branchId || "")?.name || "Unknown"}</span>
                          </div>
                        </TableCell>
                      )}
                      <TableCell>
                        <span className="font-medium">
                          {contract.mergeDataJson.positionTitle}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono">
                          ฿{contract.mergeDataJson.salaryThb.toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={contract.status} signingStatus={contract.signingStatus} />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {formatDate(contract.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <ActivityPreviewTooltip contractInstanceId={contract.id}>
                            <Button variant="ghost" size="icon" data-testid={`button-activity-${contract.id}`}>
                              <History className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </ActivityPreviewTooltip>
                          <Link href={`/contracts/${contract.id}`}>
                            <Button variant="ghost" size="icon" data-testid={`button-view-${contract.id}`}>
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                          {isAdmin && !contract.archivedAt && (
                            <>
                              {/* Show trash icon for draft/finalized/pending contracts (can be deleted) - only signed contracts are protected */}
                              {(contract.status === "draft" || contract.status === "finalized") && 
                               contract.signingStatus !== "signed" && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setContractToDelete(contract)}
                                  data-testid={`button-delete-${contract.id}`}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              )}
                              {/* Show archive icon for signed/active contracts */}
                              {(contract.signingStatus === "signed" || contract.status === "active") && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setContractToArchive(contract)}
                                  data-testid={`button-archive-${contract.id}`}
                                >
                                  <Archive className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!contractToDelete} onOpenChange={(open) => !open && setContractToDelete(null)}>
        <AlertDialogContent data-testid="dialog-delete-contract">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contract</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete this contract for{" "}
              <strong>{employeeMap.get(contractToDelete?.employeeId || "")?.fullName || "Unknown"}</strong>?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => contractToDelete && deleteContractMutation.mutate(contractToDelete.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteContractMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteContractMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!contractToArchive} onOpenChange={(open) => !open && setContractToArchive(null)}>
        <AlertDialogContent data-testid="dialog-archive-contract">
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Contract</AlertDialogTitle>
            <AlertDialogDescription>
              This contract for{" "}
              <strong>{employeeMap.get(contractToArchive?.employeeId || "")?.fullName || "Unknown"}</strong>{" "}
              is signed and cannot be deleted. Moving it to the Archive will remove it from the active list 
              while preserving it for legal compliance purposes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-archive">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => contractToArchive && archiveContractMutation.mutate(contractToArchive.id)}
              disabled={archiveContractMutation.isPending}
              data-testid="button-confirm-archive"
            >
              {archiveContractMutation.isPending ? "Archiving..." : "Move to Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
