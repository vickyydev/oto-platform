import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogBody } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Plus, Building, MapPin, Pencil, Archive, Users, UserCog } from "lucide-react";
import type { Operator, Branch, User } from "@shared/schema";
import { useAdminManagement, type ManagedTarget } from "@/hooks/use-admin-management";
import { ManagedInAdminNotice } from "@/components/managed-in-admin-notice";

type ManagedUser = User & ManagedTarget;

type OperatorFormData = {
  name: string;
  status: "active" | "archived";
  branchIds: string[];
  userIds: string[];
};

export default function OperatorsPage() {
  const { toast } = useToast();
  const management = useAdminManagement();
  const editEpoch = useRef(0);
  const [editLoading, setEditLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingOperator, setEditingOperator] = useState<Operator | null>(null);
  const [formData, setFormData] = useState<OperatorFormData>({ 
    name: "", 
    status: "active",
    branchIds: [],
    userIds: []
  });

  const { data: operators = [], isLoading, isFetching: operatorsFetching, isError: operatorsError } = useQuery<Operator[]>({
    queryKey: ["/api/admin/operators"],
  });

  const { data: allBranches = [], isFetching: branchesFetching, isError: branchesError } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  // SCRUM-604: the park group's logins come from GET /api/users (the same
  // global-admin gate as this page); there is no /api/admin/users route.
  const { data: allUsers = [], isFetching: usersFetching, isError: usersError } = useQuery<ManagedUser[]>({
    queryKey: ["/api/users"],
  });

  const listsReady = !isLoading && !operatorsFetching && !branchesFetching && !usersFetching
    && !operatorsError && !branchesError && !usersError
    && management.readList<Operator>(["/api/admin/operators"]) !== undefined
    && management.readList<ManagedUser>(["/api/users"]) !== undefined
    && management.readList<Branch>(["/api/branches"]) !== undefined;

  // Only actual legal-entity references are consulted; no tenant or branch
  // membership is used to guess a person's management authority.
  const affectedManaged = (operatorId: string | null, userIds: string[] = [], branchIds: string[] = []) => {
    const liveOperators = management.readList<Operator>(["/api/admin/operators"]);
    const liveUsers = management.readList<ManagedUser>(["/api/users"]);
    const liveBranches = management.readList<Branch>(["/api/branches"]);
    if (!liveOperators || !liveUsers || !liveBranches) return undefined;
    const flags: unknown[] = [];
    const entityFlag = (id: string | null) => id === null ? false : liveOperators.find(row => row.id === id)?.platformRolesEnabled;
    flags.push(entityFlag(operatorId));
    const affectedUsers = new Set([...userIds, ...liveUsers.filter(row => operatorId !== null && row.operatorId === operatorId).map(row => row.id)]);
    for (const id of affectedUsers) flags.push(liveUsers.find(row => row.id === id)?.managedInAdmin);
    const affectedBranches = new Set([...branchIds, ...liveBranches.filter(row => operatorId !== null && row.operatorId === operatorId).map(row => row.id)]);
    for (const id of affectedBranches) {
      const branch = liveBranches.find(row => row.id === id);
      flags.push(branch ? entityFlag(branch.operatorId) : undefined);
    }
    return flags.some(value => value === true) ? true : flags.every(value => value === false) ? false : undefined;
  };
  const canCreate = listsReady && management.canWrite(false);
  const canManageOperator = (id: string) => listsReady && management.canWrite(affectedManaged(id));
  const canEdit = !!editingOperator && canManageOperator(editingOperator.id);
  const assertOperatorWrite = (id: string | null, data: Pick<OperatorFormData, "userIds" | "branchIds">) =>
    management.assertWritable(() => affectedManaged(id, data.userIds, data.branchIds));

  useEffect(() => {
    if (!canCreate) setCreateOpen(false);
    if (!canEdit) {
      editEpoch.current++;
      setEditingOperator(null);
      setEditLoading(false);
    }
    if (!canEdit && (!createOpen || !canCreate)) {
      setFormData(prev => prev.name || prev.branchIds.length || prev.userIds.length
        ? { name: "", status: "active", branchIds: [], userIds: [] } : prev);
    }
  }, [canCreate, canEdit, createOpen]);
  useEffect(() => () => { editEpoch.current++; }, []);

  const adminUsers = allUsers.filter(u => 
    u.role === "admin" || u.role === "global_admin" || u.role === "operator_admin"
  );

  const createMutation = useMutation({
    mutationFn: async (data: OperatorFormData) => {
      const assertCurrent = management.beginWrite(() => affectedManaged(null, data.userIds, data.branchIds));
      const operator = await apiRequest("POST", "/api/admin/operators", { 
        name: data.name, 
        status: data.status 
      });
      const operatorData = await operator.json();
      assertCurrent();
      // The real create response carries the new entity's authoritative flag.
      queryClient.setQueryData<Operator[]>(["/api/admin/operators"], rows =>
        rows ? [...rows.filter(row => row.id !== operatorData.id), operatorData] : rows);
      
      if (data.branchIds.length > 0) {
        assertCurrent();
        assertOperatorWrite(operatorData.id, data);
        await apiRequest("PUT", `/api/admin/operators/${operatorData.id}/branches`, { 
          branchIds: data.branchIds 
        });
      }
      if (data.userIds.length > 0) {
        assertCurrent();
        assertOperatorWrite(operatorData.id, data);
        await apiRequest("PUT", `/api/admin/operators/${operatorData.id}/users`, { 
          userIds: data.userIds 
        });
      }
      return operatorData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/operators"] });
      queryClient.invalidateQueries({ queryKey: ["/api/branches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setCreateOpen(false);
      setFormData({ name: "", status: "active", branchIds: [], userIds: [] });
      toast({ title: "Operator created successfully" });
    },
    onError: (error: Error) => {
      management.handleError(error);
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: OperatorFormData & { id: string }) => {
      const assertCurrent = management.beginWrite(() => affectedManaged(data.id, data.userIds, data.branchIds));
      await apiRequest("PATCH", `/api/admin/operators/${data.id}`, { 
        name: data.name, 
        status: data.status 
      });
      assertCurrent();
      await apiRequest("PUT", `/api/admin/operators/${data.id}/branches`, { 
        branchIds: data.branchIds 
      });
      assertCurrent();
      await apiRequest("PUT", `/api/admin/operators/${data.id}/users`, { 
        userIds: data.userIds 
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/operators"] });
      queryClient.invalidateQueries({ queryKey: ["/api/branches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setEditingOperator(null);
      toast({ title: "Operator updated successfully" });
    },
    onError: (error: Error) => {
      management.handleError(error);
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      assertOperatorWrite(id, { userIds: [], branchIds: [] });
      return apiRequest("DELETE", `/api/admin/operators/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/operators"] });
      toast({ title: "Operator deleted" });
    },
    onError: (error: Error) => {
      management.handleError(error);
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const activeOperators = operators.filter((o) => o.status === "active");
  const archivedOperators = operators.filter((o) => o.status === "archived");

  const handleCreate = () => {
    if (!canCreate) return;
    if (!formData.name.trim()) {
      toast({ title: "Please enter an operator name", variant: "destructive" });
      return;
    }
    createMutation.mutate(formData);
  };

  const handleUpdate = () => {
    if (!editingOperator || !canManageOperator(editingOperator.id) || editLoading) return;
    if (!formData.name.trim()) {
      toast({ title: "Please fill in operator name", variant: "destructive" });
      return;
    }
    updateMutation.mutate({ id: editingOperator.id, ...formData });
  };

  const openEditDialog = async (op: Operator) => {
    if (!canManageOperator(op.id)) return;
    const epoch = ++editEpoch.current;
    resetForm();
    setEditLoading(true);
    setEditingOperator(op);
    
    try {
      const [branchesRes, usersRes] = await Promise.all([
        fetch(`/api/admin/operators/${op.id}/branches`, { credentials: "include" }),
        fetch(`/api/admin/operators/${op.id}/users`, { credentials: "include" })
      ]);
      
      const branches = branchesRes.ok ? await branchesRes.json() : [];
      const users = usersRes.ok ? await usersRes.json() : [];
      if (epoch !== editEpoch.current) return;
      // These replies are newer than the list snapshot used to open the card.
      const flags = new Map<string, boolean>(users.filter((user: ManagedUser) => typeof user.managedInAdmin === "boolean")
        .map((user: ManagedUser) => [user.id, user.managedInAdmin]));
      queryClient.setQueryData<ManagedUser[]>(["/api/users"], rows => rows?.map(user =>
        flags.has(user.id) ? { ...user, managedInAdmin: flags.get(user.id)! } : user));
      if (users.some((user: ManagedUser) => user.managedInAdmin !== false)) {
        editEpoch.current++;
        setEditingOperator(null);
        setEditLoading(false);
        resetForm();
        management.retry();
        return;
      }
      assertOperatorWrite(op.id, { userIds: users.map((user: ManagedUser) => user.id), branchIds: branches.map((branch: Branch) => branch.id) });
      
      setFormData({ 
        name: op.name, 
        status: op.status,
        branchIds: branches.map((b: Branch) => b.id),
        userIds: users.map((u: User) => u.id)
      });
    } catch (error) {
      if (epoch !== editEpoch.current || !canManageOperator(op.id)) return;
      management.handleError(error);
      setFormData({ 
        name: op.name, 
        status: op.status,
        branchIds: [],
        userIds: []
      });
    } finally {
      if (epoch === editEpoch.current) setEditLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({ name: "", status: "active", branchIds: [], userIds: [] });
  };

  const toggleBranch = (branchId: string) => {
    if (!management.canWrite(affectedManaged(editingOperator?.id ?? null, formData.userIds, [branchId]))) return;
    setFormData(prev => ({
      ...prev,
      branchIds: prev.branchIds.includes(branchId)
        ? prev.branchIds.filter(id => id !== branchId)
        : [...prev.branchIds, branchId]
    }));
  };

  const toggleUser = (userId: string) => {
    if (!management.canWrite(affectedManaged(editingOperator?.id ?? null, [userId], formData.branchIds))) return;
    setFormData(prev => ({
      ...prev,
      userIds: prev.userIds.includes(userId)
        ? prev.userIds.filter(id => id !== userId)
        : [...prev.userIds, userId]
    }));
  };

  const getUnassignedBranches = () => {
    const assignedBranchIds = new Set<string>();
    operators.forEach(op => {
      if (op.id !== editingOperator?.id) {
        allBranches
          .filter(b => b.operatorId === op.id)
          .forEach(b => assignedBranchIds.add(b.id));
      }
    });
    return allBranches.filter(b => !assignedBranchIds.has(b.id) || formData.branchIds.includes(b.id));
  };

  const getUnassignedUsers = () => {
    const assignedUserIds = new Set<string>();
    operators.forEach(op => {
      if (op.id !== editingOperator?.id) {
        adminUsers
          .filter(u => u.operatorId === op.id)
          .forEach(u => assignedUserIds.add(u.id));
      }
    });
    return adminUsers.filter(u => !assignedUserIds.has(u.id) || formData.userIds.includes(u.id));
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );
  }

  const unassignedBranches = getUnassignedBranches();
  const unassignedUsers = getUnassignedUsers();

  const formFields = (
    <div className="space-y-6 py-4">
      <div className="space-y-2">
        <Label htmlFor="name">Operator Name</Label>
        <Input
          id="name"
          placeholder="Enter operator name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          data-testid="input-operator-name"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="status">Status</Label>
        <Select
          value={formData.status}
          onValueChange={(value: "active" | "archived") => setFormData({ ...formData, status: value })}
        >
          <SelectTrigger data-testid="select-operator-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground" />
          <Label>Assign Branches</Label>
        </div>
        <ScrollArea className="h-40 border rounded-md p-3">
          {unassignedBranches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No available branches</p>
          ) : (
            <div className="space-y-2">
              {unassignedBranches.map((branch) => (
                <div key={branch.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`branch-${branch.id}`}
                    checked={formData.branchIds.includes(branch.id)}
                    onCheckedChange={() => toggleBranch(branch.id)}
                    disabled={!management.canWrite(affectedManaged(editingOperator?.id ?? null, formData.userIds, [branch.id]))}
                    data-testid={`checkbox-branch-${branch.id}`}
                  />
                  <label
                    htmlFor={`branch-${branch.id}`}
                    className="text-sm cursor-pointer flex-1"
                  >
                    {branch.name}
                  </label>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <p className="text-xs text-muted-foreground">
          {formData.branchIds.length} branch{formData.branchIds.length !== 1 ? "es" : ""} selected
        </p>
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserCog className="h-4 w-4 text-muted-foreground" />
          <Label>Assign Advisor Users</Label>
        </div>
        <ScrollArea className="h-40 border rounded-md p-3">
          {unassignedUsers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No available admin users</p>
          ) : (
            <div className="space-y-2">
              {unassignedUsers.map((user) => (
                <div key={user.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`user-${user.id}`}
                    checked={formData.userIds.includes(user.id)}
                    onCheckedChange={() => toggleUser(user.id)}
                    disabled={!management.canWrite(affectedManaged(editingOperator?.id ?? null, [user.id], formData.branchIds))}
                    data-testid={`checkbox-user-${user.id}`}
                  />
                  <label
                    htmlFor={`user-${user.id}`}
                    className="text-sm cursor-pointer flex-1"
                  >
                    {user.fullName}
                    <span className="text-muted-foreground ml-2">({user.role?.replace(/_/g, ' ')})</span>
                  </label>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <p className="text-xs text-muted-foreground">
          {formData.userIds.length} user{formData.userIds.length !== 1 ? "s" : ""} selected
        </p>
      </div>
    </div>
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-operators-heading">Operators</h1>
          <p className="text-muted-foreground">
            Manage operators and their branch assignments
          </p>
        </div>
        <Dialog open={createOpen && canCreate} onOpenChange={(open) => {
          setCreateOpen(open && canCreate);
          if (!open) resetForm();
        }}>
          {canCreate && <DialogTrigger asChild>
            <Button data-testid="button-add-operator">
              <Plus className="h-4 w-4 mr-2" />
              Add Operator
            </Button>
          </DialogTrigger>}
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Operator</DialogTitle>
              <DialogDescription>
                Add a new operator and assign branches and admin users
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
            {formFields}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)} data-testid="button-cancel-create">
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={createMutation.isPending} data-testid="button-confirm-create">
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <ManagedInAdminNotice section="operators"
        managed={management.actorManaged === true || operators.some(operator => operator.platformRolesEnabled === true)}
        checking={management.checking || operatorsFetching || usersFetching || branchesFetching}
        unavailable={!management.ready || !listsReady || operators.some(operator => typeof operator.platformRolesEnabled !== "boolean")}
        onRetry={management.retry} />

      {activeOperators.length === 0 && archivedOperators.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No operators yet</h3>
            <p className="text-muted-foreground text-center max-w-sm mt-2">
              Create your first operator to start organizing your branches
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {activeOperators.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-medium">Active Operators</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {activeOperators.map((op) => (
                  <OperatorCard
                    key={op.id}
                    operator={op}
                    onEdit={openEditDialog}
                    onDelete={(id) => deleteMutation.mutate(id)}
                    canWrite={canManageOperator(op.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {archivedOperators.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-medium text-muted-foreground">Archived Operators</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {archivedOperators.map((op) => (
                  <OperatorCard
                    key={op.id}
                    operator={op}
                    onEdit={openEditDialog}
                    onDelete={(id) => deleteMutation.mutate(id)}
                    canWrite={canManageOperator(op.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <Dialog open={canEdit} onOpenChange={(open) => {
        if (!open) {
          editEpoch.current++;
          setEditingOperator(null);
          setEditLoading(false);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Operator</DialogTitle>
            <DialogDescription>
              Update operator details, branches, and admin users
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
          {formFields}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => { editEpoch.current++; setEditingOperator(null); setEditLoading(false); }} data-testid="button-cancel-edit">
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={editLoading || updateMutation.isPending} data-testid="button-confirm-edit">
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OperatorCard({ 
  operator, 
  canWrite,
  onEdit, 
  onDelete 
}: { 
  operator: Operator; 
  canWrite: boolean;
  onEdit: (op: Operator) => void; 
  onDelete: (id: string) => void;
}) {
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/admin/operators", operator.id, "branches"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/operators/${operator.id}/branches`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch branches");
      return res.json();
    },
  });

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["/api/admin/operators", operator.id, "users"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/operators/${operator.id}/users`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
  });

  return (
    <Card className={operator.status === "archived" ? "opacity-60" : ""} data-testid={`card-operator-${operator.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Building className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">{operator.name}</CardTitle>
          </div>
          <Badge variant={operator.status === "active" ? "default" : "secondary"}>
            {operator.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
          <div className="flex items-center gap-1">
            <MapPin className="h-4 w-4" />
            <span>{branches.length} branch{branches.length !== 1 ? "es" : ""}</span>
          </div>
          <div className="flex items-center gap-1">
            <Users className="h-4 w-4" />
            <span>{users.length} user{users.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
        {branches.length > 0 && (
          <div className="space-y-1 mb-4">
            {branches.slice(0, 3).map((b) => (
              <div key={b.id} className="text-sm text-muted-foreground truncate">
                {b.name}
              </div>
            ))}
            {branches.length > 3 && (
              <div className="text-sm text-muted-foreground">
                +{branches.length - 3} more
              </div>
            )}
          </div>
        )}
        {canWrite && <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onEdit(operator)} data-testid={`button-edit-operator-${operator.id}`}>
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
          {operator.status === "active" && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => onEdit({ ...operator, status: "archived" })}
              data-testid={`button-archive-operator-${operator.id}`}
            >
              <Archive className="h-4 w-4 mr-1" />
              Archive
            </Button>
          )}
        </div>}
      </CardContent>
    </Card>
  );
}
