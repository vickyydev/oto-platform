import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Edit, Trash2, ArrowLeft, Building2, Clock, Briefcase, UserX } from "lucide-react";
import { format, parseISO } from "date-fns";
import type { Branch, Department, Role } from "@shared/schema";

type CasualWorker = {
  id: string;
  fullName: string;
  nickname: string;
  jobTitle: string | null;
  branchId: string;
  departmentId: string;
  roleId: string;
  startDate: string;
  endDate: string;
  dailyRate: number;
  rateType: string;
  status: "active" | "inactive" | "expired";
  createdAt: string;
  branch?: { id: string; name: string } | null;
  department?: { id: string; name: string } | null;
  role?: { id: string; name: string } | null;
};

type FormData = {
  fullName: string;
  nickname: string;
  jobTitle: string;
  branchId: string;
  departmentId: string;
  roleId: string;
  startDate: string;
  endDate: string;
  dailyRate: string;
};

const initialFormData: FormData = {
  fullName: "",
  nickname: "",
  jobTitle: "",
  branchId: "",
  departmentId: "",
  roleId: "",
  startDate: "",
  endDate: "",
  dailyRate: "",
};

function getStatusDisplay(worker: CasualWorker): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  const today = format(new Date(), "yyyy-MM-dd");
  if (worker.status === "inactive") return { label: "Inactive", variant: "secondary" };
  if (worker.status === "expired" || today > worker.endDate) return { label: "Expired", variant: "secondary" };
  if (today < worker.startDate) return { label: "Upcoming", variant: "outline" };
  return { label: "Active", variant: "default" };
}

export default function CasualWorkersPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { selectedBranchId, isAllBranches, activeBranchName } = useBranchContext();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingWorker, setEditingWorker] = useState<CasualWorker | null>(null);
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const canEdit = user?.role === "admin" || user?.role === "manager" || user?.role === "global_admin" || user?.role === "operator_admin";

  const casualWorkersUrl = `/api/casual-workers?branchId=${selectedBranchId || 'all'}&status=${statusFilter}`;
  const { data: casualWorkers, isLoading } = useQuery<CasualWorker[]>({
    queryKey: ["/api/casual-workers", selectedBranchId, statusFilter],
    queryFn: async () => {
      const res = await fetch(casualWorkersUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch casual workers");
      return res.json();
    },
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const { data: roles } = useQuery<Role[]>({
    queryKey: ["/api/roles"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: FormData) => {
      return apiRequest("POST", "/api/casual-workers", {
        ...data,
        dailyRate: Number(data.dailyRate),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/casual-workers"] });
      setShowCreateDialog(false);
      setFormData(initialFormData);
      toast({ title: "Casual worker created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<FormData> }) => {
      const payload: Record<string, unknown> = { ...data };
      if (data.dailyRate) {
        payload.dailyRate = Number(data.dailyRate);
      }
      return apiRequest("PATCH", `/api/casual-workers/${id}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/casual-workers"] });
      setEditingWorker(null);
      setFormData(initialFormData);
      toast({ title: "Casual worker updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/casual-workers/${id}/deactivate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/casual-workers"] });
      toast({ title: "Casual worker deactivated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/casual-workers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/casual-workers"] });
      toast({ title: "Casual worker deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filteredWorkers = casualWorkers?.filter(w => {
    if (!isAllBranches && w.branchId !== selectedBranchId) return false;
    const today = format(new Date(), "yyyy-MM-dd");
    if (statusFilter === "active") {
      return w.status === "active" && w.startDate <= today && today <= w.endDate;
    }
    if (statusFilter === "inactive") return w.status === "inactive";
    if (statusFilter === "expired") {
      return w.status === "expired" || today > w.endDate;
    }
    return true;
  }) || [];

  const handleOpenCreate = () => {
    setFormData({
      ...initialFormData,
      branchId: !isAllBranches && selectedBranchId ? selectedBranchId : "",
    });
    setShowCreateDialog(true);
  };

  const handleOpenEdit = (worker: CasualWorker) => {
    setFormData({
      fullName: worker.fullName,
      nickname: worker.nickname,
      jobTitle: worker.jobTitle || "",
      branchId: worker.branchId,
      departmentId: worker.departmentId,
      roleId: worker.roleId,
      startDate: worker.startDate,
      endDate: worker.endDate,
      dailyRate: worker.dailyRate.toString(),
    });
    setEditingWorker(worker);
  };

  const handleSubmit = () => {
    if (editingWorker) {
      updateMutation.mutate({ id: editingWorker.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const isFormValid = formData.fullName && formData.nickname && formData.branchId && 
    formData.departmentId && formData.roleId && formData.startDate && 
    formData.endDate && formData.dailyRate && Number.isInteger(Number(formData.dailyRate)) && Number(formData.dailyRate) > 0 &&
    new Date(formData.endDate) >= new Date(formData.startDate);

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/employees">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Casual Workers</h1>
            <p className="text-muted-foreground">Short-term staff for scheduling only</p>
          </div>
        </div>
        {canEdit && (
          <Button onClick={handleOpenCreate} data-testid="button-add-casual-worker">
            <Plus className="mr-2 h-4 w-4" />
            Add Casual Worker
          </Button>
        )}
      </div>

      <div className="flex items-center gap-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="select-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filteredWorkers.length} casual worker{filteredWorkers.length !== 1 ? "s" : ""}
          {!isAllBranches && ` in ${activeBranchName}`}
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : filteredWorkers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Briefcase className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No casual workers yet</h3>
            <p className="text-muted-foreground mb-4">Add casual workers for quick scheduling assignments</p>
            {canEdit && (
              <Button onClick={handleOpenCreate} data-testid="button-add-first-casual">
                <Plus className="mr-2 h-4 w-4" />
                Add Casual Worker
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                {isAllBranches && <TableHead>Branch</TableHead>}
                <TableHead>Role</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Daily Rate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredWorkers.map(worker => {
                const statusDisplay = getStatusDisplay(worker);
                return (
                  <TableRow key={worker.id} data-testid={`casual-worker-row-${worker.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-medium">{worker.nickname}</p>
                          <p className="text-sm text-muted-foreground">{worker.fullName}</p>
                        </div>
                        <Badge variant="outline" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 text-xs">
                          Casual
                        </Badge>
                      </div>
                    </TableCell>
                    {isAllBranches && (
                      <TableCell>
                        <div className="flex items-center gap-1 text-sm">
                          <Building2 className="h-3 w-3 text-muted-foreground" />
                          {worker.branch?.name || "Unknown"}
                        </div>
                      </TableCell>
                    )}
                    <TableCell>
                      <span className="text-sm">{worker.role?.name || worker.jobTitle || "—"}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        {format(parseISO(worker.startDate), "dd MMM")} - {format(parseISO(worker.endDate), "dd MMM yyyy")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{worker.dailyRate.toLocaleString()} THB/day</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusDisplay.variant} className={statusDisplay.variant === "default" ? "bg-green-600" : ""}>
                        {statusDisplay.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {canEdit && (
                          <>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              onClick={() => handleOpenEdit(worker)}
                              data-testid={`button-edit-${worker.id}`}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            {worker.status === "active" && (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="icon" data-testid={`button-deactivate-${worker.id}`}>
                                    <UserX className="h-4 w-4 text-amber-600" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Deactivate Casual Worker</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Deactivating {worker.nickname} will remove them from scheduling pickers immediately. They won't be deleted but won't appear in scheduling.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => deactivateMutation.mutate(worker.id)}>
                                      Deactivate
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="icon" data-testid={`button-delete-${worker.id}`}>
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete Casual Worker</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Are you sure you want to delete {worker.nickname}? This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction 
                                    onClick={() => deleteMutation.mutate(worker.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={showCreateDialog || !!editingWorker} onOpenChange={(open) => {
        if (!open) {
          setShowCreateDialog(false);
          setEditingWorker(null);
          setFormData(initialFormData);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingWorker ? "Edit Casual Worker" : "Add Casual Worker"}</DialogTitle>
            <DialogDescription>
              {editingWorker ? "Update the casual worker details." : "Add a short-term worker for scheduling only. No contracts or HR workflows required."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fullName">Full Name *</Label>
                <Input
                  id="fullName"
                  value={formData.fullName}
                  onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                  placeholder="John Smith"
                  data-testid="input-full-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="nickname">Nickname *</Label>
                <Input
                  id="nickname"
                  value={formData.nickname}
                  onChange={(e) => setFormData({ ...formData, nickname: e.target.value })}
                  placeholder="Johnny"
                  data-testid="input-nickname"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="jobTitle">Job Title</Label>
              <Input
                id="jobTitle"
                value={formData.jobTitle}
                onChange={(e) => setFormData({ ...formData, jobTitle: e.target.value })}
                placeholder="Floor Staff"
                data-testid="input-job-title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="branchId">Branch *</Label>
              <Select value={formData.branchId} onValueChange={(v) => setFormData({ ...formData, branchId: v })}>
                <SelectTrigger data-testid="select-branch">
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches?.map(b => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="departmentId">Department *</Label>
                <Select value={formData.departmentId} onValueChange={(v) => setFormData({ ...formData, departmentId: v })}>
                  <SelectTrigger data-testid="select-department">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments?.filter(d => d.isActive).map(d => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="roleId">Role *</Label>
                <Select value={formData.roleId} onValueChange={(v) => setFormData({ ...formData, roleId: v })}>
                  <SelectTrigger data-testid="select-role">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles?.filter(r => r.isActive).map(r => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date *</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={formData.startDate}
                  onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                  className="[&::-webkit-calendar-picker-indicator]:opacity-100 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                  data-testid="input-start-date"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date *</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={formData.endDate}
                  onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                  min={formData.startDate}
                  className="[&::-webkit-calendar-picker-indicator]:opacity-100 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                  data-testid="input-end-date"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dailyRate">Daily Rate (THB) *</Label>
              <Input
                id="dailyRate"
                type="number"
                value={formData.dailyRate}
                onChange={(e) => setFormData({ ...formData, dailyRate: e.target.value })}
                placeholder="500"
                min="1"
                step="1"
                data-testid="input-daily-rate"
              />
            </div>
          </div>

          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowCreateDialog(false);
                setEditingWorker(null);
                setFormData(initialFormData);
              }}
            >
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit}
              disabled={!isFormValid || createMutation.isPending || updateMutation.isPending}
              data-testid="button-save-casual-worker"
            >
              {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingWorker ? "Save Changes" : "Add Worker"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
