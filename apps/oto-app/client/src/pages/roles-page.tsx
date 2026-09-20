import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { Plus, Briefcase, Users, Pencil, Archive, UserPlus } from "lucide-react";
import type { Branch, Employee } from "@shared/schema";

type RoleWithCount = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  employeeCount: number;
  branches?: Branch[];
};

type EmployeeWithRole = Employee & {
  hasRole?: boolean;
};

export default function RolesPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleWithCount | null>(null);
  const [assigningRole, setAssigningRole] = useState<RoleWithCount | null>(null);
  const [formData, setFormData] = useState({ name: "", description: "", branchIds: [] as string[] });
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);

  const canEdit = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin" || user?.role === "manager";
  const isStaff = user?.role === "staff";

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: roles = [], isLoading } = useQuery<RoleWithCount[]>({
    queryKey: ["/api/roles"],
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: roleEmployees = [], isLoading: loadingRoleEmployees } = useQuery<{ employeeId: string; roleId: string }[]>({
    queryKey: ["/api/roles", assigningRole?.id, "employees"],
    queryFn: async () => {
      if (!assigningRole) return [];
      const res = await fetch(`/api/roles/${assigningRole.id}/employees`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!assigningRole,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string; branchIds: string[] }) => {
      return apiRequest("POST", "/api/roles", { 
        name: data.name, 
        description: data.description || null,
        branchIds: data.branchIds.length > 0 ? data.branchIds : undefined
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      setCreateOpen(false);
      setFormData({ name: "", description: "", branchIds: [] });
      toast({ title: "Role created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: string; name: string; description: string; branchIds: string[] }) => {
      return apiRequest("PATCH", `/api/roles/${data.id}`, { 
        name: data.name, 
        description: data.description || null,
        branchIds: data.branchIds.length > 0 ? data.branchIds : undefined
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      setEditingRole(null);
      toast({ title: "Role updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/roles/${id}/deactivate`, { force: false });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      toast({ title: "Role deactivated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const assignEmployeesMutation = useMutation({
    mutationFn: async ({ roleId, employeeIds }: { roleId: string; employeeIds: string[] }) => {
      return apiRequest("PATCH", `/api/roles/${roleId}/employees`, { employeeIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      setAssigningRole(null);
      setSelectedEmployees([]);
      toast({ title: "Employees assigned successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filteredRoles = roles.filter((r) => {
    if (isAllBranches) return true;
    if (!selectedBranchId) return true;
    return r.branches?.some(b => b.id === selectedBranchId) ?? false;
  });

  const activeRoles = filteredRoles.filter((r) => r.isActive);
  const inactiveRoles = filteredRoles.filter((r) => !r.isActive);

  const handleCreate = () => {
    if (!formData.name.trim()) {
      toast({ title: "Please enter a role name", variant: "destructive" });
      return;
    }
    createMutation.mutate(formData);
  };

  const handleUpdate = () => {
    if (!editingRole || !formData.name.trim()) {
      toast({ title: "Please enter a role name", variant: "destructive" });
      return;
    }
    updateMutation.mutate({ id: editingRole.id, name: formData.name, description: formData.description, branchIds: formData.branchIds });
  };

  const openEditDialog = (role: RoleWithCount) => {
    setEditingRole(role);
    setFormData({ 
      name: role.name, 
      description: role.description || "",
      branchIds: role.branches?.map(b => b.id) || []
    });
  };

  const openAssignDialog = (role: RoleWithCount) => {
    setAssigningRole(role);
  };

  useEffect(() => {
    if (roleEmployees.length > 0) {
      setSelectedEmployees(roleEmployees.map(re => re.employeeId));
    } else if (!loadingRoleEmployees && assigningRole) {
      setSelectedEmployees([]);
    }
  }, [roleEmployees, loadingRoleEmployees, assigningRole]);

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

  const handleAssignEmployees = () => {
    if (!assigningRole) return;
    assignEmployeesMutation.mutate({ roleId: assigningRole.id, employeeIds: selectedEmployees });
  };

  const openCreateDialog = () => {
    if (!isAllBranches && selectedBranchId) {
      setFormData({ name: "", description: "", branchIds: [selectedBranchId] });
    } else {
      setFormData({ name: "", description: "", branchIds: [] });
    }
    setCreateOpen(true);
  };

  const getBranchNames = (role: RoleWithCount) => {
    if (role.branches && role.branches.length > 0) {
      return role.branches.map(b => b.name);
    }
    return [];
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Briefcase className="h-6 w-6" />
            Roles
          </h1>
          <p className="text-muted-foreground">
            Manage job roles used for scheduling and employee assignments
          </p>
        </div>

        {canEdit && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-role" onClick={openCreateDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Add Role
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Role</DialogTitle>
                <DialogDescription>Add a new job role for the company</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Role Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g., Cashier, Barista, Chef"
                    data-testid="input-role-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData((f) => ({ ...f, description: e.target.value }))}
                    placeholder="Optional description of the role responsibilities"
                    data-testid="input-role-description"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Assign to Branches (optional)</Label>
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
                <Button onClick={handleCreate} disabled={createMutation.isPending} data-testid="button-save-role">
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
      ) : activeRoles.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Briefcase className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No roles yet</h3>
            <p className="text-muted-foreground">
              {canEdit
                ? "Create roles to define job functions for scheduling"
                : "Contact an admin to create roles"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {activeRoles.map((role) => {
            const branchNames = getBranchNames(role);
            return (
              <Card key={role.id} data-testid={`role-card-${role.id}`} className="overflow-hidden">
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
                  <div className="space-y-1 min-w-0 flex-1">
                    <CardTitle className="text-lg truncate">{role.name}</CardTitle>
                    {branchNames.length > 0 && (
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
                        onClick={() => openAssignDialog(role)}
                        title="Assign employees"
                        data-testid={`button-assign-role-${role.id}`}
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(role)}
                        data-testid={`button-edit-role-${role.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deactivateMutation.mutate(role.id)}
                        disabled={deactivateMutation.isPending}
                        data-testid={`button-deactivate-role-${role.id}`}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  {role.description && (
                    <p className="text-sm text-muted-foreground mb-2">{role.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span>{role.employeeCount} employee{role.employeeCount !== 1 ? "s" : ""}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {inactiveRoles.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium text-muted-foreground">Inactive Roles</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {inactiveRoles.map((role) => (
              <Card key={role.id} className="opacity-60">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    {role.name}
                    <Badge variant="secondary">Inactive</Badge>
                  </CardTitle>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Edit Role Dialog */}
      <Dialog open={!!editingRole} onOpenChange={(open) => !open && setEditingRole(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Role</DialogTitle>
            <DialogDescription>Update role details and branch assignments</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Role Name *</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                data-testid="input-edit-role-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={formData.description}
                onChange={(e) => setFormData((f) => ({ ...f, description: e.target.value }))}
                data-testid="input-edit-role-description"
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
            <Button variant="outline" onClick={() => setEditingRole(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending} data-testid="button-update-role">
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Employees Dialog */}
      <Dialog open={!!assigningRole} onOpenChange={(open) => {
        if (!open) {
          setAssigningRole(null);
          setSelectedEmployees([]);
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Assign Employees to {assigningRole?.name}</DialogTitle>
            <DialogDescription>
              Select employees to assign to this role. Changes will sync with employee profiles.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[400px] pr-4">
            <div className="space-y-2">
              {loadingRoleEmployees ? (
                <div className="space-y-2">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}
                </div>
              ) : employees.filter(e => e.status === 'active').map((employee) => {
                const isAssigned = roleEmployees.some(re => re.employeeId === employee.id);
                const isSelected = selectedEmployees.includes(employee.id);
                const willBeAssigned = isSelected !== isAssigned ? isSelected : isAssigned;
                
                return (
                  <div 
                    key={employee.id} 
                    className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      willBeAssigned ? 'bg-primary/10 border-primary/30' : 'hover:bg-muted'
                    }`}
                    onClick={() => {
                      if (isAssigned && !selectedEmployees.includes(employee.id)) {
                        setSelectedEmployees(prev => prev.filter(id => id !== employee.id));
                      } else if (!isAssigned && selectedEmployees.includes(employee.id)) {
                        setSelectedEmployees(prev => prev.filter(id => id !== employee.id));
                      } else {
                        toggleEmployee(employee.id);
                      }
                    }}
                  >
                    <Checkbox
                      checked={willBeAssigned}
                      onCheckedChange={() => {
                        if (isAssigned) {
                          if (selectedEmployees.includes(employee.id)) {
                            setSelectedEmployees(prev => prev.filter(id => id !== employee.id));
                          } else {
                            setSelectedEmployees(prev => [...prev, employee.id]);
                          }
                        } else {
                          toggleEmployee(employee.id);
                        }
                      }}
                      data-testid={`checkbox-employee-${employee.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{employee.nickname || employee.fullName}</p>
                      <p className="text-sm text-muted-foreground truncate">{employee.fullName}</p>
                    </div>
                    {isAssigned && !selectedEmployees.includes(employee.id) && (
                      <Badge variant="secondary" className="text-xs">Currently assigned</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setAssigningRole(null);
              setSelectedEmployees([]);
            }}>
              Cancel
            </Button>
            <Button 
              onClick={handleAssignEmployees} 
              disabled={assignEmployeesMutation.isPending}
              data-testid="button-save-employee-assignments"
            >
              {assignEmployeesMutation.isPending ? "Saving..." : "Save Assignments"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
