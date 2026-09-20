import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { Plus, Building2, Users, Pencil, Archive, UserPlus } from "lucide-react";
import type { Branch, Employee } from "@shared/schema";

type DepartmentWithBranches = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  employeeCount: number;
  branches?: Branch[];
};

export default function DepartmentsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingDept, setEditingDept] = useState<DepartmentWithBranches | null>(null);
  const [assigningDept, setAssigningDept] = useState<DepartmentWithBranches | null>(null);
  const [formData, setFormData] = useState({ name: "", description: "", branchIds: [] as string[] });
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);

  const isStaff = user?.role === "staff";
  const canEdit = !isStaff;

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: departments = [], isLoading } = useQuery<DepartmentWithBranches[]>({
    queryKey: ["/api/departments", selectedBranchId],
    queryFn: async () => {
      const url = selectedBranchId && !isAllBranches
        ? `/api/departments?branchId=${selectedBranchId}`
        : "/api/departments";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch departments");
      return res.json();
    },
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: deptEmployees = [], isLoading: loadingDeptEmployees } = useQuery<{ employeeId: string; departmentId: string }[]>({
    queryKey: ["/api/departments", assigningDept?.id, "employees"],
    queryFn: async () => {
      if (!assigningDept) return [];
      const res = await fetch(`/api/departments/${assigningDept.id}/employees`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!assigningDept,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string; branchIds: string[] }) => {
      return apiRequest("POST", "/api/departments", { 
        name: data.name, 
        description: data.description || null,
        branchIds: data.branchIds 
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      setCreateOpen(false);
      setFormData({ name: "", description: "", branchIds: [] });
      toast({ title: "Department created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: string; name: string; description: string; branchIds: string[] }) => {
      return apiRequest("PATCH", `/api/departments/${data.id}`, { 
        name: data.name, 
        description: data.description || null,
        branchIds: data.branchIds 
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      setEditingDept(null);
      toast({ title: "Department updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/departments/${id}/deactivate`, { force: false });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      toast({ title: "Department deactivated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const assignEmployeesMutation = useMutation({
    mutationFn: async ({ departmentId, employeeIds }: { departmentId: string; employeeIds: string[] }) => {
      return apiRequest("PATCH", `/api/departments/${departmentId}/employees`, { employeeIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      setAssigningDept(null);
      setSelectedEmployees([]);
      toast({ title: "Employees assigned successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const getBranchNames = (dept: DepartmentWithBranches) => {
    if (dept.branches && dept.branches.length > 0) {
      return dept.branches.map(b => b.name);
    }
    return [];
  };

  const toggleBranch = (branchId: string) => {
    setFormData(f => ({
      ...f,
      branchIds: f.branchIds.includes(branchId)
        ? f.branchIds.filter(id => id !== branchId)
        : [...f.branchIds, branchId]
    }));
  };

  const toggleEmployee = (employeeId: string) => {
    setSelectedEmployees(prev => 
      prev.includes(employeeId)
        ? prev.filter(id => id !== employeeId)
        : [...prev, employeeId]
    );
  };

  const openAssignDialog = (dept: DepartmentWithBranches) => {
    setAssigningDept(dept);
  };

  const handleAssignEmployees = () => {
    if (!assigningDept) return;
    assignEmployeesMutation.mutate({ departmentId: assigningDept.id, employeeIds: selectedEmployees });
  };

  useEffect(() => {
    if (deptEmployees.length > 0) {
      setSelectedEmployees(deptEmployees.map(de => de.employeeId));
    } else if (!loadingDeptEmployees && assigningDept) {
      setSelectedEmployees([]);
    }
  }, [deptEmployees, loadingDeptEmployees, assigningDept]);

  const activeDepts = departments.filter((d) => d.isActive);
  const inactiveDepts = departments.filter((d) => !d.isActive);

  const handleCreate = () => {
    if (!formData.name.trim()) {
      toast({ title: "Please enter a department name", variant: "destructive" });
      return;
    }
    if (formData.branchIds.length === 0) {
      toast({ title: "Please select at least one branch", variant: "destructive" });
      return;
    }
    createMutation.mutate(formData);
  };

  const handleUpdate = () => {
    if (!editingDept || !formData.name.trim()) {
      toast({ title: "Please fill in department name", variant: "destructive" });
      return;
    }
    updateMutation.mutate({ id: editingDept.id, name: formData.name, description: formData.description, branchIds: formData.branchIds });
  };

  const openEditDialog = (dept: DepartmentWithBranches) => {
    setEditingDept(dept);
    setFormData({ 
      name: dept.name, 
      description: dept.description || "", 
      branchIds: dept.branches?.map(b => b.id) || [] 
    });
  };

  const openCreateDialog = () => {
    if (!isAllBranches && selectedBranchId) {
      setFormData({ name: "", description: "", branchIds: [selectedBranchId] });
    } else {
      setFormData({ name: "", description: "", branchIds: [] });
    }
    setCreateOpen(true);
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            Departments
          </h1>
          <p className="text-muted-foreground">
            {isAllBranches ? "Manage departments and assign them to branches" : "Departments available at this branch"}
          </p>
        </div>

        {canEdit && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-department" onClick={openCreateDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Add Department
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Department</DialogTitle>
                <DialogDescription>Create a new department and assign it to branches</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Department Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g., Front Desk, Kitchen"
                    data-testid="input-department-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData((f) => ({ ...f, description: e.target.value }))}
                    placeholder="Optional description"
                    data-testid="input-department-description"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Assign to Branches *</Label>
                  <div className="border rounded-md p-3 space-y-2 max-h-48 overflow-y-auto">
                    {branches.map((branch) => (
                      <div key={branch.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`branch-${branch.id}`}
                          checked={formData.branchIds.includes(branch.id)}
                          onCheckedChange={() => toggleBranch(branch.id)}
                          data-testid={`checkbox-branch-${branch.id}`}
                        />
                        <Label htmlFor={`branch-${branch.id}`} className="font-normal cursor-pointer">
                          {branch.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                  {formData.branchIds.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      {formData.branchIds.length} branch{formData.branchIds.length !== 1 ? "es" : ""} selected
                    </p>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={createMutation.isPending} data-testid="button-save-department">
                  {createMutation.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : activeDepts.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Building2 className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No departments yet</h3>
            <p className="text-muted-foreground">
              {isAllBranches
                ? "Create departments and assign them to branches"
                : "No departments are assigned to this branch yet"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {activeDepts.map((dept) => {
            const branchNames = getBranchNames(dept);
            return (
              <Card key={dept.id} data-testid={`department-card-${dept.id}`} className="overflow-hidden">
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
                  <div className="space-y-1 min-w-0 flex-1">
                    <CardTitle className="text-lg truncate">{dept.name}</CardTitle>
                    {isAllBranches && branchNames.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {branchNames.slice(0, 3).map((name, i) => (
                          <Badge key={i} variant="outline" className="text-xs">
                            {name}
                          </Badge>
                        ))}
                        {branchNames.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{branchNames.length - 3} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openAssignDialog(dept)}
                        title="Assign employees"
                        data-testid={`button-assign-department-${dept.id}`}
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(dept)}
                        data-testid={`button-edit-department-${dept.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deactivateMutation.mutate(dept.id)}
                        disabled={deactivateMutation.isPending}
                        data-testid={`button-deactivate-department-${dept.id}`}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  {dept.description && (
                    <p className="text-sm text-muted-foreground mb-2">{dept.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span>{dept.employeeCount} employee{dept.employeeCount !== 1 ? "s" : ""}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {inactiveDepts.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium text-muted-foreground">Inactive Departments</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {inactiveDepts.map((dept) => {
              const branchNames = getBranchNames(dept);
              return (
                <Card key={dept.id} className="opacity-60">
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      {dept.name}
                      <Badge variant="secondary">Inactive</Badge>
                    </CardTitle>
                    {isAllBranches && branchNames.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {branchNames.map((name, i) => (
                          <Badge key={i} variant="outline" className="text-xs">{name}</Badge>
                        ))}
                      </div>
                    )}
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <Dialog open={!!editingDept} onOpenChange={(open) => !open && setEditingDept(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Department</DialogTitle>
            <DialogDescription>Update department details and branch assignments</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Department Name *</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                data-testid="input-edit-department-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={formData.description}
                onChange={(e) => setFormData((f) => ({ ...f, description: e.target.value }))}
                data-testid="input-edit-department-description"
              />
            </div>
            <div className="space-y-2">
              <Label>Assign to Branches</Label>
              <div className="border rounded-md p-3 space-y-2 max-h-48 overflow-y-auto">
                {branches.map((branch) => (
                  <div key={branch.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`edit-branch-${branch.id}`}
                      checked={formData.branchIds.includes(branch.id)}
                      onCheckedChange={() => toggleBranch(branch.id)}
                      data-testid={`checkbox-edit-branch-${branch.id}`}
                    />
                    <Label htmlFor={`edit-branch-${branch.id}`} className="font-normal cursor-pointer">
                      {branch.name}
                    </Label>
                  </div>
                ))}
              </div>
              {formData.branchIds.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {formData.branchIds.length} branch{formData.branchIds.length !== 1 ? "es" : ""} selected
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingDept(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending} data-testid="button-update-department">
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!assigningDept} onOpenChange={(open) => {
        if (!open) {
          setAssigningDept(null);
          setSelectedEmployees([]);
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Assign Employees to {assigningDept?.name}</DialogTitle>
            <DialogDescription>
              Select employees to assign to this department. Changes will update employee profiles.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[400px] pr-4">
            <div className="space-y-2">
              {loadingDeptEmployees ? (
                <div className="space-y-2">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}
                </div>
              ) : employees.filter(e => e.status === 'active').map((employee) => {
                const isSelected = selectedEmployees.includes(employee.id);
                
                return (
                  <div 
                    key={employee.id} 
                    className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer hover-elevate ${
                      isSelected ? 'bg-primary/10 border-primary/30' : ''
                    }`}
                    onClick={() => toggleEmployee(employee.id)}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleEmployee(employee.id)}
                      data-testid={`checkbox-dept-employee-${employee.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{employee.nickname || employee.fullName}</p>
                      <p className="text-sm text-muted-foreground truncate">{employee.fullName}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setAssigningDept(null);
              setSelectedEmployees([]);
            }}>
              Cancel
            </Button>
            <Button 
              onClick={handleAssignEmployees} 
              disabled={assignEmployeesMutation.isPending}
              data-testid="button-save-dept-employee-assignments"
            >
              {assignEmployeesMutation.isPending ? "Saving..." : "Save Assignments"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
