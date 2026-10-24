import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { UserWithBranchAccess, Branch } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, MoreHorizontal, Pencil, UserX, UserCheck, KeyRound, Search, LogIn } from "lucide-react";
import { formatDate } from "@/lib/format-utils";
import { useLegacyLoginOff } from "@/lib/sign-in-options";
import { LauncherPasswordNote, SuiteSignInDialog } from "@/components/suite-sign-in";
import { useAdminManagement, type ManagedTarget } from "@/hooks/use-admin-management";
import { ManagedInAdminNotice } from "@/components/managed-in-admin-notice";

type ManagedUser = UserWithBranchAccess & ManagedTarget;

type UserFormData = {
  email: string;
  fullName: string;
  password: string;
  phoneNumber: string;
  role: "admin" | "manager" | "staff";
  accessScope: "all_branches" | "selected_branches";
  branchIds: string[];
};

export default function UsersPage() {
  const { toast } = useToast();
  const management = useAdminManagement();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserWithBranchAccess | null>(null);
  const [resetPasswordUser, setResetPasswordUser] = useState<UserWithBranchAccess | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  // SCRUM-539: with this app's own sign-in closed, passwords typed here open
  // nothing; people get a suite sign-in instead and manage it at the launcher.
  const { off: legacyOff, launcherUrl } = useLegacyLoginOff();
  const [suiteSignInUser, setSuiteSignInUser] = useState<UserWithBranchAccess | null>(null);
  const [passwordNoteUser, setPasswordNoteUser] = useState<UserWithBranchAccess | null>(null);
  const [formData, setFormData] = useState<UserFormData>({
    email: "",
    fullName: "",
    password: "",
    phoneNumber: "",
    role: "staff",
    accessScope: "selected_branches",
    branchIds: [],
  });

  const { data: users = [], isLoading: usersLoading, isFetching: usersFetching, isError: usersError } = useQuery<ManagedUser[]>({
    queryKey: ["/api/users"],
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const usersReady = !usersLoading && !usersFetching && !usersError;
  const canCreate = usersReady && management.canWrite(false);
  const userManaged = (id: string) => management.readTarget<ManagedUser>(
    ["/api/users"], user => user.id === id, user => user.managedInAdmin,
  );
  const canManageUser = (id: string) => usersReady && management.canWrite(userManaged(id));
  const canEdit = !!editingUser && canManageUser(editingUser.id);
  const canResetPassword = !!resetPasswordUser && canManageUser(resetPasswordUser.id);
  const canProvision = !!suiteSignInUser && canManageUser(suiteSignInUser.id);
  const canShowPasswordHelp = !!passwordNoteUser && canManageUser(passwordNoteUser.id);

  useEffect(() => {
    if (!canCreate) setIsCreateDialogOpen(false);
    if (!canEdit) setEditingUser(null);
    if (!canResetPassword) { setResetPasswordUser(null); setNewPassword(""); }
    if (!canProvision) setSuiteSignInUser(null);
    if (!canShowPasswordHelp) setPasswordNoteUser(null);
    if ((!isCreateDialogOpen || !canCreate) && !canEdit) {
      setFormData(prev => prev.password ? { ...prev, password: "" } : prev);
    }
  }, [canCreate, canEdit, canResetPassword, canProvision, canShowPasswordHelp, isCreateDialogOpen]);

  const createUserMutation = useMutation({
    mutationFn: async (data: UserFormData) => {
      management.assertWritable();
      const res = await apiRequest("POST", "/api/users", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setIsCreateDialogOpen(false);
      resetForm();
      toast({ title: "User created successfully" });
    },
    onError: (error: Error) => {
      management.handleError(error);
      toast({ title: "Failed to create user", description: error.message, variant: "destructive" });
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<UserFormData> & { isActive?: boolean } }) => {
      management.assertWritable(() => userManaged(id));
      const res = await apiRequest("PATCH", `/api/users/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setEditingUser(null);
      resetForm();
      toast({ title: "User updated successfully" });
    },
    onError: (error: Error) => {
      management.handleError(error);
      toast({ title: "Failed to update user", description: error.message, variant: "destructive" });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      management.assertWritable(() => userManaged(id));
      const res = await apiRequest("POST", `/api/users/${id}/reset-password`, { password });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setResetPasswordUser(null);
      setNewPassword("");
      toast({ title: "Password reset successfully", description: "User will be required to change password on next login." });
    },
    onError: (error: Error) => {
      management.handleError(error);
      toast({ title: "Failed to reset password", description: error.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData({
      email: "",
      fullName: "",
      password: "",
      phoneNumber: "",
      role: "staff",
      accessScope: "selected_branches",
      branchIds: [],
    });
  };

  const openEditDialog = (user: UserWithBranchAccess) => {
    if (!canManageUser(user.id)) return;
    setEditingUser(user);
    setFormData({
      email: user.email,
      fullName: user.fullName,
      password: "",
      phoneNumber: user.phoneNumber ?? "",
      role: user.role as "admin" | "manager" | "staff",
      accessScope: user.hasAllBranchesAccess ? "all_branches" : "selected_branches",
      branchIds: user.allowedBranchIds,
    });
  };

  const handleSubmit = () => {
    if (editingUser ? !canManageUser(editingUser.id) : !canCreate) return;
    if (editingUser) {
      const updateData: Partial<UserFormData> = {
        email: formData.email,
        fullName: formData.fullName,
        phoneNumber: formData.phoneNumber.trim(),
        role: formData.role,
        accessScope: formData.accessScope,
        branchIds: formData.branchIds,
      };
      updateUserMutation.mutate({ id: editingUser.id, data: updateData });
    } else {
      const { password, phoneNumber, ...rest } = formData;
      createUserMutation.mutate({
        ...rest,
        ...(legacyOff ? {} : { password }),
        ...(phoneNumber.trim() ? { phoneNumber: phoneNumber.trim() } : {}),
      } as UserFormData);
    }
  };

  const toggleUserActive = (user: UserWithBranchAccess) => {
    if (!canManageUser(user.id)) return;
    updateUserMutation.mutate({
      id: user.id,
      data: { isActive: !user.isActive },
    });
  };

  const toggleBranchSelection = (branchId: string) => {
    setFormData((prev) => ({
      ...prev,
      branchIds: prev.branchIds.includes(branchId)
        ? prev.branchIds.filter((id) => id !== branchId)
        : [...prev.branchIds, branchId],
    }));
  };

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "admin":
        return "default";
      case "manager":
        return "secondary";
      default:
        return "outline";
    }
  };

  // Filter users based on search query
  const filteredUsers = users.filter((user) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      user.fullName.toLowerCase().includes(query) ||
      user.email.toLowerCase().includes(query) ||
      user.role.toLowerCase().includes(query)
    );
  });

  if (usersLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-48" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">User Management</h1>
          <p className="text-muted-foreground">Manage user accounts and branch access permissions</p>
        </div>
        {canCreate && <Button onClick={() => setIsCreateDialogOpen(true)} data-testid="button-create-user">
          <Plus className="h-4 w-4 mr-2" /> Create User
        </Button>}
      </div>
      <ManagedInAdminNotice section="accounts"
        managed={management.actorManaged === true || users.some(user => user.managedInAdmin === true)}
        checking={management.checking || usersFetching}
        unavailable={!management.ready || !usersReady || users.some(user => typeof user.managedInAdmin !== "boolean")}
        onRetry={management.retry} />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle>Users</CardTitle>
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, or role..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-users"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Branch Access</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {searchQuery ? "No users found matching your search" : "No users found"}
                  </TableCell>
                </TableRow>
              ) : filteredUsers.map((user) => (
                <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                  <TableCell className="font-medium">{user.fullName}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <Badge variant={getRoleBadgeVariant(user.role)}>{user.role}</Badge>
                  </TableCell>
                  <TableCell>
                    {user.hasAllBranchesAccess ? (
                      <span className="text-muted-foreground">All Branches</span>
                    ) : user.allowedBranchIds.length > 0 ? (
                      <span>{user.allowedBranchIds.length} branch(es)</span>
                    ) : (
                      <span className="text-muted-foreground">No branches assigned</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 items-center">
                      <Badge variant={user.isActive ? "default" : "secondary"}>
                        {user.isActive ? "Active" : "Inactive"}
                      </Badge>
                      {!legacyOff && user.mustChangePassword && (
                        <Badge variant="outline" className="text-xs">
                          Temp Password
                        </Badge>
                      )}
                      {legacyOff && (
                        <Badge variant="outline" className="text-xs" data-testid={`badge-suite-signin-${user.id}`}>
                          {user.platformUserId ? "Suite sign-in" : "No suite sign-in"}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}
                  </TableCell>
                  <TableCell>
                    {canManageUser(user.id) && <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" data-testid={`button-user-menu-${user.id}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEditDialog(user)}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        {!user.platformUserId && !["global_admin", "operator_admin", "advisor"].includes(user.role) && (
                          <DropdownMenuItem onClick={() => setSuiteSignInUser(user)} data-testid={`button-suite-signin-${user.id}`}>
                            <LogIn className="h-4 w-4 mr-2" />
                            Provision suite sign-in
                          </DropdownMenuItem>
                        )}
                        {legacyOff ? (
                          <DropdownMenuItem onClick={() => setPasswordNoteUser(user)} data-testid={`button-password-launcher-${user.id}`}>
                            <KeyRound className="h-4 w-4 mr-2" />
                            Password help
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => setResetPasswordUser(user)} data-testid={`button-reset-password-${user.id}`}>
                            <KeyRound className="h-4 w-4 mr-2" />
                            Reset Password
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => toggleUserActive(user)}>
                          {user.isActive ? (
                            <>
                              <UserX className="h-4 w-4 mr-2" />
                              Deactivate
                            </>
                          ) : (
                            <>
                              <UserCheck className="h-4 w-4 mr-2" />
                              Activate
                            </>
                          )}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-2 text-xs text-muted-foreground lg:hidden">Scroll sideways to view status and actions.</p>
        </CardContent>
      </Card>

      <Dialog open={(isCreateDialogOpen && canCreate) || canEdit} onOpenChange={(open) => {
        if (!open) {
          setIsCreateDialogOpen(false);
          setEditingUser(null);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingUser ? "Edit User" : "Create New User"}</DialogTitle>
          </DialogHeader>
          <DialogBody className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fullName">Full Name</Label>
              <Input
                id="fullName"
                value={formData.fullName}
                onChange={(e) => setFormData((prev) => ({ ...prev, fullName: e.target.value }))}
                placeholder="Enter full name"
                data-testid="input-user-fullname"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="Enter email address"
                data-testid="input-user-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phoneNumber">Phone Number</Label>
              <Input
                id="phoneNumber"
                type="tel"
                value={formData.phoneNumber}
                onChange={(e) => setFormData((prev) => ({ ...prev, phoneNumber: e.target.value }))}
                placeholder="081 234 5678"
                data-testid="input-user-phone"
              />
              <p className="text-xs text-muted-foreground">
                {editingUser?.platformUserId
                  ? "Their suite sign-in keeps the phone it was made with; this changes the number shown here."
                  : "Optional. The number they sign in with at the OTO launcher (Thai format accepted)."}
              </p>
            </div>
            {!editingUser && !legacyOff && (
              <div className="space-y-2">
                <Label htmlFor="password">Temporary Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="Enter temporary password"
                  data-testid="input-user-password"
                />
                <p className="text-xs text-muted-foreground">
                  Minimum 6 characters. User will be required to change it on first login.
                </p>
              </div>
            )}
            </div>
            <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select
                value={formData.role}
                onValueChange={(value: "admin" | "manager" | "staff") =>
                  setFormData((prev) => ({
                    ...prev,
                    role: value,
                    accessScope: value === "admin" ? "all_branches" : prev.accessScope,
                  }))
                }
              >
                <SelectTrigger data-testid="select-user-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="staff">Staff</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formData.role !== "admin" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="accessScope">Branch Access</Label>
                  <Select
                    value={formData.accessScope}
                    onValueChange={(value: "all_branches" | "selected_branches") =>
                      setFormData((prev) => ({ ...prev, accessScope: value }))
                    }
                  >
                    <SelectTrigger data-testid="select-access-scope">
                      <SelectValue placeholder="Select access scope" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all_branches">All Branches</SelectItem>
                      <SelectItem value="selected_branches">Selected Branches</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.accessScope === "selected_branches" && (
                  <div className="space-y-2">
                    <Label>Select Branches</Label>
                    <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                      {branches.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No branches available</p>
                      ) : (
                        branches.map((branch) => (
                          <div key={branch.id} className="flex items-center gap-2">
                            <Checkbox
                              id={`branch-${branch.id}`}
                              checked={formData.branchIds.includes(branch.id)}
                              onCheckedChange={() => toggleBranchSelection(branch.id)}
                              data-testid={`checkbox-branch-${branch.id}`}
                            />
                            <label
                              htmlFor={`branch-${branch.id}`}
                              className="text-sm cursor-pointer"
                            >
                              {branch.name}
                            </label>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateDialogOpen(false);
                setEditingUser(null);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createUserMutation.isPending || updateUserMutation.isPending}
              data-testid="button-save-user"
            >
              {editingUser ? "Save Changes" : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {canProvision && <SuiteSignInDialog
        open={!!suiteSignInUser}
        onOpenChange={(open) => { if (!open) setSuiteSignInUser(null); }}
        personName={suiteSignInUser?.fullName ?? ""}
        initialPhone={suiteSignInUser?.phoneNumber ?? suiteSignInUser?.phoneE164 ?? null}
        endpoint={`/api/users/${suiteSignInUser?.id}/suite-sign-in`}
        onProvisioned={() => queryClient.invalidateQueries({ queryKey: ["/api/users"] })}
        beforeProvision={() => management.assertWritable(() => suiteSignInUser ? userManaged(suiteSignInUser.id) : undefined)}
        onProvisionError={management.handleError}
      />}
      <Dialog open={canShowPasswordHelp} onOpenChange={(open) => { if (!open) setPasswordNoteUser(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Password help</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-3">
            <p className="text-sm">
              {passwordNoteUser?.platformUserId
                ? <>{passwordNoteUser.fullName} signs in at the OTO launcher with their phone number.</>
                : <>{passwordNoteUser?.fullName} has no suite sign-in yet: use "Provision suite sign-in" to give them one.</>}
            </p>
            <LauncherPasswordNote launcherUrl={launcherUrl} />
          </div>
          <DialogFooter>
            <Button onClick={() => setPasswordNoteUser(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Reset Password Dialog */}
      <Dialog open={canResetPassword} onOpenChange={(open) => {
        if (!open) {
          setResetPasswordUser(null);
          setNewPassword("");
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Set a new temporary password for <strong>{resetPasswordUser?.email}</strong>. 
              The user will be required to change it on their next login.
            </p>
            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new temporary password"
                data-testid="input-reset-password"
              />
              <p className="text-xs text-muted-foreground">Minimum 6 characters</p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setResetPasswordUser(null);
                setNewPassword("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (resetPasswordUser && newPassword.length >= 6) {
                  resetPasswordMutation.mutate({ id: resetPasswordUser.id, password: newPassword });
                }
              }}
              disabled={resetPasswordMutation.isPending || newPassword.length < 6}
              data-testid="button-confirm-reset-password"
            >
              Reset Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
